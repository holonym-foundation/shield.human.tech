/**
 * Polling utilities shared by L1→L2 and L2→L1 bridge modules.
 */

import { Fr } from '@aztec/aztec.js/fields'
import { wait } from './utils'

/**
 * Poll aztecNode.getL1ToL2MessageCheckpoint() until the message is synced on L2.
 *
 * Uses the 4.2 API (getL1ToL2MessageCheckpoint) instead of the deprecated
 * getL1ToL2MessageBlock.
 *
 * Does NOT include the final buffer wait — the caller should add
 * that if needed (so the caller can update progress between poll and wait).
 */
export async function pollL1ToL2MessageSync(
  aztecNode: any,
  messageHash: string,
  options?: {
    pollIntervalMs?: number
    maxWaitMs?: number
    onPoll?: (elapsedSec: number, pollCount: number) => void
  },
): Promise<{ synced: boolean; elapsedMinutes: number }> {
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000
  const maxWaitMs = options?.maxWaitMs ?? 25 * 60 * 1000
  const messageHashFr = Fr.fromString(messageHash)
  const startWait = Date.now()
  let pollCount = 0

  while (Date.now() - startWait < maxWaitMs) {
    pollCount++
    const elapsedSec = Math.round((Date.now() - startWait) / 1000)
    try {
      const messageCheckpoint =
        await aztecNode.getL1ToL2MessageCheckpoint(messageHashFr)
      if (messageCheckpoint !== undefined) {
        return {
          synced: true,
          elapsedMinutes: (Date.now() - startWait) / 60_000,
        }
      }
    } catch {
      // retry
    }
    options?.onPoll?.(elapsedSec, pollCount)
    await wait(pollIntervalMs)
  }

  return {
    synced: false,
    elapsedMinutes: (Date.now() - startWait) / 60_000,
  }
}

/**
 * Poll aztecNode.getProvenBlockNumber() until our L2 block is proven.
 *
 * NOTE: Do NOT use the L1 Rollup contract's getProvenCheckpointNumber() here.
 * That function returns a checkpoint counter — a sequential index that resets
 * to 0 on each rollup redeployment — which is a different scale from the L2
 * block number. aztecNode.getProvenBlockNumber() returns the proven L2 block
 * number directly and is the correct thing to compare against blockNumberForProof.
 *
 * Falls back to a fixed wait if the node call fails.
 */
export async function waitForBlockProven(params: {
  aztecNode: any
  blockNumberForProof: number
  pollIntervalMs?: number
  maxWaitMs?: number
  fixedFallbackMs?: number
  onPoll?: (provenBlock: number, neededBlock: number, elapsedMs: number) => void
  onFallback?: (fixedWaitMs: number) => void
}): Promise<{ proven: boolean; usedPoll: boolean }> {
  const {
    aztecNode,
    blockNumberForProof,
    pollIntervalMs = 120_000,
    maxWaitMs = 50 * 60 * 1000,
    fixedFallbackMs = 40 * 60 * 1000,
    onPoll,
    onFallback,
  } = params

  let blockProven = false
  let usedPoll = false

  try {
    usedPoll = true
    const startWait = Date.now()
    while (Date.now() - startWait < maxWaitMs) {
      const provenBlock = await aztecNode.getProvenBlockNumber()
      if (provenBlock >= blockNumberForProof) {
        blockProven = true
        break
      }
      onPoll?.(provenBlock, blockNumberForProof, Date.now() - startWait)
      await wait(pollIntervalMs)
    }
  } catch {
    usedPoll = false
  }

  if (!blockProven && !usedPoll) {
    // Fixed fallback wait when polling failed.
    onFallback?.(fixedFallbackMs)
    await wait(fixedFallbackMs)
  }

  return { proven: blockProven, usedPoll }
}
