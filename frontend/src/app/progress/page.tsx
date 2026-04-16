'use client'

import React, { useEffect, useRef, useCallback } from 'react'
import RootStyle from '@/components/RootStyle'
import { useRouter } from 'next/navigation'
import StyledImage from '@/components/StyledImage'
import LoadingStepsBars from '@/components/LoadingStepsBars'
import BridgeHeader from '@/components/BridgeHeader'
import { useBridgeStore } from '@/stores/bridgeStore'
import { wait } from '@/utils'
import { formatUnits, parseUnits } from 'viem'
import {
  useL2WithdrawTokensToL1,
  useL2TokenBalance,
  useL2FeeJuiceBalance,
  useL2PrivateFeeJuiceBalance,
} from '@/hooks/useL2Operations'
import { useL1TokenBalances, useL1BridgeToL2 } from '@/hooks/useL1Operations'
import { useResumeL1BridgeToL2 } from '@/hooks/useResumeL1BridgeToL2'
import { useResumeL2WithdrawToL1 } from '@/hooks/useResumeL2WithdrawToL1'
import { BridgeDirection } from '@/types/bridge'
import { L1_TOKEN_METADATA, L2_TOKEN_METADATA } from '@/config'
import { useWalletStore } from '@/stores/walletStore'
import { useToast } from '@/hooks/useToast'
import { useCountdown } from 'usehooks-ts'
import TextButton from '@/components/TextButton'
import { useTokenPrices } from '@/utils/coinGeckoPrice'
import { getTokenPriceUsd } from '@/utils/fuelPricing'

export default function ProgressPage() {
  const router = useRouter()
  const notify = useToast()
  const operationStarted = useRef(false)

  const {
    getProgressSteps,
    headerStep,
    setHeaderStep,
    progressStep,
    setProgressStep,
    bridgeConfig,
    l1TxUrl,
    l2TxUrl,
    direction,
    walletSteps,
    l1ToL2Steps,
    l2ToL1Steps,
    resetStepState,
    recoveryOperationId,
    recoveryClaimData,
    recoveryWithdrawalData,
    fuelEnabled,
    fuelAmount: fuelAmountStr,
    fuelType,
  } = useBridgeStore()

  const isRecoveryMode = !!recoveryOperationId && (!!recoveryClaimData || !!recoveryWithdrawalData)
  const isL2ToL1Recovery = !!recoveryWithdrawalData

  const steps = getProgressSteps()

  const bridgeAmount = bridgeConfig.amount
  const tokenSymbol = bridgeConfig.from.token?.symbol ?? 'USDC'

  // Show enough decimals so the number is meaningful (e.g. 0.003 WETH, not 0.00)
  const formatTokenAmount = (val: number) => {
    if (val === 0) return '0'
    if (val >= 1) return val.toFixed(2)
    // Find first significant digit and show 2 digits after it
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

  // Bridge operations
  const {
    mutate: bridgeTokensToL2,
    isPending: bridgeTokensToL2Pending,
    isSuccess: bridgeTokensToL2Success,
    isError: isBridgeTokensToL2Error,
    error: bridgeTokensToL2Error,
  } = useL1BridgeToL2(handleBridgeSuccess)

  const {
    mutate: withdrawTokensToL1,
    isPending: withdrawTokensToL1Pending,
    isSuccess: withdrawTokensToL1Success,
    isError: withdrawTokensToL1Error,
  } = useL2WithdrawTokensToL1(handleBridgeSuccess)

  // Resume hooks for recovery mode
  const { mutate: resumeBridge, isError: isResumeBridgeError } = useResumeL1BridgeToL2(handleBridgeSuccess)

  const { mutate: resumeWithdrawal, isError: isResumeWithdrawalError } = useResumeL2WithdrawToL1(handleBridgeSuccess)

  // console.log({
  //   isBridgeTokensToL2Error,
  //   // withdrawTokensToL1Error,
  // })
  // Add countdown timer with controls
  const L1_TO_L2_TIME = 15 * 60 // 15 minutes
  const L2_TO_L1_TIME = 50 * 60 // 50 minutes
  const [count, { startCountdown, stopCountdown, resetCountdown }] = useCountdown({
    countStart: direction === BridgeDirection.L1_TO_L2 ? L1_TO_L2_TIME : L2_TO_L1_TIME, // Convert minutes to seconds
    intervalMs: 1000,
  })

  // Format time as MM:SS
  const formattedTime = () => {
    const minutes = Math.floor(count / 60)
    const seconds = count % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }

  // Initial estimated time (full duration) as MM:SS – shown once complete
  const totalEstimateSeconds = direction === BridgeDirection.L1_TO_L2 ? L1_TO_L2_TIME : L2_TO_L1_TIME
  const initialEstimateFormatted = `${Math.floor(totalEstimateSeconds / 60)
    .toString()
    .padStart(2, '0')}:${(totalEstimateSeconds % 60).toString().padStart(2, '0')}`

  // Calculate total time taken
  const totalTimeTaken = () => {
    const totalSeconds = direction === BridgeDirection.L1_TO_L2 ? L1_TO_L2_TIME : L2_TO_L1_TIME
    const timeTaken = totalSeconds - count
    const minutes = Math.floor(timeTaken / 60)
    const seconds = timeTaken % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }

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

  // Prefetch routes this page navigates to
  useEffect(() => {
    router.prefetch('/complete')
    router.prefetch('/')
  }, [router])

  // Start countdown when component mounts
  useEffect(() => {
    startCountdown()
    return () => {
      stopCountdown()
    }
  }, [startCountdown, stopCountdown])

  // Handle bridge operation
  const handleBridgeOperation = useCallback(async () => {
    try {
      if (isRecoveryMode) {
        if (isL2ToL1Recovery && recoveryWithdrawalData) {
          // Resume an incomplete L2→L1 withdrawal
          await resumeWithdrawal(recoveryWithdrawalData)
        } else if (recoveryClaimData) {
          // Resume an incomplete L1→L2 deposit
          await resumeBridge(recoveryClaimData)
        }
      } else {
        // Normal flow — start a new bridge
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
      }
    } catch (error) {
      console.error('Bridge operation failed:', error)
      // Error will be handled by the error effect
    }
  }, [
    bridgeAmount,
    bridgeConfig.direction,
    bridgeTokensToL2,
    withdrawTokensToL1,
    isRecoveryMode,
    isL2ToL1Recovery,
    resumeBridge,
    recoveryClaimData,
    resumeWithdrawal,
    recoveryWithdrawalData,
  ])

  // Start bridge operation when component mounts
  useEffect(() => {
    // ? added 2 seconds delay because isBridgeTokensToL2Error or withdrawTokensToL1Error is not working as expected when called to early
    setTimeout(() => {
      if (isRecoveryMode && !operationStarted.current) {
        // Recovery mode — resume from where the user left off
        operationStarted.current = true
        handleBridgeOperation()
      } else if (Number(bridgeAmount) > 0 && !operationStarted.current) {
        operationStarted.current = true
        handleBridgeOperation()
      } else if (Number(bridgeAmount) === 0 && !isRecoveryMode) {
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
    isRecoveryMode,
  ])

  // Handle errors and stop animation
  useEffect(() => {
    const hasError =
      isBridgeTokensToL2Error || withdrawTokensToL1Error || isResumeBridgeError || isResumeWithdrawalError
    if (hasError) {
      // Stop the timer
      stopCountdown()

      // Set current step to error
      const currentStep = steps.findIndex((step) => step.status === 'active')
      if (currentStep !== -1) {
        setProgressStep(currentStep + 1, 'error')
      }
    }
  }, [
    isBridgeTokensToL2Error,
    withdrawTokensToL1Error,
    isResumeBridgeError,
    isResumeWithdrawalError,
    steps,
    setProgressStep,
    stopCountdown,
  ])

  // Stop timer when all steps are completed
  useEffect(() => {
    if (steps.every((step) => step.status === 'completed')) {
      stopCountdown()
    }
  }, [steps, stopCountdown])

  // Show error message if there's an error
  // useEffect(() => {
  //   if (isBridgeTokensToL2Error) {
  //     notify('error', 'Bridge operation failed')
  //   }
  //   if (withdrawTokensToL1Error) {
  //     notify('error', 'Withdrawal operation failed')
  //   }
  // }, [isBridgeTokensToL2Error, withdrawTokensToL1Error, notify])

  // useEffect(() => {
  //   let isMounted = true

  //   async function updateProgress() {
  //     try {
  //       if (!isMounted) return

  //       if (!isMounted) return
  //       setProgressStep(1, 'active')
  //       await wait(2000)

  //       if (!isMounted) return
  //       setProgressStep(1, 'completed')
  //       setProgressStep(2, 'active')
  //       await wait(2000)

  //       if (!isMounted) return
  //       setProgressStep(2, 'completed')
  //       setProgressStep(3, 'active')

  //       await wait(2000)
  //       if (!isMounted) return
  //       setProgressStep(3, 'completed')
  //       setProgressStep(4, 'active')
  //       await wait(2000)

  //       if (!isMounted) return
  //       setProgressStep(4, 'completed')
  //     } catch (error) {
  //       console.error('Error updating progress:', error)
  //     }
  //   }

  // updateProgress()

  // return () => {
  //   isMounted = false
  // }
  // }, [setProgressStep])

  return (
    <RootStyle className="">
      <div className="px-5 pt-5">
        <div className="flex items-center gap-4">
          <BridgeHeader />
        </div>

        {/* Warning banner */}
        <div className="bg-yellow-50 border border-yellow-200 rounded-md mt-2 px-3 py-2">
          <p className="text-xs text-yellow-800 font-medium text-center">
            Please don't reload or close this page, or it may be difficult to recover your funds.
          </p>
        </div>

        {/* Progress Card */}
        {(() => {
          const isAllComplete = steps.every((step) => step.status === 'completed')
          const hasError =
            isBridgeTokensToL2Error || withdrawTokensToL1Error || isResumeBridgeError || isResumeWithdrawalError

          const heading = hasError
            ? 'Something went wrong'
            : isAllComplete
              ? 'Transaction complete'
              : 'Transaction in progress'

          return (
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
                className={`text-center font-semibold text-md mt-5 ${hasError ? 'text-[#B91C1C]' : isAllComplete ? 'text-green-600' : ''}`}
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
                    <p className="font-semibold text-14">
                      ~{isAllComplete ? initialEstimateFormatted : formattedTime()}
                    </p>
                  </div>
                  {isAllComplete && (
                    <div className="flex justify-between mt-[2px]">
                      <p className="text-14 font-medium text-latest-grey-100">Total time taken </p>
                      <p className="font-semibold text-14">{totalTimeTaken()}</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })()}

        {/* Transaction Details */}
        <div className="bg-[#F5F5F5] rounded-md mt-4 p-4">
          <div className="flex justify-between">
            <div>
              <p className="text-14 font-semibold text-latest-grey-100">From</p>
              <div className="flex gap-2 mt-3">
                <StyledImage src="/assets/svg/ethLogo.svg" alt="" className="h-6 w-6" />
                <p className="text-16 font-medium text-latest-black-100 w-[106px]">
                  {bridgeConfig.from.network?.title}
                </p>
              </div>
            </div>
            <div>
              <p className="text-14 font-semibold text-latest-grey-100">To</p>
              <div className="flex gap-2 mt-3">
                <StyledImage src="/assets/svg/aztec.svg" alt="" className="h-6 w-6" />
                <p className="text-16 font-medium text-latest-black-100 w-[106px]">{bridgeConfig.to.network?.title}</p>
              </div>
            </div>
          </div>
          <hr className="text-latest-grey-300 my-3" />
          <p className="text-32 text-black font-medium text-center">
            {isRecoveryMode
              ? `${formatUnits(BigInt((recoveryClaimData?.amount ?? recoveryWithdrawalData?.amount) || '0'), isL2ToL1Recovery ? L2_TOKEN_METADATA.decimals : L1_TOKEN_METADATA.decimals)} ${bridgeConfig.from.token?.symbol ?? 'USDC'}`
              : `${bridgeAmount} ${bridgeConfig.from.token?.symbol ?? 'USDC'}`}
          </p>
          {!isRecoveryMode && fuelEnabled && Number(fuelAmountStr) > 0 && (
            <p className="text-center text-12 font-medium text-latest-grey-500 mt-1">
              {formatTokenAmount(Number(bridgeAmount) - Number(fuelAmountStr))} {tokenSymbol} to bridge +{' '}
              {fuelUsd ? `$${fuelUsd}` : `${formatTokenAmount(Number(fuelAmountStr))} ${tokenSymbol}`} to top up{' '}
              {fuelType === 'private' ? 'private Fee Juice' : 'Fee Juice'}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-row items-center justify-center px-5 mt-2 gap-4">
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
      </div>

      <div className="flex flex-row items-center justify-center px-5 mt-4 mb-6">
        {(steps.every((step) => step.status === 'completed') ||
          isBridgeTokensToL2Error ||
          withdrawTokensToL1Error ||
          isResumeBridgeError ||
          isResumeWithdrawalError) && (
          <TextButton className="" onClick={() => router.push('/')}>
            Back to Main Screen
          </TextButton>
        )}
      </div>

      {/* <button
        onClick={() => router.back()}
        className='flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors'
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M19 12H5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12 19L5 12L12 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className='text-14 font-medium'>Back</span>
      </button> */}
    </RootStyle>
  )
}
