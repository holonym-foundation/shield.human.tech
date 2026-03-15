import { useMutation } from '@tanstack/react-query'
import { Fr } from '@aztec/aztec.js/fields'
import { useBridgeStore, type RecoveryClaimData } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import { useToast } from './useToast'
import { wait } from '@/utils'
import { getAztecscanUrl, L1_CHAIN_ID, L1_TOKENS, L2_CHAIN_ID } from '@/config'
import { BridgeOperationStatus } from '@prisma/client'
import { TokenPortalAbi } from '@aztec/l1-artifacts'
import { extractEvent } from '@aztec/ethereum/utils'
import { decodeEventLog } from 'viem'
import { SWAP_BRIDGE_ROUTER_ADDRESS } from '@/config'
import { SwapBridgeRouterAbi } from '@/constants/abis/SwapBridgeRouterAbi'
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
} from './bridge/bridgeL1ToL2'

/**
 * Recover messageHash and messageLeafIndex from an L1 transaction receipt.
 * Used when these values were not stored (e.g. page crash between deposit and receipt parsing).
 */
async function recoverFromReceipt(
  l1TxHash: string,
  portalAddress: string,
  claimSecretHash: string,
  amount: bigint,
  aztecAddress: string,
  isPrivacyModeEnabled: boolean,
): Promise<{ messageHash: string; messageLeafIndex: string }> {
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
          const messageHash = (args.key ?? args.tokenKey).toString()
          const messageLeafIndex = (args.index ?? args.tokenIndex).toString()
          console.log('[Resume L1→L2] Recovered from router event:', { messageHash, messageLeafIndex })
          return { messageHash, messageLeafIndex }
        }
      } catch {
        // Not our event, skip
      }
    }
  }

  // Fallback: try DepositToAztecPublic/Private from TokenPortal (legacy path)
  const eventName = isPrivacyModeEnabled
    ? 'DepositToAztecPrivate'
    : 'DepositToAztecPublic'

  const privateFilter = (log: any) =>
    log.args.amount === amount &&
    log.args.secretHashForL2MessageConsumption === claimSecretHash

  const publicFilter = (log: any) =>
    log.args.secretHash === claimSecretHash &&
    log.args.amount === amount &&
    log.args.to === aztecAddress

  const log = extractEvent(
    receipt.logs,
    portalAddress as `0x${string}`,
    TokenPortalAbi,
    eventName,
    isPrivacyModeEnabled ? privateFilter : publicFilter,
  )

  const messageHash = log.args.key.toString()
  const messageLeafIndex = log.args.index.toString()
  console.log('[Resume L1→L2] Recovered from receipt: messageHash=', messageHash, 'leafIndex=', messageLeafIndex)
  return { messageHash, messageLeafIndex }
}

/**
 * Recover messageHash and messageLeafIndex by scanning L1 blocks for portal events.
 * Last-resort recovery when l1TxHash is also missing (e.g. crash right after sending tx).
 */
async function recoverFromBlockScan(
  l1BlockNumberBeforeTx: string,
  portalAddress: string,
  claimSecretHash: string,
  amount: bigint,
  aztecAddress: string,
  isPrivacyModeEnabled: boolean,
): Promise<{ messageHash: string; messageLeafIndex: string }> {
  const fromBlock = BigInt(l1BlockNumberBeforeTx)
  const currentBlock = await publicClient.getBlockNumber()
  // Scan up to 2000 blocks (enough for ~7 hours at 12s/block)
  const toBlock = fromBlock + 2000n > currentBlock ? currentBlock : fromBlock + 2000n

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
          const messageHash = (args.key ?? args.tokenKey).toString()
          const messageLeafIndex = (args.index ?? args.tokenIndex).toString()
          console.log('[Resume L1→L2] Found router event in block scan:', { messageHash, messageLeafIndex })
          return { messageHash, messageLeafIndex }
        }
      } catch {
        // Not our event, skip
      }
    }

    // Fallback: try TokenPortal events (legacy path)
    try {
      const decoded = decodeEventLog({
        abi: TokenPortalAbi,
        data: rawLog.data,
        topics: rawLog.topics,
      })
      if (decoded.eventName !== targetEventName) continue

      const args = decoded.args as any
      const matches = isPrivacyModeEnabled
        ? args.amount === amount && args.secretHashForL2MessageConsumption === claimSecretHash
        : args.secretHash === claimSecretHash && args.amount === amount && args.to === aztecAddress

      if (matches) {
        const messageHash = args.key.toString()
        const messageLeafIndex = args.index.toString()
        console.log('[Resume L1→L2] Found event in block scan: messageHash=', messageHash, 'leafIndex=', messageLeafIndex)
        return { messageHash, messageLeafIndex }
      }
    } catch {
      // Skip logs that can't be decoded with our ABI
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
    } = claimData

    let { messageHash, messageLeafIndex } = claimData

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

    const portalAddress = portalAddressL1 || L1_TOKENS[0]?.l1PortalContract || ''
    if (!portalAddressL1) {
      console.warn('[Resume L1→L2] portalAddressL1 not stored in operation — falling back to L1_TOKENS[0]. This may be wrong for multi-token operations.')
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RECOVERY: Recover messageHash + messageLeafIndex if missing
    // ═══════════════════════════════════════════════════════════════════════
    if (!messageHash || !messageLeafIndex) {
      console.log('[Resume L1→L2] messageHash or messageLeafIndex missing — attempting recovery...')
      setProgressStep(1, 'active')

      try {
        const amountBigInt = BigInt(amount)
        const targetAddress = l2Address || aztecAddress

        if (l1TxHash) {
          // Path A: We have the L1 tx hash — get receipt and extract event
          const recovered = await recoverFromReceipt(
            l1TxHash,
            portalAddress,
            claimSecretHash,
            amountBigInt,
            targetAddress,
            isPrivacyModeEnabled,
          )
          messageHash = recovered.messageHash
          messageLeafIndex = recovered.messageLeafIndex
        } else if (l1BlockNumberBeforeTx) {
          // Path B: No tx hash — scan L1 blocks for portal events
          const recovered = await recoverFromBlockScan(
            l1BlockNumberBeforeTx,
            portalAddress,
            claimSecretHash,
            amountBigInt,
            targetAddress,
            isPrivacyModeEnabled,
          )
          messageHash = recovered.messageHash
          messageLeafIndex = recovered.messageLeafIndex
        } else {
          throw new Error(
            'Cannot resume: no messageHash, no l1TxHash, and no l1BlockNumberBeforeTx. ' +
            'There is not enough data to recover. Contact support.',
          )
        }

        // Persist recovered data to backend (3 retries)
        const ok = await patchOperationWithRetry(operationId, {
          status: 'deposited',
          messageHash,
          messageLeafIndex,
          currentStep: 2,
        }, { label: 'recovered data' })
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
    setProgressStep(2, 'completed')
    setProgressStep(3, 'active')
    patchOperationAsync(operationId, { currentStep: 3 })

    const claimSecretFr = Fr.fromString(claimSecret)
    const claimResult = await executeL2Claim(
      { walletAdapter, aztecAddress, isPrivacyModeEnabled },
      {
        amount: BigInt(amount),
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
      },
    )

    const l2TxHash = claimResult.l2TxHash
    if (claimResult.usedBruteForce && claimResult.bruteForceLeafIndex != null) {
      messageLeafIndex = claimResult.bruteForceLeafIndex.toString()
    }

    const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`
    setTransactionUrls(l1TxUrl ?? null, l2TxUrl)

    // Backend: mark operation as completed
    console.log('[Resume L1→L2] PATCH completed →', { operationId, status: 'completed', l2TxHash, currentStep: 4 })
    patchOperationAsync(operationId, {
      status: 'completed',
      l2TxHash,
      l2TxUrl,
      completedAt: new Date().toISOString(),
      currentStep: 4,
    })

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
