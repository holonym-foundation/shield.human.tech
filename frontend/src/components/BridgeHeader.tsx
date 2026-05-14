import React from 'react'
import { useRouter } from 'next/navigation'
import StyledImage from './StyledImage'
import LoadingBar from './LoadingBar'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'

interface BridgeHeaderProps {
  onClick?: () => void
}

const BridgeHeader: React.FC<BridgeHeaderProps> = ({ onClick }) => {
  const router = useRouter()
  const {
    getHeaderSteps,
    headerStep,
    setHeaderStep
  } = useBridgeStore()

  const {
    isWaapConnected,
    isAztecConnected
  } = useWalletStore()

  // Update step statuses based on wallet connections
  React.useEffect(() => {
    if (isWaapConnected) {
      setHeaderStep(1, 'completed')
    } else {
      setHeaderStep(1, 'pending')
    }
    
    if (isAztecConnected) {
      setHeaderStep(2, 'completed')
    } else {
      setHeaderStep(2, 'pending')
    }
  }, [isWaapConnected, isAztecConnected, setHeaderStep])

  const steps = getHeaderSteps()

  return (
    <div className='flex flex-[1_0_0] items-center gap-[12px] rounded-[136px] border border-[#D4D4D4] bg-white px-[16px] py-[4px] pl-[8px]'>
      <img
        src='/assets/svg/human.aztec.svg'
        alt=''
        className='h-[24px] w-[24px]'
      />

      <LoadingBar steps={steps} currentStep={headerStep} />
      <p
        className={`text-center text-[#0A0A0A] font-[700] text-[16px] leading-[24px] tracking-[0.32px] uppercase font-['Suisse_Intl']`}
        onClick={() => {
          if (onClick) {
            onClick()
          }
        }}>
        BRIDGE
      </p>
      <button
        onClick={() => router.push('/activity')}
        className='ml-auto flex items-center justify-center p-1 rounded-full hover:bg-gray-100 transition-colors'
        aria-label='Bridge activity'
      >
        <svg width='20' height='20' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
          <path d='M12 8V12L15 15' stroke='#0A0A0A' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'/>
          <circle cx='12' cy='12' r='9' stroke='#0A0A0A' strokeWidth='2'/>
        </svg>
      </button>
    </div>
  )
}

export default BridgeHeader
