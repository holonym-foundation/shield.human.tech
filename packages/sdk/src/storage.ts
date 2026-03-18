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

/** Get a single deposit by operationId. */
export function getDepositById(operationId: number): any | undefined {
  return getArray(DEPOSITS_KEY).find((d: any) => d.id === operationId)
}

/** Get a single withdrawal by operationId. */
export function getWithdrawalById(operationId: number): any | undefined {
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
  operationId: number
  data: Record<string, unknown>
  label: string
  timestamp: number
}

/** Queue a PATCH that failed all retry attempts for later retry. */
export function pushFailedPatch(patch: FailedPatch): void {
  pushItem(FAILED_PATCHES_KEY, patch as unknown as Record<string, unknown>)
}

/** Get all queued failed PATCHes. */
export function getFailedPatches(): FailedPatch[] {
  return getArray(FAILED_PATCHES_KEY) as FailedPatch[]
}

/** Remove a failed PATCH after successful retry (by operationId + label). */
export function removeFailedPatch(operationId: number, label: string): void {
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
