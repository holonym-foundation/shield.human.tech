'use client'

import type { BridgeOperation, BridgeOperationStatus } from '@human.tech/aztec-bridge-sdk'
import { BRIDGE_STATUS_INFO } from '@human.tech/aztec-bridge-sdk'
import { formatUnits } from 'viem'
import { L1_TOKEN_METADATA } from '@/config'
import { isResumable } from '@/utils/resumability'
import { exportToJsonFile } from '@/utils'

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  deposited: 'bg-blue-100 text-blue-800',
  claimed: 'bg-purple-100 text-purple-800',
  submitted: 'bg-blue-100 text-blue-800',
  ready: 'bg-indigo-100 text-indigo-800',
  pending_finalize: 'bg-indigo-100 text-indigo-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
}

function formatErrorMessage(msg: unknown): string {
  if (!msg) return ''
  if (typeof msg === 'string') {
    if (msg === '[object Object]') return 'Operation failed'
    return msg
  }
  if (msg instanceof Error) return msg.message
  if (typeof msg === 'object') {
    const obj = msg as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'string') return obj.error
    return JSON.stringify(msg)
  }
  return String(msg)
}

function exportOperationData(operation: BridgeOperation) {
  const direction = operation.direction === 'L1_TO_L2' ? 'deposit' : 'withdrawal'
  const exportData = {
    type: operation.direction,
    timestamp: new Date().toISOString(),
    warning: 'Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
    data: operation,
  }
  const filename = `aztec-bridge-${direction}-${operation.id}-${Date.now()}.json`
  exportToJsonFile(exportData, filename)
}

interface ActivityCardProps {
  operation: BridgeOperation
  onResume: (operation: BridgeOperation) => void
  resuming: boolean
}

export default function ActivityCard({
  operation,
  onResume,
  resuming,
}: ActivityCardProps) {
  const amount = operation.amountDisplayL1
    ?? (operation.amountL1 ? formatUnits(BigInt(operation.amountL1), L1_TOKEN_METADATA.decimals) : '?')
  const date = new Date(operation.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const directionLabel =
    operation.direction === 'L1_TO_L2' ? 'L1 → L2' : 'L2 → L1'

  const statusInfo = BRIDGE_STATUS_INFO[operation.status as BridgeOperationStatus]
  const colorClass = STATUS_COLORS[operation.status] ?? 'bg-gray-100 text-gray-800'
  const errorText = operation.lastErrorMessage ? formatErrorMessage(operation.lastErrorMessage) : null

  return (
    <div className='bg-white rounded-lg p-4 shadow-sm border border-gray-100'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='text-sm font-medium text-gray-600'>
            {directionLabel}
          </span>
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${colorClass}`}>
            {statusInfo?.label ?? operation.status}
          </span>
        </div>
        <span className='text-xs text-gray-400'>{date}</span>
      </div>

      <p className='text-xl font-semibold mt-2'>{amount} USDC</p>

      <p className='text-xs text-gray-500 mt-1'>
        {statusInfo?.description ?? operation.status}
      </p>

      {errorText && (
        <p className='text-xs text-red-500 mt-1 truncate'>
          {errorText}
        </p>
      )}

      <div className='flex items-center gap-3 mt-3'>
        {operation.l1TxUrl && (
          <a
            href={operation.l1TxUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='text-xs font-medium text-blue-600 hover:text-blue-800'>
            L1 Tx ↗
          </a>
        )}
        {operation.l2TxUrl && (
          <a
            href={operation.l2TxUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='text-xs font-medium text-purple-600 hover:text-purple-800'>
            L2 Tx ↗
          </a>
        )}

        <button
          onClick={(e) => {
            e.stopPropagation()
            exportOperationData(operation)
          }}
          className='text-xs font-medium text-[#047857] hover:text-[#065f46] transition-colors'
          title='Download backup'>
          Export ↓
        </button>

        {isResumable(operation) && (
          <button
            onClick={() => onResume(operation)}
            disabled={resuming}
            className='ml-auto text-xs font-semibold text-white bg-black hover:bg-gray-800 disabled:bg-gray-400 px-3 py-1 rounded-lg'>
            {resuming ? 'Decrypting...' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  )
}
