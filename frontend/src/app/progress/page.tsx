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
import { useL2WithdrawTokensToL1 } from '@/hooks/useL2Operations'
import { BridgeDirection } from '@/types/bridge'
import { useL1BridgeToL2 } from '@/hooks/useL1Operations'
import { useWalletStore } from '@/stores/walletStore'
import { useToast } from '@/hooks/useToast'
import { useCountdown } from 'usehooks-ts'
import TextButton from '@/components/TextButton'

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
  } = useBridgeStore()

  const steps = getProgressSteps()

  const bridgeAmount = bridgeConfig.amount
  // const bridgeAmount = '10'

  // const { aztecAddress, metaMaskAddress } = useWalletStore()

  // Bridge operations
  const {
    mutate: bridgeTokensToL2,
    isPending: bridgeTokensToL2Pending,
    isSuccess: bridgeTokensToL2Success,
    isError: isBridgeTokensToL2Error,
    error: bridgeTokensToL2Error,
  } = useL1BridgeToL2()

  const {
    mutate: withdrawTokensToL1,
    isPending: withdrawTokensToL1Pending,
    isSuccess: withdrawTokensToL1Success,
    isError: withdrawTokensToL1Error,
  } = useL2WithdrawTokensToL1()

  // console.log({
  //   isBridgeTokensToL2Error,
  //   // withdrawTokensToL1Error,
  // })
  // Add countdown timer with controls
  const L1_TO_L2_TIME = 15 * 60 // 15 minutes
  const L2_TO_L1_TIME = 50 * 60 // 50 minutes
  const [count, { startCountdown, stopCountdown, resetCountdown }] =
    useCountdown({
      countStart: direction === 'L1_TO_L2' ? L1_TO_L2_TIME : L2_TO_L1_TIME, // Convert minutes to seconds
      intervalMs: 1000,
    })

  // Format time as MM:SS
  const formattedTime = () => {
    const minutes = Math.floor(count / 60)
    const seconds = count % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`
  }

  // Calculate total time taken
  const totalTimeTaken = () => {
    const totalSeconds =
      direction === 'L1_TO_L2' ? L1_TO_L2_TIME : L2_TO_L1_TIME
    const timeTaken = totalSeconds - count
    const minutes = Math.floor(timeTaken / 60)
    const seconds = timeTaken % 60
    return `${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`
  }

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
      // L2 to L1: L2 token has 6 decimals
      const amount = parseUnits(bridgeAmount || '0', 6)
      if (bridgeConfig.direction === BridgeDirection.L1_TO_L2) {
        await bridgeTokensToL2(amount)
      } else {
        await withdrawTokensToL1(amount)
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
  ])

  // Start bridge operation when component mounts
  useEffect(() => {
    // ? added 2 seconds delay because isBridgeTokensToL2Error or withdrawTokensToL1Error is not working as expected when called to early
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

  // Handle errors and stop animation
  useEffect(() => {
    const hasError = isBridgeTokensToL2Error || withdrawTokensToL1Error
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
    <RootStyle className=''>
      <div className='px-5 pt-5'>
        <div className='flex items-center gap-4'>
          <BridgeHeader />
        </div>

        {/* Progress Card */}
        <div className='bg-white rounded-md mt-2 p-4'>
          <div
            className='flex items-center justify-center cursor-pointer'
            // onClick={async () => {
            //   const amount = parseUnits(bridgeAmount || '0', 6) // Assuming 6 decimals for USDC
            //   await bridgeTokensToL2(amount)
            // }}
          >
            <StyledImage
              src='/assets/svg/progress.svg'
              alt=''
              className='h-[56px] w-[56px]'
            />
          </div>
          <p
            onClick={() => router.push('/complete')}
            className='text-center font-semibold text-md mt-5'>
            Transaction in progress
          </p>

          <div className='mt-5'>
            <LoadingStepsBars steps={steps} currentStep={progressStep - 1} />
          </div>
          <hr className='text-latest-grey-300 my-3' />
          <div className='flex justify-between mt-[2px]'>
            <p className='text-14 font-medium text-latest-grey-100'>
              Estimated time{' '}
            </p>
            <p className='font-semibold text-14'>~{formattedTime()}</p>
          </div>
          {steps.every((step) => step.status === 'completed') && (
            <div className='flex justify-between mt-[2px]'>
              <p className='text-14 font-medium text-latest-grey-100'>
                Total time taken{' '}
              </p>
              <p className='font-semibold text-14'>{totalTimeTaken()}</p>
            </div>
          )}
          {(isBridgeTokensToL2Error || withdrawTokensToL1Error) && (
            <div className='mt-4 text-red font-semibold text-center'>
              Operation failed. Please try again.
            </div>
          )}
        </div>

        {/* Transaction Details */}
        <div className='bg-[#F5F5F5] rounded-md mt-4 p-4'>
          <div className='flex justify-between'>
            <div>
              <p className='text-14 font-semibold text-latest-grey-100'>From</p>
              <div className='flex gap-2 mt-3'>
                <StyledImage
                  src='/assets/svg/ethLogo.svg'
                  alt=''
                  className='h-6 w-6'
                />
                <p className='text-16 font-medium text-latest-black-100 w-[106px]'>
                  {bridgeConfig.from.network?.title}
                </p>
              </div>
            </div>
            <div>
              <p className='text-14 font-semibold text-latest-grey-100'>To</p>
              <div className='flex gap-2 mt-3'>
                <StyledImage
                  src='/assets/svg/aztec.svg'
                  alt=''
                  className='h-6 w-6'
                />
                <p className='text-16 font-medium text-latest-black-100 w-[106px]'>
                  {bridgeConfig.to.network?.title}
                </p>
              </div>
            </div>
          </div>
          <hr className='text-latest-grey-300 my-3' />
          <p className='text-32 text-black font-medium text-center'>
            {bridgeAmount} USDC
          </p>
          <p className='text-center text-16 font-medium text-latest-grey-500 mt-2'>
            {/* ${bridgeConfig.amount} */}
          </p>
        </div>
      </div>

      <div className='flex flex-row items-center justify-center px-5 mt-2 gap-4'>
        {l1TxUrl && (
          <a
            href={l1TxUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='text-14 font-semibold text-blue-200 bg-blue-300 hover:text-blue-100 mt-2 block px-4 py-2 rounded-full'>
            View L1 Tx ↗
          </a>
        )}

        {l2TxUrl && (
          <a
            href={l2TxUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='text-14 font-semibold text-[#9333ea] bg-[#f3e8ff] hover:text-[#6b21a8] mt-2 block px-4 py-2 rounded-full'>
            View L2 Tx ↗
          </a>
        )}
      </div>

      <div className='flex flex-row items-center justify-center px-5 mt-4'>
        {(steps.every((step) => step.status === 'completed') ||
          isBridgeTokensToL2Error ||
          withdrawTokensToL1Error) && (
          <TextButton className='' onClick={() => router.push('/')}>
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
