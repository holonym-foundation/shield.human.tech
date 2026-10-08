'use client'

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react'
import BridgeHeader from '@/components/BridgeHeader'
import TextButton from '@/components/TextButton'
import { getStatusBadge } from '@/components/ActivityCard'
import { getDeposits, getWithdrawals } from '@human.tech/clean.sdk'
import type { BridgeOperation, RecoveryClaimData, RecoveryWithdrawalData } from '@human.tech/clean.sdk'
import { decryptOperationPayload } from '@/hooks/useBridgeOperations'
import { parseBackup, importBackup, BackupParseError, copyToClipboard, humanizeError } from '@/utils'
import { logError } from '@/utils/datadog'
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
  operationId: string
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
  numCheckpointsInEpoch: number | null
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
  encryptedVersion: number | null
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
  const rawId = raw.operationId ?? raw.id ?? null
  const operationId = rawId != null ? String(rawId) : null

  if (operationId === null) return null

  // Require at least some encrypted data for recovery to be meaningful
  if (!raw.encryptedCiphertext && !raw.ciphertext) return null

  const ciphertext = raw.encryptedCiphertext ?? raw.ciphertext ?? null
  const iv = raw.encryptedIv ?? raw.iv ?? null
  const tag = raw.encryptedTag ?? raw.tag ?? null
  const encryptedVersion = raw.encryptedVersion != null ? Number(raw.encryptedVersion) : null
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
    l2BlockNumberBeforeTx: raw.l2BlockNumberBeforeTx != null ? String(raw.l2BlockNumberBeforeTx) : null,
    l2ToL1MessageIndex: raw.l2ToL1MessageIndex != null ? String(raw.l2ToL1MessageIndex) : null,
    siblingPath: Array.isArray(raw.siblingPath) ? raw.siblingPath : null,
    epoch: raw.epoch != null ? Number(raw.epoch) : null,
    numCheckpointsInEpoch: raw.numCheckpointsInEpoch != null ? Number(raw.numCheckpointsInEpoch) : null,
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
    encryptedVersion,
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
    l1BlockNumberBeforeTx: server?.l1BlockNumberBeforeTx ?? entry.l1BlockNumberBeforeTx,
    claimAmount: server?.claimAmount ?? null,
    fuelMessageHash: server?.fuelMessageHash ?? null,
    fuelMessageLeafIndex: server?.fuelMessageLeafIndex ?? null,
    fuelAmount: server?.fuelAmount ?? null,
    l2BlockNumber: server?.l2BlockNumber ?? entry.l2BlockNumber,
    l2BlockNumberBeforeTx: server?.l2BlockNumberBeforeTx ?? entry.l2BlockNumberBeforeTx,
    l2ToL1MessageIndex: server?.l2ToL1MessageIndex ?? entry.l2ToL1MessageIndex,
    siblingPath: server?.siblingPath ?? entry.siblingPath,
    epoch: server?.epoch ?? entry.epoch,
    numCheckpointsInEpoch: server?.numCheckpointsInEpoch ?? entry.numCheckpointsInEpoch,
    recipientL1Address: server?.recipientL1Address ?? entry.recipientL1Address,
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
    isPrivacyModeEnabled: server?.isPrivacyModeEnabled ?? entry.isPrivacyModeEnabled,
    lastErrorMessage: server?.lastErrorMessage ?? null,
    nodeInfo: server?.nodeInfo ?? entry.nodeInfo,
    createdAt: server?.createdAt ?? entry.createdAt ?? new Date().toISOString(),
    completedAt: server?.completedAt ?? null,
    encryptedCiphertext: server?.encryptedCiphertext ?? entry.encryptedCiphertext,
    encryptedIv: server?.encryptedIv ?? entry.encryptedIv,
    encryptedTag: server?.encryptedTag ?? entry.encryptedTag,
    // Read the version off whichever source supplied the ciphertext, not independently:
    // pairing a server blob with a local version would describe the wrong envelope.
    encryptedVersion: server?.encryptedCiphertext ? server.encryptedVersion : entry.encryptedVersion,
    keyDerivationMessage: server?.keyDerivationMessage ?? entry.keyDerivationMessage,
    keyDerivationDomain: server?.keyDerivationDomain ?? entry.keyDerivationDomain,
  } as BridgeOperation
}

// ─── Status badge (colour from the shared ActivityCard source of truth) ──

// Colour comes from getStatusBadge (#394 single source); this component keeps
// its own size/shape classes so the pill matches the recovery card's scale.
function StatusBadge({ status }: { status: string }) {
  const style = getStatusBadge(status)
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${style.className}`}>{style.label}</span>
}

// ─── RecoveryEntryCard ───────────────────────────────────────────────

interface RecoveryEntryCardProps {
  entry: LocalRecoveryEntry
  onResume: (entry: LocalRecoveryEntry) => void
  resuming: boolean
}

function shortenOperationId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

function RecoveryEntryCard({ entry, onResume, resuming }: RecoveryEntryCardProps) {
  const notify = useToast()
  const effectiveStatus = entry.serverStatus ?? entry.status ?? 'unknown'
  const directionLabel = entry.direction === 'L1_TO_L2' ? 'L1 → L2' : 'L2 → L1'

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

  const sourceLabel = entry.source === 'localStorage' ? 'Browser storage' : 'Uploaded file'

  const handleCopyId = async () => {
    const ok = await copyToClipboard(entry.operationId)
    notify(ok ? 'success' : 'error', ok ? 'Operation ID copied' : 'Failed to copy ID')
  }

  return (
    <div className="bg-white rounded-lg p-3 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-gray-600 whitespace-nowrap">{directionLabel}</span>
          {entry.serverStatusLoading ? (
            <span className="text-xs text-gray-400">Checking...</span>
          ) : (
            <StatusBadge status={effectiveStatus} />
          )}
        </div>
        <span className="text-[11px] text-gray-400 italic flex-shrink-0">{sourceLabel}</span>
      </div>

      <p className="text-base font-semibold leading-none mt-1.5">
        {amountDisplay} {tokenDisplay}
      </p>

      <div className="mt-1 flex items-center gap-1 text-[11px] text-gray-400 min-w-0">
        <span className="font-mono truncate">#{shortenOperationId(entry.operationId)}</span>
        <button
          type="button"
          onClick={handleCopyId}
          aria-label="Copy operation ID"
          className="flex-shrink-0 text-gray-400 hover:text-[#81133B] p-0.5 rounded"
        >
          <Icon icon="ph:copy" width={12} height={12} />
        </button>
        {entry.createdAt && (
          <span className="ml-auto flex-shrink-0 whitespace-nowrap">
            {new Date(entry.createdAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>

      <div className="flex items-center gap-x-3 gap-y-1.5 mt-2 flex-wrap">
        {(entry.l1TxUrl ?? entry.serverEntry?.l1TxUrl) && (
          <a
            href={entry.l1TxUrl ?? entry.serverEntry?.l1TxUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-shield hover:text-pink-70"
          >
            L1 Tx
            <Icon icon="ph:arrow-square-out" width={13} height={13} />
          </a>
        )}
        {(entry.l2TxUrl ?? entry.serverEntry?.l2TxUrl) && (
          <a
            href={entry.l2TxUrl ?? entry.serverEntry?.l2TxUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-purple-600 hover:text-purple-800"
          >
            L2 Tx
            <Icon icon="ph:arrow-square-out" width={13} height={13} />
          </a>
        )}

        {showResume && (
          <button
            onClick={() => onResume(entry)}
            disabled={resuming}
            className="ml-auto text-xs font-semibold text-white bg-black hover:bg-gray-800 disabled:bg-gray-400 px-3 py-1 rounded-lg"
          >
            {resuming ? 'Decrypting...' : 'Resume'}
          </button>
        )}

        {!showResume && effectiveStatus !== 'completed' && (
          <span className="ml-auto text-xs text-gray-400">Not resumable ({effectiveStatus})</span>
        )}
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────

interface LocalRecoveryPanelProps {
  /** 'page' renders inside the centered app-shell card; 'modal' renders inside an overlay drawer. */
  variant?: 'page' | 'modal'
  onClose?: () => void
}

export function LocalRecoveryPanel({ variant = 'page', onClose }: LocalRecoveryPanelProps) {
  const router = useRouter()
  const notify = useToast()
  const bridge = useBridge()

  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const { token } = useAuthStore()
  const { setRecovery, setWithdrawalRecovery, setDirection } = useBridgeStore()

  const [entries, setEntries] = useState<LocalRecoveryEntry[]>([])
  const [resumingId, setResumingId] = useState<number | string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [page, setPage] = useState(0)

  // Track which operation IDs we've already attempted to fetch server status for
  const fetchedIds = useRef<Set<string>>(new Set())

  // Prefetch resume route
  useEffect(() => {
    router.prefetch('/progress/resume')
  }, [router])

  // Read the SDK's local storage (deposits + withdrawals) into recovery entries.
  const loadFromStorage = useCallback(() => {
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
    const seen = new Set<string>()
    const all: LocalRecoveryEntry[] = []
    for (const e of [...depositEntries, ...withdrawalEntries]) {
      if (!seen.has(e.operationId)) {
        seen.add(e.operationId)
        all.push(e)
      }
    }

    setEntries(all)
  }, [])

  // Load from localStorage on mount (client-only)
  useEffect(() => {
    if (!l1Address || !token) return
    loadFromStorage()
  }, [l1Address, token, loadFromStorage])

  // Fetch server status for each entry
  useEffect(() => {
    if (!l1Address || !token) return

    const unfetched = entries.filter((e) => !fetchedIds.current.has(e.operationId))
    if (unfetched.length === 0) return

    // Mark as fetching
    for (const e of unfetched) {
      fetchedIds.current.add(e.operationId)
    }

    // Set loading state
    setEntries((prev) =>
      prev.map((e) =>
        unfetched.some((u) => u.operationId === e.operationId) ? { ...e, serverStatusLoading: true } : e,
      ),
    )

    // Fetch each independently
    for (const entry of unfetched) {
      bridge
        .getOperation(entry.operationId as any)
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
            prev.map((e) => (e.operationId === entry.operationId ? { ...e, serverStatusLoading: false } : e)),
          )
        })
    }
  }, [entries, l1Address, token, bridge])

  // ─── File upload ──────────────────────────────────────────────────

  const processBackupFile = useCallback(
    (file: File) => {
      setUploadError(null)

      const reader = new FileReader()
      reader.onload = (ev) => {
        let parsed: unknown
        try {
          parsed = JSON.parse(ev.target?.result as string)
        } catch {
          setUploadError('Failed to parse JSON file. Make sure it is valid JSON.')
          notify('error', 'Import failed: file is not valid JSON.')
          return
        }

        try {
          const items = parseBackup(parsed)
          const { imported, skipped } = importBackup(items)

          // Re-read from the SDK's storage so imported entries flow through the
          // same code path (and same source label) as browser-storage entries.
          loadFromStorage()

          if (imported === 0) {
            setUploadError('This backup is already in your recovery list.')
            notify('info', 'Nothing to import. Already in your recovery list.')
          } else {
            const skippedNote = skipped > 0 ? ` (${skipped} already present)` : ''
            notify('success', `Imported ${imported} operation${imported === 1 ? '' : 's'}${skippedNote}.`)
          }
        } catch (err) {
          if (!(err instanceof BackupParseError)) {
            console.error('[LocalRecoveryPanel] backup import failed:', err)
            logError('Backup import failed', {
              errorType: 'backup_import_failed',
              error: err instanceof Error ? err.message : String(err),
            })
          }
          const msg =
            err instanceof BackupParseError
              ? err.message
              : 'This file is not a valid Shield backup. Export it again from the bridge progress screen.'
          setUploadError(msg)
          notify('error', `Import failed: ${msg}`)
        }
      }
      reader.onerror = () => {
        setUploadError('Could not read the selected file.')
        notify('error', 'Could not read the selected file.')
      }
      reader.readAsText(file)
    },
    [notify, loadFromStorage],
  )

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      // Reset input so the same file can be re-uploaded after an error.
      e.target.value = ''
      if (file) processBackupFile(file)
    },
    [processBackupFile],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) processBackupFile(file)
    },
    [processBackupFile],
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

        const decrypted = await decryptOperationPayload(op, l1Address, signWaapMessage)

        if (!decrypted) {
          throw new Error(
            'Could not decrypt operation data. Make sure you are using the same wallet that created this bridge.',
          )
        }

        if (entry.direction === 'L2_TO_L1') {
          const recoveryData: RecoveryWithdrawalData = {
            operationId: entry.operationId,
            amount: decrypted.amount ?? op.amountL2 ?? op.amountL1 ?? '0',
            l1Address: decrypted.l1Address ?? l1Address,
            l2Address: decrypted.l2Address ?? '',
            l2TxHash: op.l2TxHash,
            l2TxUrl: op.l2TxUrl,
            l2BlockNumber: op.l2BlockNumber,
            l2BlockNumberBeforeTx: op.l2BlockNumberBeforeTx,
            l2ToL1MessageIndex: op.l2ToL1MessageIndex,
            siblingPath: op.siblingPath,
            epoch: op.epoch,
            numCheckpointsInEpoch: op.numCheckpointsInEpoch,
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

          const recoveryData = {
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
            claimAmount: null,
            fuelSecret: null,
            privateFuelSalt: null,
            privateFuelSecret: null,
            privateFuelSecretHash: null,
            fuelMessageHash: null,
            fuelMessageLeafIndex: null,
            fuelAmount: null,
          } as RecoveryClaimData

          setDirection(BridgeDirection.L1_TO_L2)
          setRecovery(entry.operationId, recoveryData)
          router.push('/progress/resume')
        }
      } catch (err) {
        console.error('[LocalRecoveryPanel] resume/decrypt failed:', err)
        logError('Resume decrypt failed', {
          errorType: 'resume_decrypt_failed',
          error: err instanceof Error ? err.message : String(err),
        })
        notify('error', humanizeError(err))
      } finally {
        setResumingId(null)
      }
    },
    [l1Address, signWaapMessage, setRecovery, setWithdrawalRecovery, setDirection, router, notify],
  )

  // ─── Pagination (no-scroll: fixed batch + prev/next, mirrors /activity) ──
  // Two compact cards per page fit the shell alongside the pinned import zone and
  // footer at 720/800/900 without spilling into an app-shell scroll.
  const PAGE_SIZE = 2
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1)
  }, [page, totalPages])
  const pageItems = useMemo(
    () => entries.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [entries, page],
  )

  // ─── Auth gate ────────────────────────────────────────────────────

  const isAuthed = !!l1Address && !!token

  return (
    <div className="flex h-full max-h-[calc(90vh-5rem)] flex-col overflow-hidden px-5 pt-4 pb-4">
      {variant === 'modal' ? (
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0A0A0A]">
            <Icon icon="ph:key" width={16} height={16} className="text-[#81133B]" />
            Recover from local backup
          </span>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-6 w-6 items-center justify-center rounded-full text-[#989898] transition-colors hover:bg-[#F0F0F0] hover:text-[#0A0A0A]"
            >
              <Icon icon="ph:x-bold" width={13} height={13} />
            </button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <BridgeHeader />
        </div>
      )}

      <h2 className="text-lg font-semibold mt-3">Local Recovery</h2>
      <p className="text-xs text-gray-500 mt-1">
        Resume incomplete bridge operations from browser storage or a backup file.
      </p>

      {/* Auth warning */}
      {!isAuthed && (
        <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded-lg p-3">
          <p className="text-xs text-yellow-800 font-medium">
            Connect your wallet and sign in to load recovery data.
          </p>
        </div>
      )}

      {/* Entry list (paginated, internally bounded) */}
      {isAuthed && (
        <div className="flex-1 min-h-0 mt-3 flex flex-col">
          {entries.length === 0 && (
            <p className="text-sm text-gray-400 mt-1 text-center">
              No local recovery data found. Upload a backup file below.
            </p>
          )}

          {entries.length > 0 && (
            <>
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
                {pageItems.map((entry) => (
                  <RecoveryEntryCard
                    key={`${entry.source}-${entry.operationId}`}
                    entry={entry}
                    onResume={handleResume}
                    resuming={resumingId === entry.operationId}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-2 flex shrink-0 items-center justify-center gap-4 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    aria-label="Previous page"
                    className="text-gray-500 hover:text-[#81133B] disabled:opacity-40 disabled:hover:text-gray-500 p-1 rounded"
                  >
                    <Icon icon="ph:caret-left-bold" width={16} height={16} />
                  </button>
                  <span className="text-xs font-medium text-gray-500 tabular-nums">
                    {page + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    aria-label="Next page"
                    className="text-gray-500 hover:text-[#81133B] disabled:opacity-40 disabled:hover:text-gray-500 p-1 rounded"
                  >
                    <Icon icon="ph:caret-right-bold" width={16} height={16} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Import backup zone (pinned) */}
      <div className="mt-3 shrink-0">
        <p className="text-xs text-gray-500 mb-1.5 font-medium">Import backup file (.json)</p>
        <label
          onDragOver={(e) => {
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={(e) => {
            e.preventDefault()
            setIsDragging(false)
          }}
          onDrop={handleDrop}
          className={`flex flex-col items-center justify-center gap-1.5 w-full h-20 border-2 border-dashed rounded-lg cursor-pointer transition-colors ${
            isDragging
              ? 'border-shield bg-shield/5'
              : 'border-shield/30 hover:border-shield hover:bg-shield/5'
          }`}
        >
          <span className="text-xs text-gray-500">Drag &amp; drop your Shield backup, or</span>
          <span className="text-xs font-semibold text-white bg-shield hover:bg-[#6a0f31] px-4 py-1.5 rounded-full">
            Choose file
          </span>
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={handleFileUpload}
            aria-label="Import backup file"
          />
        </label>
        {uploadError && (
          <p role="alert" className="text-xs text-red-500 mt-1">
            {uploadError}
          </p>
        )}
      </div>

      <div className="mt-3 flex shrink-0 flex-col gap-2">
        {variant === 'modal' ? (
          <>
            <TextButton
              onClick={() => {
                onClose?.()
                router.push('/activity')
              }}
              className="!bg-transparent !text-gray-600 hover:!text-gray-900 !font-medium"
            >
              Open full Activity
            </TextButton>
            {onClose && <TextButton onClick={onClose}>Close</TextButton>}
          </>
        ) : (
          <>
            <TextButton onClick={() => router.push('/activity')}>Back to Activity</TextButton>
            <TextButton onClick={() => router.push('/?app=1')}>Back to Bridge</TextButton>
          </>
        )}
      </div>
    </div>
  )
}
