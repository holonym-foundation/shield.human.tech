'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import RootStyle from '@/components/RootStyle'
import BridgeHeader from '@/components/BridgeHeader'
import TextButton from '@/components/TextButton'
import { getDeposits, getWithdrawals } from '@human.tech/aztec-bridge-sdk'
import type {
  BridgeOperation,
  RecoveryClaimData,
  RecoveryWithdrawalData,
} from '@human.tech/aztec-bridge-sdk'
import { decryptOperationPayload } from '@/hooks/useBridgeOperations'
import { isResumable, hasPossibleLockedFunds } from '@/utils/resumability'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useWalletStore } from '@/stores/walletStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useBridge } from '@/hooks/useBridge'
import { useToast } from '@/hooks/useToast'
import { BridgeDirection } from '@/types/bridge'
import { L1_TOKEN_METADATA } from '@/config'
import { formatUnits } from 'viem'

// ─── Types ──────────────────────────────────────────────────────────

type LocalRecoverySource = 'localStorage' | 'jsonUpload'

interface LocalRecoveryEntry {
  operationId: number
  source: LocalRecoverySource
  direction: 'L1_TO_L2' | 'L2_TO_L1'
  // Plaintext metadata
  status: string | null
  amountL1: string | null
  amountL2: string | null
  amountDisplayL1: string | null
  amountDisplayL2: string | null
  tokenSymbol: string | null
  l1TxHash: string | null
  l1TxUrl: string | null
  l2TxHash: string | null
  l2TxUrl: string | null
  messageHash: string | null
  l1BlockNumberBeforeTx: string | null
  messageLeafIndex: string | null
  l2BlockNumber: string | null
  l2BlockNumberBeforeTx: string | null
  l2ToL1MessageIndex: string | null
  siblingPath: string[] | null
  epoch: number | null
  recipientL1Address: string | null
  rollupVersion: number | null
  chainIdL1: number | null
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  l1RollupAddress: string | null
  l1OutboxAddress: string | null
  tokenAddressL1: string | null
  tokenAddressL2: string | null
  isPrivacyModeEnabled: boolean | null
  nodeInfo: Record<string, unknown> | null
  currentStep: number | null
  createdAt: string | null
  // Encrypted fields (required for decryption)
  encryptedCiphertext: string | null
  encryptedIv: string | null
  encryptedTag: string | null
  keyDerivationMessage: string | null
  keyDerivationDomain: string | null
  // Server status (fetched async)
  serverStatus: string | null
  serverEntry: BridgeOperation | null
  serverStatusLoading: boolean
}

// ─── Helpers ────────────────────────────────────────────────────────

function inferDirection(raw: any): 'L1_TO_L2' | 'L2_TO_L1' | null {
  // Explicit direction field
  if (raw.direction === 'L1_TO_L2' || raw.direction === 'L2_TO_L1') {
    return raw.direction
  }
  // Heuristic: L1→L2 deposits have claimSecretHash
  if (raw.claimSecretHash || raw.messageHash) {
    return 'L1_TO_L2'
  }
  // Heuristic: L2→L1 withdrawals have l2BridgeAddress in the data
  if (raw.l2BridgeAddress || raw.l2BlockNumber !== undefined) {
    return 'L2_TO_L1'
  }
  return null
}

function toLocalRecoveryEntry(
  raw: any,
  source: LocalRecoverySource,
  direction: 'L1_TO_L2' | 'L2_TO_L1',
): LocalRecoveryEntry | null {
  const operationId =
    typeof raw.operationId === 'number'
      ? raw.operationId
      : typeof raw.id === 'number'
        ? raw.id
        : null

  if (operationId === null) return null

  // Require at least some encrypted data for recovery to be meaningful
  if (!raw.encryptedCiphertext && !raw.ciphertext) return null

  const ciphertext = raw.encryptedCiphertext ?? raw.ciphertext ?? null
  const iv = raw.encryptedIv ?? raw.iv ?? null
  const tag = raw.encryptedTag ?? raw.tag ?? null
  const keyDerivationMessage = raw.keyDerivationMessage ?? null
  const keyDerivationDomain = raw.keyDerivationDomain ?? null

  return {
    operationId,
    source,
    direction,
    status: raw.status ?? null,
    amountL1: raw.amountL1 ?? raw.amount ?? null,
    amountL2: raw.amountL2 ?? raw.amount ?? null,
    amountDisplayL1: raw.amountDisplayL1 ?? null,
    amountDisplayL2: raw.amountDisplayL2 ?? null,
    tokenSymbol: raw.tokenSymbol ?? raw.tokenSymbolL1 ?? null,
    l1TxHash: raw.l1TxHash ?? null,
    l1TxUrl: raw.l1TxUrl ?? null,
    l2TxHash: raw.l2TxHash ?? null,
    l2TxUrl: raw.l2TxUrl ?? null,
    messageHash: raw.messageHash ?? null,
    l1BlockNumberBeforeTx: raw.l1BlockNumberBeforeTx ?? null,
    messageLeafIndex: raw.messageLeafIndex ?? null,
    l2BlockNumber: raw.l2BlockNumber != null ? String(raw.l2BlockNumber) : null,
    l2BlockNumberBeforeTx:
      raw.l2BlockNumberBeforeTx != null
        ? String(raw.l2BlockNumberBeforeTx)
        : null,
    l2ToL1MessageIndex:
      raw.l2ToL1MessageIndex != null ? String(raw.l2ToL1MessageIndex) : null,
    siblingPath: Array.isArray(raw.siblingPath) ? raw.siblingPath : null,
    epoch: raw.epoch != null ? Number(raw.epoch) : null,
    recipientL1Address: raw.recipientL1Address ?? null,
    rollupVersion: raw.rollupVersion != null ? Number(raw.rollupVersion) : null,
    chainIdL1: raw.chainIdL1 != null ? Number(raw.chainIdL1) : null,
    portalAddressL1: raw.portalAddressL1 ?? null,
    bridgeAddressL2: raw.bridgeAddressL2 ?? raw.l2BridgeAddress ?? null,
    l1RollupAddress: raw.l1RollupAddress ?? null,
    l1OutboxAddress: raw.l1OutboxAddress ?? null,
    tokenAddressL1: raw.tokenAddressL1 ?? null,
    tokenAddressL2: raw.tokenAddressL2 ?? null,
    isPrivacyModeEnabled: raw.isPrivacyModeEnabled ?? null,
    nodeInfo: raw.nodeInfo ?? null,
    currentStep: raw.currentStep != null ? Number(raw.currentStep) : null,
    createdAt: raw.createdAt ?? null,
    encryptedCiphertext: ciphertext,
    encryptedIv: iv,
    encryptedTag: tag,
    keyDerivationMessage,
    keyDerivationDomain,
    serverStatus: null,
    serverEntry: null,
    serverStatusLoading: false,
  }
}

/**
 * Coerce a LocalRecoveryEntry into a BridgeOperation shape for decryptOperationPayload().
 * Server data takes priority. Fall back to local data. Set missing fields to null.
 */
function toBridgeOperationShape(entry: LocalRecoveryEntry): BridgeOperation {
  const server = entry.serverEntry
  return {
    id: entry.operationId,
    direction: entry.direction,
    status: server?.status ?? entry.status ?? 'pending',
    amountL1: server?.amountL1 ?? entry.amountL1,
    amountL2: server?.amountL2 ?? entry.amountL2,
    amountDisplayL1: server?.amountDisplayL1 ?? entry.amountDisplayL1,
    amountDisplayL2: server?.amountDisplayL2 ?? entry.amountDisplayL2,
    tokenSymbolL1: server?.tokenSymbolL1 ?? entry.tokenSymbol,
    tokenSymbolL2: server?.tokenSymbolL2 ?? null,
    l1TxHash: server?.l1TxHash ?? entry.l1TxHash,
    l1TxUrl: server?.l1TxUrl ?? entry.l1TxUrl,
    l2TxHash: server?.l2TxHash ?? entry.l2TxHash,
    l2TxUrl: server?.l2TxUrl ?? entry.l2TxUrl,
    l1BlockNumber: server?.l1BlockNumber ?? null,
    messageHash: server?.messageHash ?? entry.messageHash,
    messageLeafIndex: server?.messageLeafIndex ?? entry.messageLeafIndex,
    l1BlockNumberBeforeTx:
      server?.l1BlockNumberBeforeTx ?? entry.l1BlockNumberBeforeTx,
    amountAfterFee: server?.amountAfterFee ?? null,
    fuelMessageHash: server?.fuelMessageHash ?? null,
    fuelMessageLeafIndex: server?.fuelMessageLeafIndex ?? null,
    fuelAmount: server?.fuelAmount ?? null,
    l2BlockNumber: server?.l2BlockNumber ?? entry.l2BlockNumber,
    l2BlockNumberBeforeTx:
      server?.l2BlockNumberBeforeTx ?? entry.l2BlockNumberBeforeTx,
    l2ToL1MessageIndex:
      server?.l2ToL1MessageIndex ?? entry.l2ToL1MessageIndex,
    siblingPath: server?.siblingPath ?? entry.siblingPath,
    epoch: server?.epoch ?? entry.epoch,
    recipientL1Address:
      server?.recipientL1Address ?? entry.recipientL1Address,
    rollupVersion: server?.rollupVersion ?? entry.rollupVersion,
    chainIdL1: server?.chainIdL1 ?? entry.chainIdL1,
    portalAddressL1: server?.portalAddressL1 ?? entry.portalAddressL1,
    bridgeAddressL2: server?.bridgeAddressL2 ?? entry.bridgeAddressL2,
    l1RollupAddress: server?.l1RollupAddress ?? entry.l1RollupAddress,
    l1OutboxAddress: server?.l1OutboxAddress ?? entry.l1OutboxAddress,
    tokenSymbol: server?.tokenSymbol ?? entry.tokenSymbol,
    tokenAddressL1: server?.tokenAddressL1 ?? entry.tokenAddressL1,
    tokenAddressL2: server?.tokenAddressL2 ?? entry.tokenAddressL2,
    currentStep: server?.currentStep ?? entry.currentStep,
    isPrivacyModeEnabled:
      server?.isPrivacyModeEnabled ?? entry.isPrivacyModeEnabled,
    lastErrorMessage: server?.lastErrorMessage ?? null,
    nodeInfo: server?.nodeInfo ?? entry.nodeInfo,
    createdAt: server?.createdAt ?? entry.createdAt ?? new Date().toISOString(),
    completedAt: server?.completedAt ?? null,
    encryptedCiphertext:
      server?.encryptedCiphertext ?? entry.encryptedCiphertext,
    encryptedIv: server?.encryptedIv ?? entry.encryptedIv,
    encryptedTag: server?.encryptedTag ?? entry.encryptedTag,
    keyDerivationMessage:
      server?.keyDerivationMessage ?? entry.keyDerivationMessage,
    keyDerivationDomain:
      server?.keyDerivationDomain ?? entry.keyDerivationDomain,
  }
}

// ─── STATUS_STYLES (shared with ActivityCard) ───────────────────────

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
  deposited: { label: 'Deposited', className: 'bg-blue-100 text-blue-800' },
  claimed: { label: 'Claimed', className: 'bg-purple-100 text-purple-800' },
  submitted: { label: 'Submitted', className: 'bg-blue-100 text-blue-800' },
  ready: { label: 'Ready', className: 'bg-indigo-100 text-indigo-800' },
  pending_finalize: {
    label: 'Finalizing',
    className: 'bg-indigo-100 text-indigo-800',
  },
  completed: { label: 'Completed', className: 'bg-green-100 text-green-800' },
  failed: { label: 'Failed', className: 'bg-red-100 text-red-800' },
}

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] ?? {
    label: status,
    className: 'bg-gray-100 text-gray-800',
  }
  return (
    <span
      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${style.className}`}>
      {style.label}
    </span>
  )
}

// ─── RecoveryEntryCard ───────────────────────────────────────────────

interface RecoveryEntryCardProps {
  entry: LocalRecoveryEntry
  onResume: (entry: LocalRecoveryEntry) => void
  resuming: boolean
}

function RecoveryEntryCard({
  entry,
  onResume,
  resuming,
}: RecoveryEntryCardProps) {
  const effectiveStatus = entry.serverStatus ?? entry.status ?? 'unknown'
  const directionLabel =
    entry.direction === 'L1_TO_L2' ? 'L1 -> L2' : 'L2 -> L1'

  const rawAmount =
    entry.amountDisplayL1 ??
    entry.amountDisplayL2 ??
    (entry.amountL1
      ? formatUnits(BigInt(entry.amountL1), L1_TOKEN_METADATA.decimals)
      : entry.amountL2
        ? formatUnits(BigInt(entry.amountL2), L1_TOKEN_METADATA.decimals)
        : null)

  const amountDisplay = rawAmount ?? '?'
  const tokenDisplay = entry.tokenSymbol ?? L1_TOKEN_METADATA.symbol

  const opShape = toBridgeOperationShape(entry)
  const resumable = isResumable(opShape)
  const lockedFunds = hasPossibleLockedFunds(opShape)
  const showResume = resumable || lockedFunds

  const sourceLabel =
    entry.source === 'localStorage' ? 'Browser storage' : 'Uploaded file'

  return (
    <div className='bg-white rounded-lg p-4 shadow-sm border border-gray-100'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <span className='text-sm font-medium text-gray-600'>
            {directionLabel}
          </span>
          {entry.serverStatusLoading ? (
            <span className='text-xs text-gray-400'>Checking...</span>
          ) : (
            <StatusBadge status={effectiveStatus} />
          )}
        </div>
        <span className='text-xs text-gray-400 italic'>{sourceLabel}</span>
      </div>

      <p className='text-xl font-semibold mt-2'>
        {amountDisplay} {tokenDisplay}
      </p>

      <p className='text-xs text-gray-400 mt-1'>Operation #{entry.operationId}</p>

      {entry.createdAt && (
        <p className='text-xs text-gray-400'>
          {new Date(entry.createdAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}

      <div className='flex items-center gap-3 mt-3'>
        {(entry.l1TxUrl ?? entry.serverEntry?.l1TxUrl) && (
          <a
            href={entry.l1TxUrl ?? entry.serverEntry?.l1TxUrl ?? '#'}
            target='_blank'
            rel='noopener noreferrer'
            className='text-xs font-medium text-blue-600 hover:text-blue-800'>
            L1 Tx
          </a>
        )}
        {(entry.l2TxUrl ?? entry.serverEntry?.l2TxUrl) && (
          <a
            href={entry.l2TxUrl ?? entry.serverEntry?.l2TxUrl ?? '#'}
            target='_blank'
            rel='noopener noreferrer'
            className='text-xs font-medium text-purple-600 hover:text-purple-800'>
            L2 Tx
          </a>
        )}

        {showResume && (
          <button
            onClick={() => onResume(entry)}
            disabled={resuming}
            className='ml-auto text-xs font-semibold text-white bg-black hover:bg-gray-800 disabled:bg-gray-400 px-3 py-1 rounded-lg'>
            {resuming ? 'Decrypting...' : 'Resume'}
          </button>
        )}

        {!showResume && effectiveStatus !== 'completed' && (
          <span className='ml-auto text-xs text-gray-400'>
            Not resumable ({effectiveStatus})
          </span>
        )}
      </div>
    </div>
  )
}

// ─── File Upload Validation ──────────────────────────────────────────

const REQUIRED_FIELDS = [
  'encryptedCiphertext',
  'encryptedIv',
  'encryptedTag',
  'keyDerivationMessage',
  'keyDerivationDomain',
]

// Also accept legacy field names
const LEGACY_REQUIRED_FIELDS = [
  'ciphertext',
  'iv',
  'tag',
  'keyDerivationMessage',
  'keyDerivationDomain',
]

function validateUploadedEntry(obj: any): string | null {
  const hasOperationId =
    typeof obj.operationId === 'number' || typeof obj.id === 'number'
  if (!hasOperationId) return 'Missing operationId or id'

  const hasNewFields = REQUIRED_FIELDS.every((f) => obj[f] != null)
  const hasLegacyFields = LEGACY_REQUIRED_FIELDS.every((f) => obj[f] != null)

  if (!hasNewFields && !hasLegacyFields) {
    return `Missing required encryption fields. Expected: ${REQUIRED_FIELDS.join(', ')}`
  }
  return null
}

// ─── Main Page ───────────────────────────────────────────────────────

export default function LocalRecoveryPage() {
  const router = useRouter()
  const notify = useToast()
  const bridge = useBridge()

  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const { token } = useAuthStore()
  const { setRecovery, setWithdrawalRecovery, setDirection } = useBridgeStore()

  const [entries, setEntries] = useState<LocalRecoveryEntry[]>([])
  const [resumingId, setResumingId] = useState<number | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)

  // Track which operation IDs we've already attempted to fetch server status for
  const fetchedIds = useRef<Set<number>>(new Set())

  // Prefetch resume route
  useEffect(() => {
    router.prefetch('/progress/resume')
  }, [router])

  // Load from localStorage on mount (client-only)
  useEffect(() => {
    if (!l1Address || !token) return

    const deposits = getDeposits()
    const withdrawals = getWithdrawals()

    const depositEntries: LocalRecoveryEntry[] = []
    for (const raw of deposits) {
      const dir = inferDirection(raw) ?? 'L1_TO_L2'
      const entry = toLocalRecoveryEntry(raw, 'localStorage', dir)
      if (entry) depositEntries.push(entry)
    }

    const withdrawalEntries: LocalRecoveryEntry[] = []
    for (const raw of withdrawals) {
      const dir = inferDirection(raw) ?? 'L2_TO_L1'
      const entry = toLocalRecoveryEntry(raw, 'localStorage', dir)
      if (entry) withdrawalEntries.push(entry)
    }

    // Deduplicate by operationId — keep first occurrence
    const seen = new Set<number>()
    const all: LocalRecoveryEntry[] = []
    for (const e of [...depositEntries, ...withdrawalEntries]) {
      if (!seen.has(e.operationId)) {
        seen.add(e.operationId)
        all.push(e)
      }
    }

    setEntries(all)
  }, [l1Address, token])

  // Fetch server status for each entry
  useEffect(() => {
    if (!l1Address || !token) return

    const unfetched = entries.filter(
      (e) => !fetchedIds.current.has(e.operationId),
    )
    if (unfetched.length === 0) return

    // Mark as fetching
    for (const e of unfetched) {
      fetchedIds.current.add(e.operationId)
    }

    // Set loading state
    setEntries((prev) =>
      prev.map((e) =>
        unfetched.some((u) => u.operationId === e.operationId)
          ? { ...e, serverStatusLoading: true }
          : e,
      ),
    )

    // Fetch each independently
    for (const entry of unfetched) {
      bridge
        .getOperation(entry.operationId)
        .then((serverEntry: BridgeOperation | null) => {
          setEntries((prev) =>
            prev.map((e) =>
              e.operationId === entry.operationId
                ? {
                    ...e,
                    serverStatusLoading: false,
                    serverStatus: serverEntry?.status ?? null,
                    serverEntry: serverEntry ?? null,
                  }
                : e,
            ),
          )
        })
        .catch(() => {
          // Server fetch failed — clear loading, keep local status
          setEntries((prev) =>
            prev.map((e) =>
              e.operationId === entry.operationId
                ? { ...e, serverStatusLoading: false }
                : e,
            ),
          )
        })
    }
  }, [entries, l1Address, token, bridge])

  // ─── File upload ──────────────────────────────────────────────────

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setUploadError(null)
      const file = e.target.files?.[0]
      if (!file) return

      const reader = new FileReader()
      reader.onload = (ev) => {
        try {
          const text = ev.target?.result as string
          const parsed = JSON.parse(text)

          const raws: any[] = Array.isArray(parsed) ? parsed : [parsed]
          const newEntries: LocalRecoveryEntry[] = []

          for (const raw of raws) {
            const validationError = validateUploadedEntry(raw)
            if (validationError) {
              setUploadError(`Invalid entry: ${validationError}`)
              return
            }

            const dir = inferDirection(raw)
            if (!dir) {
              setUploadError(
                'Could not determine bridge direction. Make sure the file has a "direction", "claimSecretHash", or "l2BridgeAddress" field.',
              )
              return
            }

            const entry = toLocalRecoveryEntry(raw, 'jsonUpload', dir)
            if (!entry) {
              setUploadError('Entry is missing required fields (operationId/id).')
              return
            }

            newEntries.push(entry)
          }

          // Deduplicate against existing entries
          setEntries((prev) => {
            const existingIds = new Set(prev.map((e) => e.operationId))
            const deduplicated = newEntries.filter(
              (e) => !existingIds.has(e.operationId),
            )
            if (deduplicated.length === 0) {
              setUploadError(
                'All entries in this file are already in the list.',
              )
              return prev
            }
            return [...prev, ...deduplicated]
          })
        } catch {
          setUploadError('Failed to parse JSON file. Make sure it is valid JSON.')
        }
      }
      reader.readAsText(file)

      // Reset input so same file can be re-uploaded
      e.target.value = ''
    },
    [],
  )

  // ─── Resume flow ─────────────────────────────────────────────────

  const handleResume = useCallback(
    async (entry: LocalRecoveryEntry) => {
      if (!l1Address) {
        notify('error', 'Please connect your Ethereum wallet first')
        return
      }

      setResumingId(entry.operationId)
      try {
        const op = toBridgeOperationShape(entry)

        const decrypted = await decryptOperationPayload(
          op,
          l1Address,
          signWaapMessage,
        )

        if (!decrypted) {
          throw new Error(
            'Could not decrypt operation data. Make sure you are using the same wallet that created this bridge.',
          )
        }

        if (entry.direction === 'L2_TO_L1') {
          const recoveryData: RecoveryWithdrawalData = {
            operationId: entry.operationId,
            amount:
              decrypted.amount ?? op.amountL2 ?? op.amountL1 ?? '0',
            l1Address: decrypted.l1Address ?? l1Address,
            l2Address: decrypted.l2Address ?? '',
            l2TxHash: op.l2TxHash,
            l2TxUrl: op.l2TxUrl,
            l2BlockNumber: op.l2BlockNumber,
            l2BlockNumberBeforeTx: op.l2BlockNumberBeforeTx,
            l2ToL1MessageIndex: op.l2ToL1MessageIndex,
            siblingPath: op.siblingPath,
            recipientL1Address: op.recipientL1Address ?? l1Address,
            rollupVersion: op.rollupVersion,
            chainIdL1: op.chainIdL1,
            portalAddressL1: op.portalAddressL1,
            bridgeAddressL2: op.bridgeAddressL2,
            l1RollupAddress: op.l1RollupAddress,
            l1OutboxAddress: op.l1OutboxAddress,
            isPrivacyModeEnabled: op.isPrivacyModeEnabled ?? false,
            nodeInfo: op.nodeInfo,
            status: op.status,
            currentStep: op.currentStep,
          }

          setDirection(BridgeDirection.L2_TO_L1)
          setWithdrawalRecovery(entry.operationId, recoveryData)
          router.push('/progress/resume')
        } else {
          // L1→L2
          if (!decrypted.claimSecret || !decrypted.claimSecretHash) {
            throw new Error(
              'Could not decrypt claim secret. Make sure you are using the same wallet that created this bridge.',
            )
          }

          const recoveryData: RecoveryClaimData = {
            operationId: entry.operationId,
            claimSecret: decrypted.claimSecret,
            claimSecretHash: decrypted.claimSecretHash,
            messageHash: op.messageHash,
            messageLeafIndex: op.messageLeafIndex,
            amount: decrypted.amount ?? op.amountL1 ?? '0',
            l1Address: decrypted.l1Address ?? l1Address,
            l2Address: decrypted.l2Address ?? '',
            l1TxHash: op.l1TxHash,
            l1TxUrl: op.l1TxUrl,
            l1BlockNumberBeforeTx: op.l1BlockNumberBeforeTx,
            isPrivacyModeEnabled: op.isPrivacyModeEnabled ?? false,
            nodeInfo: op.nodeInfo,
            status: op.status,
            currentStep: op.currentStep,
            portalAddressL1: op.portalAddressL1,
            bridgeAddressL2: op.bridgeAddressL2,
            tokenAddressL1: op.tokenAddressL1,
            tokenAddressL2: op.tokenAddressL2,
          }

          setDirection(BridgeDirection.L1_TO_L2)
          setRecovery(entry.operationId, recoveryData)
          router.push('/progress/resume')
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to decrypt'
        notify('error', msg)
      } finally {
        setResumingId(null)
      }
    },
    [
      l1Address,
      signWaapMessage,
      setRecovery,
      setWithdrawalRecovery,
      setDirection,
      router,
      notify,
    ],
  )

  // ─── Auth gate ────────────────────────────────────────────────────

  const isAuthed = !!l1Address && !!token

  return (
    <RootStyle className='overflow-y-auto'>
      <div className='px-5 pt-5 pb-5 flex flex-col h-full'>
        <div className='flex items-center gap-4'>
          <BridgeHeader />
        </div>

        <h2 className='text-lg font-semibold mt-4'>Local Recovery</h2>
        <p className='text-xs text-gray-500 mt-1'>
          Resume incomplete bridge operations from browser storage or a backup
          file.
        </p>

        {/* Auth warning */}
        {!isAuthed && (
          <div className='mt-4 bg-yellow-50 border border-yellow-200 rounded-lg p-3'>
            <p className='text-xs text-yellow-800 font-medium'>
              Connect your wallet and sign in to load recovery data.
            </p>
          </div>
        )}

        {/* Entry list */}
        {isAuthed && (
          <>
            {entries.length === 0 && (
              <p className='text-sm text-gray-400 mt-4 text-center'>
                No local recovery data found. Upload a backup file below.
              </p>
            )}

            <div className='flex flex-col gap-3 mt-3 flex-1 overflow-y-auto'>
              {entries.map((entry) => (
                <RecoveryEntryCard
                  key={`${entry.source}-${entry.operationId}`}
                  entry={entry}
                  onResume={handleResume}
                  resuming={resumingId === entry.operationId}
                />
              ))}
            </div>
          </>
        )}

        {/* File upload zone */}
        <div className='mt-4'>
          <p className='text-xs text-gray-500 mb-2 font-medium'>
            Upload backup file (.json)
          </p>
          <label className='flex flex-col items-center justify-center w-full h-20 border-2 border-dashed border-gray-200 rounded-lg cursor-pointer hover:border-gray-400 hover:bg-gray-50 transition-colors'>
            <span className='text-xs text-gray-400'>
              Click to select or drag &amp; drop a .json file
            </span>
            <input
              type='file'
              accept='.json'
              className='hidden'
              onChange={handleFileUpload}
            />
          </label>
          {uploadError && (
            <p className='text-xs text-red-500 mt-1'>{uploadError}</p>
          )}
        </div>

        <div className='mt-4 flex flex-col gap-2'>
          <TextButton onClick={() => router.push('/activity')}>
            Back to Activity
          </TextButton>
          <TextButton onClick={() => router.push('/')}>
            Back to Bridge
          </TextButton>
        </div>
      </div>
    </RootStyle>
  )
}
