'use client'

import React, { useState } from 'react'

interface FuelClaimLinkModalProps {
  isOpen: boolean
  link: string
  recipient: string
  onClose: () => void
}

function shortenAztec(addr: string): string {
  if (!addr) return ''
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

export default function FuelClaimLinkModal({
  isOpen,
  link,
  recipient,
  onClose,
}: FuelClaimLinkModalProps) {
  const [copied, setCopied] = useState(false)

  if (!isOpen) return null

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore — input is selectable as a fallback
    }
  }

  return (
    <div
      className='fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4'
      onClick={onClose}
    >
      <div
        className='bg-white rounded-lg shadow-xl max-w-lg w-full p-5'
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className='text-lg font-semibold'>Share fuel claim link</h3>
        <p className='text-sm text-latest-grey-600 mt-1'>
          Send this link to <span className='font-mono'>{shortenAztec(recipient)}</span> through a trusted channel.
          Anyone with the link can pay gas to submit the claim, but the Fee Juice always lands at the encoded
          recipient address.
        </p>

        <div className='mt-3 flex gap-2'>
          <input
            type='text'
            readOnly
            value={link}
            onClick={(e) => (e.target as HTMLInputElement).select()}
            className='flex-1 min-w-0 px-2 py-1.5 text-xs font-mono border border-gray-300 rounded-md bg-gray-50'
          />
          <button
            type='button'
            onClick={onCopy}
            className='shrink-0 px-3 py-1.5 text-xs font-medium bg-black text-white rounded-md'
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <div className='mt-4 flex justify-end'>
          <button
            type='button'
            onClick={onClose}
            className='text-sm font-medium text-latest-grey-600 hover:text-latest-grey-900 px-3 py-1.5'
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
