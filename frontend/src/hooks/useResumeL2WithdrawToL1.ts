import { useMutation } from '@tanstack/react-query'
import { useBridgeStore, type RecoveryWithdrawalData } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { useToast } from './useToast'
import { wait } from '@/utils'
import { aztecNode } from '@/aztec'
import { L1_CHAIN_ID, L1_TOKENS, L1_CONTRACT_ADDRESSES } from '@/config'
import {
  patchOperationWithRetry,
  patchOperationAsync,
} from './bridge/bridgeUtils'
import {
  computeL2ToL1MessageLeaf,
  computeWitness,
  waitForBlockProven,
  executeL1Withdraw,
} from './bridge/bridgeL2ToL1'

/**
 * Recover l2BlockNumber from l2TxHash by polling the Aztec node for the receipt.
 */
async function recoverL2BlockNumber(l2TxHash: string): Promise<number> {
  console.log('[Resume L2→L1] Recovering l2BlockNumber from l2TxHash...')
  for (let i = 0; i < 30; i++) {
    try {
      const receipt = await aztecNode.getTxReceipt(
        l2TxHash as unknown as Parameters<typeof aztecNode.getTxReceipt>[0],
      )
      if (receipt?.blockNumber != null) {
        console.log('[Resume L2→L1] Recovered l2BlockNumber=', receipt.blockNumber)
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

/**
 * Hook to resume an incomplete L2→L1 withdrawal operation.
 *
 * Determines the current stage from RecoveryWithdrawalData and picks up
 * from where the user left off:
 *
 * Stage: status=submitted → recompute witness (leafIndex + siblingPath) → wait for proven → L1 withdraw
 * Stage: status=ready → have witness → wait for proven → L1 withdraw
 *
 * The nonce is NOT needed for the L1 withdrawal — only for the L2 burn+exit (already done).
 * The L2→L1 message leaf is computed from: l1Address, amount, l2BridgeAddress, portalContract, rollupVersion, chainId.
 */
export function useResumeL2WithdrawToL1(onSuccess?: (data: any) => void) {
  const { setProgressStep, setTransactionUrls, clearRecovery } =
    useBridgeStore()
  const { waapAddress: l1Address } = useWalletStore()
  const notify = useToast()

  const mutationFn = async (
    data: RecoveryWithdrawalData,
  ): Promise<string | undefined> => {
    const {
      operationId,
      amount,
      l2TxHash,
      l2TxUrl,
      recipientL1Address,
      isPrivacyModeEnabled,
      status,
    } = data

    let {
      l2BlockNumber,
      l2BlockNumberBeforeTx,
      l2ToL1MessageIndex,
      siblingPath,
      rollupVersion,
      chainIdL1,
      portalAddressL1,
      bridgeAddressL2,
      l1RollupAddress,
    } = data

    console.log('[Resume L2→L1] Starting resume with recovery data:', {
      operationId,
      amount,
      l2TxHash: l2TxHash ? l2TxHash.slice(0, 14) + '...' : null,
      l2TxUrl: l2TxUrl ? 'set' : null,
      recipientL1Address,
      isPrivacyModeEnabled,
      status,
      l2BlockNumber: l2BlockNumber ?? null,
      l2BlockNumberBeforeTx: l2BlockNumberBeforeTx ?? null,
      l2ToL1MessageIndex: l2ToL1MessageIndex ?? null,
      siblingPath: siblingPath ? `[${siblingPath.length}]` : null,
      rollupVersion: rollupVersion ?? null,
      chainIdL1: chainIdL1 ?? null,
      portalAddressL1: portalAddressL1 ?? null,
      bridgeAddressL2: bridgeAddressL2 ?? null,
      l1RollupAddress: l1RollupAddress ?? null,
      currentStep: data.currentStep ?? null,
    })

    const withdrawRecipient = recipientL1Address || l1Address
    if (!withdrawRecipient) {
      throw new Error('L1 address not available for withdrawal')
    }

    // Use config defaults if DB values are missing (legacy operations stored before multi-token)
    if (!portalAddressL1) {
      console.warn('[Resume L2→L1] portalAddressL1 not stored in operation — falling back to L1_TOKENS[0]. This may be wrong for multi-token operations.')
      portalAddressL1 = L1_TOKENS[0]?.l1PortalContract || ''
    }
    if (!bridgeAddressL2) {
      console.warn('[Resume L2→L1] bridgeAddressL2 not stored in operation — falling back to L1_TOKENS[0]. This may be wrong for multi-token operations.')
      bridgeAddressL2 = L1_TOKENS[0]?.l2BridgeContract || ''
    }

    // Show L2 tx URL if available
    if (l2TxUrl) {
      setTransactionUrls(null, l2TxUrl)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Step 1: L2 burn+exit already done — mark as completed
    // ═══════════════════════════════════════════════════════════════════════
    setProgressStep(1, 'completed')
    patchOperationAsync(operationId, { currentStep: 2 })

    // ═══════════════════════════════════════════════════════════════════════
    // Step 2: Recompute witness if missing (leafIndex + siblingPath)
    // ═══════════════════════════════════════════════════════════════════════
    const needsWitness = !l2ToL1MessageIndex || !siblingPath || siblingPath.length === 0
    let withdrawEpoch: bigint | undefined

    if (needsWitness) {
      setProgressStep(2, 'active')
      console.log('[Resume L2→L1] Witness data missing — recomputing...')

      // Recover l2BlockNumber if missing
      let blockNum: number | undefined
      if (l2BlockNumber) {
        blockNum = Number(l2BlockNumber)
      } else if (l2TxHash) {
        blockNum = await recoverL2BlockNumber(l2TxHash)
        l2BlockNumber = String(blockNum)
        patchOperationAsync(operationId, { l2BlockNumber: String(blockNum) })
      } else if (l2BlockNumberBeforeTx) {
        const startBlock = Number(l2BlockNumberBeforeTx)
        const currentBlock = await aztecNode.getBlockNumber()
        console.log('[Resume L2→L1] Scanning L2 blocks', startBlock, '→', currentBlock, 'for tx...')
        throw new Error(
          `l2BlockNumber missing and no l2TxHash to recover it. ` +
          `We know the tx was after L2 block ${startBlock}. ` +
          'Please contact support with your operation ID.',
        )
      } else {
        throw new Error(
          'Cannot recover witness: no l2BlockNumber, l2TxHash, or l2BlockNumberBeforeTx. Contact support.',
        )
      }

      if (!blockNum || blockNum === 0) {
        throw new Error('L2 block number is required for witness computation.')
      }

      // Get rollupVersion from node if not stored
      if (rollupVersion == null || chainIdL1 == null) {
        const nodeInfo = await aztecNode.getNodeInfo()
        rollupVersion = rollupVersion ?? nodeInfo?.rollupVersion
        chainIdL1 = chainIdL1 ?? (nodeInfo?.l1ChainId as number | undefined) ?? L1_CHAIN_ID
        const l1Addresses = nodeInfo?.l1ContractAddresses as Record<string, any> | undefined
        l1RollupAddress = l1RollupAddress ?? l1Addresses?.rollupAddress?.toString()
      }

      if (rollupVersion == null) {
        throw new Error('Rollup version not available. Cannot compute L2→L1 message leaf.')
      }

      // Ensure rollup address is available for epoch conversion
      if (!l1RollupAddress) {
        l1RollupAddress = L1_CONTRACT_ADDRESSES.rollupAddress || null
      }
      if (!l1RollupAddress) {
        throw new Error('Rollup address not available. Cannot convert block number to epoch for L2→L1 witness.')
      }

      // Compute witness using shared modules
      const msgLeaf = computeL2ToL1MessageLeaf({
        l1Recipient: withdrawRecipient,
        amount: BigInt(amount),
        l2BridgeAddress: bridgeAddressL2,
        portalAddress: portalAddressL1,
        rollupVersion,
        chainId: chainIdL1,
      })

      const witnessResult = await computeWitness(blockNum, msgLeaf, l1RollupAddress)
      l2ToL1MessageIndex = witnessResult.leafIndex
      siblingPath = witnessResult.siblingPath
      withdrawEpoch = witnessResult.epoch

      // Persist witness data to backend (3 retries)
      const ok = await patchOperationWithRetry(operationId, {
        status: 'ready',
        l2ToL1MessageIndex,
        siblingPath,
        currentStep: 3,
      }, { label: 'witness data' })
      if (ok) {
        console.log('[Resume L2→L1] Witness data stored on backend')
      }

      setProgressStep(2, 'completed')
    } else {
      // Witness already available
      setProgressStep(2, 'completed')
      console.log('[Resume L2→L1] Witness data already available: leafIndex=', l2ToL1MessageIndex)
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Step 3: Wait for L2 block to be proven on L1
    // ═══════════════════════════════════════════════════════════════════════
    setProgressStep(3, 'active')
    patchOperationAsync(operationId, { currentStep: 3 })

    const blockNumberForProof = Number(l2BlockNumber)

    // Get rollup address for polling if missing (try config first, then node)
    if (!l1RollupAddress) {
      l1RollupAddress = L1_CONTRACT_ADDRESSES.rollupAddress || null
    }
    if (!l1RollupAddress) {
      try {
        const nodeInfo = await aztecNode.getNodeInfo()
        const l1Addresses = nodeInfo?.l1ContractAddresses as Record<string, any> | undefined
        l1RollupAddress = l1Addresses?.rollupAddress?.toString()
      } catch {
        // Will fall back to fixed wait
      }
    }

    // If epoch wasn't set during witness computation (witness was already available),
    // convert block → epoch now for the L1 withdraw call
    if (withdrawEpoch == null && l1RollupAddress) {
      const { publicClient } = await import('./bridge/bridgeUtils')
      const { RollupAbi } = await import('@aztec/l1-artifacts')
      const epochRaw = await publicClient.readContract({
        address: l1RollupAddress as `0x${string}`,
        abi: RollupAbi,
        functionName: 'getEpochForCheckpoint',
        args: [BigInt(blockNumberForProof)],
      })
      withdrawEpoch = typeof epochRaw === 'bigint' ? epochRaw : BigInt(epochRaw as number)
      console.log('[Resume L2→L1] Block', blockNumberForProof, '→ Epoch', withdrawEpoch.toString())
    }
    if (withdrawEpoch == null) {
      throw new Error('Could not determine epoch for L1 withdraw. Rollup address not available.')
    }

    await waitForBlockProven({
      blockNumberForProof,
      rollupAddress: l1RollupAddress,
      onPoll: (provenBlock, neededBlock, elapsedMs) => {
        const elapsedMin = Math.round(elapsedMs / 60_000)
        notify('info', `Waiting for L2 block to be proven on L1 (proven: ${provenBlock}, need: ${neededBlock}, ${elapsedMin} min elapsed)...`)
      },
      onFallback: (fixedWaitMs) => {
        notify('info', `Waiting ~${Math.round(fixedWaitMs / 60_000)} min for block finalization...`)
      },
    })

    setProgressStep(3, 'completed')

    // Final buffer before L1 withdraw
    console.log('[Resume L2→L1] Final wait before L1 withdraw (30s)...')
    await wait(30_000)

    // ═══════════════════════════════════════════════════════════════════════
    // Step 4: Send L1 withdraw tx
    // ═══════════════════════════════════════════════════════════════════════
    setProgressStep(4, 'active')
    patchOperationAsync(operationId, { currentStep: 4 })

    const withdrawResult = await executeL1Withdraw({
      l1Address: withdrawRecipient,
      amount: BigInt(amount),
      epoch: withdrawEpoch,
      leafIndex: l2ToL1MessageIndex!,
      siblingPath: siblingPath as string[],
      portalAddress: portalAddressL1,
    })

    setTransactionUrls(withdrawResult.l1TxUrl, l2TxUrl ?? null)

    // Mark as completed on backend
    console.log('[Resume L2→L1] PATCH completed →', { operationId, status: 'completed', l1TxHash: withdrawResult.l1TxHash, currentStep: 5 })
    patchOperationAsync(operationId, {
      status: 'completed',
      l1TxHash: withdrawResult.l1TxHash,
      l1TxUrl: withdrawResult.l1TxUrl,
      completedAt: new Date().toISOString(),
      currentStep: 5,
    })

    setProgressStep(4, 'completed')

    // ═══════════════════════════════════════════════════════════════════════
    // Step 5: Done
    // ═══════════════════════════════════════════════════════════════════════
    setProgressStep(5, 'active')
    await wait(3000)
    setProgressStep(5, 'completed')

    // Clear recovery state
    clearRecovery()

    return withdrawResult.l1TxHash
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
