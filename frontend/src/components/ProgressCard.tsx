'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCountdown } from 'usehooks-ts'
import LoadingStepsBars from '@/components/LoadingStepsBars'
import StyledImage from '@/components/StyledImage'
import TextButton from '@/components/TextButton'
import type { LoadingStep } from '@/stores/bridgeStore'
import { STORAGE_KEYS } from '@human.tech/aztec-bridge-sdk'
import { exportClaimData, exportWithdrawalData } from '@/utils'

export interface ProgressCardProps {
  steps: LoadingStep[]
  progressStep: number
  hasError: boolean
  l1TxUrl: string | null
  l2TxUrl: string | null
  estimatedTimeSeconds: number
  /** Display amount string, e.g. "10.5 USDC" */
  amountDisplay: string
  /** Optional fuel breakdown for fresh L1→L2 with fuel */
  fuelBreakdown?: { bridgeAmount: string; fuelAmount: string }
  /** From/To network titles */
  fromNetwork: string
  toNetwork: string
  /** Bridge direction — used for export button */
  direction?: 'L1_TO_L2' | 'L2_TO_L1'
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export default function ProgressCard({
  steps,
  progressStep,
  hasError,
  l1TxUrl,
  l2TxUrl,
  estimatedTimeSeconds,
  amountDisplay,
  fuelBreakdown,
  fromNetwork,
  toNetwork,
  direction,
}: ProgressCardProps) {
  const router = useRouter()

  const isAllComplete = steps.every((step) => step.status === 'completed')

  // Track whether backup data is available in localStorage
  const [hasBackup, setHasBackup] = useState(false)
  useEffect(() => {
    if (!direction) return
    const key = direction === 'L1_TO_L2' ? STORAGE_KEYS.deposits : STORAGE_KEYS.withdrawals
    const check = () => {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return
        const entries = JSON.parse(raw)
        if (entries.some((e: any) => !e.success)) setHasBackup(true)
      } catch {
        /* ignore */
      }
    }
    check()
    // Re-check when localStorage changes (SDK writes during operation)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === key) check()
    }
    window.addEventListener('storage', handleStorage)
    // Also poll briefly since storage events don't fire for same-tab writes
    const interval = setInterval(check, 3000)
    return () => {
      window.removeEventListener('storage', handleStorage)
      clearInterval(interval)
    }
  }, [direction])

  const [count, { startCountdown, stopCountdown }] = useCountdown({
    countStart: estimatedTimeSeconds,
    intervalMs: 1000,
  })

  // Start countdown on mount, stop on unmount
  useEffect(() => {
    startCountdown()
    return () => {
      stopCountdown()
    }
  }, [startCountdown, stopCountdown])

  // Stop countdown on completion or error
  useEffect(() => {
    if (isAllComplete || hasError) {
      stopCountdown()
    }
  }, [isAllComplete, hasError, stopCountdown])

  const formattedCountdown = formatSeconds(count)
  const initialEstimateFormatted = formatSeconds(estimatedTimeSeconds)

  // Time taken = total estimate - remaining
  const timeTakenSeconds = estimatedTimeSeconds - count
  const formattedTimeTaken = formatSeconds(timeTakenSeconds)

  const heading = hasError ? 'Something went wrong' : isAllComplete ? 'Transaction complete' : 'Transaction in progress'

  const showBackButton = isAllComplete || hasError

  return (
    <div>
      {/* Warning banner — only when in progress */}
      {!isAllComplete && !hasError && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md mt-2 px-3 py-2">
          <p className="text-xs text-yellow-800 font-medium text-center">
            Please don't reload or close this page, or it may be difficult to recover your funds.
          </p>
        </div>
      )}

      {/* Progress Card */}
      <div className="bg-white rounded-md mt-2 p-4">
        <div className="flex items-center justify-center">
          {hasError ? (
            <svg width="56" height="56" viewBox="0 0 25 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M12.5004 8.99998V13M12.5004 17H12.5104M22.2304 18L14.2304 3.99998C14.056 3.69218 13.803 3.43617 13.4973 3.25805C13.1917 3.07993 12.8442 2.98608 12.4904 2.98608C12.1366 2.98608 11.7892 3.07993 11.4835 3.25805C11.1778 3.43617 10.9249 3.69218 10.7504 3.99998L2.75042 18C2.5741 18.3053 2.48165 18.6519 2.48243 19.0045C2.48321 19.3571 2.5772 19.7032 2.75486 20.0078C2.93253 20.3124 3.18757 20.5646 3.49411 20.7388C3.80066 20.9131 4.14783 21.0032 4.50042 21H20.5004C20.8513 20.9996 21.1959 20.9069 21.4997 20.7313C21.8035 20.5556 22.0556 20.3031 22.2309 19.9991C22.4062 19.6951 22.4985 19.3504 22.4984 18.9995C22.4983 18.6486 22.4059 18.3039 22.2304 18Z"
                stroke="#B91C1C"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <StyledImage
              src={isAllComplete ? '/assets/svg/transactionComplete.svg' : '/assets/svg/progress.svg'}
              alt=""
              className="h-[56px] w-[56px]"
            />
          )}
        </div>

        <p
          className={`text-center font-semibold text-md mt-5 ${
            hasError ? 'text-[#B91C1C]' : isAllComplete ? 'text-green-600' : ''
          }`}
        >
          {heading}
        </p>

        {hasError && (
          <p className="text-center text-12 text-latest-grey-500 mt-1">
            The transaction was cancelled or could not be completed. You can safely go back and try again.
          </p>
        )}

        <div className="mt-5">
          <LoadingStepsBars steps={steps} currentStep={progressStep - 1} />
        </div>

        {!hasError && (
          <>
            <hr className="text-latest-grey-300 my-3" />
            <div className="flex justify-between mt-[2px]">
              <p className="text-14 font-medium text-latest-grey-100">Estimated time </p>
              <p className="font-semibold text-14">~{isAllComplete ? initialEstimateFormatted : formattedCountdown}</p>
            </div>
            {isAllComplete && (
              <div className="flex justify-between mt-[2px]">
                <p className="text-14 font-medium text-latest-grey-100">Total time taken </p>
                <p className="font-semibold text-14">{formattedTimeTaken}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Transaction Details */}
      <div className="bg-[#F5F5F5] rounded-md mt-4 p-4">
        <div className="flex justify-between">
          <div>
            <p className="text-14 font-semibold text-latest-grey-100">From</p>
            <div className="flex gap-2 mt-3">
              <StyledImage src="/assets/svg/ethLogo.svg" alt="" className="h-6 w-6" />
              <p className="text-16 font-medium text-latest-black-100 w-[106px]">{fromNetwork}</p>
            </div>
          </div>
          <div>
            <p className="text-14 font-semibold text-latest-grey-100">To</p>
            <div className="flex gap-2 mt-3">
              <StyledImage src="/assets/svg/aztec.svg" alt="" className="h-6 w-6" />
              <p className="text-16 font-medium text-latest-black-100 w-[106px]">{toNetwork}</p>
            </div>
          </div>
        </div>
        <hr className="text-latest-grey-300 my-3" />
        <p className="text-32 text-black font-medium text-center">{amountDisplay}</p>
        {fuelBreakdown && (
          <p className="text-center text-12 font-medium text-latest-grey-500 mt-1">
            {/* F4: bridgeAmount/fuelAmount strings already include their own
                token symbol and "to top up …" suffix from the producer at
                app/progress/page.tsx — do NOT double-suffix here. */}
            {fuelBreakdown.bridgeAmount} to bridge + {fuelBreakdown.fuelAmount}
          </p>
        )}
      </div>

      {/* Transaction Links */}
      <div className="flex flex-row items-center justify-center mt-2 gap-4">
        {l1TxUrl && (
          <a
            href={l1TxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-14 font-semibold text-blue-200 bg-blue-300 hover:text-blue-100 mt-2 block px-4 py-2 rounded-full"
          >
            View L1 Tx ↗
          </a>
        )}
        {l2TxUrl && (
          <a
            href={l2TxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-14 font-semibold text-[#9333ea] bg-[#f3e8ff] hover:text-[#6b21a8] mt-2 block px-4 py-2 rounded-full"
          >
            View L2 Tx ↗
          </a>
        )}
        {direction && hasBackup && (
          <button
            onClick={() => {
              try {
                const key = direction === 'L1_TO_L2' ? STORAGE_KEYS.deposits : STORAGE_KEYS.withdrawals
                const raw = localStorage.getItem(key)
                if (!raw) return
                const entries = JSON.parse(raw)
                const latest = entries.filter((e: any) => !e.success).pop()
                if (!latest) return
                if (direction === 'L1_TO_L2') {
                  exportClaimData(latest)
                } else {
                  exportWithdrawalData(latest)
                }
              } catch (e) {
                console.error('[ProgressCard] Export failed:', e)
              }
            }}
            className="text-14 font-semibold text-[#047857] bg-[#ecfdf5] hover:text-[#065f46] mt-2 block px-4 py-2 rounded-full transition-colors"
          >
            Export Backup ↓
          </button>
        )}
      </div>

      {/* Back to Main Screen */}
      {showBackButton && (
        <div className="flex flex-row items-center justify-center mt-4 mb-6">
          <TextButton className="" onClick={() => router.push('/')}>
            Back to Main Screen
          </TextButton>
        </div>
      )}
    </div>
  )
}
