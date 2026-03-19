'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import RootStyle from '@/components/RootStyle'
import BridgeHeader from '@/components/BridgeHeader'
import ActivityCard from '@/components/ActivityCard'
import TextButton from '@/components/TextButton'
import {
  useBridgeOperations,
  decryptOperationPayload,
} from '@/hooks/useBridgeOperations'
import type { BridgeOperation, RecoveryClaimData, RecoveryWithdrawalData } from '@human.tech/aztec-bridge-sdk'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { useToast } from '@/hooks/useToast'
import { BridgeDirection } from '@/types/bridge'

export default function ActivityPage() {
  const router = useRouter()
  const notify = useToast()
  const [resumingId, setResumingId] = useState<number | null>(null)

  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const { setRecovery, setWithdrawalRecovery, setDirection } = useBridgeStore()

  // Prefetch routes this page navigates to
  useEffect(() => {
    router.prefetch('/progress/resume')
    router.prefetch('/activity/local-recovery')
    router.prefetch('/')
  }, [router])

  const {
    data: operations,
    isLoading,
    isError,
    error,
  } = useBridgeOperations()

  const handleResume = useCallback(
    async (operation: BridgeOperation) => {
      if (!l1Address) {
        notify('error', 'Please connect your Ethereum wallet first')
        return
      }

      setResumingId(operation.id)
      try {
        // Decrypt the encrypted payload to verify wallet ownership
        const decrypted = await decryptOperationPayload(
          operation,
          l1Address,
          signWaapMessage,
        )

        if (!decrypted) {
          throw new Error(
            'Could not decrypt operation data. Make sure you are using the same wallet that created this bridge.',
          )
        }

        if (operation.direction === 'L2_TO_L1') {
          // ── L2→L1 Resume ──
          // Nonce is NOT needed for L1 withdraw — only for the L2 burn (already done).
          // We just need: amount, l1Address, contract addresses, l2BlockNumber, witness.
          const recoveryData: RecoveryWithdrawalData = {
            operationId: operation.id,
            amount: decrypted.amount ?? operation.amountL2 ?? operation.amountL1 ?? '0',
            l1Address: decrypted.l1Address ?? l1Address,
            l2Address: decrypted.l2Address ?? '',
            l2TxHash: operation.l2TxHash,
            l2TxUrl: operation.l2TxUrl,
            l2BlockNumber: operation.l2BlockNumber,
            l2BlockNumberBeforeTx: operation.l2BlockNumberBeforeTx,
            l2ToL1MessageIndex: operation.l2ToL1MessageIndex,
            siblingPath: operation.siblingPath,
            recipientL1Address: operation.recipientL1Address ?? l1Address,
            rollupVersion: operation.rollupVersion,
            chainIdL1: operation.chainIdL1,
            portalAddressL1: operation.portalAddressL1,
            bridgeAddressL2: operation.bridgeAddressL2,
            l1RollupAddress: operation.l1RollupAddress,
            l1OutboxAddress: operation.l1OutboxAddress,
            isPrivacyModeEnabled: operation.isPrivacyModeEnabled ?? false,
            nodeInfo: operation.nodeInfo,
            status: operation.status,
            currentStep: operation.currentStep,
          }

          setDirection(BridgeDirection.L2_TO_L1)
          setWithdrawalRecovery(operation.id, recoveryData)
          router.push('/progress/resume')
        } else {
          // ── L1→L2 Resume ──
          if (!decrypted.claimSecret || !decrypted.claimSecretHash) {
            throw new Error(
              'Could not decrypt claim secret. Make sure you are using the same wallet that created this bridge.',
            )
          }

          const recoveryData: RecoveryClaimData = {
            operationId: operation.id,
            claimSecret: decrypted.claimSecret,
            claimSecretHash: decrypted.claimSecretHash,
            messageHash: operation.messageHash,
            messageLeafIndex: operation.messageLeafIndex,
            amount: decrypted.amount ?? operation.amountL1 ?? '0',
            l1Address: decrypted.l1Address ?? l1Address,
            l2Address: decrypted.l2Address ?? '',
            l1TxHash: operation.l1TxHash,
            l1TxUrl: operation.l1TxUrl,
            l1BlockNumberBeforeTx: operation.l1BlockNumberBeforeTx,
            isPrivacyModeEnabled: operation.isPrivacyModeEnabled ?? false,
            nodeInfo: operation.nodeInfo,
            status: operation.status,
            currentStep: operation.currentStep,
            // Contract snapshot for multi-token support
            portalAddressL1: operation.portalAddressL1,
            bridgeAddressL2: operation.bridgeAddressL2,
            tokenAddressL1: operation.tokenAddressL1,
            tokenAddressL2: operation.tokenAddressL2,
          }

          setDirection(BridgeDirection.L1_TO_L2)
          setRecovery(operation.id, recoveryData)
          router.push('/progress/resume')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to decrypt'
        notify('error', msg)
      } finally {
        setResumingId(null)
      }
    },
    [l1Address, signWaapMessage, setRecovery, setWithdrawalRecovery, setDirection, router, notify],
  )

  return (
    <RootStyle className='overflow-y-auto'>
      <div className='px-5 pt-5 pb-5 flex flex-col h-full'>
        <div className='flex items-center gap-4'>
          <BridgeHeader />
        </div>

        <h2 className='text-lg font-semibold mt-4'>Bridge Activity</h2>

        {isLoading && (
          <p className='text-sm text-gray-400 mt-4 text-center'>
            Loading operations...
          </p>
        )}

        {isError && (
          <p className='text-sm text-red-500 mt-4 text-center'>
            {error instanceof Error ? error.message : 'Failed to load'}
          </p>
        )}

        {!isLoading && operations && operations.length === 0 && (
          <p className='text-sm text-gray-400 mt-4 text-center'>
            No bridge operations yet.
          </p>
        )}

        <div className='flex flex-col gap-3 mt-3 flex-1 overflow-y-auto'>
          {operations?.map((op) => (
            <ActivityCard
              key={op.id}
              operation={op}
              onResume={handleResume}
              resuming={resumingId === op.id}
            />
          ))}
        </div>

        <div className='mt-4 flex flex-col gap-2'>
          <TextButton onClick={() => router.push('/')}>
            Back to Bridge
          </TextButton>
          <TextButton
            onClick={() => router.push('/activity/local-recovery')}
            className='!bg-transparent !text-gray-600 hover:!text-gray-900 !font-medium'>
            Recover from local data
          </TextButton>
        </div>
      </div>
    </RootStyle>
  )
}
