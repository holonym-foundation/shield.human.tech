'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { STORAGE_KEYS } from '@human.tech/aztec-bridge-sdk'
import { buildFuelClaimUrl } from '@/utils/fuelClaimLink'
import { useBridgeStore } from '@/stores/bridgeStore'

const LS_KEY_BRIDGE_DEPOSITS = STORAGE_KEYS.deposits

// Polls localStorage because the bridge flow writes fuel-message metadata via
// updateLocalStorageItem, not zustand — no subscribable signal.
export function FuelClaimLinkPanel() {
  const { currentOperationId } = useBridgeStore()
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [recipient, setRecipient] = useState<string | null>(null)
  const [amount, setAmount] = useState<string | null>(null)

  const readEntry = useCallback(() => {
    if (typeof window === 'undefined') return
    if (!currentOperationId) {
      setLink(null)
      setRecipient(null)
      return
    }
    try {
      const raw = localStorage.getItem(LS_KEY_BRIDGE_DEPOSITS)
      if (!raw) {
        setLink(null)
        return
      }
      const claims = JSON.parse(raw) as any[]
      // SDK stores `id` as number|string — normalize both sides for the comparison.
      const entry = claims.find(
        (c) =>
          c &&
          String(c.id) === currentOperationId &&
          c.fuelClaimByOther &&
          c.fuelRecipient &&
          c.fuelMessageHash &&
          c.fuelMessageLeafIndex &&
          c.fuelAmount,
      )
      if (!entry) {
        setLink(null)
        return
      }
      if (!entry.fuelSecret) {
        setLink(null)
        return
      }
      const url = buildFuelClaimUrl(window.location.origin, {
        recipient: entry.fuelRecipient,
        claimAmount: String(entry.fuelAmount),
        claimSecret: entry.fuelSecret,
        messageLeafIndex: String(entry.fuelMessageLeafIndex),
        fuelMessageHash: entry.fuelMessageHash,
        l1TxHash: entry.l1TxHash,
      })
      setLink(url)
      setRecipient(entry.fuelRecipient)
      setAmount(String(entry.fuelAmount))
    } catch {
      setLink(null)
    }
  }, [currentOperationId])

  useEffect(() => {
    readEntry()
    const interval = setInterval(readEntry, 3000)
    return () => clearInterval(interval)
  }, [readEntry])

  if (!link || !recipient) return null

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore — fall back to manual copy from the input
    }
  }

  const shortRecipient = recipient.length > 14 ? `${recipient.slice(0, 8)}…${recipient.slice(-6)}` : recipient

  return (
    <div className="mx-5 mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
      <p className="font-semibold text-amber-900">Send the claim link to your recipient</p>
      <p className="text-amber-800 mt-1">
        Fee juice for <span className="font-mono">{shortRecipient}</span> is on L1, but they need this link to claim it
        on L2. Send it to them through a trusted channel — anyone with the link can pay gas to submit the claim, but the
        funds always land at <span className="font-mono">{shortRecipient}</span>.
      </p>
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          readOnly
          value={link}
          onClick={(e) => (e.target as HTMLInputElement).select()}
          className="flex-1 min-w-0 px-2 py-1 text-xs font-mono border border-amber-300 rounded-md bg-white"
        />
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 px-3 py-1 text-xs font-medium border border-amber-300 bg-white text-amber-900 rounded-md hover:bg-amber-100"
        >
          Open
        </a>
        <button
          type="button"
          onClick={onCopy}
          className="shrink-0 px-3 py-1 text-xs font-medium bg-black text-white rounded-md"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export default FuelClaimLinkPanel
