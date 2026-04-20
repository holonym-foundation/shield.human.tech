/**
 * Built-in localStorage backup for bridge operations.
 *
 * The SDK automatically persists encrypted secrets and operation state
 * to localStorage so that operations can be recovered after page reloads,
 * network drops, or other interruptions.
 *
 * Keys match the frontend's localStorage keys so recovery UI and SDK
 * can see each other's entries.
 */

// Keys aligned with frontend (bridgeUtils.ts: LS_KEY_BRIDGE_DEPOSITS / LS_KEY_BRIDGE_WITHDRAWALS)
const DEPOSITS_KEY = 'bridge:deposits:l1ToL2'
const WITHDRAWALS_KEY = 'bridge:withdrawals:l2ToL1'

function isLocalStorageAvailable(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

function getArray(key: string): any[] {
  if (!isLocalStorageAvailable()) return []
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : []
  } catch (err) {
    console.error(
      '[Bridge SDK] localStorage parse failed for key', key,
      '— returning empty array. Recovery data may have been corrupted.',
      err,
    )
    return []
  }
}

function setArray(key: string, arr: any[]): void {
  if (!isLocalStorageAvailable()) return
  try {
    localStorage.setItem(key, JSON.stringify(arr))
  } catch (err) {
    // Storage full or unavailable — server backup exists, but warn loudly
    console.error(
      '[Bridge SDK] localStorage write failed for key', key,
      '— data NOT persisted locally. Server backup is the only recovery path.',
      err,
    )
  }
}

function pushItem(key: string, item: Record<string, unknown>): void {
  const arr = getArray(key)
  arr.push(item)
  setArray(key, arr)
}

function updateItem(
  key: string,
  predicate: (item: any) => boolean,
  updater: (item: any) => any,
  fallbackEntry?: Record<string, unknown>,
): void {
  const arr = getArray(key)
  const idx = arr.findIndex(predicate)
  if (idx === -1) {
    // Entry was lost (e.g., localStorage cleared between steps).
    // Create a fallback entry if provided so local recovery is still possible.
    if (fallbackEntry) {
      arr.push(fallbackEntry)
      setArray(key, arr)
      console.warn('[Bridge SDK] localStorage entry not found — created fallback entry for recovery.')
    }
    return
  }
  arr[idx] = updater(arr[idx])
  setArray(key, arr)
}

// ─── Public API ─────────────────────────────────────────────────────

/** Push a new deposit backup entry. */
export function pushDeposit(data: Record<string, unknown>): void {
  pushItem(DEPOSITS_KEY, data)
}

/** Update an existing deposit entry by predicate. Creates fallback if entry missing. */
export function updateDeposit(
  predicate: (item: any) => boolean,
  updater: (item: any) => any,
  fallbackEntry?: Record<string, unknown>,
): void {
  updateItem(DEPOSITS_KEY, predicate, updater, fallbackEntry)
}

/** Push a new withdrawal backup entry. */
export function pushWithdrawal(data: Record<string, unknown>): void {
  pushItem(WITHDRAWALS_KEY, data)
}

/** Update an existing withdrawal entry by predicate. Creates fallback if entry missing. */
export function updateWithdrawal(
  predicate: (item: any) => boolean,
  updater: (item: any) => any,
  fallbackEntry?: Record<string, unknown>,
): void {
  updateItem(WITHDRAWALS_KEY, predicate, updater, fallbackEntry)
}

/** Get all deposit entries (for recovery UI). */
export function getDeposits(): any[] {
  return getArray(DEPOSITS_KEY)
}

/** Get all withdrawal entries (for recovery UI). */
export function getWithdrawals(): any[] {
  return getArray(WITHDRAWALS_KEY)
}

/** Get a single deposit by operationId. Accepts string or number (cuid IDs). */
export function getDepositById(operationId: string | number): any | undefined {
  return getArray(DEPOSITS_KEY).find((d: any) => d.id === operationId)
}

/** Get a single withdrawal by operationId. Accepts string or number (cuid IDs). */
export function getWithdrawalById(operationId: string | number): any | undefined {
  return getArray(WITHDRAWALS_KEY).find((w: any) => w.id === operationId)
}

/** Get all pending (incomplete) deposits. Includes 'failed' ops that have an l1TxHash (funds may be locked). */
export function getPendingDeposits(): any[] {
  return getArray(DEPOSITS_KEY).filter((d: any) => {
    if (d.status === 'completed') return false
    if (d.status === 'failed' && !d.l1TxHash) return false
    return true
  })
}

/** Get all pending (incomplete) withdrawals. Includes 'failed' ops that have an l2TxHash (funds may be burned). */
export function getPendingWithdrawals(): any[] {
  return getArray(WITHDRAWALS_KEY).filter((w: any) => {
    if (w.status === 'completed') return false
    if (w.status === 'failed' && !w.l2TxHash) return false
    return true
  })
}

// ─── Failed PATCH Queue ─────────────────────────────────────────────
// When patchOperationWithRetry exhausts all attempts, the failed PATCH
// data is stored here so the next resume or SDK init can retry it.

const FAILED_PATCHES_KEY = 'bridge:failedPatches'

export interface FailedPatch {
  operationId: number | string
  data: Record<string, unknown>
  label: string
  timestamp: number
}

// Prevent unbounded queue growth: entries older than this are dropped, and
// the queue never holds more than MAX_FAILED_PATCHES items (oldest evicted).
// A user bridging repeatedly through a flaky network could otherwise amass
// thousands of stale entries that slow every retry pass.
const FAILED_PATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MAX_FAILED_PATCHES = 100

/** Queue a PATCH that failed all retry attempts for later retry. */
export function pushFailedPatch(patch: FailedPatch): void {
  if (!isLocalStorageAvailable()) return
  try {
    const arr = getArray(FAILED_PATCHES_KEY) as FailedPatch[]
    const cutoff = Date.now() - FAILED_PATCH_TTL_MS
    // Drop TTL-expired entries. An entry with no timestamp (legacy) gets the
    // benefit of the doubt and stays — `timestamp ?? Date.now()`.
    const fresh = arr.filter((p) => (p.timestamp ?? Date.now()) > cutoff)
    fresh.push(patch)
    // If we're over the cap, evict oldest to make room.
    if (fresh.length > MAX_FAILED_PATCHES) {
      const dropped = fresh.length - MAX_FAILED_PATCHES
      fresh.splice(0, dropped)
      console.warn(
        `[Bridge SDK] Failed-PATCH queue reached ${MAX_FAILED_PATCHES} items — dropped ${dropped} oldest entries. ` +
        'This usually indicates prolonged backend unavailability.',
      )
    }
    setArray(FAILED_PATCHES_KEY, fresh as unknown as Record<string, unknown>[])
  } catch (err) {
    console.error('[Bridge SDK] pushFailedPatch failed:', err)
  }
}

/** Get all queued failed PATCHes. */
export function getFailedPatches(): FailedPatch[] {
  return getArray(FAILED_PATCHES_KEY) as FailedPatch[]
}

/** Remove a failed PATCH after successful retry (by operationId + label). */
export function removeFailedPatch(operationId: number | string, label: string): void {
  if (!isLocalStorageAvailable()) return
  try {
    const arr = getArray(FAILED_PATCHES_KEY)
    const filtered = arr.filter(
      (p: any) => !(p.operationId === operationId && p.label === label),
    )
    setArray(FAILED_PATCHES_KEY, filtered)
  } catch {
    // Non-critical
  }
}

/** Clear all failed PATCHes (e.g. after successful bulk retry). */
export function clearFailedPatches(): void {
  if (!isLocalStorageAvailable()) return
  try {
    localStorage.removeItem(FAILED_PATCHES_KEY)
  } catch {
    // Non-critical
  }
}

/** Storage keys (exported for consumers that need to read directly). */
export const STORAGE_KEYS = {
  deposits: DEPOSITS_KEY,
  withdrawals: WITHDRAWALS_KEY,
  failedPatches: FAILED_PATCHES_KEY,
} as const

// ─── Export Builders ────────────────────────────────────────────────
//
// Pure helpers that build the JSON payload for a user-downloadable recovery
// file. The consumer handles the actual download (Blob + click) — these just
// shape the data. Keeping this in the SDK means every field needed for
// manual recovery lives next to the canonical type definitions.

/**
 * Build the L1→L2 deposit recovery export payload.
 * Includes only fields needed to recover the operation off-line.
 */
export function buildDepositExport(deposit: any): {
  type: 'L1_TO_L2'
  timestamp: string
  warning: string
  data: Record<string, unknown>
} {
  return {
    type: 'L1_TO_L2',
    timestamp: new Date().toISOString(),
    warning:
      '⚠️ CRITICAL: Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
    data: {
      id: deposit.id,
      claimSecretHash: deposit.claimSecretHash,
      encryptedCiphertext: deposit.encryptedCiphertext,
      encryptedIv: deposit.encryptedIv,
      encryptedTag: deposit.encryptedTag,
      keyDerivationDomain: deposit.keyDerivationDomain,
      messageHash: deposit.messageHash,
      messageLeafIndex: deposit.messageLeafIndex,
      claimAmount: deposit.claimAmount,
      l1Address: deposit.l1Address,
      l2Address: deposit.l2Address,
      l1TxHash: deposit.l1TxHash,
      l1TxUrl: deposit.l1TxUrl,
      l1BlockNumberBeforeTx: deposit.l1BlockNumberBeforeTx,
      nodeInfo: deposit.nodeInfo ?? undefined,
      isPrivacyModeEnabled: deposit.isPrivacyModeEnabled,
      status: deposit.status,
      portalAddressL1: deposit.portalAddressL1 ?? undefined,
      bridgeAddressL2: deposit.bridgeAddressL2 ?? undefined,
      tokenAddressL1: deposit.tokenAddressL1 ?? undefined,
      tokenAddressL2: deposit.tokenAddressL2 ?? undefined,
      fuelMessageHash: deposit.fuelMessageHash ?? undefined,
      fuelMessageLeafIndex: deposit.fuelMessageLeafIndex ?? undefined,
      fuelAmount: deposit.fuelAmount ?? undefined,
    },
  }
}

/**
 * Build the L2→L1 withdrawal recovery export payload.
 * Handles legacy storage shapes (l2ToL1MessageIndex vs leafIndex, l2BlockNumber
 * vs l2TxReceipt.blockNumber) so older entries still export cleanly.
 */
export function buildWithdrawalExport(withdrawal: any): {
  type: 'L2_TO_L1'
  timestamp: string
  warning: string
  data: Record<string, unknown>
} {
  return {
    type: 'L2_TO_L1',
    timestamp: new Date().toISOString(),
    warning:
      '⚠️ CRITICAL: Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
    data: {
      encryptedCiphertext: withdrawal.encryptedCiphertext,
      encryptedIv: withdrawal.encryptedIv,
      encryptedTag: withdrawal.encryptedTag,
      keyDerivationDomain: withdrawal.keyDerivationDomain,
      l2TxHash: withdrawal.l2TxHash,
      l2BlockNumber: withdrawal.l2BlockNumber ?? withdrawal.l2TxReceipt?.blockNumber,
      l2BlockNumberBeforeTx: withdrawal.l2BlockNumberBeforeTx ?? undefined,
      nodeInfo: withdrawal.nodeInfo ?? undefined,
      l2ToL1MessageIndex: withdrawal.l2ToL1MessageIndex ?? withdrawal.leafIndex,
      siblingPath: withdrawal.siblingPath,
      amount: withdrawal.amount,
      l1Address: withdrawal.l1Address,
      l2Address: withdrawal.l2Address,
      bridgeAddressL2: withdrawal.bridgeAddressL2 ?? withdrawal.l2BridgeAddress,
      recipientL1Address: withdrawal.recipientL1Address ?? withdrawal.l1Address,
      status: withdrawal.status,
      portalAddressL1: withdrawal.portalAddressL1 ?? undefined,
      rollupVersion: withdrawal.rollupVersion ?? undefined,
      chainIdL1: withdrawal.chainIdL1 ?? undefined,
      l1RollupAddress: withdrawal.l1RollupAddress ?? undefined,
    },
  }
}
