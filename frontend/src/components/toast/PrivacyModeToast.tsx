import clsxm from '@/utils/clsxm'
import Image from 'next/image'
import React from 'react'
import { ToastContentProps } from 'react-toastify'
import { publicAsset } from '@/config'

interface PrivacyModeToastProps extends Partial<ToastContentProps> {
  heading?: string
  message?: string
}

const PrivacyModeToast = ({
  closeToast,
  toastProps,
  heading,
  message,
}: PrivacyModeToastProps) => (
  <div className='flex items-center gap-4 w-full'>
    <div className='flex p-[10px] items-center gap-[10px] rounded-full bg-[#737373]'>
      <Image
        src={publicAsset('/assets/svg/toast/shield-check.svg')}
        alt='Shield Check'
        width={heading ? 34 : 24}
        height={heading ? 34 : 24}
      />
    </div>
    <div className='flex flex-col justify-center items-start gap-[4px] flex-1'>
      {heading && (
        <span className='text-white font-sans text-[14px] font-semibold leading-[20px]'>
          {heading}
        </span>
      )}
      {message && (
        <span
          className={clsxm(
            'text-[#D4D4D4] font-sans leading-[15.6px]',
            heading ? 'text-[12px]' : 'text-[16px]',
            heading && 'font-medium'
          )}>
          {message}
        </span>
      )}
    </div>
    <button
      onClick={closeToast}
      className='self-start ml-auto focus:outline-none'>
      <svg
        width='24'
        height='24'
        viewBox='0 0 24 24'
        fill='none'
        xmlns='http://www.w3.org/2000/svg'
        className='text-white hover:text-neutral-500 transition-colors duration-200'>
        <path
          d='M18 6L6 18'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path
          d='M6 6L18 18'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
    </button>
  </div>
)

export default PrivacyModeToast
