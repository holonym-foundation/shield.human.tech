'use client'

import React, { useEffect, useRef, useCallback } from 'react'
import RootStyle from '@/components/RootStyle'
import { useRouter } from 'next/navigation'
import BridgeHeader from '@/components/BridgeHeader'
import { useBridgeStore } from '@/stores/bridgeStore'
import { parseUnits } from 'viem'
import {
  useL2WithdrawTokensToL1,
  useL2TokenBalance,
  useL2FeeJuiceBalance,
} from '@/hooks/useL2Operations'
import { useL1TokenBalances, useL1BridgeToL2 } from '@/hooks/useL1Operations'
import { BridgeDirection } from '@/types/bridge'
import { L1_TOKEN_METADATA, L2_TOKEN_METADATA } from '@/config'
import { useToast } from '@/hooks/useToast'
import ProgressCard from '@/components/ProgressCard'

export default function ProgressPage() {
  const router = useRouter()
  const notify = useToast()
  const operationStarted = useRef(false)

  const {
    getProgressSteps,
    progressStep,
    setProgressStep,
    bridgeConfig,
    l1TxUrl,
    l2TxUrl,
    fuelEnabled,
    fuelAmount: fuelAmountStr,
  } = useBridgeStore()

  const steps = getProgressSteps()
  const bridgeAmount = bridgeConfig.amount

  // Refetch balances when bridge/withdrawal completes
  const { refetch: refetchL1Balance } = useL1TokenBalances()
  const { refetch: refetchL2Balance } = useL2TokenBalance()
  const { refetch: refetchFeeJuiceBalance } = useL2FeeJuiceBalance()
  const handleBridgeSuccess = useCallback(() => {
    notify.promise(
      Promise.all([refetchL1Balance(), refetchL2Balance(), refetchFeeJuiceBalance()]),
      {
        pending: 'Refreshing balances...',
        success: 'Balances updated',
        error: 'Failed to refresh balances',
      }
    )
  }, [notify, refetchL1Balance, refetchL2Balance, refetchFeeJuiceBalance])

  // Bridge operations
  const {
    mutate: bridgeTokensToL2,
    isError: isBridgeTokensToL2Error,
  } = useL1BridgeToL2(handleBridgeSuccess)

  const {
    mutate: withdrawTokensToL1,
    isError: withdrawTokensToL1Error,
  } = useL2WithdrawTokensToL1(handleBridgeSuccess)

  // Warn user before leaving the page while operation is in progress
  useEffect(() => {
    const isInProgress = steps.some((step) => step.status === 'active')
    if (!isInProgress) return

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [steps])

  // Prefetch home route
  useEffect(() => {
    router.prefetch('/')
  }, [router])

  // Handle bridge operation
  const handleBridgeOperation = useCallback(async () => {
    try {
      const displayAmount = bridgeAmount || '0'
      const amountL1 = parseUnits(displayAmount, L1_TOKEN_METADATA.decimals)
      const amountL2 = parseUnits(displayAmount, L2_TOKEN_METADATA.decimals)
      const mutationParams = {
        amountL1: amountL1.toString(),
        amountL2: amountL2.toString(),
        amountDisplayL1: displayAmount,
        amountDisplayL2: displayAmount,
      }
      if (bridgeConfig.direction === BridgeDirection.L1_TO_L2) {
        await bridgeTokensToL2(mutationParams)
      } else {
        await withdrawTokensToL1(mutationParams)
      }
    } catch (error) {
      console.error('Bridge operation failed:', error)
    }
  }, [
    bridgeAmount,
    bridgeConfig.direction,
    bridgeTokensToL2,
    withdrawTokensToL1,
  ])

  // Start bridge operation when component mounts (2-second delay for hook stability)
  useEffect(() => {
    setTimeout(() => {
      if (Number(bridgeAmount) > 0 && !operationStarted.current) {
        operationStarted.current = true
        handleBridgeOperation()
      } else if (Number(bridgeAmount) === 0) {
        router.push('/')
      }
    }, 2000)
  }, [
    bridgeAmount,
    bridgeConfig.direction,
    bridgeTokensToL2,
    withdrawTokensToL1,
    router,
    handleBridgeOperation,
  ])

  // Handle errors — set current step to error state
  useEffect(() => {
    const hasError = isBridgeTokensToL2Error || withdrawTokensToL1Error
    if (hasError) {
      const currentStep = steps.findIndex((step) => step.status === 'active')
      if (currentStep !== -1) {
        setProgressStep(currentStep + 1, 'error')
      }
    }
  }, [isBridgeTokensToL2Error, withdrawTokensToL1Error, steps, setProgressStep])

  const hasError = isBridgeTokensToL2Error || withdrawTokensToL1Error
  const amountDisplay = `${bridgeAmount} USDC`
  const fuelBreakdown =
    fuelEnabled && Number(fuelAmountStr) > 0
      ? {
          bridgeAmount: (Number(bridgeAmount) - Number(fuelAmountStr)).toFixed(2),
          fuelAmount: Number(fuelAmountStr).toFixed(2),
        }
      : undefined

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
          fuelBreakdown={fuelBreakdown}
          fromNetwork={bridgeConfig.from.network?.title ?? ''}
          toNetwork={bridgeConfig.to.network?.title ?? ''}
          direction={bridgeConfig.direction === BridgeDirection.L1_TO_L2 ? 'L1_TO_L2' : 'L2_TO_L1'}
        />
      </div>
    </RootStyle>
  )
}
