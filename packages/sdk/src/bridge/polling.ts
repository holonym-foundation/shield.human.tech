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
  const pollIntervalMs = options?.pollIntervalMs ?? 30_000
  const maxWaitMs = options?.maxWaitMs ?? 40 * 60 * 1000
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
    if (!blockProven) {
      // Polling worked but the block never proved within maxWaitMs.
      // Sending an L1 withdraw now would burn gas on a guaranteed revert —
      // hard-fail so the caller bails and can resume later when proven.
      throw new Error(
        'Block not yet proven after max wait. The L1 withdraw would revert. Please resume later when the block is proven.',
      )
    }
  } catch (err) {
    // Rethrow our own "not proven" timeout — only swallow transient node errors.
    if (err instanceof Error && err.message.startsWith('Block not yet proven')) {
      throw err
    }
    usedPoll = false
  }

  if (!blockProven && !usedPoll) {
    // Fixed fallback wait when polling failed due to a transient node error.
    onFallback?.(fixedFallbackMs)
    await wait(fixedFallbackMs)
  }

  return { proven: blockProven, usedPoll }
}

/**
 * Wait for the L2 sequencer to include the L1→L2 message in the state tree.
 *
 * The archiver checkpoint appears quickly, but the message is only consumable
 * after the sequencer includes it in an L2 block — which can take up to one
 * epoch (~19 min on testnet: 32 slots × 36s).
 *
 * Strategy: wait for at least `minBlocks` new L2 blocks AND at least `minWaitMs`
 * elapsed time, whichever is longer. This ensures the sequencer has processed
 * the L1 state containing the message before we attempt to claim.
 *
 * @param sinceBlock - L2 block number when the checkpoint was first observed.
 *   If omitted, queries the current block and waits for it to advance.
 */
export async function waitForNextL2Block(
  aztecNode: any,
  options?: {
    sinceBlock?: number
    pollIntervalMs?: number
    maxWaitMs?: number
    minWaitMs?: number
    minBlocks?: number
    onPoll?: (elapsedSec: number, currentBlock: number, targetBlock: number) => void
  },
): Promise<number> {
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000
  const maxWaitMs = options?.maxWaitMs ?? 25 * 60 * 1000
  const minWaitMs = options?.minWaitMs ?? 2 * 60 * 1000
  const minBlocks = options?.minBlocks ?? 2
  const startTime = Date.now()

  const sinceBlock =
    options?.sinceBlock ?? (await aztecNode.getBlockNumber())
  const targetBlock = sinceBlock + minBlocks

  while (Date.now() - startTime < maxWaitMs) {
    const elapsedMs = Date.now() - startTime
    const elapsedSec = Math.round(elapsedMs / 1000)
    try {
      const currentBlock = await aztecNode.getBlockNumber()
      options?.onPoll?.(elapsedSec, currentBlock, targetBlock)
      const blocksReady = currentBlock >= targetBlock
      const minTimeReady = elapsedMs >= minWaitMs
      if (blocksReady && minTimeReady) {
        return currentBlock
      }
    } catch {
      // transient — retry
    }
    await wait(pollIntervalMs)
  }

  // Timed out — return current block so the caller can proceed to retry-based claiming.
  return await aztecNode.getBlockNumber().catch(() => sinceBlock)
}
