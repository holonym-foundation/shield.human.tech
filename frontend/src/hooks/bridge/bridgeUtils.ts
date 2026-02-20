/**
 * Shared bridge utilities used by L1->L2 and L2->L1 hooks.
 *
 * - Single publicClient (replaces 4 duplicate declarations)
 * - PATCH with retry (replaces inline retry loops)
 * - Fire-and-forget PATCH (replaces .catch(() => {}) patterns)
 * - localStorage helpers (replaces inline read-modify-write blocks)
 */

import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import { api } from '@/lib/api'
import { wait } from '@/utils'

// ─── Shared Log Context ─────────────────────────────────────────────

/** Common wallet metadata passed to step functions that emit logInfo/logError. */
export interface BridgeLogContext {
  walletType: string
  loginMethod: string | null
  walletProvider: string | null
  address: string
  chainId: number | null
  aztecLoginMethod: string | null
  aztecAddress: string
}

// ─── localStorage Keys ──────────────────────────────────────────────

/** localStorage key for L1→L2 deposit operations. */
export const LS_KEY_BRIDGE_DEPOSITS = 'bridge:deposits:l1ToL2'

/** localStorage key for L2→L1 withdrawal operations. */
export const LS_KEY_BRIDGE_WITHDRAWALS = 'bridge:withdrawals:l2ToL1'

const L1_RPC_URL = process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL

/** Shared L1 public client for transaction polling and contract reads. */
export const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(L1_RPC_URL),
})

/**
 * PATCH a backend operation with retry logic.
 * Replaces the "3 retries with 2s delay" pattern used throughout the bridge hooks.
 *
 * @returns true if succeeded, false if all retries failed
 */
export async function patchOperationWithRetry(
  operationId: string,
  data: Record<string, unknown>,
  options?: { maxAttempts?: number; retryDelayMs?: number; label?: string }
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? 3
  const retryDelayMs = options?.retryDelayMs ?? 2000
  const label = options?.label ?? 'PATCH'

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await api.patch(`/api/bridge/operations/${operationId}`, data)
      return true
    } catch (err) {
      console.warn(
        `[Bridge] ${label} attempt ${attempt + 1}/${maxAttempts} failed:`,
        err,
      )
      if (attempt < maxAttempts - 1) await wait(retryDelayMs)
    }
  }
  return false
}

/**
 * Fire-and-forget PATCH (non-critical step updates like currentStep).
 * Logs failures so they are visible in browser console for debugging.
 */
export function patchOperationAsync(
  operationId: string | undefined,
  data: Record<string, unknown>,
): void {
  if (!operationId) return
  api.patch(`/api/bridge/operations/${operationId}`, data).catch((err) => {
    console.error(
      `[Bridge] patchOperationAsync failed for ${operationId}:`,
      Object.keys(data).join(', '),
      err,
    )
  })
}

/**
 * Update an item in a localStorage JSON array by predicate.
 *
 * @param storageKey - localStorage key (e.g. LS_KEY_BRIDGE_DEPOSITS, LS_KEY_BRIDGE_WITHDRAWALS)
 * @param predicate  - function to find the item to update
 * @param updater    - function to produce the updated item
 */
export function updateLocalStorageItem(
  storageKey: string,
  predicate: (item: any) => boolean,
  updater: (item: any) => any,
): void {
  try {
    const existing = localStorage.getItem(storageKey)
    const items = existing ? JSON.parse(existing) : []
    const idx = items.findIndex(predicate)
    if (idx !== -1) {
      items[idx] = updater(items[idx])
      localStorage.setItem(storageKey, JSON.stringify(items))
    }
  } catch {
    // localStorage not critical
  }
}

/**
 * Push an item to a localStorage JSON array.
 */
export function pushToLocalStorageArray(
  storageKey: string,
  item: any,
): void {
  try {
    const existing = localStorage.getItem(storageKey)
    const items = existing ? JSON.parse(existing) : []
    items.push(item)
    localStorage.setItem(storageKey, JSON.stringify(items))
  } catch {
    // localStorage not critical
  }
}
