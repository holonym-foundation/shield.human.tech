'use client'

import React, { useEffect, useRef, useCallback } from 'react'
import RootStyle from '@/components/RootStyle'
import { useRouter } from 'next/navigation'
import BridgeHeader from '@/components/BridgeHeader'
import ProgressCard from '@/components/ProgressCard'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { formatUnits } from 'viem'
import { useL2TokenBalance, useL2FeeJuiceBalance } from '@/hooks/useL2Operations'
import { useL1TokenBalances } from '@/hooks/useL1Operations'
import { useResumeL1BridgeToL2 } from '@/hooks/useResumeL1BridgeToL2'
import { useResumeL2WithdrawToL1 } from '@/hooks/useResumeL2WithdrawToL1'
import { L1_TOKEN_METADATA, L2_TOKEN_METADATA, L1_NETWORKS, L2_NETWORKS } from '@/config'
import { useToast } from '@/hooks/useToast'

export default function ResumePage() {
  const router = useRouter()
  const notify = useToast()
  const operationStarted = useRef(false)

  const {
    getProgressSteps,
    progressStep,
    setProgressStep,
    resetStepState,
    setDirection,
    l1TxUrl,
    l2TxUrl,
    recoveryClaimData,
    recoveryWithdrawalData,
  } = useBridgeStore()

  const isL2ToL1Recovery = !!recoveryWithdrawalData

  // Refetch balances on success
  const { aztecAddress } = useWalletStore()
  const { refetch: refetchL1Balance } = useL1TokenBalances()
  const { refetch: refetchL2Balance } = useL2TokenBalance()
  const { refetch: refetchFeeJuiceBalance } = useL2FeeJuiceBalance()

  const handleResumeSuccess = useCallback(() => {
    // The L2 balance queries require a connected Aztec wallet. On an L2→L1 resume the L2 wallet
    // is often absent (resume runs from persisted data + an L1 client), and refetch() bypasses
    // the queries' `enabled` guard — so only refresh L2 balances when the address is present.
    const refetches: Promise<unknown>[] = [refetchL1Balance()]
    if (aztecAddress) {
      refetches.push(refetchL2Balance(), refetchFeeJuiceBalance())
    }
    notify.promise(Promise.allSettled(refetches), {
      pending: 'Refreshing balances...',
      success: 'Balances updated',
      error: 'Failed to refresh balances',
    })
  }, [notify, aztecAddress, refetchL1Balance, refetchL2Balance, refetchFeeJuiceBalance])

  const {
    mutate: resumeL1ToL2,
    isError: isResumeL1ToL2Error,
  } = useResumeL1BridgeToL2(handleResumeSuccess)

  const {
    mutate: resumeL2ToL1,
    isError: isResumeL2ToL1Error,
  } = useResumeL2WithdrawToL1(handleResumeSuccess)

  // On mount: reset step state and set direction
  useEffect(() => {
    resetStepState()
    setDirection(isL2ToL1Recovery ? 'L2_TO_L1' : 'L1_TO_L2')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Redirect to activity if no recovery data
  useEffect(() => {
    if (!recoveryClaimData && !recoveryWithdrawalData) {
      router.push('/activity')
    }
  }, [recoveryClaimData, recoveryWithdrawalData, router])

  // Arm beforeunload only inside the irrecoverable window. l1TxUrl/l2TxUrl may already be set
  // from persisted recovery data on mount — that's correct: a resume is itself an in-flight bridge.
  useEffect(() => {
    const steps = getProgressSteps()
    const hasInFlightTx = !!(l1TxUrl || l2TxUrl)
    const hasActiveStep = steps.some((step) => step.status === 'active')
    if (!hasInFlightTx || !hasActiveStep) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [getProgressSteps, l1TxUrl, l2TxUrl])

  // Prefetch activity route
  useEffect(() => {
    router.prefetch('/activity')
  }, [router])

  // Handle resume operation
  const handleResumeOperation = useCallback(async () => {
    try {
      if (isL2ToL1Recovery && recoveryWithdrawalData) {
        await resumeL2ToL1(recoveryWithdrawalData)
      } else if (recoveryClaimData) {
        await resumeL1ToL2(recoveryClaimData)
      }
    } catch (error) {
      console.error('Resume operation failed:', error)
    }
  }, [isL2ToL1Recovery, recoveryClaimData, recoveryWithdrawalData, resumeL1ToL2, resumeL2ToL1])

  // Start resume on mount with 2s delay for hook stability
  useEffect(() => {
    const hasRecoveryData = !!recoveryClaimData || !!recoveryWithdrawalData
    setTimeout(() => {
      if (hasRecoveryData && !operationStarted.current) {
        operationStarted.current = true
        handleResumeOperation()
      }
    }, 2000)
  }, [
    recoveryClaimData,
    recoveryWithdrawalData,
    handleResumeOperation,
  ])

  // Handle errors — set current active step to error state
  useEffect(() => {
    const hasError = isResumeL1ToL2Error || isResumeL2ToL1Error
    if (hasError) {
      const steps = getProgressSteps()
      const currentStep = steps.findIndex((step) => step.status === 'active')
      if (currentStep !== -1) {
        setProgressStep(currentStep + 1, 'error')
      }
    }
  }, [isResumeL1ToL2Error, isResumeL2ToL1Error, getProgressSteps, setProgressStep])

  const steps = getProgressSteps()
  const hasError = isResumeL1ToL2Error || isResumeL2ToL1Error

  // Compute amount display
  const recoveryAmount = recoveryClaimData?.amount ?? recoveryWithdrawalData?.amount ?? '0'
  const decimals = isL2ToL1Recovery ? L2_TOKEN_METADATA.decimals : L1_TOKEN_METADATA.decimals
  const tokenSymbol = isL2ToL1Recovery ? L2_TOKEN_METADATA.symbol : L1_TOKEN_METADATA.symbol
  const formattedAmount = formatUnits(BigInt(recoveryAmount), decimals)
  const amountDisplay = `${formattedAmount} ${tokenSymbol}`

  // From/To network labels
  const fromNetwork = isL2ToL1Recovery ? (L2_NETWORKS[0]?.title ?? 'Aztec') : (L1_NETWORKS[0]?.title ?? 'Ethereum')
  const toNetwork = isL2ToL1Recovery ? (L1_NETWORKS[0]?.title ?? 'Ethereum') : (L2_NETWORKS[0]?.title ?? 'Aztec')

  return (
    <RootStyle className=''>
      <div className='px-5 pt-5'>
        <div className='flex items-center gap-4'>
          <BridgeHeader />
        </div>

        <ProgressCard
          steps={steps}
          progressStep={progressStep}
          hasError={hasError}
          l1TxUrl={l1TxUrl}
          l2TxUrl={l2TxUrl}
          estimatedTimeSeconds={15 * 60}
          amountDisplay={amountDisplay}
          fromNetwork={fromNetwork}
          toNetwork={toNetwork}
          direction={isL2ToL1Recovery ? 'L2_TO_L1' : 'L1_TO_L2'}
        />
      </div>
    </RootStyle>
  )
}
