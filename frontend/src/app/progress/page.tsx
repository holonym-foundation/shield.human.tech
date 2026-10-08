'use client'

import React, { useEffect, useRef, useCallback, useState } from 'react'
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
import { pushNotification } from '@/stores/useNotificationsStore'
import { useTokenPrices } from '@/utils/coinGeckoPrice'
import { getTokenPriceUsd } from '@/utils/fuelPricing'

export default function ProgressPage() {
  const router = useRouter()
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
    isPrivacyModeEnabled,
    recoveryClaimData,
    recoveryWithdrawalData,
  } = useBridgeStore()

  // The header's privacy toggle stays live on this page, so the store flag can change after the
  // transfer started. The badge must show the operation's own mode: a resumed operation carries
  // it in its recovery data; a fresh one started on entry, while the toggle still matched.
  const [modeAtEntry] = useState(isPrivacyModeEnabled)
  const operationIsPrivate =
    recoveryClaimData?.isPrivacyModeEnabled ?? recoveryWithdrawalData?.isPrivacyModeEnabled ?? modeAtEntry

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
    // BridgeHeader now shows the live "Refreshing balances" status off the shared
    // balance-query fetching flags, so there is no pending/success corner toast.
    // Only a genuine refresh failure is surfaced, via the feed.
    Promise.all([
      refetchL1Balance(),
      refetchL2Balance(),
      refetchFeeJuiceBalance(),
      refetchPrivateFeeJuiceBalance(),
    ]).catch(() => {
      pushNotification({ type: 'error', title: 'Failed to refresh balances' })
    })
  }, [refetchL1Balance, refetchL2Balance, refetchFeeJuiceBalance, refetchPrivateFeeJuiceBalance])

  // Fresh bridge operations only — resume lives at /progress/resume
  const {
    mutate: bridgeTokensToL2,
    isError: isBridgeTokensToL2Error,
    error: bridgeTokensToL2Err,
  } = useL1BridgeToL2(handleBridgeSuccess)

  const {
    mutate: withdrawTokensToL1,
    isError: withdrawTokensToL1Error,
    error: withdrawTokensToL1Err,
  } = useL2WithdrawTokensToL1(handleBridgeSuccess)

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
        router.push('/?app=1')
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

  const hasError = isBridgeTokensToL2Error || withdrawTokensToL1Error
  const errorMessage =
    (bridgeTokensToL2Err instanceof Error ? bridgeTokensToL2Err.message : null) ??
    (withdrawTokensToL1Err instanceof Error ? withdrawTokensToL1Err.message : null)

  // A transfer is genuinely "in progress" once an operation step has gone active and the
  // flow hasn't reached a terminal state (all steps completed, or an errored step). This is
  // the single signal that gates every state-loss guard on this screen.
  const isAllComplete = steps.length > 0 && steps.every((step) => step.status === 'completed')
  const isTransferInProgress = !isAllComplete && !hasError && steps.some((step) => step.status === 'active')

  // While in progress, warn on any full-page unload (reload, tab close, hard navigation) —
  // the live progress view and pending on-chain state would be dropped. Attach only in that
  // window; the cleanup detaches the moment the flow completes or errors (deps re-run).
  useEffect(() => {
    if (!isTransferInProgress) return
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Legacy browsers require a returnValue to trigger the native confirm.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [isTransferInProgress])

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
    // No-scroll budget: same cap as the bridge card (see app/page.tsx) so the progress card
    // never grows the RootStyle region past its 90vh floor. The header stays pinned; the
    // card body scrolls inside itself if it can't fit, never the page.
    <RootStyle className="min-h-0 overflow-hidden">
      <div className="flex h-full flex-col overflow-hidden">
        <div className="px-5 pt-5">
          <div className="flex items-center gap-4">
            <BridgeHeader />
          </div>
        </div>

        {/* Scrolls internally (never the page) if the card can't fit the viewport. */}
        <div className="px-5 pb-5 min-h-0 flex-1 overflow-y-auto">
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
            errorMessage={errorMessage}
            isPrivate={operationIsPrivate}
            currentPrivacyMode={isPrivacyModeEnabled}
          />

          <FuelClaimLinkPanel />
        </div>
      </div>
    </RootStyle>
  )
}
