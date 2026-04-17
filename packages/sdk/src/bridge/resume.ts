/**
 * Bridge resume/recovery module.
 *
 * Handles resuming incomplete bridge operations by:
 * 1. Fetching the operation from the backend
 * 2. Decrypting the encrypted payload to recover secrets
 * 3. Determining direction and current stage
 * 4. Dispatching to the appropriate resume handler
 *
 * Recovery paths for L1→L2:
 *   - Has messageHash + messageLeafIndex → poll + claim
 *   - Has l1TxHash but no messageHash → recover from receipt → poll + claim
 *   - Has l1BlockNumberBeforeTx only → scan L1 blocks → poll + claim
 *
 * Recovery paths for L2→L1:
 *   - Has witness (leafIndex + siblingPath) → wait for proven → L1 withdraw
 *   - Has l2BlockNumber → compute witness → wait for proven → L1 withdraw
 *   - Has l2TxHash but no l2BlockNumber → recover from receipt → compute witness → ...
 *   - Has l2BlockNumberBeforeTx only → block scan → compute witness → ...
 */

import { Fr } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { extractEvent } from '@aztec/ethereum/utils'
import { CustomTokenPortalAbi } from '../contracts/abis/CustomTokenPortalAbi'
import { decodeEventLog } from 'viem'

import type { BridgeApiClient } from '../api'
import { getOperation, patchOperationWithRetry, patchOperationAsync } from '../operations'
import {
  decryptOperationPayload,
} from '../encryption'
import type {
  ResolvedConfig,
  ResumeParams,
  BridgeResult,
  BridgeOperation,
  BridgeActivityData,
  BridgeEventCallback,
} from '../types'
import { createL1PublicClient, wait } from './utils'
import { getAztecscanUrl as getAztecscanBaseUrl, getEtherscanUrl as getEtherscanBaseUrl } from '../config'
import { pollL1ToL2MessageSync, waitForBlockProven, waitForNextL2Block } from './polling'
import { executeL2Claim } from './l1ToL2'
import { executeL1Withdraw } from './l2ToL1'
import { computeL2ToL1MessageLeaf, computeWitness } from './witness'
import { updateDeposit, updateWithdrawal } from '../storage'

/**
 * Resume an incomplete bridge operation.
 *
 * Fetches the operation, decrypts the payload, determines the current
 * stage, and resumes from where it left off.
 */
export async function resume(
  config: ResolvedConfig,
  apiClient: BridgeApiClient,
  aztecNode: any,
  domain: string,
  operationId: number | string,
  params: ResumeParams,
): Promise<BridgeResult> {
  const { signMessage, onStep, onEvent } = params
  const emit: BridgeEventCallback = onEvent ?? (() => {})

  // 1. Fetch operation
  const op = await getOperation(apiClient, operationId)

  // 2. Decrypt payload
  const decryptedData = await decryptOperationPayload(op, signMessage, domain, params.l1Address)
  if (!decryptedData) {
    throw new Error(
      'Could not decrypt operation payload. Ensure you are using the same wallet that created this operation.',
    )
  }

  // 3. Determine direction and dispatch
  if (op.direction === 'L1_TO_L2') {
    return resumeL1ToL2(config, apiClient, aztecNode, op, decryptedData, params, emit)
  } else if (op.direction === 'L2_TO_L1') {
    return resumeL2ToL1(config, apiClient, aztecNode, op, decryptedData, params, emit)
  } else {
    throw new Error(`Unknown operation direction: ${op.direction}`)
  }
}

// ─── L1→L2 Recovery Helpers ─────────────────────────────────────────

/**
 * Recover messageHash, messageLeafIndex, and post-fee `claimAmount` from the
 * portal event in an L1 transaction receipt.
 *
 * The `amount` field emitted by TokenPortal.DepositToAztec{Public,Private}
 * is the POST-fee amount — the exact value used in the L1→L2 content hash.
 * Backfilling it here means the caller can persist it to the DB and avoid
 * a later on-chain `calculateFee()` reconstruction (which could diverge
 * if the portal's live fee rate shifts between deposit and resume).
 */
async function recoverFromReceipt(
  publicClient: any,
  l1TxHash: string,
  portalAddress: string,
  claimSecretHash: string,
  amount: bigint,
  l2Address: string,
  isPrivacyModeEnabled: boolean,
): Promise<{ messageHash: string; messageLeafIndex: string; l1BlockNumber?: string; claimAmount?: string }> {
  console.log('[SDK Resume L1→L2] Recovering from receipt (txHash=', l1TxHash, ')...')

  // Use waitForTransactionReceipt instead of getTransactionReceipt
  // so that pending/unmined transactions are polled rather than throwing immediately.
  // This handles the "internet went down after tx sent" scenario.
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: l1TxHash as `0x${string}`,
    timeout: 300_000, // 5 minutes
  })

  const eventName = isPrivacyModeEnabled
    ? 'DepositToAztecPrivate'
    : 'DepositToAztecPublic'

  // Filter by secretHash (and recipient for public). DO NOT filter by amount —
  // the portal event's amount field is the POST-fee claimAmount, while the
  // caller's `amount` may be the pre-fee value, so equality filters would
  // always miss. Matches main's recoverFromReceipt behavior.
  const privateFilter = (log: any) =>
    log.args.secretHash?.toString() === claimSecretHash.toString()

  const publicFilter = (log: any) =>
    log.args.secretHash?.toString() === claimSecretHash.toString() &&
    log.args.to?.toString() === l2Address

  const log = extractEvent(
    receipt.logs,
    portalAddress as `0x${string}`,
    CustomTokenPortalAbi,
    eventName,
    isPrivacyModeEnabled ? privateFilter : publicFilter,
  )

  const messageHash = log.args.key.toString()
  const messageLeafIndex = log.args.index.toString()
  const l1BlockNumber = receipt.blockNumber != null ? String(receipt.blockNumber) : undefined
  const claimAmount = log.args.amount != null ? log.args.amount.toString() : undefined
  console.log('[SDK Resume L1→L2] Recovered: messageHash=', messageHash, 'leafIndex=', messageLeafIndex, 'claimAmount=', claimAmount)
  return { messageHash, messageLeafIndex, l1BlockNumber, claimAmount }
}

/**
 * Recover messageHash, messageLeafIndex, and (where available) claimAmount +
 * fuel message fields by scanning L1 blocks for portal / SwapBridgeRouter events.
 *
 * For fuel-enabled bridges the deposit flows through SwapBridgeRouter, which
 * emits BridgeWithFuel carrying both the token message data (tokenKey /
 * tokenIndex / tokenAmount) AND the fuel message data (fuelKey / fuelIndex /
 * fuelAmount) in a single log. We therefore include SwapBridgeRouter's address
 * in the getLogs filter so a fuel-only block-scan resume can still recover the
 * fuel fields it needs to build the FeeJuice payment method.
 */
async function recoverFromBlockScan(
  publicClient: any,
  l1BlockNumberBeforeTx: string,
  portalAddress: string,
  claimSecretHash: string,
  amount: bigint,
  l2Address: string,
  isPrivacyModeEnabled: boolean,
  swapBridgeRouterAddress?: string,
): Promise<{
  messageHash: string
  messageLeafIndex: string
  l1TxHash?: string
  claimAmount?: string
  fuelMessageHash?: string
  fuelMessageLeafIndex?: string
  fuelAmount?: string
}> {
  const fromBlock = BigInt(l1BlockNumberBeforeTx)
  const toBlock = await publicClient.getBlockNumber()

  console.log('[SDK Resume L1→L2] Scanning L1 blocks', fromBlock.toString(), '→', toBlock.toString(), '...')

  const targetEventName = isPrivacyModeEnabled
    ? 'DepositToAztecPrivate'
    : 'DepositToAztecPublic'

  // Paginate in 2000-block chunks to stay within RPC provider limits.
  const CHUNK_SIZE = 2000n

  // Lazy-load the router ABI only if a router address is configured — keeps the
  // non-fuel path free of an unnecessary module import.
  const routerAddrLower = swapBridgeRouterAddress?.toLowerCase()
  let SwapBridgeRouterAbi: any
  if (routerAddrLower) {
    ;({ SwapBridgeRouterAbi } = await import('../contracts/abis/SwapBridgeRouterAbi'))
  }
  const scanAddresses = routerAddrLower
    ? [portalAddress as `0x${string}`, swapBridgeRouterAddress as `0x${string}`]
    : (portalAddress as `0x${string}`)

  for (let chunkFrom = fromBlock; chunkFrom <= toBlock; chunkFrom += CHUNK_SIZE) {
    const chunkTo = chunkFrom + CHUNK_SIZE - 1n > toBlock ? toBlock : chunkFrom + CHUNK_SIZE - 1n

    let logs: any[] = []
    let chunkRetries = 0
    const MAX_CHUNK_RETRIES = 2
    while (true) {
      try {
        logs = await publicClient.getLogs({
          address: scanAddresses,
          fromBlock: chunkFrom,
          toBlock: chunkTo,
        })
        break
      } catch (err) {
        chunkRetries++
        if (chunkRetries > MAX_CHUNK_RETRIES) {
          console.warn('[SDK Resume L1→L2] getLogs failed after retries for chunk', chunkFrom.toString(), '→', chunkTo.toString(), ':', err)
          throw new Error(
            `Block scan failed for range ${chunkFrom}–${chunkTo} after ${MAX_CHUNK_RETRIES} retries. ` +
            'RPC may be rate-limited. Try resuming again later.'
          )
        }
        console.warn('[SDK Resume L1→L2] getLogs failed for chunk', chunkFrom.toString(), '→', chunkTo.toString(), ', retrying...:', err)
        await wait(1000)
      }
    }

    for (const rawLog of logs) {
      // Router path first — BridgeWithFuel carries both token and fuel message
      // data. If this matches, we still want the portal event's claimAmount
      // (BridgeWithFuel.tokenAmount is already post-fee but we keep the portal
      // value as an authoritative fallback).
      if (routerAddrLower && rawLog.address?.toLowerCase() === routerAddrLower) {
        try {
          // SwapBridgeRouterAbi is lazy-loaded as `any`, so decodeEventLog's
          // generic narrowing isn't available here — cast to access .eventName.
          const decoded = decodeEventLog({
            abi: SwapBridgeRouterAbi,
            data: rawLog.data,
            topics: rawLog.topics,
          }) as { eventName: string; args: Record<string, any> }
          if (decoded.eventName === 'Bridge' || decoded.eventName === 'BridgeWithFuel') {
            const args = decoded.args as any
            const eventSecretHash = (args.secretHash ?? args.tokenSecretHash)?.toString()
            if (eventSecretHash && eventSecretHash !== claimSecretHash.toString()) continue
            const messageHash = (args.key ?? args.tokenKey).toString()
            const messageLeafIndex = (args.index ?? args.tokenIndex).toString()
            const l1TxHash = rawLog.transactionHash?.toString()
            let claimAmount: string | undefined
            let fuelMessageHash: string | undefined
            let fuelMessageLeafIndex: string | undefined
            let fuelAmount: string | undefined
            if (decoded.eventName === 'BridgeWithFuel') {
              if (args.tokenAmount != null) claimAmount = args.tokenAmount.toString()
              if (args.fuelKey) fuelMessageHash = args.fuelKey.toString()
              if (args.fuelIndex != null) fuelMessageLeafIndex = args.fuelIndex.toString()
              if (args.fuelAmount != null) fuelAmount = args.fuelAmount.toString()
            }
            // Prefer the authoritative portal event (same tx) for claimAmount
            // if the router args didn't carry it.
            if (!claimAmount) {
              for (const sib of logs) {
                if (sib.transactionHash !== rawLog.transactionHash) continue
                if (sib.address?.toLowerCase() !== portalAddress.toLowerCase()) continue
                try {
                  const sibDecoded = decodeEventLog({
                    abi: CustomTokenPortalAbi,
                    data: sib.data,
                    topics: sib.topics,
                  })
                  if (sibDecoded.eventName === targetEventName) {
                    const sibArgs = sibDecoded.args as any
                    if (sibArgs.amount != null) {
                      claimAmount = sibArgs.amount.toString()
                      break
                    }
                  }
                } catch { /* skip */ }
              }
            }
            console.log('[SDK Resume L1→L2] Found router event in block scan: messageHash=', messageHash, 'leafIndex=', messageLeafIndex)
            return { messageHash, messageLeafIndex, l1TxHash, claimAmount, fuelMessageHash, fuelMessageLeafIndex, fuelAmount }
          }
        } catch { /* not our event */ }
        continue
      }

      // Portal path (non-fuel OR fuel fallback when router events didn't match first)
      try {
        const decoded = decodeEventLog({
          abi: CustomTokenPortalAbi,
          data: rawLog.data,
          topics: rawLog.topics,
        })
        if (decoded.eventName !== targetEventName) continue

        const args = decoded.args as any
        // Match by secretHash (and recipient for public). Do NOT filter by amount —
        // portal event amount is POST-fee while the caller's amount may be pre-fee,
        // so an equality filter would always miss. Matches main's behavior.
        const matches = isPrivacyModeEnabled
          ? args.secretHash?.toString() === claimSecretHash.toString()
          : args.secretHash?.toString() === claimSecretHash.toString() && args.to?.toString() === l2Address

        if (matches) {
          const messageHash = args.key.toString()
          const messageLeafIndex = args.index.toString()
          const l1TxHash = rawLog.transactionHash?.toString()
          const claimAmount = args.amount != null ? args.amount.toString() : undefined
          console.log('[SDK Resume L1→L2] Found event in block scan: messageHash=', messageHash, 'leafIndex=', messageLeafIndex, 'l1TxHash=', l1TxHash)
          return { messageHash, messageLeafIndex, l1TxHash, claimAmount }
        }
      } catch {
        // Skip logs that can't be decoded with our ABI
      }
    }
  }

  throw new Error(
    `Could not find deposit event in blocks ${fromBlock}–${toBlock}. ` +
    'The deposit may not have been mined yet, or the block range may need to be extended. ' +
    'Try resuming again later.'
  )
}

// ─── L1→L2 Resume ───────────────────────────────────────────────────

/**
 * Resume L1→L2 bridge.
 *
 * Frontend step mapping:
 *   Step 1: L1 deposit already done (mark completed)
 *   Step 2: Poll for L1→L2 message sync
 *   Step 3: Execute L2 claim
 *   Step 4: Complete
 */
async function resumeL1ToL2(
  config: ResolvedConfig,
  apiClient: BridgeApiClient,
  aztecNode: any,
  op: BridgeOperation,
  data: BridgeActivityData,
  params: ResumeParams,
  emit: BridgeEventCallback,
): Promise<BridgeResult> {
  try {
  const { walletAdapter, l2Address, onStep } = params

  if (!walletAdapter) throw new Error('walletAdapter required to resume L1→L2')
  if (!l2Address) throw new Error('l2Address required to resume L1→L2')
  if (!data.claimSecret) throw new Error('claimSecret not found in decrypted data')

  // Short-circuit if the operation is already completed (e.g. a previous claim
  // succeeded but the PATCH to the UI/session failed). Avoids a wasted wallet
  // popup and a confusing "already consumed" error surfaced after the fact.
  if (op.status === 'completed') {
    emit({ type: 'operation_completed', operationId: op.id, alreadyCompleted: true })
    onStep?.(3, 'completed')
    return {
      operationId: op.id,
      l1TxHash: op.l1TxHash ?? undefined,
      l2TxHash: op.l2TxHash ?? undefined,
    }
  }

  const claimSecret = Fr.fromString(data.claimSecret)
  const claimSecretHash = data.claimSecretHash ?? ''
  const isPrivacyModeEnabled = op.isPrivacyModeEnabled ?? false

  // Use the post-fee amount when available — the custom TokenPortal deducts fees before
  // creating the L2 message. The L2 claim must use the actual amount in the message.
  // Priority:
  //   1. claimAmount (exact post-fee, persisted by happy-path from the receipt event)
  //   2. On-chain calculateFee(amountL1) — covers the case where the receipt event
  //      was never persisted. Without this fallback the SDK would send the pre-fee
  //      amount, which fails the portal's L1→L2 content-hash check.
  //   3. amountL2 / data.amount / amountL1 (last resort, may be pre-fee)
  let amount: bigint
  if (op.claimAmount) {
    amount = BigInt(op.claimAmount)
  } else if (op.amountL1 && op.portalAddressL1) {
    const { getPostFeeClaimAmount } = await import('./utils')
    amount = await getPostFeeClaimAmount(config, op.portalAddressL1, BigInt(op.amountL1))
  } else {
    amount = BigInt(op.amountL2 ?? data.amount ?? op.amountL1 ?? '0')
  }
  if (amount === 0n) {
    throw new Error('Cannot resume: operation amount is zero. The operation data may be corrupted.')
  }

  // Prepare fuel fee option for L2 claim if fuel was used
  let fuelFeeOption: { fee: { paymentMethod: any; gasSettings?: any } } | undefined
  let fuelMessageLeafIndex = op.fuelMessageLeafIndex
  let fuelMessageHash = op.fuelMessageHash
  let fuelAmount = op.fuelAmount

  // If any fuel secret exists but fuel receipt data is missing (receipt PATCH failed),
  // attempt to recover it from the L1 transaction receipt. Triggers for BOTH public fuel
  // (data.fuelSecret) and private fuel (data.privateFuelSecret) — main's BridgeWithFuel
  // event carries fuelKey/fuelIndex/fuelAmount regardless of fuel type.
  const hasAnyFuelSecret = !!(data.fuelSecret || data.privateFuelSecret)
  if (hasAnyFuelSecret && (!fuelMessageLeafIndex || !fuelAmount) && op.l1TxHash && config.swapBridgeRouterAddress) {
    try {
      const { SwapBridgeRouterAbi } = await import('../contracts/abis/SwapBridgeRouterAbi')
      const publicClient = createL1PublicClient(config)
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: op.l1TxHash as `0x${string}`,
        timeout: 300_000,
      })
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== config.swapBridgeRouterAddress.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: SwapBridgeRouterAbi,
            data: log.data,
            topics: log.topics,
          })
          if (decoded.eventName === 'BridgeWithFuel') {
            const args = decoded.args as any
            fuelMessageLeafIndex = args.fuelIndex.toString()
            fuelMessageHash = args.fuelKey.toString()
            fuelAmount = args.fuelAmount.toString()
            console.log('[SDK Resume L1→L2] Recovered fuel data from receipt: leafIndex=', fuelMessageLeafIndex, 'hash=', fuelMessageHash, 'amount=', fuelAmount)
            // Persist only missing fuel fields — don't overwrite values already in DB
            const fuelPatchData: Record<string, unknown> = {}
            if (!op.fuelMessageLeafIndex) fuelPatchData.fuelMessageLeafIndex = fuelMessageLeafIndex
            if (!op.fuelAmount) fuelPatchData.fuelAmount = fuelAmount
            if (!op.fuelMessageHash) fuelPatchData.fuelMessageHash = fuelMessageHash
            if (Object.keys(fuelPatchData).length > 0) {
              await patchOperationWithRetry(apiClient, op.id, fuelPatchData, { label: 'recovered fuel data' })
            }
            break
          }
        } catch {
          // Not our event, skip
        }
      }
    } catch (err) {
      console.warn('[SDK Resume L1→L2] Could not recover fuel data from receipt:', err)
    }
  }

  if (data.privateFuelSecret && data.privateFuelSalt && fuelMessageLeafIndex && fuelAmount) {
    // Private-fuel resume: rebuild PrivateMintAndPayFeePaymentMethod from the
    // salt + derived secret persisted in the encrypted blob.
    if (!config.bridgedFpcAddress) {
      throw new Error(
        'Private fuel resume requires bridgedFpcAddress in the active deployment config.',
      )
    }
    const { PrivateMintAndPayFeePaymentMethod, maxFeesPerGasFromBaseFees } =
      await import('@wonderland/aztec-fee-payment')
    const { Gas, GasFees } = await import('@aztec/stdlib/gas')
    const baseFees = await aztecNode.getCurrentMinFees()
    const gasLimits = Gas.from({ l2Gas: 2_000_000, daGas: 50_000 })
    const teardownGasLimits = Gas.from({ l2Gas: 0, daGas: 0 })
    const maxFeesPerGas = maxFeesPerGasFromBaseFees(baseFees)
    const paymentMethod = new PrivateMintAndPayFeePaymentMethod(
      AztecAddress.fromString(config.bridgedFpcAddress),
      BigInt(fuelAmount),
      Fr.fromString(data.privateFuelSecret),
      Fr.fromString(data.privateFuelSalt),
      new Fr(BigInt(fuelMessageLeafIndex)),
    )
    fuelFeeOption = {
      fee: {
        paymentMethod,
        gasSettings: {
          gasLimits,
          teardownGasLimits,
          maxFeesPerGas,
          maxPriorityFeesPerGas: GasFees.empty(),
        },
      },
    }
    console.log('[SDK Resume L1→L2] Using PrivateMintAndPayFeePaymentMethod (BridgedFPC) for private-fuel resume')
  } else if (data.fuelSecret && fuelMessageLeafIndex && fuelAmount) {
    // Public-fuel resume: FeeJuicePaymentMethodWithClaim against the claimer's aztec address.
    // All three inputs are required — a zero `fuelAmount` here would produce a
    // FeeJuice note of zero value, which the claim uses as the payment method and
    // then fails downstream with an opaque "insufficient fee" error. Main gates
    // on the same three fields (useResumeL1BridgeToL2.ts:545); mirror that so a
    // partially-recovered op falls through to a no-fuel claim instead of
    // attempting (and failing) with a bogus FeeJuicePaymentMethodWithClaim.
    const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')
    const { buildClaimGasSettings } = await import('../fuelGasEstimate')
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(
      AztecAddress.fromString(l2Address),
      {
        claimAmount: BigInt(fuelAmount),
        claimSecret: Fr.fromString(data.fuelSecret),
        messageLeafIndex: BigInt(fuelMessageLeafIndex),
      },
    )
    const gasSettings = await buildClaimGasSettings(aztecNode)
    fuelFeeOption = { fee: { paymentMethod, gasSettings } }
    console.log('[SDK Resume L1→L2] Using FeeJuicePaymentMethodWithClaim for public-fuel resume')
  }

  if (!op.portalAddressL1) {
    throw new Error(
      'portalAddressL1 not stored in operation. Cannot resume without knowing which token portal to use. Contact support with your operation ID.',
    )
  }
  const portalAddress = op.portalAddressL1

  let messageHash = op.messageHash
  let messageLeafIndex = op.messageLeafIndex
  let recoveredL1BlockNumber: string | undefined
  // Post-fee claimAmount recovered from the L1 receipt (either the portal's
  // DepositToAztec* event or the SwapBridgeRouter.BridgeWithFuel.tokenAmount).
  // Used to both (a) override the `amount` fallback below when we found a
  // fresher value, and (b) backfill the DB via the recovery PATCH so future
  // resumes don't re-query the portal's fee rate.
  let recoveredClaimAmount: string | undefined

  // ═════════════════════════════════════════════════════════════════════
  // RECOVERY: Recover messageHash + messageLeafIndex if missing
  // ═════════════════════════════════════════════════════════════════════
  if (!messageHash || !messageLeafIndex) {
    console.log('[SDK Resume L1→L2] messageHash or messageLeafIndex missing — attempting recovery...')
    onStep?.(1, 'active')

    const publicClient = createL1PublicClient(config)
    const targetAddress = l2Address

    if (op.l1TxHash) {
      // Path A: We have the L1 tx hash — get receipt and extract event.
      // For fuel-enabled deposits, try SwapBridgeRouter contract first, then fall back to portal.
      emit({ type: 'recovery_from_receipt', l1TxHash: op.l1TxHash })
      let recovered: {
        messageHash: string
        messageLeafIndex: string
        l1BlockNumber?: string
        claimAmount?: string
      } | null = null

      if ((data.fuelSecret || data.privateFuelSecret) && config.swapBridgeRouterAddress) {
        // Fuel path (public or private): the deposit went through SwapBridgeRouter,
        // not the portal directly. Try extracting from SwapBridgeRouter receipt first.
        try {
          const { SwapBridgeRouterAbi } = await import('../contracts/abis/SwapBridgeRouterAbi')
          const fuelReceipt = await publicClient.waitForTransactionReceipt({
            hash: op.l1TxHash as `0x${string}`,
            timeout: 300_000,
          })
          for (const log of fuelReceipt.logs) {
            // SwapBridgeRouter emits BridgeWithFuel which includes the token message data
            if (log.address.toLowerCase() !== config.swapBridgeRouterAddress.toLowerCase()) continue
            try {
              const decoded = decodeEventLog({
                abi: SwapBridgeRouterAbi,
                data: log.data,
                topics: log.topics,
              })
              if (decoded.eventName === 'BridgeWithFuel') {
                const args = decoded.args as any
                // BridgeWithFuel.tokenAmount IS the post-fee amount (SwapBridgeRouter.sol:304
                // emits tokenAmountAfterFee under the name tokenAmount). Prefer it over the
                // sibling portal event, but fall back to the portal event if tokenAmount is
                // ever missing (defensive — old router deployments).
                let claimAmount: string | undefined
                if (args.tokenAmount != null) claimAmount = args.tokenAmount.toString()
                if (!claimAmount) {
                  const portalEventName = isPrivacyModeEnabled ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'
                  for (const portalLog of fuelReceipt.logs) {
                    if (portalLog.address.toLowerCase() !== portalAddress.toLowerCase()) continue
                    try {
                      const portalDecoded = decodeEventLog({
                        abi: CustomTokenPortalAbi,
                        data: portalLog.data,
                        topics: portalLog.topics,
                      })
                      if (portalDecoded.eventName === portalEventName) {
                        const portalArgs = portalDecoded.args as any
                        if (portalArgs.amount != null) {
                          claimAmount = portalArgs.amount.toString()
                          break
                        }
                      }
                    } catch { /* skip non-portal log */ }
                  }
                }
                recovered = {
                  messageHash: args.tokenKey.toString(),
                  messageLeafIndex: args.tokenIndex.toString(),
                  l1BlockNumber: fuelReceipt.blockNumber != null ? String(fuelReceipt.blockNumber) : undefined,
                  claimAmount,
                }
                console.log('[SDK Resume L1→L2] Recovered from SwapBridgeRouter receipt:', recovered)
                break
              }
            } catch { /* Not our event */ }
          }
          // Also try portal events in the same receipt (SwapBridgeRouter calls portal internally)
          if (!recovered) {
            recovered = await recoverFromReceipt(
              publicClient, op.l1TxHash, portalAddress, claimSecretHash,
              amount, targetAddress, isPrivacyModeEnabled,
            )
          }
        } catch (err) {
          console.warn('[SDK Resume L1→L2] SwapBridgeRouter recovery failed, trying portal:', err)
        }
      }

      if (!recovered) {
        recovered = await recoverFromReceipt(
          publicClient, op.l1TxHash, portalAddress, claimSecretHash,
          amount, targetAddress, isPrivacyModeEnabled,
        )
      }
      messageHash = recovered.messageHash
      messageLeafIndex = recovered.messageLeafIndex
      recoveredL1BlockNumber = recovered.l1BlockNumber
      if (recovered.claimAmount) recoveredClaimAmount = recovered.claimAmount
    } else if (op.l1BlockNumberBeforeTx) {
      // Path B: No tx hash — scan L1 blocks. Pass the SwapBridgeRouter address
      // so fuel-enabled bridges that crashed before the receipt PATCH can
      // still recover their fuel message fields from BridgeWithFuel events.
      emit({ type: 'recovery_from_block_scan', l1BlockNumberBeforeTx: op.l1BlockNumberBeforeTx })
      const recovered = await recoverFromBlockScan(
        publicClient,
        op.l1BlockNumberBeforeTx,
        portalAddress,
        claimSecretHash,
        amount,
        targetAddress,
        isPrivacyModeEnabled,
        config.swapBridgeRouterAddress,
      )
      messageHash = recovered.messageHash
      messageLeafIndex = recovered.messageLeafIndex
      if (recovered.claimAmount) recoveredClaimAmount = recovered.claimAmount
      // Backfill fuel fields recovered from BridgeWithFuel so the public /
      // private fuel payment method can be rebuilt further down.
      if (recovered.fuelMessageHash && !fuelMessageHash) fuelMessageHash = recovered.fuelMessageHash
      if (recovered.fuelMessageLeafIndex && !fuelMessageLeafIndex) fuelMessageLeafIndex = recovered.fuelMessageLeafIndex
      if (recovered.fuelAmount && !fuelAmount) fuelAmount = recovered.fuelAmount

      // Persist l1TxHash + l1TxUrl so a follow-up resume (which requires
      // op.l1TxHash for receipt-based recovery) can run. Also update the
      // local `op` object so downstream code sees the recovered value.
      if (recovered.l1TxHash) {
        op.l1TxHash = recovered.l1TxHash
        const l1TxUrl = `${getEtherscanBaseUrl(config.l1ChainId)}/tx/${recovered.l1TxHash}`
        const l1TxPatchOk = await patchOperationWithRetry(apiClient, op.id, {
          l1TxHash: recovered.l1TxHash,
          l1TxUrl,
        }, { label: 'recovered l1TxHash from block scan' })
        if (!l1TxPatchOk) {
          emit({ type: 'patch_failed', operationId: op.id, label: 'recovered l1TxHash', data: { l1TxHash: recovered.l1TxHash } })
        }
      }
      // Persist fuel fields and claimAmount recovered from the block scan so
      // they survive a subsequent session crash without re-scanning.
      const scanFuelPatch: Record<string, unknown> = {}
      if (!op.fuelMessageHash && recovered.fuelMessageHash) scanFuelPatch.fuelMessageHash = recovered.fuelMessageHash
      if (!op.fuelMessageLeafIndex && recovered.fuelMessageLeafIndex) scanFuelPatch.fuelMessageLeafIndex = recovered.fuelMessageLeafIndex
      if (!op.fuelAmount && recovered.fuelAmount) scanFuelPatch.fuelAmount = recovered.fuelAmount
      if (Object.keys(scanFuelPatch).length > 0) {
        await patchOperationWithRetry(apiClient, op.id, scanFuelPatch, { label: 'recovered fuel data from block scan' })
      }
    } else {
      throw new Error(
        'Cannot resume: no messageHash, no l1TxHash, and no l1BlockNumberBeforeTx. ' +
        'There is not enough data to recover. Contact support.',
      )
    }

    // Persist only missing recovery fields — don't overwrite values already in DB.
    // `claimAmount` is included because later resumes (without re-running receipt
    // recovery) need it to avoid the on-chain `calculateFee()` fallback, which
    // can diverge from the original post-fee amount if the portal's fee rate has
    // shifted since the deposit.
    const recoveredPatchData: Record<string, unknown> = {
      status: 'deposited',
      currentStep: 2,
    }
    if (!op.messageHash) recoveredPatchData.messageHash = messageHash
    if (!op.messageLeafIndex) recoveredPatchData.messageLeafIndex = messageLeafIndex
    if (!op.l1BlockNumber && recoveredL1BlockNumber) recoveredPatchData.l1BlockNumber = recoveredL1BlockNumber
    if (!op.claimAmount && recoveredClaimAmount) recoveredPatchData.claimAmount = recoveredClaimAmount
    await patchOperationWithRetry(apiClient, op.id, recoveredPatchData, { label: 'recovered data' })

    // If we just recovered a fresher post-fee amount, use it for this run's
    // L2 claim — the earlier `amount` resolution may have fallen back to an
    // on-chain calculateFee() that could disagree with the receipt event.
    if (recoveredClaimAmount) {
      amount = BigInt(recoveredClaimAmount)
    }
  }

  // Step 1 done (L1 deposit already completed)
  onStep?.(1, 'completed')

  // ═════════════════════════════════════════════════════════════════════
  // Step 2: Poll for L1→L2 message sync
  // ═════════════════════════════════════════════════════════════════════
  onStep?.(2, 'active')
  patchOperationAsync(apiClient, op.id, { currentStep: 2 })

  // Poll for both main and fuel messages in parallel (matches happy path)
  const syncPromises: Promise<any>[] = [
    pollL1ToL2MessageSync(aztecNode, messageHash!),
  ]
  if (fuelMessageHash) {
    syncPromises.push(pollL1ToL2MessageSync(aztecNode, fuelMessageHash))
  }
  const syncResults = await Promise.all(syncPromises)
  const syncResult = syncResults[0]
  emit({ type: 'sync_poll', elapsedMinutes: syncResult.elapsedMinutes, synced: syncResult.synced })

  if (!syncResult.synced) {
    throw new Error(
      `L1-to-L2 message sync timeout after ${syncResult.elapsedMinutes.toFixed(1)} minutes. You can try resuming again later.`,
    )
  }

  // Wait for the sequencer to include the L1→L2 message in a new L2 block.
  // The archiver checkpoint appears quickly, but the message is only consumable
  // after the sequencer includes it in an L2 block (can take up to ~1 epoch on testnet).
  console.log('[SDK Resume L1→L2] Waiting for sequencer to include message in L2 block...')
  await waitForNextL2Block(aztecNode)

  onStep?.(2, 'completed')

  // ═════════════════════════════════════════════════════════════════════
  // Step 3: Claim on L2
  // ═════════════════════════════════════════════════════════════════════
  onStep?.(3, 'active')
  patchOperationAsync(apiClient, op.id, { currentStep: 3 })

  let l2TxHash: string | undefined
  let alreadyClaimed = false

  try {
    const claimResult = await executeL2Claim(
      { walletAdapter, aztecAddress: l2Address, isPrivacyModeEnabled },
      {
        amount,
        claimSecret,
        messageLeafIndex: messageLeafIndex ? BigInt(messageLeafIndex) : null,
      },
      {
        onAttempt: (attempt, maxAttempts) => {
          emit({ type: 'claim_attempt', attempt, maxAttempts })
        },
        onRetry: (attempt, maxAttempts, delayMs) => {
          emit({ type: 'claim_retry', attempt, maxAttempts, delayMs })
        },
        feeOption: fuelFeeOption,
      },
    )

    l2TxHash = claimResult.l2TxHash
    if (claimResult.usedBruteForce && claimResult.bruteForceLeafIndex != null) {
      messageLeafIndex = claimResult.bruteForceLeafIndex.toString()
      patchOperationAsync(apiClient, op.id, { messageLeafIndex })
    }
  } catch (claimErr) {
    // If the claim fails because the message was already consumed (previous
    // resume succeeded but completion PATCH didn't), treat as success.
    const errMsg = claimErr instanceof Error ? claimErr.message : String(claimErr)
    if (isAlreadyConsumedError(errMsg)) {
      console.log('[SDK Resume L1→L2] Claim already consumed — treating as previously completed.')
      alreadyClaimed = true
      l2TxHash = op.l2TxHash ?? 'already-claimed'
    } else {
      throw claimErr
    }
  }

  const l2TxUrl = l2TxHash
    ? `${getAztecscanBaseUrl(config.l2ChainId)}/tx-effects/${l2TxHash}`
    : op.l2TxUrl ?? ''

  // Mark as completed on server (retry — critical for DB consistency)
  // Only send l2TxHash/l2TxUrl if they carry real values — don't overwrite
  // a real tx hash in the DB with an 'already-claimed' sentinel.
  const l1l2CompletionData: Record<string, unknown> = {
    status: 'completed',
    completedAt: new Date().toISOString(),
    currentStep: 4,
  }
  if (l2TxHash && l2TxHash !== 'already-claimed') {
    l1l2CompletionData.l2TxHash = l2TxHash
    l1l2CompletionData.l2TxUrl = l2TxUrl
  }
  await patchOperationWithRetry(apiClient, op.id, l1l2CompletionData, { label: 'L1→L2 resume completion' })

  onStep?.(3, 'completed')

  // ═════════════════════════════════════════════════════════════════════
  // Step 4: Complete
  // ═════════════════════════════════════════════════════════════════════
  onStep?.(4, 'active')
  emit({ type: 'operation_completed', operationId: op.id, l1TxHash: op.l1TxHash ?? undefined, l2TxHash })

  // Mark localStorage deposit as completed with URL fields
  updateDeposit(
    (c: any) => c.id === op.id,
    (c: any) => ({
      ...c,
      success: true,
      status: 'completed',
      l2TxHash,
      l2TxUrl,
      l1TxUrl: op.l1TxUrl ?? undefined,
      completedAt: Date.now(),
    }),
  )

  await wait(3000)
  onStep?.(4, 'completed')

  return {
    operationId: op.id,
    l1TxHash: op.l1TxHash ?? undefined,
    l2TxHash,
    l1TxUrl: op.l1TxUrl ?? undefined,
    l2TxUrl,
  }
  } catch (err) {
    emit({
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      fundsAtRisk: true,
    })
    throw err
  }
}

// ─── L2→L1 Recovery Helper ──────────────────────────────────────────

/**
 * Recover l2BlockNumber from l2TxHash by polling the Aztec node.
 */
async function recoverL2BlockNumber(aztecNode: any, l2TxHash: string): Promise<number> {
  console.log('[SDK Resume L2→L1] Recovering l2BlockNumber from l2TxHash...')
  for (let i = 0; i < 30; i++) {
    try {
      const receipt = await aztecNode.getTxReceipt(l2TxHash as any)
      if (receipt?.blockNumber != null) {
        console.log('[SDK Resume L2→L1] Recovered l2BlockNumber=', receipt.blockNumber)
        return receipt.blockNumber
      }
    } catch {
      // Retry
    }
    await wait(2000)
  }
  throw new Error(
    'Could not get L2 block number from tx receipt. The transaction may not be finalized yet. Try again later.',
  )
}

// ─── L2→L1 Resume ───────────────────────────────────────────────────

/**
 * Resume L2→L1 withdrawal.
 *
 * Frontend step mapping:
 *   Step 1: L2 burn+exit already done (mark completed)
 *   Step 2: Compute witness (if missing)
 *   Step 3: Wait for block proven on L1
 *   Step 4: Execute L1 withdraw
 *   Step 5: Done
 */
async function resumeL2ToL1(
  config: ResolvedConfig,
  apiClient: BridgeApiClient,
  aztecNode: any,
  op: BridgeOperation,
  data: BridgeActivityData,
  params: ResumeParams,
  emit: BridgeEventCallback,
): Promise<BridgeResult> {
  try {
  const { sendTransaction, onStep } = params

  if (!sendTransaction) throw new Error('sendTransaction required to resume L2→L1')

  // Short-circuit if the operation is already completed.
  if (op.status === 'completed') {
    emit({ type: 'operation_completed', operationId: op.id, alreadyCompleted: true })
    onStep?.(5, 'completed')
    return {
      operationId: op.id,
      l1TxHash: op.l1TxHash ?? undefined,
      l2TxHash: op.l2TxHash ?? undefined,
    }
  }

  if (!op.portalAddressL1) {
    throw new Error('portalAddressL1 not stored in operation. Cannot resume.')
  }
  if (!op.bridgeAddressL2) {
    throw new Error('bridgeAddressL2 not stored in operation. Cannot resume.')
  }

  const amount = BigInt(data.amount ?? op.amountL2 ?? '0')
  if (amount === 0n) {
    throw new Error('Cannot resume: operation amount is zero. The operation data may be corrupted.')
  }
  const l1Address = data.l1Address ?? op.recipientL1Address ?? ''

  if (!l1Address || !/^0x[a-fA-F0-9]{40}$/.test(l1Address)) {
    throw new Error(
      'Cannot resume L2→L1 withdrawal: no valid L1 recipient address found in the operation data. ' +
      'Contact support with your operation ID.',
    )
  }

  // Warn if the currently connected wallet differs from the original deposit wallet.
  // Tokens will be sent to the ORIGINAL l1Address, not the currently connected wallet.
  if (params.l1Address && params.l1Address.toLowerCase() !== l1Address.toLowerCase()) {
    console.warn(
      `[SDK Resume L2→L1] Connected wallet (${params.l1Address}) differs from original recipient (${l1Address}). ` +
      'Tokens will be sent to the original recipient address.',
    )
    emit({
      type: 'error',
      error: new Error(
        `Connected wallet (${params.l1Address}) differs from the original recipient (${l1Address}). ` +
        'Tokens will be sent to the original recipient address. If this is not what you want, switch wallets and retry.',
      ),
      fundsAtRisk: false,
    })
  }

  const publicClient = createL1PublicClient(config)

  let l2ToL1MessageIndex = op.l2ToL1MessageIndex
  let siblingPath = op.siblingPath
  let withdrawEpoch: bigint | undefined = op.epoch != null ? BigInt(op.epoch) : undefined
  let l2BlockNumber = op.l2BlockNumber
  let rollupVersion: number | undefined = op.rollupVersion ?? config.rollupVersion
  let l1RollupAddress = op.l1RollupAddress ?? config.l1ContractAddresses.rollupAddress

  // Step 1: burn already done
  onStep?.(1, 'completed')
  patchOperationAsync(apiClient, op.id, { currentStep: 2 })

  // ═════════════════════════════════════════════════════════════════════
  // Step 2: Recompute witness if missing
  // ═════════════════════════════════════════════════════════════════════
  const needsWitness = !l2ToL1MessageIndex || !siblingPath || siblingPath.length === 0

  if (needsWitness) {
    onStep?.(2, 'active')
    console.log('[SDK Resume L2→L1] Witness data missing — recomputing...')

    // Recover l2BlockNumber if missing
    let blockNum: number | undefined
    if (l2BlockNumber) {
      blockNum = Number(l2BlockNumber)
    } else if (op.l2TxHash) {
      emit({ type: 'recovery_l2_block', l2TxHash: op.l2TxHash, l2BlockNumber: 0 })
      try {
        blockNum = await recoverL2BlockNumber(aztecNode, op.l2TxHash)
        l2BlockNumber = String(blockNum)
        emit({ type: 'recovery_l2_block', l2TxHash: op.l2TxHash, l2BlockNumber: blockNum })
        await patchOperationWithRetry(apiClient, op.id, { l2BlockNumber: String(blockNum) }, { label: 'recovered l2BlockNumber' })
      } catch (recoverErr) {
        // If receipt polling fails but we have l2BlockNumberBeforeTx, fall through to block scan
        if (op.l2BlockNumberBeforeTx) {
          console.warn('[SDK Resume L2→L1] recoverL2BlockNumber failed, falling through to block scan:', recoverErr)
        } else {
          throw recoverErr
        }
      }
    }
    // Block scan fallback — used when l2TxHash recovery failed OR when only l2BlockNumberBeforeTx is available
    if (!blockNum && op.l2BlockNumberBeforeTx) {
      // Block scan fallback
      const startBlock = Number(op.l2BlockNumberBeforeTx)
      const currentBlock = await aztecNode.getBlockNumber()
      console.log('[SDK Resume L2→L1] Scanning L2 blocks', startBlock, '→', currentBlock, '...')

      if (rollupVersion == null) {
        const nodeInfo = await aztecNode.getNodeInfo()
        rollupVersion = nodeInfo?.rollupVersion != null ? Number(nodeInfo.rollupVersion) : undefined
        const l1Addresses = nodeInfo?.l1ContractAddresses as Record<string, any> | undefined
        l1RollupAddress = l1RollupAddress ?? l1Addresses?.rollupAddress?.toString()
      }
      if (rollupVersion == null || !l1RollupAddress) {
        throw new Error(
          `l2BlockNumber and l2TxHash both missing. Rollup info unavailable for block scan. ` +
          `We know the tx was after L2 block ${startBlock}. Contact support with your operation ID.`,
        )
      }

      const msgLeaf = computeL2ToL1MessageLeaf({
        l1Recipient: l1Address,
        amount,
        l2BridgeAddress: op.bridgeAddressL2!,
        portalAddress: op.portalAddressL1!,
        rollupVersion,
        chainId: op.chainIdL1 ?? config.l1ChainId,
      })

      let foundBlock: number | undefined
      for (let b = startBlock; b <= currentBlock; b++) {
        try {
          const result = await computeWitness(aztecNode, b, msgLeaf, op.l2TxHash!)
          if (result.leafIndex != null) {
            foundBlock = b
            l2ToL1MessageIndex = result.leafIndex
            siblingPath = result.siblingPath
            withdrawEpoch = result.epoch
            console.log('[SDK Resume L2→L1] Found burn tx in L2 block', b, 'leafIndex=', result.leafIndex)
            break
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : ''
          if (msg.includes('message not found') || msg.includes('does not match')) {
            continue
          }
          console.warn('[SDK Resume L2→L1] Error scanning block', b, ':', msg)
        }
      }

      if (!foundBlock) {
        throw new Error(
          `Could not find L2→L1 message in blocks ${startBlock}–${currentBlock}. ` +
          'The burn tx may not have been mined yet. Try resuming again later, or contact support.',
        )
      }

      blockNum = foundBlock
      l2BlockNumber = String(foundBlock)

      // Persist recovered witness data
      await patchOperationWithRetry(apiClient, op.id, {
        status: 'ready',
        l2ToL1MessageIndex,
        siblingPath,
        epoch: withdrawEpoch != null ? Number(withdrawEpoch) : undefined,
        l2BlockNumber: String(foundBlock),
        currentStep: 3,
      }, { label: 'recovered witness from block scan' })
    } else if (!blockNum) {
      throw new Error(
        'Cannot recover witness: no l2BlockNumber, l2TxHash, or l2BlockNumberBeforeTx. Contact support.',
      )
    }

    if (!blockNum || blockNum === 0) {
      throw new Error('L2 block number is required for witness computation.')
    }

    // If we recovered blockNum but didn't compute witness via block scan above, do it now
    if (!l2ToL1MessageIndex || !siblingPath || siblingPath.length === 0) {
      if (rollupVersion == null) {
        const nodeInfo = await aztecNode.getNodeInfo()
        rollupVersion = nodeInfo?.rollupVersion != null ? Number(nodeInfo.rollupVersion) : undefined
        const l1Addresses = nodeInfo?.l1ContractAddresses as Record<string, any> | undefined
        l1RollupAddress = l1RollupAddress ?? l1Addresses?.rollupAddress?.toString()
      }

      if (rollupVersion == null) {
        throw new Error('Rollup version not available. Cannot compute L2→L1 message leaf.')
      }
      if (!l1RollupAddress) {
        throw new Error('Rollup address not available. Cannot convert block number to epoch for L2→L1 witness.')
      }

      const msgLeaf = computeL2ToL1MessageLeaf({
        l1Recipient: l1Address,
        amount,
        l2BridgeAddress: op.bridgeAddressL2!,
        portalAddress: op.portalAddressL1!,
        rollupVersion,
        chainId: op.chainIdL1 ?? config.l1ChainId,
      })

      const witnessResult = await computeWitness(aztecNode, blockNum, msgLeaf, op.l2TxHash!)
      l2ToL1MessageIndex = witnessResult.leafIndex
      siblingPath = witnessResult.siblingPath
      withdrawEpoch = witnessResult.epoch

      // Persist witness data — only send l2BlockNumber if not already stored
      const witnessPatchData: Record<string, unknown> = {
        status: 'ready',
        l2ToL1MessageIndex,
        siblingPath,
        epoch: withdrawEpoch != null ? Number(withdrawEpoch) : undefined,
        currentStep: 3,
      }
      if (!op.l2BlockNumber && blockNum != null) witnessPatchData.l2BlockNumber = String(blockNum)
      await patchOperationWithRetry(apiClient, op.id, witnessPatchData, { label: 'witness data' })
    }

    // Update localStorage with witness data
    updateWithdrawal(
      (w: any) => w.id === op.id,
      (w: any) => ({
        ...w,
        l2ToL1MessageIndex: l2ToL1MessageIndex!,
        siblingPath: siblingPath as string[],
        status: 'ready',
      }),
    )

    emit({
      type: 'witness_computed',
      leafIndex: l2ToL1MessageIndex!,
      siblingPath: siblingPath as string[],
      epoch: Number(withdrawEpoch ?? 0),
    })

    onStep?.(2, 'completed')
  } else {
    // Witness already available
    onStep?.(2, 'completed')
    console.log('[SDK Resume L2→L1] Witness already available: leafIndex=', l2ToL1MessageIndex)
  }

  // ═════════════════════════════════════════════════════════════════════
  // Step 3: Wait for L2 block to be proven on L1
  // ═════════════════════════════════════════════════════════════════════
  onStep?.(3, 'active')
  patchOperationAsync(apiClient, op.id, { currentStep: 3 })

  const blockNumberForProof = Number(l2BlockNumber)
  if (!blockNumberForProof || isNaN(blockNumberForProof)) {
    throw new Error(
      'l2BlockNumber is required for proof polling but is missing or invalid. ' +
      'Resume from the Activity page to recover the block number first.',
    )
  }

  // Ensure we have rollup address for polling
  if (!l1RollupAddress) {
    try {
      const nodeInfo = await aztecNode.getNodeInfo()
      const l1Addresses = nodeInfo?.l1ContractAddresses as Record<string, any> | undefined
      l1RollupAddress = l1Addresses?.rollupAddress?.toString()
    } catch {
      // Will fall back to fixed wait
    }
  }

  // If epoch wasn't set during witness computation, convert block → epoch now.
  // The checkpoint may not be available immediately after the block is proven,
  // so retry up to 5 times with a 30s delay (matches old frontend behavior).
  if (withdrawEpoch == null && l1RollupAddress) {
    const { RollupAbi } = await import('@aztec/l1-artifacts')
    const maxRetries = 5
    const retryDelayMs = 30_000
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const epochRaw = await publicClient.readContract({
          address: l1RollupAddress as `0x${string}`,
          abi: RollupAbi,
          functionName: 'getEpochForCheckpoint',
          args: [BigInt(blockNumberForProof)],
        })
        withdrawEpoch = typeof epochRaw === 'bigint' ? epochRaw : BigInt(epochRaw as number)
        console.log('[SDK Resume L2→L1] Block', blockNumberForProof, '→ Epoch', withdrawEpoch.toString())
        break
      } catch (epochErr) {
        if (attempt === maxRetries) {
          throw new Error(
            `Failed to get epoch for block ${blockNumberForProof} after ${maxRetries} attempts: ${epochErr instanceof Error ? epochErr.message : String(epochErr)}`,
          )
        }
        console.warn(`[SDK Resume L2→L1] getEpochForCheckpoint attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelayMs / 1000}s...`)
        await wait(retryDelayMs)
      }
    }
  }
  if (withdrawEpoch == null) {
    throw new Error('Could not determine epoch for L1 withdraw. Rollup address not available.')
  }

  // Check return value — don't proceed if block isn't proven
  const provenResult = await waitForBlockProven({
    aztecNode,
    blockNumberForProof,
    onPoll: (provenBlock, neededBlock, elapsedMs) => {
      emit({ type: 'proven_poll', provenBlock, neededBlock, elapsedMs })
    },
    onFallback: (fixedWaitMs) => {
      emit({ type: 'proven_fallback', fixedWaitMs })
    },
  })

  // Match happy path behavior: only hard-fail when polling was available
  // but the block still wasn't proven. When polling is unavailable (no
  // rollupAddress), proceed — the L1 withdraw will revert if not proven.
  if (!provenResult.proven && provenResult.usedPoll) {
    throw new Error(
      `L2 block ${blockNumberForProof} was not proven on L1 after waiting. ` +
      'You can resume this withdrawal later from the Activity page.'
    )
  }
  if (!provenResult.proven) {
    console.warn('[SDK Resume L2→L1] Block proven status unknown (polling unavailable). Proceeding — L1 withdraw may revert.')
  }

  onStep?.(3, 'completed')

  // Final buffer before L1 withdraw
  console.log('[SDK Resume L2→L1] Final wait before L1 withdraw (30s)...')
  await wait(30_000)

  // ═════════════════════════════════════════════════════════════════════
  // Step 4: Send L1 withdraw tx
  // ═════════════════════════════════════════════════════════════════════
  onStep?.(4, 'active')
  patchOperationAsync(apiClient, op.id, { currentStep: 4 })

  let withdrawL1TxHash: string | undefined
  let withdrawL1TxUrl: string | undefined
  let withdrawL1BlockNumber: string | undefined
  let alreadyWithdrawn = false

  try {
    const withdrawResult = await executeL1Withdraw({
      publicClient,
      sendTransaction,
      l1Address,
      amount,
      epoch: withdrawEpoch,
      leafIndex: l2ToL1MessageIndex!,
      siblingPath: siblingPath as string[],
      portalAddress: op.portalAddressL1,
      chainId: op.chainIdL1 ?? config.l1ChainId,
      l2BlockNumber: Number(l2BlockNumber),
      outboxAddress: op.l1OutboxAddress ?? config.l1ContractAddresses.outboxAddress,
    })

    withdrawL1TxHash = withdrawResult.l1TxHash
    withdrawL1TxUrl = withdrawResult.l1TxUrl
    withdrawL1BlockNumber = withdrawResult.l1BlockNumber

    if (withdrawL1TxHash === 'already-consumed') {
      alreadyWithdrawn = true
    } else {
      emit({ type: 'l1_withdraw_sent', l1TxHash: withdrawL1TxHash, l1TxUrl: withdrawL1TxUrl })
    }
  } catch (withdrawErr) {
    // If the withdraw reverts because the message was already consumed
    // (previous resume succeeded but completion PATCH didn't), treat as success.
    const errMsg = withdrawErr instanceof Error ? withdrawErr.message : String(withdrawErr)
    if (isAlreadyConsumedError(errMsg)) {
      console.log('[SDK Resume L2→L1] Withdraw already consumed — treating as previously completed.')
      alreadyWithdrawn = true
      withdrawL1TxHash = op.l1TxHash ?? 'already-withdrawn'
      withdrawL1TxUrl = op.l1TxUrl ?? ''
    } else {
      throw withdrawErr
    }
  }

  // Mark as completed on backend
  // Only send l1TxHash/l1TxUrl if they carry real values — don't overwrite
  // a real tx hash in the DB with an 'already-withdrawn' sentinel.
  const completionPatchData: Record<string, unknown> = {
    status: 'completed',
    completedAt: new Date().toISOString(),
    currentStep: 5,
  }
  if (withdrawL1TxHash && withdrawL1TxHash !== 'already-withdrawn') {
    completionPatchData.l1TxHash = withdrawL1TxHash
    completionPatchData.l1TxUrl = withdrawL1TxUrl
  }
  if (withdrawL1BlockNumber) completionPatchData.l1BlockNumber = withdrawL1BlockNumber
  await patchOperationWithRetry(apiClient, op.id, completionPatchData, { label: 'L2→L1 resume completion' })

  onStep?.(4, 'completed')

  // ═════════════════════════════════════════════════════════════════════
  // Step 5: Done
  // ═════════════════════════════════════════════════════════════════════
  onStep?.(5, 'active')
  emit({ type: 'operation_completed', operationId: op.id, l1TxHash: withdrawL1TxHash, l2TxHash: op.l2TxHash ?? undefined })

  // Mark localStorage withdrawal as completed with URL fields
  updateWithdrawal(
    (w: any) => w.id === op.id,
    (w: any) => ({
      ...w,
      success: true,
      status: 'completed',
      l1TxHash: withdrawL1TxHash,
      l1TxUrl: withdrawL1TxUrl,
      l2TxUrl: op.l2TxUrl ?? undefined,
      completedAt: Date.now(),
    }),
  )

  await wait(3000)
  onStep?.(5, 'completed')

  return {
    operationId: op.id,
    l1TxHash: withdrawL1TxHash,
    l2TxHash: op.l2TxHash ?? undefined,
    l1TxUrl: withdrawL1TxUrl,
    l2TxUrl: op.l2TxUrl ?? undefined,
  }
  } catch (err) {
    emit({
      type: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      fundsAtRisk: true,
    })
    throw err
  }
}

// ─── Already-Consumed Detection ─────────────────────────────────────

/**
 * Detects whether an error indicates the L1→L2 message or L2→L1 message
 * was already consumed (i.e., a previous resume attempt succeeded but the
 * completion PATCH didn't persist).
 *
 * Known patterns:
 * - Aztec L2 claim: "l1_to_l2_msg_exists" / "nonexistent L1-to-L2 message" (already consumed)
 * - Aztec L2 claim: "already nullified" / "note already consumed"
 * - L1 TokenPortal withdraw: "Nothing to consume" / "NothingToConsumeAtBlock"
 * - L1 Outbox: "already consumed" / "AlreadyConsumed"
 *
 * NOTE: Do NOT add generic patterns like /execution reverted/ — that would
 * silently swallow real L1 failures (wrong epoch, bad proof, contract paused)
 * and mark the operation as completed when funds never arrived.
 */
function isAlreadyConsumedError(errMsg: string): boolean {
  const patterns = [
    /already\s*(nullified|consumed)/i,
    /nothing\s*to\s*consume/i,
    /NothingToConsumeAtBlock/i,
    /AlreadyConsumed/i,
    /message.*already.*consumed/i,
    /note.*already.*consumed/i,
    /nonexistent L1-to-L2 message/i,
    /l1_to_l2_msg_exists/i,
    // Known consumed-state custom error selectors (match even if the contract
    // renames the error string in a future deploy).
    // NothingToConsumeAtBlock(uint256,uint256) = keccak256 selector 0x945d8c59
    /0x945d8c59/i,
  ]
  return patterns.some((p) => p.test(errMsg))
}

