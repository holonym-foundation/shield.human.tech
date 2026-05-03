'use client'

import React from 'react'
import type { BridgeOperation } from '@human.tech/aztec-bridge-sdk'
import { formatUnits } from 'viem'
import { L1_TOKEN_METADATA } from '@/config'
import { isResumable, hasPossibleLockedFunds } from '@/utils/resumability'

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
  deposited: { label: 'Deposited', className: 'bg-blue-100 text-blue-800' },
  claimed: { label: 'Claimed', className: 'bg-purple-100 text-purple-800' },
  submitted: { label: 'Submitted', className: 'bg-blue-100 text-blue-800' },
  ready: { label: 'Ready', className: 'bg-indigo-100 text-indigo-800' },
  pending_finalize: { label: 'Finalizing', className: 'bg-indigo-100 text-indigo-800' },
  completed: { label: 'Completed', className: 'bg-green-100 text-green-800' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800' },
}

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? {
    label: status,
    className: 'bg-gray-100 text-gray-800',
  }
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${style.className}`}>{style.label}</span>
}

/**
 * True when the operation has the fuel-leg fields populated. Whether the fuel was sent to a
 * third party (as opposed to the bridger's own L2) is in the encrypted blob, so we can't tell
 * here — we just expose the share button whenever fuel data exists, and let the click handler
 * decrypt and decide.
 */
function hasFuelClaimData(op: BridgeOperation): boolean {
  if (op.direction !== 'L1_TO_L2') return false
  return !!op.fuelMessageHash && !!op.fuelMessageLeafIndex && !!op.fuelAmount && !!op.l1TxHash
}

interface ActivityCardProps {
  operation: BridgeOperation
  onResume: (operation: BridgeOperation) => void
  resuming: boolean
  onShareFuelClaim?: (operation: BridgeOperation) => void
  sharingFuelClaim?: boolean
}

export default function ActivityCard({
  operation,
  onResume,
  resuming,
  onShareFuelClaim,
  sharingFuelClaim,
}: ActivityCardProps) {
  const decimals = operation.tokenDecimalsL1 ?? L1_TOKEN_METADATA.decimals
  const tokenSymbol = operation.tokenSymbol ?? operation.tokenSymbolL1 ?? L1_TOKEN_METADATA.symbol
  const amount =
    operation.amountDisplayL1 ?? (operation.amountL1 ? formatUnits(BigInt(operation.amountL1), decimals) : '?')
  const date = new Date(operation.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const directionLabel = operation.direction === 'L1_TO_L2' ? 'L1 → L2' : 'L2 → L1'

  // Resume button shown for both standard resumable states AND the edge case
  // where status='pending' but a tx hash exists (session died after tx send
  // but before the status-update PATCH landed — funds may be locked on-chain).
  // Both branches use the same decrypt + resume pipeline; the badge below
  // tells the user which case they're in.
  const resumable = isResumable(operation)
  const lockedFunds = hasPossibleLockedFunds(operation)
  const showResume = resumable || lockedFunds

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-600">{directionLabel}</span>
          <StatusBadge status={operation.status} />
          {lockedFunds && (
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-orange-100 text-orange-800">
              Funds may be locked
            </span>
          )}
        </div>
        <span className="text-xs text-gray-400">{date}</span>
      </div>

      <p className="text-xl font-semibold mt-2">
        {amount} {tokenSymbol}
      </p>

      {operation.lastErrorMessage && <p className="text-xs text-red-500 mt-1 truncate">{operation.lastErrorMessage}</p>}

      <div className="flex items-center gap-3 mt-3">
        {operation.l1TxUrl && (
          <a
            href={operation.l1TxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            L1 Tx ↗
          </a>
        )}
        {operation.l2TxUrl && (
          <a
            href={operation.l2TxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-purple-600 hover:text-purple-800"
          >
            L2 Tx ↗
          </a>
        )}

        <div className="ml-auto flex items-center gap-2">
          {onShareFuelClaim && hasFuelClaimData(operation) && (
            <button
              onClick={() => onShareFuelClaim(operation)}
              disabled={!!sharingFuelClaim}
              className="text-xs font-semibold text-black bg-amber-100 hover:bg-amber-200 disabled:opacity-50 px-3 py-1 rounded-lg"
            >
              {sharingFuelClaim ? 'Decrypting…' : 'Share fuel claim'}
            </button>
          )}
          {showResume && (
            <button
              onClick={() => onResume(operation)}
              disabled={resuming}
              className="text-xs font-semibold text-white bg-black hover:bg-gray-800 disabled:bg-gray-400 px-3 py-1 rounded-lg"
            >
              {resuming ? 'Decrypting...' : 'Resume'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
