'use client'

import React, { useEffect, useRef, useCallback } from 'react'
import RootStyle from '@/components/RootStyle'
import { useRouter } from 'next/navigation'
import BridgeHeader from '@/components/BridgeHeader'
import ProgressCard from '@/components/ProgressCard'
import FuelClaimLinkPanel from '@/components/FuelClaimLinkPanel'
import { useBridgeStore } from '@/stores/bridgeStore'
import { parseUnits } from 'viem'
import {
  useL2WithdrawTokensToL1,
  useL2TokenBalance,
  useL2FeeJuiceBalance,
  useL2PrivateFeeJuiceBalance,
} from '@/hooks/useL2Operations'
import { useL1TokenBalances, useL1BridgeToL2 } from '@/hooks/useL1Operations'
import { BridgeDirection } from '@/types/bridge'
import { L1_TOKEN_METADATA, L2_TOKEN_METADATA } from '@/config'
import { useToast } from '@/hooks/useToast'
import { useTokenPrices } from '@/utils/coinGeckoPrice'
import { getTokenPriceUsd } from '@/utils/fuelPricing'

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
    direction,
    fuelEnabled,
    fuelAmount: fuelAmountStr,
    fuelType,
  } = useBridgeStore()

  const steps = getProgressSteps()

  const bridgeAmount = bridgeConfig.amount
  const tokenSymbol = bridgeConfig.from.token?.symbol ?? 'USDC'

  // Show enough decimals so the number is meaningful (e.g. 0.003 WETH, not 0.00)
  const formatTokenAmount = (val: number) => {
    if (val === 0) return '0'
    if (val >= 1) return val.toFixed(2)
    const magnitude = -Math.floor(Math.log10(Math.abs(val)))
    return val.toFixed(Math.min(magnitude + 2, 8))
  }

  // Token prices for displaying fuel amount in USD
  const { prices } = useTokenPrices()
  const fuelUsd =
    fuelAmountStr && Number(fuelAmountStr) > 0
      ? (Number(fuelAmountStr) * getTokenPriceUsd(tokenSymbol, prices)).toFixed(2)
      : null

  // Refetch balances when bridge/withdrawal completes (show toast on progress page too)
  const { refetch: refetchL1Balance } = useL1TokenBalances()
  const { refetch: refetchL2Balance } = useL2TokenBalance()
  const { refetch: refetchFeeJuiceBalance } = useL2FeeJuiceBalance()
  const { refetch: refetchPrivateFeeJuiceBalance } = useL2PrivateFeeJuiceBalance()
  const handleBridgeSuccess = useCallback(() => {
    notify.promise(
      Promise.all([refetchL1Balance(), refetchL2Balance(), refetchFeeJuiceBalance(), refetchPrivateFeeJuiceBalance()]),
      {
        pending: 'Refreshing balances...',
        success: 'Balances updated',
        error: 'Failed to refresh balances',
      },
    )
  }, [notify, refetchL1Balance, refetchL2Balance, refetchFeeJuiceBalance, refetchPrivateFeeJuiceBalance])

  // Fresh bridge operations only — resume lives at /progress/resume
  const { mutate: bridgeTokensToL2, isError: isBridgeTokensToL2Error } = useL1BridgeToL2(handleBridgeSuccess)

  const { mutate: withdrawTokensToL1, isError: withdrawTokensToL1Error } = useL2WithdrawTokensToL1(handleBridgeSuccess)

  const L1_TO_L2_TIME = 15 * 60 // seconds
  const L2_TO_L1_TIME = 50 * 60 // seconds
  const estimatedTimeSeconds = direction === BridgeDirection.L1_TO_L2 ? L1_TO_L2_TIME : L2_TO_L1_TIME

  // Prefetch routes this page navigates to
  useEffect(() => {
    router.prefetch('/complete')
    router.prefetch('/')
  }, [router])

  // Handle fresh bridge operation
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
  }, [bridgeAmount, bridgeConfig.direction, bridgeTokensToL2, withdrawTokensToL1])

  // Start bridge operation when component mounts. A 2s delay lets the error
  // state on the hooks settle — they briefly report isError=true during
  // teardown/remount otherwise.
  useEffect(() => {
    setTimeout(() => {
      if (Number(bridgeAmount) > 0 && !operationStarted.current) {
        operationStarted.current = true
        handleBridgeOperation()
      } else if (Number(bridgeAmount) === 0) {
        router.push('/')
      }
    }, 2000)
  }, [bridgeAmount, bridgeConfig.direction, bridgeTokensToL2, withdrawTokensToL1, router, handleBridgeOperation])

  // Handle errors — set current active step to error state
  useEffect(() => {
    const hasError = isBridgeTokensToL2Error || withdrawTokensToL1Error
    if (hasError) {
      const currentStep = steps.findIndex((step) => step.status === 'active')
      if (currentStep !== -1) {
        setProgressStep(currentStep + 1, 'error')
      }
    }
  }, [isBridgeTokensToL2Error, withdrawTokensToL1Error, steps, setProgressStep])

  // Arm beforeunload only inside the irrecoverable window: a tx is broadcast and the bridge
  // hasn't reached a terminal state. Otherwise nothing is at risk and the prompt is noise.
  useEffect(() => {
    const hasInFlightTx = !!(l1TxUrl || l2TxUrl)
    const hasActiveStep = steps.some((step) => step.status === 'active')
    if (!hasInFlightTx || !hasActiveStep) return
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [steps, l1TxUrl, l2TxUrl])

  const hasError = isBridgeTokensToL2Error || withdrawTokensToL1Error

  // Amount display with optional fuel breakdown. Preserved from the pre-split
  // page: if fuel is enabled and > 0, show "<bridged> <symbol> to bridge +
  // $<usd> to top up <fuel type>" below the main amount.
  const amountDisplay = `${bridgeAmount} ${bridgeConfig.from.token?.symbol ?? 'USDC'}`
  const fuelBreakdown =
    fuelEnabled && Number(fuelAmountStr) > 0
      ? {
          bridgeAmount: `${formatTokenAmount(Number(bridgeAmount) - Number(fuelAmountStr))} ${tokenSymbol}`,
          fuelAmount: fuelUsd
            ? `$${fuelUsd} to top up ${fuelType === 'private' ? 'private Fee Juice' : 'Fee Juice'}`
            : `${formatTokenAmount(Number(fuelAmountStr))} ${tokenSymbol} to top up ${fuelType === 'private' ? 'private Fee Juice' : 'Fee Juice'}`,
        }
      : undefined

  const fromNetwork = bridgeConfig.from.network?.title ?? ''
  const toNetwork = bridgeConfig.to.network?.title ?? ''

  return (
    <RootStyle className="">
      <div className="px-5 pt-5">
        <div className="flex items-center gap-4">
          <BridgeHeader />
        </div>

        <ProgressCard
          steps={steps}
          progressStep={progressStep}
          hasError={hasError}
          l1TxUrl={l1TxUrl}
          l2TxUrl={l2TxUrl}
          estimatedTimeSeconds={estimatedTimeSeconds}
          amountDisplay={amountDisplay}
          fuelBreakdown={fuelBreakdown}
          fromNetwork={fromNetwork}
          toNetwork={toNetwork}
          direction={direction === BridgeDirection.L1_TO_L2 ? 'L1_TO_L2' : 'L2_TO_L1'}
        />

        <FuelClaimLinkPanel />
      </div>
    </RootStyle>
  )
}
