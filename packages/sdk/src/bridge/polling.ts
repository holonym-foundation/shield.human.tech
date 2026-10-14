/**
 * Polling utilities shared by L1→L2 and L2→L1 bridge modules.
 */

import { Fr } from '@aztec/aztec.js/fields'
import { wait } from './utils'

/**
 * Poll until the L1→L2 message is consumable on L2.
 *
 * Readiness is a membership witness for the message at the 'latest' block: the node
 * returns one only once the sequencer has included the message in the L1→L2 tree, which
 * is when a claim can actually consume it. A bare checkpoint lookup returns a value as
 * soon as the archiver indexes the message from L1, which is earlier; consuming at that
 * point reverts the claim's public phase with an empty "Assertion failed:". This single
 * poll therefore covers the whole wait — no separate block-count heuristic is needed.
 *
 * The witness call is used instead of aztec.js's isL1ToL2MessageReady because the latter
 * needs aztec_getL1ToL2MessageCheckpoint, which dRPC does not serve (-32601), so every
 * poll threw. Node errors are reported through `lastError` instead of being dropped.
 */
export async function pollL1ToL2MessageSync(
  aztecNode: any,
  messageHash: string,
  options?: {
    pollIntervalMs?: number
    maxWaitMs?: number
    onPoll?: (elapsedSec: number, pollCount: number) => void
  },
): Promise<{ synced: boolean; elapsedMinutes: number; lastError?: string }> {
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000
  const maxWaitMs = options?.maxWaitMs ?? 40 * 60 * 1000
  const messageHashFr = Fr.fromString(messageHash)
  const startWait = Date.now()
  let pollCount = 0
  let lastError: string | undefined

  while (Date.now() - startWait < maxWaitMs) {
    pollCount++
    const elapsedSec = Math.round((Date.now() - startWait) / 1000)
    try {
      const witness = await aztecNode.getL1ToL2MessageMembershipWitness('latest', messageHashFr)
      if (witness !== undefined) {
        return {
          synced: true,
          elapsedMinutes: (Date.now() - startWait) / 60_000,
        }
      }
      lastError = undefined
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message !== lastError) {
        console.warn('[SDK] L1→L2 message readiness check failed, retrying:', message)
      }
      lastError = message
    }
    options?.onPoll?.(elapsedSec, pollCount)
    await wait(pollIntervalMs)
  }

  return {
    synced: false,
    elapsedMinutes: (Date.now() - startWait) / 60_000,
    lastError,
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

