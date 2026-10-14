import {
  createSigningMessage,
  deriveEncryptionKeyCandidates,
  decryptDataWithCandidates,
  buildDepositExport,
  buildWithdrawalExport,
  getDepositById,
  getWithdrawalById,
  STORAGE_KEYS,
} from '@human.tech/clean.sdk'
import { formatUnits } from 'viem'
import { getAllowedAppOrigins, isAllowedAppOrigin, normalizeAppOrigin } from '@/lib/domainAllowlist'

// Frontend-only anti-phishing guard: only prompt for encryption signatures on our domain.
// This is NOT an SDK concern — the SDK is domain-agnostic.
function isDevelopmentOrigin(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1'
}

/**
 * Verify the current page origin is allowed for encryption key derivation.
 * Prevents phishing sites from tricking users into signing key-derivation messages.
 * Must be called in the frontend before any signMessage used for encryption.
 */
export function verifyEncryptionDomain(): void {
  if (typeof window === 'undefined') return // SSR — skip
  const origin = normalizeAppOrigin(window.location.origin)
  if (isAllowedAppOrigin(origin) || isDevelopmentOrigin()) return
  const allowedOrigins = Array.from(getAllowedAppOrigins()).join(', ')
  throw new Error(
    `Security Error: Encryption key derivation is only allowed on ${allowedOrigins}. ` +
      `Current origin: ${origin}.`,
  )
}

export const truncateDecimals = (value: number | string, decimals = 6): number => {
  const [integerPart, decimalPart] = value.toString().split('.')

  return parseFloat(`${integerPart}.${decimalPart?.slice(0, decimals) || '0000'}`)
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error instances, wallet provider objects (plain { message, code } objects),
 * and falls back to String() for primitives.
 */
export function extractErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  if (typeof error === 'string') return error
  return fallback
}

/**
 * Map any thrown value to a safe, human-readable message fit for a toast/notification.
 *
 * User-facing copy must NEVER carry a raw viem / contract-revert / RPC string (design SOP
 * §10 + "human-readable errors, never raw"). This is the central humanization chokepoint:
 * known error shapes map to specific, reassuring copy; everything else falls back to a
 * generic safe message. The RAW error is intentionally dropped here — log it separately
 * (console + Datadog) at the call site so it still shows up in metrics.
 *
 * Ordering matters: a specific shape (an Aztec checkpoint revert, a user rejection) is
 * matched before the broad "contract reverted" / "viem" catch-all so the precise message wins.
 */
export function humanizeError(error: unknown): string {
  const raw = extractErrorMessage(error, '').toLowerCase()

  // Aztec rollup checkpoint briefly unavailable — a transient revert on reads
  // (e.g. Rollup__UnavailableTempCheckpointLog from getCheckpoint) while the network catches up.
  if (
    raw.includes('unavailabletempcheckpoint') ||
    raw.includes('getcheckpoint') ||
    (raw.includes('rollup__') && raw.includes('checkpoint'))
  ) {
    return 'The Aztec network is briefly catching up. Try again in a moment.'
  }

  // Node / RPC throttling or missing a method (free tiers answer 429, -32601, or a batch-size error
  // under load); the payload is JSON-RPC internals that mean nothing to a user.
  if (
    /\b429\b/.test(raw) ||
    raw.includes('rate limit') ||
    raw.includes('too many requests') ||
    raw.includes('-32601') ||
    raw.includes('method is not available') ||
    (raw.includes('is not available') && raw.includes('does not exist')) ||
    raw.includes('batch size') ||
    raw.includes('temporary internal error')
  ) {
    return 'The Aztec network is busy. Please try again in a moment.'
  }

  // Node / RPC unreachable or 5xx.
  if (
    raw.includes('failed to fetch') ||
    raw.includes('fetch failed') ||
    raw.includes('500 from server') ||
    raw.includes('network error') ||
    raw.includes('econnrefused') ||
    raw.includes('timeout') ||
    raw.includes('timed out') ||
    /aztec.*\.(zkv\.xyz|aztec-labs\.com)/i.test(raw)
  ) {
    return 'The Aztec network is temporarily unavailable. Please try again shortly.'
  }

  // User declined the request in their wallet.
  if (raw.includes('user rejected') || raw.includes('user denied') || raw.includes('rejected the request')) {
    return 'You declined the request in your wallet.'
  }

  // Wallet locked.
  if (raw.includes('locked')) {
    return 'Your wallet is locked. Please unlock it and try again.'
  }

  // Not enough funds / gas.
  if (raw.includes('insufficient funds') || raw.includes('insufficient balance')) {
    return 'Insufficient funds to complete this transaction.'
  }

  // Nonce / transaction ordering.
  if (raw.includes('nonce')) {
    return 'A transaction ordering issue occurred. Please refresh and try again.'
  }

  // Generic viem / contract revert.
  if (
    raw.includes('reverted') ||
    raw.includes('execution reverted') ||
    raw.includes('contract function') ||
    raw.includes('viem@')
  ) {
    return 'Something went wrong talking to the network. Please try again in a moment.'
  }

  return 'Something went wrong. Please try again in a moment.'
}

/**
 * Serialize Aztec NodeInfo to a plain JSON-serializable object for storage/export.
 * Converts address-like values (EthAddress, etc.) to string.
 */
export function serializeNodeInfo(
  nodeInfo:
    | {
        nodeVersion?: string
        l1ChainId?: number
        rollupVersion?: number
        enr?: string
        l1ContractAddresses?: Record<string, unknown>
        protocolContractAddresses?: Record<string, unknown>
      }
    | null
    | undefined,
): Record<string, unknown> | null {
  if (nodeInfo == null) return null
  const toPlain = (obj: unknown): unknown => {
    if (obj == null) return obj
    if (
      typeof obj === 'object' &&
      obj !== null &&
      'toString' in obj &&
      typeof (obj as { toString: () => string }).toString === 'function'
    ) {
      const s = (obj as { toString: () => string }).toString()
      if (s && s !== '[object Object]') return s
    }
    if (Array.isArray(obj)) return obj.map(toPlain)
    if (typeof obj === 'object' && obj !== null) {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toPlain(v)]))
    }
    return obj
  }
  return {
    nodeVersion: nodeInfo.nodeVersion,
    l1ChainId: nodeInfo.l1ChainId,
    rollupVersion: nodeInfo.rollupVersion,
    enr: nodeInfo.enr,
    l1ContractAddresses:
      nodeInfo.l1ContractAddresses != null
        ? (toPlain(nodeInfo.l1ContractAddresses) as Record<string, unknown>)
        : undefined,
    protocolContractAddresses:
      nodeInfo.protocolContractAddresses != null
        ? (toPlain(nodeInfo.protocolContractAddresses) as Record<string, unknown>)
        : undefined,
  } as Record<string, unknown>
}

/**
 * Export data as JSON file for backup
 */
export const exportToJsonFile = (data: any, filename: string) => {
  const jsonString = JSON.stringify(data, null, 2)
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Copy text to clipboard
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    // Fallback for older browsers
    try {
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.left = '-999999px'
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      const successful = document.execCommand('copy')
      document.body.removeChild(textArea)
      return successful
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
      return false
    }
  }
}

/**
 * Decrypt a field from an encrypted localStorage entry.
 * Shared by copyClaimSecret (L1→L2) and copyNonce (L2→L1).
 *
 * Looks up the entry via the SDK's storage helpers (getDepositById /
 * getWithdrawalById) rather than reading localStorage directly — matches the
 * canonical storage shape the SDK writes.
 */
export async function decryptStorageEntry(
  storageKey: string,
  entryId: string,
  fieldName: string,
  signMessage: (message: string, address: string) => Promise<string>,
): Promise<{ value: string; entry: any } | null> {
  verifyEncryptionDomain()

  const entry = storageKey.includes('deposits') ? getDepositById(entryId) : getWithdrawalById(entryId)
  if (!entry?.encryptedCiphertext) return null

  const signingMessage = createSigningMessage(entry.l1Address, entry.keyDerivationDomain)
  const signature = await signMessage(signingMessage, entry.l1Address)
  const keys = await deriveEncryptionKeyCandidates(
    entry.l1Address,
    signature,
    entry.keyDerivationDomain,
    entry.encryptedVersion,
  )
  const decrypted = JSON.parse(
    await decryptDataWithCandidates(entry.encryptedCiphertext, entry.encryptedIv, entry.encryptedTag, keys),
  )

  const value = decrypted[fieldName]
  if (!value) return null

  return { value, entry }
}

// ─── Descriptive recovery-backup filenames (#247) ────────────────────────────
//
// Old names were `shield-human-tech-<dir>-<id>-<epoch>.json`, only an id + epoch,
// so a folder of backups was indistinguishable. These helpers fold the amount,
// privacy mode, and a readable local timestamp into the name so a user can tell
// which transaction each file belongs to at a glance. Direction is fixed by the
// caller (claim = L1→L2, withdrawal = L2→L1), so it is passed in, not sniffed.
//
// Every token is best-effort: if a source field is genuinely missing it is
// dropped (never guessed) and the rest of the name still forms. Nothing here
// throws; a filename must always come back.

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Readable local timestamp `YYYY-MM-DD-HHmm` (not a raw epoch). */
function formatFilenameTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  )
}

/**
 * Human-readable "amount + symbol" token for the filename, using the same
 * amount/symbol/decimals convention ActivityCard reads off an operation:
 * prefer a pre-formatted display string, else format the raw bigint with the
 * L1 token decimals. Returns '' if no amount is available. Sanitized so a
 * fractional amount reads as `100_5USDC` (dot → underscore) with nothing else
 * that could muddle the name.
 */
function amountToken(op: any): string {
  let display: string | null = null
  try {
    const decimals = op?.tokenDecimalsL1 ?? op?.tokenDecimalsL2 ?? null
    if (op?.amountDisplayL1 != null) display = String(op.amountDisplayL1)
    else if (op?.amount != null) display = String(op.amount)
    else if (op?.amountDisplayL2 != null) display = String(op.amountDisplayL2)
    else if (op?.amountL1 != null && decimals != null) display = formatUnits(BigInt(op.amountL1), decimals)
    else if (op?.claimAmount != null && decimals != null) display = formatUnits(BigInt(op.claimAmount), decimals)
    else if (op?.amountL2 != null && decimals != null) display = formatUnits(BigInt(op.amountL2), decimals)
  } catch {
    display = null
  }
  if (display == null) return ''

  const amount = display.replace(/\./g, '_').replace(/[^0-9_]/g, '')
  if (!amount) return ''
  const symbol = (op?.tokenSymbol ?? op?.tokenSymbolL1 ?? op?.tokenSymbolL2 ?? '')
    .toString()
    .replace(/[^A-Za-z0-9]+/g, '')
  return `${amount}${symbol}`
}

/**
 * Build a filesystem-safe, human-readable recovery-backup filename, e.g.
 * `shield-L1-to-L2-100USDC-public-2026-07-22-1230-a1b2c3d4.json`.
 */
function buildRecoveryFilename(op: any, direction: 'L1-to-L2' | 'L2-to-L1'): string {
  const tokens: string[] = ['shield', direction]

  const amt = amountToken(op)
  if (amt) tokens.push(amt)

  // Only emit a mode token when the privacy flag is explicitly known.
  if (op?.isPrivacyModeEnabled === true) tokens.push('private')
  else if (op?.isPrivacyModeEnabled === false) tokens.push('public')

  // Per-op timestamp when valid, otherwise now.
  const created = op?.createdAt != null ? new Date(op.createdAt) : null
  const when = created != null && !Number.isNaN(created.getTime()) ? created : new Date()
  tokens.push(formatFilenameTimestamp(when))

  // Short id slice so two otherwise-identical txs never collide.
  const id = op?.id != null ? String(op.id).replace(/[^A-Za-z0-9]+/g, '') : ''
  if (id) tokens.push(id.slice(0, 8))

  return `${tokens.join('-')}.json`
}

/** Trigger a browser download of the L1→L2 claim recovery JSON. */
export const exportClaimData = (claimData: any) => {
  const payload = buildDepositExport(claimData)
  exportToJsonFile(payload, buildRecoveryFilename(claimData, 'L1-to-L2'))
}

/** Trigger a browser download of the L2→L1 withdrawal recovery JSON. */
export const exportWithdrawalData = (withdrawalData: any) => {
  const payload = buildWithdrawalExport(withdrawalData)
  exportToJsonFile(payload, buildRecoveryFilename(withdrawalData, 'L2-to-L1'))
}

// ─── Backup import (inverse of exportClaimData / exportWithdrawalData) ────────

export type BridgeDirectionTag = 'L1_TO_L2' | 'L2_TO_L1'

export interface ParsedBackupEntry {
  direction: BridgeDirectionTag
  /** Storage-shaped entry (canonical SDK deposit/withdrawal record). */
  entry: Record<string, any>
}

/** Thrown by parseBackup with a user-facing message when a file is malformed. */
export class BackupParseError extends Error {}

function coerceEntryFields(raw: Record<string, any>): Record<string, any> {
  // Normalize legacy ciphertext/iv/tag names to the encrypted* names the SDK
  // storage + decryptOperationPayload expect. Non-destructive: keep everything else.
  const entry: Record<string, any> = { ...raw }
  if (entry.encryptedCiphertext == null && raw.ciphertext != null) entry.encryptedCiphertext = raw.ciphertext
  if (entry.encryptedIv == null && raw.iv != null) entry.encryptedIv = raw.iv
  if (entry.encryptedTag == null && raw.tag != null) entry.encryptedTag = raw.tag
  return entry
}

function inferBackupDirection(entry: Record<string, any>): BridgeDirectionTag | null {
  if (entry.direction === 'L1_TO_L2' || entry.direction === 'L2_TO_L1') return entry.direction
  // L1→L2 deposits carry a claim secret hash / L1 inbox message hash.
  if (entry.claimSecretHash != null || entry.messageHash != null || entry.messageLeafIndex != null) return 'L1_TO_L2'
  // L2→L1 withdrawals carry L2 tx / outbox proof data.
  if (
    entry.l2TxHash != null ||
    entry.l2BlockNumber != null ||
    entry.l2ToL1MessageIndex != null ||
    entry.siblingPath != null ||
    entry.bridgeAddressL2 != null ||
    entry.l2BridgeAddress != null
  ) {
    return 'L2_TO_L1'
  }
  return null
}

function normalizeBackupItem(item: any): ParsedBackupEntry {
  if (item == null || typeof item !== 'object') {
    throw new BackupParseError('Backup file does not contain a valid recovery object.')
  }

  // Wrapped export shape: { type, timestamp, warning, data }. Otherwise treat the
  // object itself as a raw storage entry (legacy / hand-edited files).
  const isWrapped = item.data != null && typeof item.data === 'object' && ('type' in item || 'warning' in item)
  const source = isWrapped ? item.data : item

  const entry = coerceEntryFields(source)

  const hasEncryption =
    entry.encryptedCiphertext != null && entry.encryptedIv != null && entry.encryptedTag != null
  if (!hasEncryption) {
    throw new BackupParseError(
      'Backup is missing encrypted payload (encryptedCiphertext / encryptedIv / encryptedTag).',
    )
  }
  if (entry.keyDerivationDomain == null) {
    throw new BackupParseError('Backup is missing keyDerivationDomain; it cannot be decrypted.')
  }

  const direction =
    (item.type === 'L1_TO_L2' || item.type === 'L2_TO_L1' ? item.type : null) ?? inferBackupDirection(entry)
  if (!direction) {
    throw new BackupParseError('Could not determine bridge direction (L1→L2 vs L2→L1) from this backup.')
  }

  // Canonical storage key is `id`. Deposits carry it; withdrawal exports omit it,
  // so fall back to l2TxHash as a stable, dedupe-able identifier.
  const id = entry.id ?? entry.operationId ?? (direction === 'L2_TO_L1' ? entry.l2TxHash : null)
  if (id == null) {
    throw new BackupParseError('Backup has no operation id and no fallback identifier; cannot import.')
  }
  entry.id = String(id)

  return { direction, entry }
}

/**
 * Parse + validate an exported backup (single object or array of them) into
 * normalized, storage-shaped entries. Throws BackupParseError on malformed input.
 */
export function parseBackup(parsed: unknown): ParsedBackupEntry[] {
  const items = Array.isArray(parsed) ? parsed : [parsed]
  if (items.length === 0) throw new BackupParseError('Backup file is empty.')
  return items.map(normalizeBackupItem)
}

/**
 * Merge parsed backup entries into the SDK's localStorage (the same arrays
 * getDeposits / getWithdrawals read), deduping by operation id. Returns counts.
 */
export function importBackup(items: ParsedBackupEntry[]): { imported: number; skipped: number } {
  if (typeof window === 'undefined') return { imported: 0, skipped: 0 }

  const grouped = new Map<string, ParsedBackupEntry[]>()
  for (const it of items) {
    const key = it.direction === 'L1_TO_L2' ? STORAGE_KEYS.deposits : STORAGE_KEYS.withdrawals
    const bucket = grouped.get(key) ?? []
    bucket.push(it)
    grouped.set(key, bucket)
  }

  let imported = 0
  let skipped = 0

  for (const [key, bucket] of grouped) {
    let arr: any[]
    try {
      const rawStore = localStorage.getItem(key)
      arr = rawStore ? JSON.parse(rawStore) : []
      if (!Array.isArray(arr)) arr = []
    } catch {
      arr = []
    }

    const ids = new Set(arr.map((e) => String(e?.id ?? e?.operationId)))
    for (const { entry } of bucket) {
      const id = String(entry.id)
      if (ids.has(id)) {
        skipped++
        continue
      }
      arr.push(entry)
      ids.add(id)
      imported++
    }

    localStorage.setItem(key, JSON.stringify(arr))
  }

  return { imported, skipped }
}
