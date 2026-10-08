import type { AztecNode } from '@aztec-labs/aztec.js/node'
/**
 * Polling utilities shared by L1→L2 and L2→L1 bridge modules.
 */

import { Fr } from '@aztec-labs/aztec.js/fields'
import { isL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging'
import { wait } from './utils'

/**
 * Poll until the L1→L2 message is consumable on L2.
 *
 * Uses isL1ToL2MessageReady, which returns true only once the 'latest' chain tip
 * has advanced to the message's checkpoint — i.e. the sequencer has included the
 * message and a claim can actually consume it. A bare getL1ToL2MessageCheckpoint
 * lookup returns a value as soon as the archiver indexes the message from L1
 * (message "seen"), which is earlier; consuming at that point reverts the claim's
 * public phase with an empty "Assertion failed:". This single poll therefore
 * covers the whole wait — no separate block-count heuristic is needed afterward.
 */
export async function pollL1ToL2MessageSync(
  aztecNode: AztecNode,
  messageHash: string,
  options?: {
    pollIntervalMs?: number
    maxWaitMs?: number
    onPoll?: (elapsedSec: number, pollCount: number) => void
  },
): Promise<{ synced: boolean; elapsedMinutes: number }> {
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000
  const maxWaitMs = options?.maxWaitMs ?? 40 * 60 * 1000
  const messageHashFr = Fr.fromString(messageHash)
  const startWait = Date.now()
  let pollCount = 0

  while (Date.now() - startWait < maxWaitMs) {
    pollCount++
    const elapsedSec = Math.round((Date.now() - startWait) / 1000)
    try {
      if (await isL1ToL2MessageReady(aztecNode, messageHashFr, 'latest')) {
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
 * Poll until our L2 block is proven.
 *
 * Uses node.getBlockNumber('proven'), which returns the proven L2 block number
 * directly. Do NOT use node.getProvenBlockNumber() (not a method on the v5 client)
 * or the L1 Rollup's getProvenCheckpointNumber() (a checkpoint counter that resets
 * on redeployment — a different scale from the L2 block number).
 *
 * Falls back to a fixed wait if the node call fails.
 */
export async function waitForBlockProven(params: {
  aztecNode: AztecNode
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
    maxWaitMs = 90 * 60 * 1000,
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
      const provenBlock = await aztecNode.getBlockNumber('proven')
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

