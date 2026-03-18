/**
 * Bridge operations CRUD module.
 *
 * Handles creating, reading, and updating bridge operations via the backend API.
 * Includes retry logic for critical PATCH operations (fund-safety).
 */

import type { BridgeApiClient } from './api'
import type { BridgeOperation } from './types'
import {
  pushFailedPatch,
  getFailedPatches,
  removeFailedPatch,
  clearFailedPatches,
} from './storage'

/**
 * Create a new bridge operation on the backend.
 */
export async function createOperation(
  apiClient: BridgeApiClient,
  data: Record<string, unknown>,
): Promise<{ operationId: number }> {
  const res = await apiClient.post<{ operationId: number }>(
    '/api/bridge/operations',
    data,
  )
  if (!res.operationId) {
    throw new Error('Server did not return operationId. Operation not created.')
  }
  return res
}

/**
 * Get all bridge operations for the authenticated user.
 */
export async function getOperations(
  apiClient: BridgeApiClient,
): Promise<BridgeOperation[]> {
  const res = await apiClient.get<{ operations: BridgeOperation[] }>(
    '/api/bridge/operations',
  )
  return res.operations ?? []
}

/**
 * Get a single bridge operation by ID.
 */
export async function getOperation(
  apiClient: BridgeApiClient,
  operationId: number,
): Promise<BridgeOperation> {
  return apiClient.get<BridgeOperation>(
    `/api/bridge/operations/${operationId}`,
  )
}

/**
 * PATCH a bridge operation with retry logic (3 attempts, 2s delay).
 *
 * Used for fund-critical updates (l1TxHash, messageHash, l2BlockNumber, etc.)
 * where failure to persist means potential recovery issues.
 *
 * If all retries fail, the PATCH is queued in localStorage for later retry.
 *
 * @returns true if succeeded, false if all retries failed (queued for retry)
 */
export async function patchOperationWithRetry(
  apiClient: BridgeApiClient,
  operationId: number,
  data: Record<string, unknown>,
  options?: { maxAttempts?: number; retryDelayMs?: number; label?: string },
): Promise<boolean> {
  const maxAttempts = options?.maxAttempts ?? 3
  const retryDelayMs = options?.retryDelayMs ?? 2000
  const label = options?.label ?? 'PATCH'

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await apiClient.patch(`/api/bridge/operations/${operationId}`, data)
      return true
    } catch (err) {
      console.warn(
        `[Bridge SDK] ${label} attempt ${attempt + 1}/${maxAttempts} failed:`,
        err,
      )
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, retryDelayMs))
      }
    }
  }

  // All retries exhausted — queue for later retry
  console.error(
    `[Bridge SDK] ${label} FAILED after ${maxAttempts} attempts for operation ${operationId}. Queuing for retry.`,
  )
  pushFailedPatch({
    operationId,
    data,
    label,
    timestamp: Date.now(),
  })

  return false
}

/**
 * Retry all queued failed PATCHes.
 *
 * Call this on SDK init, before resume, or periodically. Returns the number
 * of successfully retried PATCHes.
 */
export async function retryFailedPatches(
  apiClient: BridgeApiClient,
): Promise<{ succeeded: number; failed: number; total: number }> {
  const pending = getFailedPatches()
  if (pending.length === 0) return { succeeded: 0, failed: 0, total: 0 }

  console.log(`[Bridge SDK] Retrying ${pending.length} queued PATCH(es)...`)

  let succeeded = 0
  let failed = 0

  for (const patch of pending) {
    try {
      await apiClient.patch(
        `/api/bridge/operations/${patch.operationId}`,
        patch.data,
      )
      removeFailedPatch(patch.operationId, patch.label)
      succeeded++
      console.log(
        `[Bridge SDK] Retry succeeded: ${patch.label} for ${patch.operationId}`,
      )
    } catch (err) {
      failed++
      console.warn(
        `[Bridge SDK] Retry still failing: ${patch.label} for ${patch.operationId}:`,
        err,
      )
    }
  }

  // If all succeeded, clean up the key entirely
  if (failed === 0) {
    clearFailedPatches()
  }

  return { succeeded, failed, total: pending.length }
}

/**
 * Fire-and-forget PATCH for non-critical updates (e.g. currentStep).
 * Logs failures but never throws.
 */
export function patchOperationAsync(
  apiClient: BridgeApiClient,
  operationId: number | undefined,
  data: Record<string, unknown>,
): void {
  if (!operationId) return
  apiClient
    .patch(`/api/bridge/operations/${operationId}`, data)
    .catch((err) => {
      console.error(
        `[Bridge SDK] patchOperationAsync failed for ${operationId}:`,
        Object.keys(data).join(', '),
        err,
      )
    })
}
