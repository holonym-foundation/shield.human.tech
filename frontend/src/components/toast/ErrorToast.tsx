import clsxm from '@/utils/clsxm'
import React, { useState } from 'react'
import { ToastContentProps } from 'react-toastify'

interface ErrorToastProps extends Partial<ToastContentProps> {
  heading?: string
  // widen back to ReactNode so callers (e.g. BridgeActionButton's
  // Attestation-Required toast) can pass JSX with clickable links and the
  // type system actually checks them, instead of casting via `as unknown as string`.
  message?: React.ReactNode
}

const ErrorToast = ({ closeToast, toastProps, heading, message }: ErrorToastProps) => {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    // Only string messages can be copied to clipboard; for ReactNode messages
    // (JSX), copying just the heading is the closest safe approximation —
    // String(<jsxElement>) would produce "[object Object]".
    const messageStr = typeof message === 'string' ? message : ''
    const text = [heading, messageStr].filter(Boolean).join(': ')
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="flex items-center gap-4 w-full">
      <img src="/assets/svg/toast/error.svg" alt="Error Icon" width={heading ? 54 : 44} height={heading ? 54 : 44} />
      <div className="flex flex-col justify-center items-start gap-[4px] flex-1">
        {heading && (
          <span className="text-[#0A0A0A] font-sans text-[14px] font-semibold leading-[20px]">{heading}</span>
        )}
        {message && (
          <span
            className={clsxm(
              'text-[#737373] font-sans leading-[15.6px]',
              heading ? 'text-[12px]' : 'text-[16px]',
              heading && 'font-medium',
            )}
          >
            {message}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 self-start ml-auto">
        <button
          onClick={handleCopy}
          className="focus:outline-none p-0.5"
          title={copied ? 'Copied!' : 'Copy error message'}
        >
          {copied ? (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-green-600"
            >
              <path
                d="M20 6L9 17L4 12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="text-[#737373] hover:text-neutral-900 transition-colors duration-200"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
              <path
                d="M5 15H4C2.89543 15 2 14.1046 2 13V4C2 2.89543 2.89543 2 4 2H13C14.1046 2 15 2.89543 15 4V5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
        <button onClick={closeToast} className="focus:outline-none p-0.5">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="text-[#737373] hover:text-neutral-900 transition-colors duration-200"
          >
            <path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export default ErrorToast
