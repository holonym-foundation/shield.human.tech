import clsxm from '@/utils/clsxm'
import React from 'react'
import { ToastContentProps } from 'react-toastify'

function highlightClickHere(text: string): React.ReactNode {
  const match = text.match(/(.*?)(click here)(.*)/i)
  if (!match) return text
  return (
    <>
      {match[1]}
      <span className='text-[#0A0A0A] font-semibold underline'>{match[2]}</span>
      {match[3]}
    </>
  )
}

interface WarningToastProps extends Partial<ToastContentProps> {
  heading?: string
  message?: string
}

const WarningToast = ({
  closeToast,
  toastProps,
  heading,
  message,
}: WarningToastProps) => (
  <div className='flex items-center gap-4 w-full'>
    <img
      src='/assets/svg/toast/warning.svg'
      alt='Warning Icon'
      width={heading ? 54 : 44}
      height={heading ? 54 : 44}
    />
    <div className='flex flex-col justify-center items-start gap-[4px] flex-1'>
      {heading && (
        <span className='text-[#0A0A0A] font-sans text-[14px] font-semibold leading-[20px]'>
          {heading}
        </span>
      )}
      {message && (
        <span
          className={clsxm(
            'text-[#737373] font-sans leading-[15.6px]',
            heading ? 'text-[12px]' : 'text-[16px]',
            heading && 'font-medium'
          )}>
          {highlightClickHere(message)}
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
        className='text-[#737373] hover:text-neutral-900 transition-colors duration-200'>
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

export default WarningToast
