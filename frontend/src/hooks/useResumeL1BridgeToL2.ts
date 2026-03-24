import { useMutation } from '@tanstack/react-query'
import { Fr } from '@aztec/aztec.js/fields'
import { useBridgeStore, type RecoveryClaimData } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import { useToast } from './useToast'
import { wait } from '@/utils'
import { getAztecscanUrl, BRIDGED_FPC_ADDRESS, L1_CHAIN_ID, L1_TOKENS, L2_CHAIN_ID } from '@/config'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { BridgeOperationStatus } from '@prisma/client'
// import { TokenPortalAbi } from '@aztec/l1-artifacts'
// @ts-ignore — JSON import from forge build output (custom compliant portal w/ attestation structs)
import CustomTokenPortalJson from '../../../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
const CustomTokenPortalAbi = CustomTokenPortalJson.abi
import { decodeEventLog, parseEventLogs } from 'viem'
import { extractEvent } from '@aztec/ethereum/utils'
import { SWAP_BRIDGE_ROUTER_ADDRESS } from '@/config'
import { SwapBridgeRouterAbi } from '@/constants/abis/SwapBridgeRouterAbi'
import { api } from '@/lib/api'
import {
  LS_KEY_BRIDGE_DEPOSITS,
  patchOperationWithRetry,
  patchOperationAsync,
  updateLocalStorageItem,
  publicClient,
} from './bridge/bridgeUtils'
import {
  pollL1ToL2MessageSync,
  executeL2Claim,
  getPostFeeClaimAmount,
  CustomTokenPortalEventAbi,
} from './bridge/bridgeL1ToL2'

/** Recovery result with optional fuel fields from BridgeWithFuel events */
interface RecoveryResult {
  messageHash: string
  messageLeafIndex: string
  /** Post-fee claim amount from the TokenPortal deposit event (source of truth for L2 claim). */
  claimAmount?: string
  fuelMessageHash?: string
  fuelMessageLeafIndex?: string
  fuelAmount?: string
}

/**
 * Recover messageHash and messageLeafIndex from an L1 transaction receipt.
 * Used when these values were not stored (e.g. page crash between deposit and receipt parsing).
 * Also extracts fuel fields from BridgeWithFuel events when present.
 */
async function recoverFromReceipt(
  l1TxHash: string,
  portalAddress: string,
  claimSecretHash: string,
  amount: bigint,
  aztecAddress: string,
  isPrivacyModeEnabled: boolean,
): Promise<RecoveryResult> {
  console.log('[Resume L1→L2] Recovering messageHash from L1 receipt (txHash=', l1TxHash, ')...')

  const receipt = await publicClient.getTransactionReceipt({
    hash: l1TxHash as `0x${string}`,
  })

  // Try SwapBridgeRouter Bridge event first (our custom portal has different event signatures)
  if (SWAP_BRIDGE_ROUTER_ADDRESS) {
    for (const txLog of receipt.logs) {
      if (txLog.address.toLowerCase() !== SWAP_BRIDGE_ROUTER_ADDRESS.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: SwapBridgeRouterAbi,
          data: txLog.data,
          topics: txLog.topics,
        })
        if (decoded.eventName === 'Bridge' || decoded.eventName === 'BridgeWithFuel') {
          const args = decoded.args as any
          // Verify this event belongs to the user by checking secretHash
          const eventSecretHash = (args.secretHash ?? args.tokenSecretHash)?.toString()
          if (eventSecretHash && eventSecretHash !== claimSecretHash) continue
          const messageHash = (args.key ?? args.tokenKey).toString()
          const messageLeafIndex = (args.index ?? args.tokenIndex).toString()
          const result: RecoveryResult = { messageHash, messageLeafIndex }
          // Extract fuel fields from BridgeWithFuel events
          if (decoded.eventName === 'BridgeWithFuel') {
            if (args.fuelKey) result.fuelMessageHash = args.fuelKey.toString()
            if (args.fuelIndex != null) result.fuelMessageLeafIndex = args.fuelIndex.toString()
            if (args.fuelAmount) result.fuelAmount = args.fuelAmount.toString()
          }
          // Extract post-fee claimAmount from the TokenPortal event in the same receipt
          // (the router calls TokenPortal which emits DepositToAztecPublic/Private with the post-fee amount)
          const portalEventName = isPrivacyModeEnabled ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'
          for (const portalLog of receipt.logs) {
            if (portalLog.address.toLowerCase() !== portalAddress.toLowerCase()) continue
            try {
              const portalDecoded = decodeEventLog({
                abi: CustomTokenPortalEventAbi,
                data: portalLog.data,
                topics: portalLog.topics,
              })
              if (portalDecoded.eventName === portalEventName) {
                const portalArgs = portalDecoded.args as any
                if (portalArgs.amount != null) {
                  result.claimAmount = portalArgs.amount.toString()
                }
                break
              }
            } catch {
              // Not a portal event, skip
            }
          }
          console.log('[Resume L1→L2] Recovered from router event:', result)
          return result
        }
      } catch {
        // Not our event, skip
      }
    }
  }

  // Fallback: try DepositToAztecPublic/Private from TokenPortal (legacy path)
  // Try our custom ABI first (has fee field), then upstream as fallback
  const eventName = isPrivacyModeEnabled
    ? 'DepositToAztecPrivate'
    : 'DepositToAztecPublic'

  // Match by secretHash only — event amount is post-fee (amountAfterFee),
  // so we can't filter by the pre-fee amount the recovery data stores.
  const privateFilter = (log: any) =>
    log.args.secretHash === claimSecretHash

  const publicFilter = (log: any) =>
    log.args.secretHash === claimSecretHash &&
    log.args.to === aztecAddress

  const filter = isPrivacyModeEnabled ? privateFilter : publicFilter

  for (const abi of [CustomTokenPortalEventAbi, CustomTokenPortalAbi]) {
    try {
      const log = extractEvent(
        receipt.logs,
        portalAddress as `0x${string}`,
        abi,
        eventName,
        filter,
      )
      const messageHash = log.args.key.toString()
      const messageLeafIndex = log.args.index.toString()
      const result: RecoveryResult = { messageHash, messageLeafIndex }
      // Extract post-fee claimAmount from the deposit event (amount field is post-fee)
      if (log.args.amount != null) {
        result.claimAmount = log.args.amount.toString()
      }
      console.log('[Resume L1→L2] Recovered from receipt:', result)
      return result
    } catch {
      // This ABI didn't match, try next
    }
  }
  throw new Error('Could not extract deposit event from receipt (tried custom + upstream ABIs)')
}

/**
 * Recover messageHash and messageLeafIndex by scanning L1 blocks for portal events.
 * Last-resort recovery when l1TxHash is also missing (e.g. crash right after sending tx).
 * Also extracts fuel fields from BridgeWithFuel events when present.
 */
async function recoverFromBlockScan(
  l1BlockNumberBeforeTx: string,
  portalAddress: string,
  claimSecretHash: string,
  amount: bigint,
  aztecAddress: string,
  isPrivacyModeEnabled: boolean,
): Promise<RecoveryResult> {
  const fromBlock = BigInt(l1BlockNumberBeforeTx)
  const currentBlock = await publicClient.getBlockNumber()
  // Scan up to 50000 blocks (~7 days at 12s/block) to cover delayed resumes
  const toBlock = fromBlock + 50000n > currentBlock ? currentBlock : fromBlock + 50000n

  console.log('[Resume L1→L2] Scanning L1 blocks', fromBlock.toString(), '→', toBlock.toString(), 'for portal events...')

  const addresses = [portalAddress as `0x${string}`]
  if (SWAP_BRIDGE_ROUTER_ADDRESS) {
    addresses.push(SWAP_BRIDGE_ROUTER_ADDRESS as `0x${string}`)
  }
  const logs = await publicClient.getLogs({
    address: addresses,
    fromBlock,
    toBlock,
  })

  const targetEventName = isPrivacyModeEnabled
    ? 'DepositToAztecPrivate'
    : 'DepositToAztecPublic'

  for (const rawLog of logs) {
    // Try SwapBridgeRouter events first
    if (SWAP_BRIDGE_ROUTER_ADDRESS && rawLog.address.toLowerCase() === SWAP_BRIDGE_ROUTER_ADDRESS.toLowerCase()) {
      try {
        const decoded = decodeEventLog({
          abi: SwapBridgeRouterAbi,
          data: rawLog.data,
          topics: rawLog.topics,
        })
        if (decoded.eventName === 'Bridge' || decoded.eventName === 'BridgeWithFuel') {
          const args = decoded.args as any
          // Verify this event belongs to the user by checking secretHash
          const eventSecretHash = (args.secretHash ?? args.tokenSecretHash)?.toString()
          if (eventSecretHash && eventSecretHash !== claimSecretHash) continue
          const messageHash = (args.key ?? args.tokenKey).toString()
          const messageLeafIndex = (args.index ?? args.tokenIndex).toString()
          const result: RecoveryResult = { messageHash, messageLeafIndex }
          if (decoded.eventName === 'BridgeWithFuel') {
            if (args.fuelKey) result.fuelMessageHash = args.fuelKey.toString()
            if (args.fuelIndex != null) result.fuelMessageLeafIndex = args.fuelIndex.toString()
            if (args.fuelAmount) result.fuelAmount = args.fuelAmount.toString()
          }
          // Extract post-fee claimAmount from the TokenPortal event in the same tx
          const portalEventName = isPrivacyModeEnabled ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'
          for (const portalLog of logs) {
            if (portalLog.transactionHash !== rawLog.transactionHash) continue
            if (portalLog.address.toLowerCase() === (SWAP_BRIDGE_ROUTER_ADDRESS ?? '').toLowerCase()) continue
            try {
              const portalDecoded = decodeEventLog({
                abi: CustomTokenPortalEventAbi,
                data: portalLog.data,
                topics: portalLog.topics,
              })
              if (portalDecoded.eventName === portalEventName) {
                const portalArgs = portalDecoded.args as any
                if (portalArgs.amount != null) {
                  result.claimAmount = portalArgs.amount.toString()
                }
                break
              }
            } catch {
              // Not a portal event, skip
            }
          }
          console.log('[Resume L1→L2] Found router event in block scan:', result)
          return result
        }
      } catch {
        // Not our event, skip
      }
    }

    // Fallback: try TokenPortal events (custom ABI first, then upstream)
    for (const abi of [CustomTokenPortalEventAbi, CustomTokenPortalAbi]) {
      try {
        const decoded = decodeEventLog({
          abi,
          data: rawLog.data,
          topics: rawLog.topics,
        })
        if (decoded.eventName !== targetEventName) continue

        const args = decoded.args as any
        // Match by secretHash only — event amount is post-fee (amountAfterFee),
        // so we can't filter by the pre-fee amount the recovery data stores.
        const matches = isPrivacyModeEnabled
          ? args.secretHash === claimSecretHash
          : args.secretHash === claimSecretHash && args.to === aztecAddress

        if (matches) {
          const messageHash = args.key.toString()
          const messageLeafIndex = args.index.toString()
          const result: RecoveryResult = { messageHash, messageLeafIndex }
          if (args.amount != null) {
            result.claimAmount = args.amount.toString()
          }
          console.log('[Resume L1→L2] Found event in block scan:', result)
          return result
        }
      } catch {
        // Skip logs that can't be decoded with this ABI
      }
    }
  }

  throw new Error(
    `Could not find deposit event in blocks ${fromBlock}–${toBlock}. ` +
    'The deposit may not have been mined yet, or the block range may need to be extended. ' +
    'Try resuming again later.'
  )
}

/**
 * Hook to resume an incomplete L1→L2 bridge operation.
 *
 * Determines the current stage from RecoveryClaimData and picks up
 * from where the user left off:
 *
 * Stage 1: has messageHash + messageLeafIndex → poll for sync → claim on L2
 * Stage 2: has l1TxHash but no messageHash → recover from L1 receipt → then Stage 1
 * Stage 3: has l1BlockNumberBeforeTx only → scan L1 blocks → then Stage 1
 * Stage 4: brute-force messageLeafIndex if extraction gave messageHash but not index
 *
 * Pre-deposit failures (status=pending/failed with no l1TxHash) are safe — no funds at risk.
 */
export function useResumeL1BridgeToL2(onSuccess?: (data: any) => void) {
  const { setProgressStep, setTransactionUrls, clearRecovery } =
    useBridgeStore()
  const { aztecAddress, aztecLoginMethod } = useWalletStore()
  const walletAdapter = useWalletAdapter()
  const notify = useToast()

  const mutationFn = async (
    claimData: RecoveryClaimData,
  ): Promise<string | undefined> => {
    const {
      operationId,
      claimSecret,
      claimSecretHash,
      amount,
      l2Address,
      l1TxHash,
      l1TxUrl,
      l1BlockNumberBeforeTx,
      isPrivacyModeEnabled,
      portalAddressL1,
      // Fuel recovery fields (from decrypted blob)
      fuelSecret,
      privateFuelSalt,
      privateFuelSecret,
    } = claimData

    let { messageHash, messageLeafIndex } = claimData
    // Fuel receipt fields — may be populated from DB or recovered from L1 events
    let fuelMessageLeafIndex = claimData.fuelMessageLeafIndex
    let fuelAmount = claimData.fuelAmount
    // Post-fee claim amount — prefer DB value, backfill from recovery if needed
    let recoveredClaimAmount: string | null = claimData.claimAmount

    console.log('[Resume L1→L2] Starting resume with recovery data:', {
      operationId,
      hasClaimSecret: !!claimSecret,
      hasClaimSecretHash: !!claimSecretHash,
      amount,
      l2Address,
      l1TxHash: l1TxHash ? l1TxHash.slice(0, 14) + '...' : null,
      l1TxUrl: l1TxUrl ? 'set' : null,
      l1BlockNumberBeforeTx,
      isPrivacyModeEnabled,
      messageHash: messageHash ?? null,
      messageLeafIndex: messageLeafIndex ?? null,
      currentStep: claimData.currentStep ?? null,
    })

    if (!aztecAddress) {
      throw new Error('Aztec wallet not connected')
    }
    if (!walletAdapter) {
      throw new Error(
        'Aztec wallet adapter not initialized. Please wait for wallet to connect.',
      )
    }

    if (!portalAddressL1) {
      throw new Error(
        'portalAddressL1 not stored in operation. Cannot resume without knowing which token portal to use. Contact support with your operation ID.',
      )
    }
    const portalAddress = portalAddressL1

    // ═══════════════════════════════════════════════════════════════════════
    // RECOVERY: Recover messageHash + messageLeafIndex if missing
    // ═══════════════════════════════════════════════════════════════════════
    if (!messageHash || !messageLeafIndex) {
      console.log('[Resume L1→L2] messageHash or messageLeafIndex missing — attempting recovery...')
      setProgressStep(1, 'active')

      try {
        const amountBigInt = BigInt(amount)
        const targetAddress = l2Address || aztecAddress

        let recovered: RecoveryResult
        if (l1TxHash) {
          // Path A: We have the L1 tx hash — get receipt and extract event
          recovered = await recoverFromReceipt(
            l1TxHash,
            portalAddress,
            claimSecretHash,
            amountBigInt,
            targetAddress,
            isPrivacyModeEnabled,
          )
        } else if (l1BlockNumberBeforeTx) {
          // Path B: No tx hash — scan L1 blocks for portal events
          recovered = await recoverFromBlockScan(
            l1BlockNumberBeforeTx,
            portalAddress,
            claimSecretHash,
            amountBigInt,
            targetAddress,
            isPrivacyModeEnabled,
          )
        } else {
          throw new Error(
            'Cannot resume: no messageHash, no l1TxHash, and no l1BlockNumberBeforeTx. ' +
            'There is not enough data to recover. Contact support.',
          )
        }

        messageHash = recovered.messageHash
        messageLeafIndex = recovered.messageLeafIndex
        // Backfill claimAmount and fuel receipt data from recovery
        if (recovered.claimAmount && !recoveredClaimAmount) {
          recoveredClaimAmount = recovered.claimAmount
        }
        if (recovered.fuelMessageLeafIndex && !fuelMessageLeafIndex) {
          fuelMessageLeafIndex = recovered.fuelMessageLeafIndex
        }
        if (recovered.fuelAmount && !fuelAmount) {
          fuelAmount = recovered.fuelAmount
        }

        // Persist recovered data to backend (3 retries)
        const patchData: Record<string, unknown> = {
          status: 'deposited',
          messageHash,
          messageLeafIndex,
          currentStep: 2,
        }
        // Also persist recovered fuel + claimAmount fields so they survive future session crashes
        if (recovered.claimAmount) patchData.claimAmount = recovered.claimAmount
        if (recovered.fuelMessageHash) patchData.fuelMessageHash = recovered.fuelMessageHash
        if (recovered.fuelMessageLeafIndex) patchData.fuelMessageLeafIndex = recovered.fuelMessageLeafIndex
        if (recovered.fuelAmount) patchData.fuelAmount = recovered.fuelAmount

        const ok = await patchOperationWithRetry(operationId, patchData, { label: 'recovered data' })
        if (ok) {
          console.log('[Resume L1→L2] Recovered data stored on backend')
        }
      } catch (recoveryError) {
        console.error('[Resume L1→L2] Recovery failed:', recoveryError)
        throw new Error(
          `Recovery failed: ${recoveryError instanceof Error ? recoveryError.message : 'Unknown error'}. ` +
          'Your funds are safe on L1. You can try resuming again later.',
        )
      }
    }

    // Set UI to show L1 tx URL if available
    if (l1TxUrl) {
      setTransactionUrls(l1TxUrl, null)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Step 2: Poll for L1→L2 message sync
    // ═══════════════════════════════════════════════════════════════════════
    setProgressStep(1, 'completed') // L1 deposit already done
    setProgressStep(2, 'active')
    patchOperationAsync(operationId, { currentStep: 2 })

    const syncResult = await pollL1ToL2MessageSync(messageHash!)
    if (!syncResult.synced) {
      throw new Error(
        `L1-to-L2 message sync timeout after ${syncResult.elapsedMinutes.toFixed(1)} minutes. You can try resuming again later.`,
      )
    }

    // Extra buffer so the message is visible on the wallet's node
    console.log('[Resume L1→L2] Final wait before claiming (2 min)...')
    await wait(120_000)

    // ═══════════════════════════════════════════════════════════════════════
    // Step 3: Claim on L2
    // ═══════════════════════════════════════════════════════════════════════

    // Guard: check if the operation was already completed (e.g. a previous claim
    // succeeded but the UI didn't update). Prevents double-claim confusion.
    if (operationId) {
      try {
        const { data } = await api.get(`/api/bridge/operations/${operationId}`)
        if (data?.status === 'completed') {
          notify('info', 'This deposit has already been claimed successfully.')
          setProgressStep(3, 'completed')
          return operationId
        }
      } catch {
        // Non-critical — proceed with the claim attempt
      }
    }

    setProgressStep(2, 'completed')
    setProgressStep(3, 'active')
    patchOperationAsync(operationId, { currentStep: 3 })

    const claimSecretFr = Fr.fromString(claimSecret)
    // TokenPortal deducts fees before computing the L1→L2 content hash.
    // The L2 claim must use the post-fee amount to match the content hash.
    // Priority: DB value > recovered from L1 event > re-derive from current fee rate (last resort).
    const preFeeBridgeAmount = BigInt(amount)
    const storedClaimAmount = recoveredClaimAmount
    const claimAmountPostFee = storedClaimAmount
      ? BigInt(storedClaimAmount)
      : await getPostFeeClaimAmount(portalAddress, preFeeBridgeAmount)

    // ── Build fuel fee payment method (if fuel data is available) ──
    // Same logic as useL1Operations.ts:883-945 — atomically claim FeeJuice and pay gas
    let feeOption: { fee: { paymentMethod: any; gasSettings?: any } } | undefined
    if (privateFuelSecret && privateFuelSalt && fuelMessageLeafIndex && fuelAmount && BRIDGED_FPC_ADDRESS) {
      // Private fuel path: BridgedMintAndPayFeePaymentMethod
      try {
        const { BridgedMintAndPayFeePaymentMethod, REASONABLE_GAS_LIMITS, maxFeesPerGasFromBaseFees } =
          await import('@defi-wonderland/aztec-fee-payment')
        const { Fr: FieldFr } = await import('@aztec/aztec.js/fields')
        const { Gas, GasFees } = await import('@aztec/stdlib/gas')
        const { aztecNode } = await import('@/aztec')

        const baseFees = await aztecNode.getCurrentMinFees()
        const maxFeesPerGas = maxFeesPerGasFromBaseFees(baseFees)
        const gasLimits = REASONABLE_GAS_LIMITS
        const teardownGasLimits = Gas.from({ l2Gas: 0, daGas: 0 })

        console.log('[Resume L1→L2] Building BridgedMintAndPayFeePaymentMethod (private fuel)')
        // Convert string secrets to Fr field elements for the Noir contract
        const fuelSecretFr = FieldFr.fromString(privateFuelSecret)
        const fuelSaltFr = FieldFr.fromString(privateFuelSalt)
        const paymentMethod = new BridgedMintAndPayFeePaymentMethod(
          AztecAddress.fromString(BRIDGED_FPC_ADDRESS),
          BigInt(fuelAmount),
          fuelSecretFr,
          fuelSaltFr,
          new FieldFr(BigInt(fuelMessageLeafIndex)),
        )
        feeOption = { fee: { paymentMethod, gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas, maxPriorityFeesPerGas: GasFees.empty() } } }
      } catch (err) {
        // Payment method construction failure is not recoverable — re-throw so the user
        // sees a clear error instead of a confusing "insufficient fee" later.
        throw new Error(`[Resume L1→L2] Failed to create BridgedMintAndPayFeePaymentMethod: ${err}`)
      }
    } else if (fuelSecret && fuelMessageLeafIndex && fuelAmount) {
      // Public fuel path: FeeJuicePaymentMethodWithClaim
      try {
        const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')
        console.log('[Resume L1→L2] Building FeeJuicePaymentMethodWithClaim (public fuel)')
        const paymentMethod = new FeeJuicePaymentMethodWithClaim(AztecAddress.fromString(aztecAddress), {
          claimAmount: BigInt(fuelAmount),
          claimSecret: Fr.fromString(fuelSecret),
          messageLeafIndex: BigInt(fuelMessageLeafIndex),
        })
        feeOption = { fee: { paymentMethod } }
      } catch (err) {
        throw new Error(`[Resume L1→L2] Failed to create FeeJuicePaymentMethodWithClaim: ${err}`)
      }
    }

    const claimResult = await executeL2Claim(
      { walletAdapter, aztecAddress, isPrivacyModeEnabled },
      {
        amount: claimAmountPostFee,
        claimSecret: claimSecretFr,
        messageLeafIndex: messageLeafIndex ? BigInt(messageLeafIndex) : null,
      },
      {
        onAttempt: (attempt, maxAttempts) => {
          notify('info', `Claiming tokens on L2 (attempt ${attempt}/${maxAttempts})...`)
        },
        onRetry: (attempt, maxAttempts, delayMs) => {
          notify('info', `L2 node hasn't synced this message yet. Retrying in ${Math.round(delayMs / 60_000)} min (${attempt}/${maxAttempts})...`)
        },
        feeOption,
      },
    )

    const l2TxHash = claimResult.l2TxHash
    if (claimResult.usedBruteForce && claimResult.bruteForceLeafIndex != null) {
      messageLeafIndex = claimResult.bruteForceLeafIndex.toString()
    }

    const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`
    setTransactionUrls(l1TxUrl ?? null, l2TxUrl)

    // Backend: mark operation as completed (retry — critical for DB consistency)
    console.log('[Resume L1→L2] PATCH completed →', { operationId, status: 'completed', l2TxHash, currentStep: 4 })
    await patchOperationWithRetry(operationId, {
      status: 'completed',
      l2TxHash,
      l2TxUrl,
      completedAt: new Date().toISOString(),
      currentStep: 4,
    }, { label: 'L1→L2 resume completion' })

    // Update localStorage
    updateLocalStorageItem(
      LS_KEY_BRIDGE_DEPOSITS,
      (c: any) => c.id === operationId,
      (c: any) => ({
        ...c,
        success: true,
        status: BridgeOperationStatus.completed,
        l2TxHash,
        l2TxUrl,
        completedAt: Date.now(),
      }),
    )

    // ═══════════════════════════════════════════════════════════════════════
    // Step 4: Complete
    // ═══════════════════════════════════════════════════════════════════════
    setProgressStep(3, 'completed')
    setProgressStep(4, 'active')
    await wait(3000)
    setProgressStep(4, 'completed')

    // Register token in wallet
    if (aztecLoginMethod && walletAdapter) {
      try {
        await walletAdapter.registerToken(walletAdapter.tokenAddress)
      } catch {
        // Not critical
      }
    }

    // Clear recovery state
    clearRecovery()

    return l2TxHash
  }

  return useMutation({
    mutationFn,
    onSuccess: (txHash) => {
      if (onSuccess) {
        onSuccess(txHash)
      }
    },
  })
}
