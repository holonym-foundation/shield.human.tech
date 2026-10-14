'use client'

import React, { useState, useCallback, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Icon } from '@iconify/react'
import RootStyle from '@/components/RootStyle'
import BridgeHeader from '@/components/BridgeHeader'
import ActivityCard from '@/components/ActivityCard'
import FuelClaimLinkModal from '@/components/FuelClaimLinkModal'
import { useBridgeOperations, decryptOperationPayload } from '@/hooks/useBridgeOperations'
import type { BridgeOperation, RecoveryClaimData, RecoveryWithdrawalData } from '@human.tech/clean.sdk'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { useToast } from '@/hooks/useToast'
import { BridgeDirection } from '@/types/bridge'
import { buildFuelClaimUrl } from '@/utils/fuelClaimLink'
import { humanizeError } from '@/utils'
import { logError } from '@/utils/datadog'

export default function ActivityPage() {
  const router = useRouter()
  const notify = useToast()
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [sharingId, setSharingId] = useState<string | null>(null)
  const [shareLink, setShareLink] = useState<{ link: string; recipient: string } | null>(null)
  const [page, setPage] = useState(0)
  const prefersReducedMotion = useReducedMotion()

  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const { setRecovery, setWithdrawalRecovery, setDirection } = useBridgeStore()

  // Prefetch routes this page navigates to
  useEffect(() => {
    router.prefetch('/progress/resume')
    router.prefetch('/activity/local-recovery')
    router.prefetch('/')
  }, [router])

  const { data: operations, isLoading, isError, error } = useBridgeOperations()

  // Fixed batch of cards per page keeps the card body inside the shell's height
  // budget (card is capped at calc(90vh-5rem) ≈ 568px at innerHeight 720). The
  // fixed chrome (BridgeHeader + "Bridge Activity" + the pagination row + footer)
  // shrank once the footer collapsed from two stacked full-width buttons to a
  // single 20/80 back+CTA row (~48px reclaimed), leaving ~348px for the batch. A
  // compact card runs ~96px (completed) to ~130px (failed: single-line error +
  // Resume + tx links), so three compact cards fit 720/800/900. The list lives in
  // a capped overflow-y-auto region, so a rare all-tall-failed page scrolls INSIDE
  // that region without ever page-scrolling the shell. Measured, not guessed.
  const PAGE_SIZE = 3
  const ops = useMemo(() => operations ?? [], [operations])
  const totalPages = Math.max(1, Math.ceil(ops.length / PAGE_SIZE))
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1)
  }, [page, totalPages])
  const pageItems = ops.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  const handleResume = useCallback(
    async (operation: BridgeOperation) => {
      if (!l1Address) {
        notify('error', 'Please connect your Ethereum wallet first')
        return
      }

      setResumingId(operation.id)
      try {
        // Decrypt the encrypted payload to verify wallet ownership
        const decrypted = await decryptOperationPayload(operation, l1Address, signWaapMessage)

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
            epoch: operation.epoch,
            numCheckpointsInEpoch: operation.numCheckpointsInEpoch,
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
            claimAmount: operation.claimAmount ?? null,
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
            // Fuel recovery: secrets from decrypted blob, receipt data from DB
            fuelSecret: decrypted.fuelSecret ?? null,
            privateFuelSalt: decrypted.privateFuelSalt ?? null,
            privateFuelSecret: decrypted.privateFuelSecret ?? null,
            fuelMessageHash: operation.fuelMessageHash ?? null,
            fuelMessageLeafIndex: operation.fuelMessageLeafIndex ?? null,
            fuelAmount: operation.fuelAmount ?? null,
          }

          setDirection(BridgeDirection.L1_TO_L2)
          setRecovery(operation.id, recoveryData)
          router.push('/progress/resume')
        }
      } catch (err) {
        console.error('[activity] resume/decrypt failed:', err)
        logError('Resume decrypt failed', {
          errorType: 'resume_decrypt_failed',
          error: err instanceof Error ? err.message : String(err),
        })
        notify('error', humanizeError(err))
      } finally {
        setResumingId(null)
      }
    },
    [l1Address, signWaapMessage, setRecovery, setWithdrawalRecovery, setDirection, router, notify],
  )

  const handleShareFuelClaim = useCallback(
    async (operation: BridgeOperation) => {
      if (!l1Address) {
        notify('error', 'Please connect your Ethereum wallet first')
        return
      }
      if (
        !operation.fuelMessageHash ||
        !operation.fuelMessageLeafIndex ||
        !operation.fuelAmount ||
        !operation.l1TxHash
      ) {
        notify('error', 'Missing fuel data for this bridge. Cannot rebuild the claim link.')
        return
      }
      setSharingId(operation.id)
      try {
        const decrypted = await decryptOperationPayload(operation, l1Address, signWaapMessage)
        if (!decrypted) {
          throw new Error(
            'Could not decrypt operation data. Make sure you are using the same wallet that created this bridge.',
          )
        }
        if (!decrypted.fuelSecret) {
          throw new Error('No fuel secret in this bridge. Was it a public fuel deposit?')
        }
        // The override field is only set in the blob when the bridger sent fuel to a third party.
        // Self-fuel bridges never write it, so a missing field here means there's nothing to share.
        const recipient = decrypted.fuelRecipient
        if (!recipient || recipient === decrypted.l2Address) {
          notify('info', 'Fee Juice added to your Aztec account. It is ready to use, no claim needed.')
          return
        }
        const link = buildFuelClaimUrl(window.location.origin, {
          recipient,
          claimAmount: operation.fuelAmount,
          claimSecret: decrypted.fuelSecret,
          messageLeafIndex: operation.fuelMessageLeafIndex,
          fuelMessageHash: operation.fuelMessageHash,
          l1TxHash: operation.l1TxHash,
        })
        setShareLink({ link, recipient })
      } catch (err) {
        console.error('[activity] build fuel claim link failed:', err)
        logError('Fuel claim share failed', {
          errorType: 'fuel_claim_share_failed',
          error: err instanceof Error ? err.message : String(err),
        })
        notify('error', humanizeError(err))
      } finally {
        setSharingId(null)
      }
    },
    [l1Address, signWaapMessage, notify],
  )

  return (
    <RootStyle className="min-h-0 overflow-hidden">
      <div className="flex h-full flex-col overflow-hidden px-5 pt-4 pb-4">
        <div className="flex items-center gap-4">
          <BridgeHeader />
        </div>

        <h2 className="text-lg font-semibold mt-3">Bridge Activity</h2>

        <div className="flex-1 min-h-0 mt-3 flex flex-col">
          {isLoading && <p className="text-sm text-gray-400 mt-1 text-center">Loading operations...</p>}

          {isError && (
            <p className="text-sm text-red-500 mt-1 text-center">
              {humanizeError(error)}
            </p>
          )}

          {!isLoading && !isError && ops.length === 0 && (
            <p className="text-sm text-gray-400 mt-1 text-center">No bridge operations yet.</p>
          )}

          {ops.length > 0 && (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={page}
                    initial={prefersReducedMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
                    transition={{ duration: prefersReducedMotion ? 0 : 0.15 }}
                    className="flex flex-col gap-3"
                  >
                    {pageItems.map((op) => (
                      <ActivityCard
                        key={op.id}
                        operation={op}
                        onResume={handleResume}
                        resuming={resumingId === op.id}
                        onShareFuelClaim={handleShareFuelClaim}
                        sharingFuelClaim={sharingId === op.id}
                      />
                    ))}
                  </motion.div>
                </AnimatePresence>
              </div>

              {totalPages > 1 && (
                <div className="mt-2 flex shrink-0 items-center justify-center gap-4 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    aria-label="Previous page"
                    className="text-gray-500 hover:text-[#81133B] disabled:opacity-40 disabled:hover:text-gray-500 p-1 rounded"
                  >
                    <Icon icon="ph:caret-left-bold" width={16} height={16} />
                  </button>
                  <span className="text-xs font-medium text-gray-500 tabular-nums">
                    {page + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    aria-label="Next page"
                    className="text-gray-500 hover:text-[#81133B] disabled:opacity-40 disabled:hover:text-gray-500 p-1 rounded"
                  >
                    <Icon icon="ph:caret-right-bold" width={16} height={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer: a single 20/80 row (SOP §4 / #194) instead of two stacked
            same-weight buttons. The compact icon-only back button (~20%) shares
            the row with the brand-filled primary CTA (~80%), mirroring the
            back+primary split used across the ProgressCard recovery states. */}
        <div className="mt-3 flex w-full shrink-0 items-stretch gap-2">
          <button
            type="button"
            onClick={() => router.push('/?app=1')}
            title="Back to Bridge"
            aria-label="Back to Bridge"
            className="flex flex-[2_1_0%] items-center justify-center rounded-lg border border-latest-grey-300 text-latest-grey-100 transition-colors hover:border-latest-black-100 hover:text-latest-black-100"
          >
            <Icon icon="ph:arrow-left-bold" width={18} height={18} />
          </button>
          <button
            type="button"
            onClick={() => router.push('/activity/local-recovery')}
            className="flex-[8_1_0%] rounded-lg bg-black py-[10px] font-semibold text-white transition-opacity hover:opacity-80"
          >
            Recover from local data
          </button>
        </div>
      </div>
      <FuelClaimLinkModal
        isOpen={!!shareLink}
        link={shareLink?.link ?? ''}
        recipient={shareLink?.recipient ?? ''}
        onClose={() => setShareLink(null)}
      />
    </RootStyle>
  )
}
