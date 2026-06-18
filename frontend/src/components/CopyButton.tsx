'use client'

import React, { useState } from 'react'

export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard API unavailable (e.g. non-secure context) — no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy code'}
      className="absolute right-2 top-2 z-10 rounded bg-white/10 px-2 py-1 text-12 text-neutral-200 opacity-0 transition-opacity hover:bg-white/20 focus:opacity-100 group-hover:opacity-100">
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
