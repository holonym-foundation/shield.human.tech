/**
 * L2→L1 withdrawal orchestrator.
 *
 * Extracts all withdrawal logic from the frontend hooks into a pure,
 * framework-agnostic module.
 *
 * Frontend step mapping (5-step UI):
 *   Step 1: Validate + encrypt nonce + burn+exit on L2
 *   Step 2: Persist receipt + compute witness
 *   Step 3: Wait for block proven on L1
 *   Step 4: Execute L1 withdraw
 *   Step 5: Done
 */

import { Fr } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { encodeFunctionData, parseUnits } from 'viem'
import { CustomTokenPortalAbi } from '../contracts/abis/CustomTokenPortalAbi'

import type { BridgeApiClient } from '../api'
import {
  patchOperationWithRetry,
  patchOperationAsync,
  createOperation,
} from '../operations'
import {
  createSigningMessage,
  deriveEncryptionKey,
  encryptData,
} from '../encryption'
import type {
  ResolvedConfig,
  WithdrawL2ToL1Params,
  BridgeResult,
  L1WithdrawResult,
  BridgeEventCallback,
} from '../types'
import {
  createL1PublicClient,
  serializeNodeInfo,
  wait,
  extractErrorString,
  isAlreadyConsumedError,
  isFatalContractReadError,
  assertPassportDeadlineBuffer,
  assertValidEpoch,
} from './utils'
import { getEtherscanUrl as getEtherscanBaseUrl, getAztecscanUrl as getAztecscanBaseUrl } from '../config'
import { waitForBlockProven } from './polling'
import { computeL2ToL1MessageLeaf, computeWitness } from './witness'
import { pushWithdrawal, updateWithdrawal } from '../storage'
import { fetchAttestationsForWithdrawal, assertNonEmptyWithdrawalAttestation } from '../attestation'
import type { L2CleanHandsStruct, L2PassportStruct } from '../types'

// ─── L1 Withdraw Execution ──────────────────────────────────────────

/**
 * Encode and send the withdraw transaction on L1 TokenPortal, wait for confirmation.
 */
export async function executeL1Withdraw(params: {
  publicClient: any
  sendTransaction: (tx: { from?: string; to: string; data: string }) => Promise<string>
  l1Address: string
  amount: bigint
  epoch: bigint
  leafIndex: string
  siblingPath: string[]
  portalAddress: string
  chainId: number
  /** L2 block number — used by the outbox idempotency check */
  l2BlockNumber: number
  /** Outbox address for idempotency check */
  outboxAddress?: string
}): Promise<L1WithdrawResult> {
  const { publicClient, sendTransaction, l1Address, amount, epoch, leafIndex, siblingPath, portalAddress, chainId, l2BlockNumber, outboxAddress } = params

  // Check if the L2→L1 message has already been consumed on L1.
  // Prevents wasting gas on a tx that would revert, and unblocks stuck operations.
  if (outboxAddress) {
    try {
      const isConsumed = await publicClient.readContract({
        address: outboxAddress as `0x${string}`,
        abi: [{
          type: 'function',
          name: 'hasMessageBeenConsumedAtBlockAndIndex',
          inputs: [
            { name: 'l2BlockNumber', type: 'uint256' },
            { name: 'leafIndex', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
          stateMutability: 'view',
        }],
        functionName: 'hasMessageBeenConsumedAtBlockAndIndex',
        args: [BigInt(l2BlockNumber), BigInt(leafIndex)],
      })
      if (isConsumed) {
        const l1TxUrl = `${getEtherscanBaseUrl(chainId)}/tx/already-consumed`
        return { l1TxHash: 'already-consumed', l1TxUrl }
      }
    } catch (e) {
      // Distinguish fatal (contract missing/ABI wrong/address invalid) from
      // transient (RPC timeout, rate-limit). Fatal means the check can NEVER
      // succeed, so proceeding sends a tx we can't reason about — abort with
      // a clear error instead. Transient errors fall through to the L1 tx
      // (which has its own already-consumed catch in withdrawL2ToL1).
      const errMsg = e instanceof Error ? e.message : String(e)
      if (isFatalContractReadError(errMsg)) {
        throw new Error(
          `Outbox consumption pre-check failed fatally at ${outboxAddress}: ${errMsg}. ` +
          `This suggests a misconfigured outbox address or ABI mismatch — aborting before the L1 tx.`,
        )
      }
      console.warn('[SDK L2→L1] Outbox consumption check failed (transient), proceeding:', errMsg)
    }
  }

  const siblingPathHex = siblingPath.map((s) => s as `0x${string}`)

  const withdrawCallData = encodeFunctionData({
    abi: CustomTokenPortalAbi,
    functionName: 'withdraw',
    args: [
      l1Address as `0x${string}`,
      amount,
      false, // _withCaller
      epoch,
      BigInt(leafIndex),
      siblingPathHex,
    ],
  })

  const l1WithdrawTxHash = await sendTransaction({
    from: l1Address,
    to: portalAddress,
    data: withdrawCallData,
  })

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: l1WithdrawTxHash as `0x${string}`,
    timeout: 300_000, // 5 minutes — matches the L1 deposit receipt timeout
  })

  if (receipt.status !== 'success') {
    throw new Error(
      `L1 withdraw transaction reverted (hash: ${receipt.transactionHash}). ` +
      `Your funds are safe — you can retry this withdrawal from the Activity page.`
    )
  }

  const l1TxHash = receipt.transactionHash.toString()
  // Use dynamic etherscan URL instead of hardcoded Sepolia
  const l1TxUrl = `${getEtherscanBaseUrl(chainId)}/tx/${l1TxHash}`
  const l1BlockNumber = receipt.blockNumber != null ? String(receipt.blockNumber) : undefined

  return { l1TxHash, l1TxUrl, l1BlockNumber }
}

// ─── Main L2→L1 Withdrawal Orchestrator ─────────────────────────────

/**
 * Execute a full L2→L1 withdrawal operation.
 *
 * Frontend UI steps:
 *   1: Validate + encrypt nonce + burn+exit on L2
 *   2: Persist receipt + compute witness
 *   3: Wait for block proven on L1
 *   4: Execute L1 withdraw
 *   5: Done
 */
export async function withdrawL2ToL1(
  config: ResolvedConfig,
  apiClient: BridgeApiClient,
  aztecNode: any,
  domain: string,
  params: WithdrawL2ToL1Params,
): Promise<BridgeResult> {
  const {
    token: tokenOrSymbol,
    amount: amountStr,
    l1Address,
    l2Address,
    isPrivate,
    sendTransaction,
    walletAdapter,
    signMessage,
    onStep,
    onEvent,
  } = params

  const emit: BridgeEventCallback = onEvent ?? (() => {})

  // Resolve token (accept both L1 symbol "USDC" and L2 symbol "cUSDC")
  const tokenConfig = config.tokens.find(
    (t) =>
      t.symbol.toLowerCase() === tokenOrSymbol.toLowerCase() ||
      `c${t.symbol}`.toLowerCase() === tokenOrSymbol.toLowerCase() ||
      t.l2TokenContract.toLowerCase() === tokenOrSymbol.toLowerCase(),
  )
  if (!tokenConfig) {
    throw new Error(`Unknown token: ${tokenOrSymbol}`)
  }

  // Use parseUnits instead of parseFloat to avoid floating-point precision loss
  const amount = parseUnits(amountStr, tokenConfig.decimals)
  if (amount === 0n) {
    throw new Error('Amount must be greater than zero')
  }
  const publicClient = createL1PublicClient(config)

  // 🔒 Track whether L2 burn+exit has been confirmed (funds are burned on L2).
  // If true, the outer catch must NEVER mark the operation as 'failed' — it stays
  // 'submitted' so the user can Resume from the activity page.
  let burnConfirmed = false
  let operationId: number | undefined

  try {
    // ── Step 1: Validate + encrypt nonce + burn+exit ──
    onStep?.(1, 'active')

    if (!l1Address || !l2Address) throw new Error('Required accounts not connected')
    if (!walletAdapter) throw new Error('Aztec wallet not connected')

    let l1BlockNumberBeforeTx: string
    try {
      l1BlockNumberBeforeTx = (await publicClient.getBlockNumber()).toString()
    } catch (err) {
      throw new Error('Could not get L1 block number. Please check your connection and try again.')
    }

    let l2BlockNumberBeforeTx: number
    try {
      l2BlockNumberBeforeTx = await aztecNode.getBlockNumber()
    } catch (err) {
      throw new Error('Could not get L2 block number. Please check your connection and try again.')
    }
    if (l2BlockNumberBeforeTx == null) {
      throw new Error('L2 block number is required before transaction (recovery)')
    }

    let nodeInfoForTx: any
    try {
      nodeInfoForTx = await aztecNode.getNodeInfo()
    } catch (err) {
      throw new Error('Could not get Aztec node info. Please check your connection and try again.')
    }
    const nodeInfoSnapshot = serializeNodeInfo(nodeInfoForTx)
    if (nodeInfoSnapshot?.rollupVersion == null) {
      throw new Error('Rollup version is required before transaction (recovery)')
    }

    // Encrypt nonce and backup
    const nonce = Fr.random()
    const l2BridgeAddress = tokenConfig.l2BridgeContract

    const signingMsg = createSigningMessage(l1Address, domain)
    const keyDerivationDomain = domain
    const sig = await signMessage(signingMsg)
    if (!sig) throw new Error('Failed to sign message for encryption key derivation')
    const encryptionKey = await deriveEncryptionKey(l1Address, sig, keyDerivationDomain)

    // Include portalAddressL1 so that if only the encrypted blob survives
    // (e.g. DB row lost, blob exported for local recovery) the resumer can
    // still identify which L1 TokenPortal to address the withdraw at.
    const secretsPayload = JSON.stringify({
      nonce: nonce.toString(),
      amount: amount.toString(),
      l1Address,
      l2Address,
      l2BridgeAddress,
      portalAddressL1: tokenConfig.l1PortalContract,
      isPrivacyModeEnabled: isPrivate,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx: String(l2BlockNumberBeforeTx),
    })
    const encrypted = await encryptData(secretsPayload, encryptionKey)

    // Never emit plaintext nonce — only encrypted payload
    emit({
      type: 'nonce_generated',
      l2BridgeAddress,
      encryptedPayload: encrypted,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx: String(l2BlockNumberBeforeTx),
      nodeInfo: nodeInfoSnapshot ?? {},
    })

    const snapshotRollupVersion = nodeInfoSnapshot?.rollupVersion as number | undefined
    const snapshotL1ChainId = nodeInfoSnapshot?.l1ChainId as number | undefined
    const snapshotL1Addresses = nodeInfoSnapshot?.l1ContractAddresses as Record<string, string> | undefined

    // Use token name fields correctly (pairedSymbol/title)
    const tokenSymbolL1 = tokenConfig.pairedSymbol ?? tokenConfig.symbol
    const tokenSymbolL2 = `c${tokenConfig.symbol}`
    const tokenNameL1 = tokenConfig.pairedSymbol ?? tokenConfig.symbol
    const tokenNameL2 = tokenConfig.title ?? `Clean ${tokenConfig.symbol}`

    const operationData = {
      encryptedCiphertext: encrypted.ciphertext,
      encryptedIv: encrypted.iv,
      encryptedTag: encrypted.tag,
      keyDerivationMessage: signingMsg,
      keyDerivationDomain,
      direction: 'L2_TO_L1',
      l1Address,
      l2Address,
      amountL1: amount.toString(),
      amountL2: amount.toString(),
      amountDisplayL1: amountStr,
      amountDisplayL2: amountStr,
      isPrivacyModeEnabled: isPrivate,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx: String(l2BlockNumberBeforeTx),
      recipientL1Address: l1Address,
      nodeInfo: nodeInfoSnapshot,
      rollupVersion: snapshotRollupVersion,
      chainIdL1: snapshotL1ChainId ?? config.l1ChainId,
      chainIdL2: config.l2ChainId,
      portalAddressL1: tokenConfig.l1PortalContract,
      bridgeAddressL2: l2BridgeAddress,
      l1RollupAddress: snapshotL1Addresses?.rollupAddress,
      l1OutboxAddress: snapshotL1Addresses?.outboxAddress,
      l1InboxAddress: snapshotL1Addresses?.inboxAddress,
      l1RegistryAddress: snapshotL1Addresses?.registryAddress,
      tokenSymbol: tokenSymbolL1,
      tokenSymbolL1,
      tokenSymbolL2,
      tokenNameL1,
      tokenNameL2,
      tokenAddressL1: tokenConfig.l1TokenContract,
      tokenAddressL2: tokenConfig.l2TokenContract,
      tokenDecimalsL1: tokenConfig.decimals,
      tokenDecimalsL2: tokenConfig.decimals,
      currentStep: 1,
    }

    // Create operation BEFORE localStorage push so we have operationId.
    // If the server backup fails, abort BEFORE any L2 burn to prevent fund loss.
    try {
      const createResult = await createOperation(apiClient, operationData)
      operationId = createResult.operationId
    } catch (backupErr) {
      const detail = backupErr instanceof Error ? backupErr.message : String(backupErr)
      throw new Error(
        `Failed to backup withdrawal data to server. Withdrawal aborted to prevent fund loss. (${detail})`,
      )
    }

    emit({ type: 'operation_created', operationId, data: operationData })

    // localStorage push with ALL fields matching frontend
    pushWithdrawal({
      id: operationId,
      operationId,
      l2BridgeAddress,
      timestamp: Date.now(),
      amount: amount.toString(),
      amountDisplay: amountStr,
      l1Address,
      l2Address,
      tokenSymbol: tokenConfig.symbol,
      portalAddressL1: tokenConfig.l1PortalContract,
      encryptedCiphertext: encrypted.ciphertext,
      encryptedIv: encrypted.iv,
      encryptedTag: encrypted.tag,
      keyDerivationDomain,
      keyDerivationMessage: signingMsg,
      isPrivacyModeEnabled: isPrivate,
      success: false,
      status: 'pending',
      l2TxHash: null as string | null,
      l2BlockNumber: null as string | null,
      l2BlockNumberBeforeTx: l2BlockNumberBeforeTx != null ? String(l2BlockNumberBeforeTx) : null as string | null,
      nodeInfo: nodeInfoSnapshot,
      l2TxUrl: null as string | null,
      l2ToL1MessageIndex: null as string | null,
      siblingPath: null as string[] | null,
    })

    // Fetch attestation for both public and private withdrawals — the deployed
    // L2 bridge gates `authorize_exit_to_l1_public` on POCH/Passport, same as
    // exit_to_l1_private. Without an attestation, the L2 call reverts before
    // the burn even fires.
    const attestResult = await fetchAttestationsForWithdrawal(
      apiClient, tokenConfig.l1PortalContract, l2BridgeAddress, amount, tokenConfig.decimals, emit
    )
    // Defense-in-depth: refuse to burn if the cascade somehow produced
    // both-empty structs (L2 bridge would revert otherwise — after burn is
    // already irreversible).
    assertNonEmptyWithdrawalAttestation(attestResult)
    const l2CleanHands: L2CleanHandsStruct = attestResult.cleanHands
    const l2Passport: L2PassportStruct = attestResult.passport
    // Passport deadline buffer — L2 bridge rejects once `block.timestamp >=
    // deadline`. 10-min buffer covers burn mining before the L2 phase that
    // consumes the nonce. Fail fast before the L2 burn becomes irreversible.
    if (l2Passport) {
      assertPassportDeadlineBuffer(l2Passport.deadline, 600n, 'the withdrawal')
    }

    // Execute burn+exit on L2 (DANGER ZONE)
    // Set burnConfirmed=true AFTER the wallet call succeeds, not before.
    // If the call throws with a txHash available (network error reading receipt),
    // we check for the txHash before re-throwing.
    const userAddress = AztecAddress.fromString(l2Address)
    let burnResult: { txHash: string; blockNumber?: number }
    try {
      burnResult = isPrivate
        ? await walletAdapter.executeWithdrawToL1Private(l1Address, amount, nonce, l2CleanHands, l2Passport, userAddress.toString())
        : await walletAdapter.executeWithdrawToL1Public(l1Address, amount, nonce, l2CleanHands, l2Passport, userAddress.toString())
      // 🔒 Only set burnConfirmed after the wallet call returns successfully
      burnConfirmed = true
    } catch (burnErr) {
      // Check if the error object contains a txHash — this means the tx was
      // submitted on-chain but the adapter threw while reading the receipt.
      const errTxHash = (burnErr as any)?.txHash ?? (burnErr as any)?.transactionHash
      if (errTxHash) {
        // Tx was submitted — treat as confirmed to prevent marking 'failed'
        burnConfirmed = true
        burnResult = { txHash: errTxHash }
      } else {
        // No txHash — check if this is a user rejection (safe to retry)
        const msg = burnErr instanceof Error ? burnErr.message : String(burnErr)
        const code = (burnErr as any)?.code
        const isUserRejection =
          code === 4001 ||
          msg.includes('user rejected') ||
          msg.includes('User denied') ||
          msg.includes('ACTION_REJECTED') ||
          msg.includes('Request rejected') ||
          msg.includes('Rejected by user') ||
          /\bcancelled\b/i.test(msg)
        // burnConfirmed stays false — operation can be marked 'failed' and retried
        if (!isUserRejection) {
          // Non-user-rejection, non-txHash error: burn was never submitted
          burnConfirmed = false
        }
        throw burnErr
      }
    }

    const l2TxHash = burnResult.txHash
    let l2BlockNumber: number | undefined = burnResult.blockNumber

    // CRITICAL: Persist l2TxHash to BOTH localStorage AND server IMMEDIATELY after burn.
    // Fire the server PATCH in parallel with localStorage — don't wait for one to finish
    // before starting the other. This minimizes the window where a crash could lose the tx hash.
    const l2TxUrl = `${getAztecscanBaseUrl(config.l2ChainId)}/tx-effects/${l2TxHash}`
    updateWithdrawal(
      (w: any) => w.id === operationId,
      (w: any) => ({ ...w, l2TxHash, l2TxUrl, status: 'submitted' }),
      // Fallback entry if original pushWithdrawal was lost (e.g. localStorage cleared)
      {
        id: operationId,
        operationId,
        l2TxHash,
        l2TxUrl,
        l1Address,
        l2Address,
        l2BridgeAddress,
        isPrivacyModeEnabled: isPrivate,
        timestamp: Date.now(),
        status: 'submitted',
      },
    )
    // Fire server PATCH immediately (non-blocking) so l2TxHash reaches the DB ASAP
    const l2TxPatchPromise = patchOperationWithRetry(apiClient, operationId, {
      status: 'submitted',
      l2TxHash,
      l2TxUrl,
      currentStep: 2,
    }, { label: 'l2TxHash' })

    emit({ type: 'burn_sent', l2TxHash })

    onStep?.(1, 'completed')

    // ── Step 2: Persist receipt + compute witness ──
    onStep?.(2, 'active')

    // Await the PATCH we fired above
    const l2TxPatchOk = await l2TxPatchPromise
    if (!l2TxPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'l2TxHash', data: { l2TxHash, l2TxUrl } })
    }

    emit({ type: 'burn_confirmed', l2TxHash, l2TxUrl, l2BlockNumber: l2BlockNumber ?? undefined })

    // Poll for block number if not returned
    if (l2BlockNumber == null) {
      for (let i = 0; i < 60; i++) {
        await wait(2000)
        try {
          const receipt = await aztecNode.getTxReceipt(l2TxHash as any)
          if (receipt?.blockNumber != null) {
            l2BlockNumber = receipt.blockNumber
            emit({ type: 'recovery_l2_block', l2TxHash, l2BlockNumber: l2BlockNumber! })
            break
          }
        } catch {
          // retry
        }
      }
    }

    if (l2BlockNumber == null || l2BlockNumber === 0) {
      throw new Error('L2 block number is required for the withdrawal proof')
    }

    const blockPatchOk = await patchOperationWithRetry(apiClient, operationId, {
      l2BlockNumber: String(l2BlockNumber),
    }, { label: 'l2BlockNumber' })
    if (!blockPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'l2BlockNumber', data: { l2BlockNumber: String(l2BlockNumber) } })
    }

    // Update localStorage with l2BlockNumber and status:'submitted'
    updateWithdrawal(
      (w: any) => w.id === operationId,
      (w: any) => ({
        ...w,
        l2BlockNumber: l2BlockNumber?.toString() ?? null,
        status: 'submitted',
      }),
    )

    // 120s wait after block number polling (lets L2 block propagate to wallet's node)
    await wait(120_000)

    // Compute witness — use the snapshotted rollupVersion from when the burn happened,
    // not a fresh one. If the rollup was upgraded between burn and witness, a fresh
    // version would produce a wrong leaf hash and the witness would never be found.
    const freshNodeInfo = await aztecNode.getNodeInfo()
    const rollupVersion = (nodeInfoSnapshot?.rollupVersion as number | undefined)
      ?? (freshNodeInfo?.rollupVersion != null ? Number(freshNodeInfo.rollupVersion) : undefined)
    if (rollupVersion == null) throw new Error('Rollup version not available')

    const freshL1Addresses = freshNodeInfo?.l1ContractAddresses ?? null

    // Validate outboxAddress before witness computation
    const outboxAddress = freshL1Addresses?.outboxAddress?.toString()
    if (!outboxAddress) {
      throw new Error('L1 outbox address not available from node. Cannot compute L2→L1 witness.')
    }

    const rollupAddress = freshL1Addresses?.rollupAddress?.toString()
      ?? config.l1ContractAddresses.rollupAddress

    if (!rollupAddress) throw new Error('Rollup address not available')

    const msgLeaf = computeL2ToL1MessageLeaf({
      l1Recipient: l1Address,
      amount,
      l2BridgeAddress,
      portalAddress: tokenConfig.l1PortalContract,
      rollupVersion,
      chainId: config.l1ChainId,
    })

    let witnessResult
    try {
      witnessResult = await computeWitness(
        aztecNode,
        l2BlockNumber,
        msgLeaf,
        l2TxHash,
      )
    } catch (err) {
      // User-friendly error for BlockNotProven
      const errMsg = err instanceof Error ? err.message : String(err)
      if (/BlockNotProven|NothingToConsumeAtBlock/i.test(errMsg)) {
        throw new Error(
          `The L2 block (${l2BlockNumber}) has not been proven on L1 yet. ` +
          'This is expected — it can take 30–50 minutes. ' +
          'You can resume this withdrawal from the Activity page once the block is proven.'
        )
      }
      throw err
    }

    // If epoch is null, derive it from the rollup contract so the DB always has it.
    // Deployed Rollup exposes `getEpochForCheckpoint(uint256)` (per @aztec/l1-artifacts
    // RollupAbi on 4.2.0-aztecnr-rc.2), NOT `getEpochForBlock` — the latter exists in
    // the in-repo Rollup.sol but not on the deployed contract, so calling it fails.
    let resolvedEpoch = witnessResult.epoch
    if (resolvedEpoch == null || resolvedEpoch === 0n) {
      try {
        const epochFromRollup = await publicClient.readContract({
          address: rollupAddress as `0x${string}`,
          abi: [{
            type: 'function' as const,
            name: 'getEpochForCheckpoint',
            inputs: [{ name: '_blockNumber', type: 'uint256' }],
            outputs: [{ name: '', type: 'uint256' }],
            stateMutability: 'view' as const,
          }],
          functionName: 'getEpochForCheckpoint',
          args: [BigInt(l2BlockNumber)],
        })
        resolvedEpoch = epochFromRollup as bigint
      } catch {
        console.warn('[SDK L2→L1] Could not derive epoch from rollup contract — resume will retry')
      }
    }

    const witnessPatchData = {
      status: 'ready',
      l2ToL1MessageIndex: witnessResult.leafIndex,
      siblingPath: witnessResult.siblingPath,
      epoch: resolvedEpoch != null ? Number(resolvedEpoch) : undefined,
      currentStep: 3,
    }
    const witnessPatchOk = await patchOperationWithRetry(apiClient, operationId, witnessPatchData, { label: 'witness data' })
    if (!witnessPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'witness data', data: { l2ToL1MessageIndex: witnessResult.leafIndex } })
    }

    // Update localStorage with witness data
    updateWithdrawal(
      (w: any) => w.id === operationId,
      (w: any) => ({
        ...w,
        l2ToL1MessageIndex: witnessResult.leafIndex,
        siblingPath: witnessResult.siblingPath,
        status: 'ready',
      }),
    )

    emit({
      type: 'witness_computed',
      leafIndex: witnessResult.leafIndex,
      siblingPath: witnessResult.siblingPath,
      epoch: Number(resolvedEpoch ?? witnessResult.epoch),
    })

    onStep?.(2, 'completed')

    // ── Step 3: Wait for block proven ──
    onStep?.(3, 'active')

    // Check return value — don't proceed to L1 withdraw if block isn't proven
    const provenResult = await waitForBlockProven({
      aztecNode,
      blockNumberForProof: l2BlockNumber,
      onPoll: (provenBlock, neededBlock, elapsedMs) => {
        emit({ type: 'proven_poll', provenBlock, neededBlock, elapsedMs })
      },
      onFallback: (fixedWaitMs) => {
        emit({ type: 'proven_fallback', fixedWaitMs })
      },
    })

    // If polling was used and the block is not proven, hard-fail — we know it's not ready.
    // If polling was NOT available (no rollupAddress), proceed anyway after the fallback
    // wait — the L1 withdraw will revert if the block isn't actually proven, and the
    // user can retry from the Activity page. This matches the pre-SDK behavior.
    if (!provenResult.proven && provenResult.usedPoll) {
      throw new Error(
        `L2 block ${l2BlockNumber} was not proven on L1 after waiting. ` +
        'You can resume this withdrawal later from the Activity page.'
      )
    }
    if (!provenResult.proven) {
      console.warn('[SDK L2→L1] Block proven status unknown (polling unavailable). Proceeding — L1 withdraw may revert.')
    }

    // Final wait before sending L1 withdraw tx (keep step 3 active during wait)
    await wait(30_000)

    onStep?.(3, 'completed')

    // ── Step 4: Execute L1 withdraw ──
    onStep?.(4, 'active')
    patchOperationAsync(apiClient, operationId, { currentStep: 4 })

    // L1 TokenPortal.withdraw encodes `epoch` into the outbox proof; zero/null
    // produces a proof that never matches a real message. Fail fast so the
    // user knows to resume (witness data is already persisted).
    const finalEpoch = assertValidEpoch(resolvedEpoch ?? witnessResult.epoch, l2BlockNumber)

    // If the outbox pre-check missed (RPC blip, race with another device) and
    // the L1 tx reverts with an "already consumed" error, that means the
    // withdrawal actually settled — the burn side always succeeds once a
    // consumption exists. Treat the revert as success instead of surfacing
    // a 'failed'-ish error that leaves the operation stuck in 'ready'.
    // Resume already has this handling (resume.ts); mirror it here so the
    // happy-path doesn't depend on a follow-up resume to converge.
    let withdrawResult: L1WithdrawResult
    try {
      withdrawResult = await executeL1Withdraw({
        publicClient,
        sendTransaction,
        l1Address,
        amount,
        epoch: finalEpoch,
        leafIndex: witnessResult.leafIndex,
        siblingPath: witnessResult.siblingPath,
        portalAddress: tokenConfig.l1PortalContract,
        chainId: config.l1ChainId,
        l2BlockNumber,
        outboxAddress: outboxAddress ?? config.l1ContractAddresses.outboxAddress,
      })
    } catch (withdrawErr) {
      const errMsg = withdrawErr instanceof Error ? withdrawErr.message : String(withdrawErr)
      if (isAlreadyConsumedError(errMsg)) {
        console.log('[SDK L2→L1] L1 withdraw already consumed — treating as previously completed.')
        withdrawResult = {
          l1TxHash: 'already-consumed',
          l1TxUrl: `${getEtherscanBaseUrl(config.l1ChainId)}/tx/already-consumed`,
        }
      } else {
        throw withdrawErr
      }
    }

    if (withdrawResult.l1TxHash !== 'already-consumed') {
      emit({ type: 'l1_withdraw_sent', l1TxHash: withdrawResult.l1TxHash, l1TxUrl: withdrawResult.l1TxUrl })
    }

    // Mark as completed on server (retry — critical for DB consistency)
    const completionPatchData: Record<string, unknown> = {
      status: 'completed',
      l1TxHash: withdrawResult.l1TxHash,
      l1TxUrl: withdrawResult.l1TxUrl,
      completedAt: new Date().toISOString(),
      currentStep: 5,
    }
    if (withdrawResult.l1BlockNumber) completionPatchData.l1BlockNumber = withdrawResult.l1BlockNumber
    const completionPatchOk = await patchOperationWithRetry(apiClient, operationId, completionPatchData, { label: 'L2→L1 completion' })
    if (!completionPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'L2→L1 completion', data: { l1TxHash: withdrawResult.l1TxHash, status: 'completed' } })
    }

    onStep?.(4, 'completed')

    // ── Step 5: Done ──
    onStep?.(5, 'active')

    emit({ type: 'operation_completed', operationId, l1TxHash: withdrawResult.l1TxHash, l2TxHash })

    // Mark localStorage entry as completed with URL fields
    updateWithdrawal(
      (w: any) => w.id === operationId,
      (w: any) => ({
        ...w,
        success: true,
        status: 'completed',
        l1TxHash: withdrawResult.l1TxHash,
        l1TxUrl: withdrawResult.l1TxUrl,
        l2TxUrl,
        completedAt: Date.now(),
      }),
    )

    await wait(3000)
    onStep?.(5, 'completed')

    return {
      operationId,
      l1TxHash: withdrawResult.l1TxHash,
      l2TxHash,
      l1TxUrl: withdrawResult.l1TxUrl,
      l2TxUrl,
    }
  } catch (error) {
    // 🔒 CRITICAL: Only mark as 'failed' if burn has NOT happened.
    // If burn confirmed, status stays 'submitted'/'ready' so user can Resume.
    const err = error instanceof Error ? error : new Error(extractErrorString(error))
    const errorMessage = err.message

    emit({ type: 'error', error: err, fundsAtRisk: burnConfirmed, operationId })

    if (operationId) {
      const patchData: Record<string, unknown> = {
        lastErrorMessage: errorMessage.slice(0, 500),
      }
      if (!burnConfirmed) {
        patchData.status = 'failed'
      }
      // Await retry so 'failed' status persists to DB before the throw
      await patchOperationWithRetry(apiClient, operationId, patchData, { label: 'error status' })
    }

    throw error
  }
}

