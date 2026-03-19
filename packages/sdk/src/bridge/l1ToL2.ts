/**
 * L1→L2 bridge orchestrator.
 *
 * Extracts all deposit logic from the frontend hooks into a pure,
 * framework-agnostic module. All React/browser dependencies are
 * replaced with injected callbacks and config objects.
 *
 * Frontend step mapping (5-step UI):
 *   Step 1: Validate + generate secret + approve + send L1 deposit + extract receipt
 *   Step 2: Poll for L1→L2 message sync
 *   Step 3: Execute L2 claim
 *   Step 4: Complete (success animation)
 *   Step 5: Done
 */

import { Fr } from '@aztec/aztec.js/fields'
import { computeSecretHash } from '@aztec/aztec.js/crypto'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TestERC20Abi } from '@aztec/l1-artifacts'
import { extractEvent } from '@aztec/ethereum/utils'
import { encodeFunctionData, decodeEventLog, parseUnits } from 'viem'
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
import { BridgeAndFuelAbi } from '../contracts/abis/BridgeAndFuelAbi'
import type {
  ResolvedConfig,
  BridgeL1ToL2Params,
  BridgeResult,
  L2ClaimDeps,
  L2ClaimResult,
  BridgeEventCallback,
  FuelQuote,
} from '../types'
import { createL1PublicClient, serializeNodeInfo, wait, extractErrorString } from './utils'
import { getEtherscanUrl as getEtherscanBaseUrl, getAztecscanUrl as getAztecscanBaseUrl } from '../config'
import { pollL1ToL2MessageSync } from './polling'
import { pushDeposit, updateDeposit } from '../storage'
import { fetchAttestationsForDeposit } from '../attestation'

// ─── L2 Claim Execution ─────────────────────────────────────────────

/**
 * Execute claim_public or claim_private on L2.
 *
 * If messageLeafIndex is provided: retry up to maxAttempts on "nonexistent message".
 * If messageLeafIndex is null: brute-force indices 0..bruteForceMaxIndex.
 */
export async function executeL2Claim(
  deps: L2ClaimDeps,
  params: {
    amount: bigint
    claimSecret: Fr
    messageLeafIndex: bigint | null
  },
  options?: {
    maxAttempts?: number
    retryDelayMs?: number
    bruteForceMaxIndex?: number
    onAttempt?: (attempt: number, maxAttempts: number) => void
    onRetry?: (attempt: number, maxAttempts: number, retryDelayMs: number) => void
    feeOption?: { fee: { paymentMethod: any } }
  },
): Promise<L2ClaimResult> {
  const { walletAdapter, aztecAddress, isPrivacyModeEnabled } = deps
  const { amount, claimSecret, messageLeafIndex } = params
  const maxAttempts = options?.maxAttempts ?? 5
  const retryDelayMs = options?.retryDelayMs ?? 120_000
  const bruteForceMaxIndex = options?.bruteForceMaxIndex ?? 64

  const method = isPrivacyModeEnabled ? 'claim_private' : 'claim_public'

  if (messageLeafIndex != null) {
    let result: { txHash: string } | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        options?.onAttempt?.(attempt, maxAttempts)
        result = await walletAdapter.executeCall(
          walletAdapter.bridgeAddress,
          method,
          [
            AztecAddress.fromString(aztecAddress),
            amount,
            claimSecret,
            messageLeafIndex,
          ],
          { contractType: 'bridge', ...options?.feeOption },
        )
        break
      } catch (err) {
        // Retry on any error — the claim is idempotent and most failures are transient
        // (reorgs, block header not found, message not synced, PXE lag, network errors, etc.)
        if (attempt < maxAttempts) {
          options?.onRetry?.(attempt, maxAttempts, retryDelayMs)
          await wait(retryDelayMs)
          continue
        }
        throw err
      }
    }
    return { l2TxHash: result!.txHash, usedBruteForce: false }
  } else {
    // Brute-force path — only catch index-miss errors, re-throw everything else
    for (let idx = 0; idx < bruteForceMaxIndex; idx++) {
      try {
        const result = await walletAdapter.executeCall(
          walletAdapter.bridgeAddress,
          method,
          [
            AztecAddress.fromString(aztecAddress),
            amount,
            claimSecret,
            BigInt(idx),
          ],
          { contractType: 'bridge', ...options?.feeOption },
        )
        return {
          l2TxHash: result.txHash,
          usedBruteForce: true,
          bruteForceLeafIndex: idx,
        }
      } catch (bruteErr) {
        const msg = bruteErr instanceof Error ? bruteErr.message : String(bruteErr)
        // Only swallow "wrong index" errors — re-throw network/wallet/unexpected errors
        const isIndexMiss =
          msg.includes('nonexistent L1-to-L2 message') ||
          msg.includes('l1_to_l2_msg_exists') ||
          msg.includes('message not found') ||
          msg.includes('does not match')
        if (!isIndexMiss) {
          throw bruteErr
        }
        // Wrong index — try next
      }
    }
    throw new Error(
      `Could not find correct messageLeafIndex after trying 0–${bruteForceMaxIndex - 1}. ` +
        'The L1→L2 message may not be synced to L2 yet. Try again later.',
    )
  }
}

// ─── Main L1→L2 Bridge Orchestrator ─────────────────────────────────

/**
 * Execute a full L1→L2 bridge operation.
 *
 * Frontend UI steps:
 *   1: Validate + secret + approve + L1 deposit + receipt
 *   2: Poll for L1→L2 message sync
 *   3: Execute L2 claim
 *   4: Complete (success animation)
 *   5: Done
 */
export async function bridgeL1ToL2(
  config: ResolvedConfig,
  apiClient: BridgeApiClient,
  aztecNode: any,
  domain: string,
  params: BridgeL1ToL2Params,
): Promise<BridgeResult> {
  const {
    token: tokenOrSymbol,
    amount: amountStr,
    l1Address,
    l2Address,
    isPrivate,
    fuel,
    fuelQuote,
    sendTransaction,
    walletAdapter,
    signMessage,
    onStep,
    onEvent,
  } = params

  const emit: BridgeEventCallback = onEvent ?? (() => {})

  // Resolve token
  const tokenConfig = config.tokens.find(
    (t) =>
      t.symbol.toLowerCase() === tokenOrSymbol.toLowerCase() ||
      `c${t.symbol}`.toLowerCase() === tokenOrSymbol.toLowerCase() ||
      t.l1TokenContract.toLowerCase() === tokenOrSymbol.toLowerCase(),
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

  // 🔒 Track whether L1 deposit has been confirmed (funds are locked on L1).
  // If true, the outer catch must NEVER mark the operation as 'failed' — it stays
  // 'deposited' so the user can Resume the L2 claim from the activity page.
  let depositConfirmed = false
  // Track whether the L1 tx was sent (l1TxHash known). Between tx submission and
  // receipt confirmation, funds MAY be at risk (tx could be mining).
  let l1TxSent = false
  let operationId: number | undefined

  try {
    // ── Step 1: Validate + generate secret + approve + deposit + receipt ──
    onStep?.(1, 'active')

    if (!l1Address || !l2Address) throw new Error('Required accounts not connected')
    if (!walletAdapter) throw new Error('Aztec wallet not connected')

    // Validate l2Address is a valid 0x-prefixed 32-byte hex string
    if (!/^0x[0-9a-fA-F]{64}$/.test(l2Address)) {
      throw new Error(`Invalid L2 address format: expected 0x + 64 hex chars, got ${l2Address.slice(0, 20)}...`)
    }

    let nodeInfo: any
    try {
      nodeInfo = await aztecNode.getNodeInfo()
    } catch (err) {
      throw new Error('Could not get Aztec node info. Please check your connection and try again.')
    }
    const l1Addresses = nodeInfo?.l1ContractAddresses ?? null
    if (!l1Addresses?.outboxAddress?.toString()) {
      throw new Error('L1 contract addresses not initialized')
    }

    let l1BlockNumberBeforeTx: string
    try {
      l1BlockNumberBeforeTx = (await publicClient.getBlockNumber()).toString()
    } catch (err) {
      throw new Error('Could not get L1 block number. Please check your connection and try again.')
    }

    let l2BlockNumberBeforeTx: string
    try {
      l2BlockNumberBeforeTx = (await aztecNode.getBlockNumber()).toString()
    } catch (err) {
      throw new Error('Could not get L2 block number. Please check your connection and try again.')
    }

    // Generate claim secret
    const claimSecret = Fr.random()
    const claimSecretHash = await computeSecretHash(claimSecret)
    const nodeInfoSnapshot = serializeNodeInfo(nodeInfo)

    // Deterministic encryption
    const keyDerivationDomain = domain
    const signingMessage = createSigningMessage(l1Address, keyDerivationDomain)
    const signature = await signMessage(signingMessage)
    if (!signature) throw new Error('Failed to sign message for encryption key derivation')
    const encryptionKey = await deriveEncryptionKey(l1Address, signature, keyDerivationDomain)

    // Generate fuel secrets if applicable
    let fuelSecret: Fr | undefined
    let fuelSecretHash: Fr | undefined
    if (fuel?.enabled) {
      fuelSecret = Fr.random()
      fuelSecretHash = await computeSecretHash(fuelSecret)
    }

    const payloadToEncrypt: Record<string, unknown> = {
      claimSecret: claimSecret.toString(),
      claimSecretHash: claimSecretHash.toString(),
      amount: amount.toString(),
      l1Address,
      l2Address,
      isPrivacyModeEnabled: isPrivate,
      l1BlockNumberBeforeTx,
      nodeInfo: nodeInfoSnapshot,
    }
    if (fuelSecret && fuelSecretHash) {
      payloadToEncrypt.fuelSecret = fuelSecret.toString()
      payloadToEncrypt.fuelSecretHash = fuelSecretHash.toString()
      // Store fuel amount so resume can compute claimAmount = amount - fuelAmountTokenUnits
      payloadToEncrypt.fuelAmount = fuel?.amount ?? '0'
      if (tokenConfig.decimals != null) payloadToEncrypt.fuelDecimals = tokenConfig.decimals
    }

    const encrypted = await encryptData(JSON.stringify(payloadToEncrypt), encryptionKey)

    // Only emit hashes and encrypted payload — never plaintext secrets.
    // Any consumer that logs events (Datadog, Sentry) would expose secrets otherwise.
    emit({
      type: 'secrets_generated',
      claimSecretHash: claimSecretHash.toString(),
      fuelSecretHash: fuelSecretHash?.toString(),
      encryptedPayload: encrypted,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx,
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
      keyDerivationMessage: signingMessage,
      keyDerivationDomain,
      direction: 'L1_TO_L2',
      l1Address,
      l2Address,
      amountL1: amount.toString(),
      amountL2: amount.toString(),
      amountDisplayL1: amountStr,
      amountDisplayL2: amountStr,
      isPrivacyModeEnabled: isPrivate,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx,
      nodeInfo: nodeInfoSnapshot,
      rollupVersion: snapshotRollupVersion,
      chainIdL1: snapshotL1ChainId ?? config.l1ChainId,
      chainIdL2: config.l2ChainId,
      portalAddressL1: tokenConfig.l1PortalContract,
      bridgeAddressL2: tokenConfig.l2BridgeContract,
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
      tokenLogoUrlL1: tokenConfig.logo || undefined,
      tokenLogoUrlL2: tokenConfig.logo || undefined,
      currentStep: 1,
    }

    // Create operation BEFORE localStorage push so we have operationId.
    // If the server backup fails, abort BEFORE any L1 transaction to prevent fund loss.
    try {
      const createResult = await createOperation(apiClient, operationData)
      operationId = createResult.operationId
    } catch (backupErr) {
      const detail = backupErr instanceof Error ? backupErr.message : String(backupErr)
      throw new Error(
        `Failed to backup claim secret to server. Bridge aborted to prevent fund loss. (${detail})`,
      )
    }

    emit({ type: 'operation_created', operationId, data: operationData })

    // localStorage push with ALL fields matching frontend (including id, timestamp, etc.)
    pushDeposit({
      id: operationId,
      operationId,
      encryptedCiphertext: encrypted.ciphertext,
      encryptedIv: encrypted.iv,
      encryptedTag: encrypted.tag,
      keyDerivationMessage: signingMessage,
      keyDerivationDomain,
      l1Address,
      l2Address,
      l1BlockNumberBeforeTx,
      isPrivacyModeEnabled: isPrivate,
      tokenSymbol: tokenConfig.symbol,
      hasFuel: fuel?.enabled ?? false,
      amount: amount.toString(),
      amountDisplay: amountStr,
      claimAmount: amount.toString(),
      claimSecretHash: claimSecretHash.toString(),
      messageHash: null as string | null,
      messageLeafIndex: null as string | null,
      timestamp: Date.now(),
      success: false,
      l1TxHash: null as string | null,
      l1TxUrl: null as string | null,
      nodeInfo: nodeInfoSnapshot,
      fuelAmount: fuel?.enabled ? fuel.amount : undefined,
      status: 'pending',
    })

    // Guard: private deposits with fuel are not supported.
    // BridgeAndFuel always calls depositToAztecPublic on the portal.
    if (isPrivate && fuel?.enabled) {
      throw new Error(
        'Private deposits with fuel are not currently supported. ' +
        'BridgeAndFuel uses depositToAztecPublic. Disable fuel or use public mode.',
      )
    }

    // Resolve fuel amount in token units (needed for approval + tx encoding)
    const isFuelEnabled = fuel?.enabled && fuelSecretHash && fuelQuote
    const fuelAmountTokenUnits = isFuelEnabled ? parseUnits(fuel!.amount, tokenConfig.decimals) : 0n

    if (fuel?.enabled && !fuelQuote) {
      throw new Error('fuel.enabled is true but fuelQuote was not provided. Use getMockFuelQuote() to generate one.')
    }

    // Check and approve allowance
    // When fuel is enabled, approve BridgeAndFuel (which pulls totalAmount).
    // Otherwise, approve TokenPortal directly.
    const spender = isFuelEnabled
      ? config.bridgeAndFuelAddress
      : tokenConfig.l1PortalContract

    const allowance = await publicClient.readContract({
      address: tokenConfig.l1TokenContract as `0x${string}`,
      abi: TestERC20Abi,
      functionName: 'allowance',
      args: [l1Address as `0x${string}`, spender as `0x${string}`],
    })

    // When fuel is enabled, BridgeAndFuel pulls totalAmount = amount + fuelAmountTokenUnits
    const totalApprovalNeeded = amount + fuelAmountTokenUnits

    if (BigInt(allowance as bigint) < totalApprovalNeeded) {
      const approveData = encodeFunctionData({
        abi: TestERC20Abi,
        functionName: 'approve',
        args: [spender as `0x${string}`, totalApprovalNeeded],
      })

      const approveTxHash = await sendTransaction({
        from: l1Address,
        to: tokenConfig.l1TokenContract,
        data: approveData,
      })

      await publicClient.waitForTransactionReceipt({ hash: approveTxHash as `0x${string}` })
    }

    // Send L1 deposit transaction
    let txHash: string

    if (isFuelEnabled) {
      // ── Fuel path: call BridgeAndFuel.bridgeWithFuel ──
      const bridgeData = encodeFunctionData({
        abi: BridgeAndFuelAbi,
        functionName: 'bridgeWithFuel',
        args: [
          {
            tokenPortal: tokenConfig.l1PortalContract as `0x${string}`,
            bridgeToken: tokenConfig.l1TokenContract as `0x${string}`,
            totalAmount: amount + fuelAmountTokenUnits,
            fuelAmount: fuelAmountTokenUnits,
            aztecRecipient: l2Address as `0x${string}`,
            tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
            fuelSecretHash: fuelSecretHash!.toString() as `0x${string}`,
            feeJuicePortal: config.feeJuicePortalAddress as `0x${string}`,
            swapTarget: fuelQuote!.swapTarget as `0x${string}`,
            swapAllowanceTarget: fuelQuote!.swapAllowanceTarget as `0x${string}`,
            minFuelOutput: fuelQuote!.minOutput,
          },
          fuelQuote!.swapData as `0x${string}`,
        ],
      })

      txHash = await sendTransaction({
        from: l1Address,
        to: config.bridgeAndFuelAddress,
        data: bridgeData,
      })
    } else {
      // ── Standard path: call TokenPortal directly ──
      let bridgeData: `0x${string}`
      if (isPrivate) {
        // Our custom TokenPortal.depositToAztecPrivate requires 4 args:
        // (amount, secretHash, CleanHandsData, PassportData). The @aztec/l1-artifacts
        // ABI only has the 2-arg version, so we use a local ABI fragment.
        // Fetch attestation (POCH → Passport fallback) for private deposit
        const { cleanHands: attestCleanHands, passport: attestPassport } =
          await fetchAttestationsForDeposit(apiClient, tokenConfig.l1PortalContract, amount, tokenConfig.decimals, emit)
        const emptyCleanHands = {
          nonce: attestCleanHands.nonce,
          actionId: attestCleanHands.actionId,
          signature: attestCleanHands.signature as `0x${string}`,
        }
        const emptyPassport = {
          maxAmount: attestPassport.maxAmount,
          nonce: attestPassport.nonce,
          deadline: attestPassport.deadline,
          signature: attestPassport.signature as `0x${string}`,
        }
        bridgeData = encodeFunctionData({
          abi: CustomTokenPortalAbi,
          functionName: 'depositToAztecPrivate',
          args: [amount, claimSecretHash.toString() as `0x${string}`, emptyCleanHands, emptyPassport],
        })
      } else {
        bridgeData = encodeFunctionData({
          abi: CustomTokenPortalAbi,
          functionName: 'depositToAztecPublic',
          args: [l2Address as `0x${string}`, amount, claimSecretHash.toString() as `0x${string}`],
        })
      }

      txHash = await sendTransaction({
        from: l1Address,
        to: tokenConfig.l1PortalContract,
        data: bridgeData,
      })
    }

    const l1TxHash = typeof txHash === 'string' ? txHash : String(txHash)
    l1TxSent = true
    const l1TxUrl = `${getEtherscanBaseUrl(config.l1ChainId)}/tx/${l1TxHash}`

    emit({ type: 'deposit_sent', l1TxHash, l1TxUrl })

    // Persist l1TxHash to localStorage immediately (before backend patch).
    // Pass a fallback entry so that if the original pushDeposit entry was lost
    // (e.g., localStorage cleared between steps), a new entry is created for recovery.
    updateDeposit(
      (c: any) => c.id === operationId,
      (c: any) => ({ ...c, l1TxHash, l1TxUrl }),
      {
        id: operationId,
        operationId,
        l1TxHash,
        l1TxUrl,
        l1Address,
        l2Address,
        claimSecretHash: claimSecretHash.toString(),
        isPrivacyModeEnabled: isPrivate,
        tokenSymbol: tokenConfig.symbol,
        hasFuel: fuel?.enabled ?? false,
        timestamp: Date.now(),
        status: 'deposited',
      },
    )

    const l1TxPatchOk = await patchOperationWithRetry(apiClient, operationId, { l1TxHash, l1TxUrl }, { label: 'l1TxHash' })
    if (!l1TxPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'l1TxHash', data: { l1TxHash, l1TxUrl } })
    }

    // Wait for receipt — only AFTER receipt confirms do we know funds are locked.
    // Add 5-minute timeout matching the resume path.
    const txReceipt = await publicClient.waitForTransactionReceipt({
      hash: l1TxHash as `0x${string}`,
      timeout: 300_000, // 5 minutes
    })

    // 🔒 Check receipt status BEFORE setting depositConfirmed.
    // A reverted tx means funds were NOT locked — the catch block should mark as 'failed'.
    if (txReceipt.status === 'reverted') {
      throw new Error(
        `L1 deposit transaction reverted on-chain (hash: ${txReceipt.transactionHash}). ` +
        `No funds were locked. You can retry the deposit.`
      )
    }

    // 🔒 Only set depositConfirmed AFTER confirming the tx succeeded on-chain.
    depositConfirmed = true

    // Extract message hash + leaf index from receipt
    let messageHashStr: string
    let messageLeafIndexStr: string
    let fuelMessageHashStr: string | undefined
    let fuelMessageLeafIndexStr: string | undefined
    let fuelAmountReceived: bigint | undefined
    let amountAfterFee: bigint | undefined

    if (isFuelEnabled) {
      // ── Fuel path: extract BridgeWithFuel event from BridgeAndFuel contract ──
      let bridgeWithFuelLog: any = null
      for (const log of txReceipt.logs) {
        if (log.address.toLowerCase() !== config.bridgeAndFuelAddress.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: BridgeAndFuelAbi,
            data: log.data,
            topics: log.topics,
          })
          if (decoded.eventName === 'BridgeWithFuel') {
            bridgeWithFuelLog = decoded
            break
          }
        } catch {
          // Not our event, skip
        }
      }

      if (!bridgeWithFuelLog) {
        throw new Error('BridgeWithFuel event not found in transaction receipt')
      }

      const args = bridgeWithFuelLog.args as any
      messageHashStr = args.tokenKey.toString()
      messageLeafIndexStr = args.tokenIndex.toString()
      fuelMessageHashStr = args.fuelKey.toString()
      fuelMessageLeafIndexStr = args.fuelIndex.toString()
      fuelAmountReceived = args.fuelAmount as bigint

      // Also extract amountAfterFee from the portal's DepositToAztecPublic event.
      // BridgeAndFuel calls the portal internally, which emits this event with the post-fee amount.
      try {
        const portalLog = extractEvent(
          txReceipt.logs,
          tokenConfig.l1PortalContract as `0x${string}`,
          CustomTokenPortalAbi,
          'DepositToAztecPublic',
          (log: any) => log.args.secretHash?.toString() === claimSecretHash.toString(),
        )
        amountAfterFee = portalLog.args.amount as bigint
      } catch (e) {
        // Non-fatal — fall back to using `amount` for the claim.
        // Log because if the secretHash filter missed, the claim may use the wrong amount.
        console.warn('[SDK L1→L2] Could not extract amountAfterFee from portal event — using original amount for claim:', e)
      }
    } else {
      // ── Standard path: extract DepositToAztec event from TokenPortal ──
      // IMPORTANT: Use CustomTokenPortalAbi, NOT the upstream @aztec/l1-artifacts TokenPortalAbi.
      // Our deployed TokenPortal has a `fee` field in its events that changes the event signature
      // (different keccak256 hash). The standard ABI would never match these events.
      const eventName = isPrivate ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'

      // Coerce both sides to string for safe comparison — viem may decode
      // event args as bigint or 0x-hex while Fr.toString() may produce a different format.
      const privateEventFilter = (log: any) =>
        log.args.secretHash?.toString() === claimSecretHash.toString()

      const publicEventFilter = (log: any) =>
        log.args.secretHash?.toString() === claimSecretHash.toString() &&
        log.args.to?.toString() === l2Address

      const eventFilter = isPrivate ? privateEventFilter : publicEventFilter

      const log = extractEvent(
        txReceipt.logs,
        tokenConfig.l1PortalContract as `0x${string}`,
        CustomTokenPortalAbi,
        eventName,
        eventFilter,
      )

      messageHashStr = log.args.key.toString()
      messageLeafIndexStr = log.args.index.toString()

      // The custom portal deducts fees before creating the L2 message.
      // The `amount` in the event is the POST-FEE amount — use it for the L2 claim.
      amountAfterFee = log.args.amount as bigint
    }

    emit({
      type: 'deposit_confirmed',
      l1TxHash,
      l1TxUrl,
      messageHash: messageHashStr,
      messageLeafIndex: messageLeafIndexStr,
      fuelMessageHash: fuelMessageHashStr,
      fuelMessageLeafIndex: fuelMessageLeafIndexStr,
      fuelAmount: fuelAmountReceived?.toString(),
    })

    // Persist deposit receipt data to localStorage with status: 'deposited'
    updateDeposit(
      (c: any) => c.id === operationId,
      (c: any) => ({
        ...c,
        messageHash: messageHashStr,
        messageLeafIndex: messageLeafIndexStr,
        l1TxHash,
        l1TxUrl,
        status: 'deposited',
        ...(fuelMessageHashStr ? { fuelMessageHash: fuelMessageHashStr } : {}),
        ...(fuelMessageLeafIndexStr ? { fuelMessageLeafIndex: fuelMessageLeafIndexStr } : {}),
        ...(fuelAmountReceived != null ? { fuelAmount: fuelAmountReceived.toString() } : {}),
        ...(amountAfterFee != null ? { amountAfterFee: amountAfterFee.toString() } : {}),
      }),
    )

    // Persist receipt to backend
    // l1TxHash/l1TxUrl already sent in the earlier PATCH — don't re-send to avoid redundant overwrites.
    const receiptPatchData: Record<string, unknown> = {
      status: 'deposited',
      messageHash: messageHashStr,
      messageLeafIndex: messageLeafIndexStr,
      l1BlockNumber: txReceipt.blockNumber != null ? String(txReceipt.blockNumber) : undefined,
      currentStep: 2,
    }
    if (fuelMessageHashStr) receiptPatchData.fuelMessageHash = fuelMessageHashStr
    if (fuelMessageLeafIndexStr) receiptPatchData.fuelMessageLeafIndex = fuelMessageLeafIndexStr
    if (fuelAmountReceived != null) receiptPatchData.fuelAmount = fuelAmountReceived.toString()
    if (amountAfterFee != null) receiptPatchData.amountAfterFee = amountAfterFee.toString()

    const receiptPatchOk = await patchOperationWithRetry(apiClient, operationId, receiptPatchData, { label: 'receipt data' })
    if (!receiptPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'receipt data', data: { messageHash: messageHashStr, messageLeafIndex: messageLeafIndexStr } })
    }

    onStep?.(1, 'completed')

    // ── Step 2: Poll for L1→L2 message sync ──
    onStep?.(2, 'active')

    // Poll for both messages in parallel when fuel is enabled
    const syncPromises: Promise<any>[] = [
      pollL1ToL2MessageSync(aztecNode, messageHashStr),
    ]
    if (fuelMessageHashStr) {
      syncPromises.push(pollL1ToL2MessageSync(aztecNode, fuelMessageHashStr))
    }
    const syncResults = await Promise.all(syncPromises)
    const syncResult = syncResults[0]
    const fuelSyncResult = syncResults[1]

    emit({ type: 'sync_poll', elapsedMinutes: syncResult.elapsedMinutes, synced: syncResult.synced })

    if (!syncResult.synced) {
      throw new Error(
        `L1-to-L2 message sync timeout after ${syncResult.elapsedMinutes.toFixed(1)} minutes. You can try resuming later.`,
      )
    }

    // Check fuel message sync too — if fuel didn't sync, the claim will fail
    if (fuelSyncResult && !fuelSyncResult.synced) {
      throw new Error(
        `Fuel message sync timeout after ${fuelSyncResult.elapsedMinutes.toFixed(1)} minutes. You can try resuming later.`,
      )
    }

    // Brief buffer for wallet node to catch up
    await wait(120_000)

    onStep?.(2, 'completed')

    // ── Step 3: Execute L2 claim ──
    onStep?.(3, 'active')
    patchOperationAsync(apiClient, operationId, { currentStep: 3 })

    // Build fee payment method if fuel is enabled
    let feeOption: { fee: { paymentMethod: any } } | undefined
    if (isFuelEnabled && fuelSecret && fuelMessageLeafIndexStr && fuelAmountReceived) {
      const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')
      const paymentMethod = new FeeJuicePaymentMethodWithClaim(
        AztecAddress.fromString(l2Address),
        {
          claimAmount: fuelAmountReceived,
          claimSecret: fuelSecret,
          messageLeafIndex: BigInt(fuelMessageLeafIndexStr),
        },
      )
      feeOption = { fee: { paymentMethod } }
    }

    // When fuel is enabled, BridgeAndFuel splits totalAmount into amount (token) + fuel.
    // The L2 claim is always for `amount` (the token portion).
    // For standard (non-fuel) deposits, the custom TokenPortal deducts fees before
    // creating the L2 message. The `amountAfterFee` extracted from the receipt event
    // is the actual amount in the L2 message — use it for the claim.
    const claimAmount = amountAfterFee ?? amount

    const claimResult = await executeL2Claim(
      { walletAdapter, aztecAddress: l2Address, isPrivacyModeEnabled: isPrivate },
      { amount: claimAmount, claimSecret, messageLeafIndex: BigInt(messageLeafIndexStr) },
      {
        onAttempt: (attempt, maxAttempts) => {
          emit({ type: 'claim_attempt', attempt, maxAttempts })
        },
        onRetry: (attempt, maxAttempts, delayMs) => {
          emit({ type: 'claim_retry', attempt, maxAttempts, delayMs })
        },
        feeOption,
      },
    )

    const l2TxHash = claimResult.l2TxHash
    const l2TxUrl = `${getAztecscanBaseUrl(config.l2ChainId)}/tx-effects/${l2TxHash}`

    // Persist brute-forced leaf index
    if (claimResult.usedBruteForce && claimResult.bruteForceLeafIndex != null) {
      patchOperationAsync(apiClient, operationId, {
        messageLeafIndex: claimResult.bruteForceLeafIndex.toString(),
      })
    }

    // Poll for L2 block number from claim receipt (best-effort, non-blocking for completion)
    let l2ClaimBlockNumber: string | undefined
    try {
      for (let i = 0; i < 15; i++) {
        const l2Receipt = await aztecNode.getTxReceipt(l2TxHash as any)
        if (l2Receipt?.blockNumber != null) {
          l2ClaimBlockNumber = String(l2Receipt.blockNumber)
          break
        }
        await wait(2000)
      }
      if (!l2ClaimBlockNumber) {
        console.warn('[SDK L1→L2] Could not get L2 claim block number after 15 attempts — will be null in DB')
      }
    } catch (err) {
      console.warn('[SDK L1→L2] Could not get L2 claim block number:', err)
    }

    // Mark as completed on server (retry — critical for DB consistency)
    const completionData: Record<string, unknown> = {
      status: 'completed',
      l2TxHash,
      l2TxUrl,
      completedAt: new Date().toISOString(),
      currentStep: 4,
    }
    if (l2ClaimBlockNumber) completionData.l2BlockNumber = l2ClaimBlockNumber
    const completionPatchOk = await patchOperationWithRetry(apiClient, operationId, completionData, { label: 'L1→L2 completion' })
    if (!completionPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'L1→L2 completion', data: { l2TxHash, status: 'completed' } })
    }

    onStep?.(3, 'completed')

    // ── Step 4: Complete ──
    onStep?.(4, 'active')

    emit({ type: 'operation_completed', operationId, l1TxHash, l2TxHash })

    // Mark localStorage entry as completed with URL fields
    updateDeposit(
      (c: any) => c.id === operationId,
      (c: any) => ({
        ...c,
        success: true,
        status: 'completed',
        l2TxHash,
        l2TxUrl,
        l1TxUrl,
        completedAt: Date.now(),
      }),
    )

    // Token registration after successful bridge
    if (walletAdapter?.registerToken) {
      try {
        await walletAdapter.registerToken(tokenConfig.l2TokenContract)
      } catch {
        // Non-critical — token will still appear after refresh
      }
    }

    await wait(3000)
    onStep?.(4, 'completed')

    return { operationId, l1TxHash, l2TxHash, l1TxUrl, l2TxUrl }
  } catch (error) {
    // 🔒 CRITICAL: Only mark as 'failed' if no funds are at risk.
    // If deposit was confirmed OR l1TxHash was sent (tx may be mining),
    // status stays 'deposited'/'pending' so user can Resume from Activity page.
    const err = error instanceof Error ? error : new Error(extractErrorString(error))
    const errorMessage = err.message

    // Funds may be at risk if deposit confirmed OR tx was broadcast
    const fundsAtRisk = depositConfirmed || l1TxSent
    emit({ type: 'error', error: err, fundsAtRisk, operationId })

    if (operationId) {
      const patchData: Record<string, unknown> = {
        lastErrorMessage: errorMessage.slice(0, 500),
      }
      // Only mark 'failed' if no tx was sent — otherwise the tx may still mine
      if (!depositConfirmed && !l1TxSent) {
        patchData.status = 'failed'
      }
      // Await retry so 'failed' status persists to DB before the throw
      await patchOperationWithRetry(apiClient, operationId, patchData, { label: 'error status' })
    }

    throw error
  }
}

