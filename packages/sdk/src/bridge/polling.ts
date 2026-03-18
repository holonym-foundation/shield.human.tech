/**
 * Polling utilities shared by L1→L2 and L2→L1 bridge modules.
 */

import { Fr } from '@aztec/aztec.js/fields'
import { RollupAbi } from '@aztec/l1-artifacts'
import { wait } from './utils'

/**
 * Poll aztecNode.getL1ToL2MessageBlock() until the message is synced on L2.
 *
 * Does NOT include the final buffer wait — the caller should add
 * that if needed (so the caller can update progress between poll and wait).
 */
export async function pollL1ToL2MessageSync(
  aztecNode: any,
  messageHash: string,
  options?: { pollIntervalMs?: number; maxWaitMs?: number },
): Promise<{ synced: boolean; elapsedMinutes: number }> {
  const pollIntervalMs = options?.pollIntervalMs ?? 30_000
  const maxWaitMs = options?.maxWaitMs ?? 40 * 60 * 1000
  const messageHashFr = Fr.fromString(messageHash)
  const startWait = Date.now()

  while (Date.now() - startWait < maxWaitMs) {
    try {
      const messageBlock =
        await aztecNode.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        return {
          synced: true,
          elapsedMinutes: (Date.now() - startWait) / 60_000,
        }
      }
    } catch {
      // retry
    }
    await wait(pollIntervalMs)
  }

  return {
    synced: false,
    elapsedMinutes: (Date.now() - startWait) / 60_000,
  }
}

/**
 * Poll L1 Rollup.getProvenCheckpointNumber() until our L2 block is proven.
 * Falls back to a fixed wait if rollupAddress is unavailable or polling fails.
 */
export async function waitForBlockProven(params: {
  publicClient: any
  blockNumberForProof: number
  rollupAddress: string | null | undefined
  pollIntervalMs?: number
  maxWaitMs?: number
  fixedFallbackMs?: number
  onPoll?: (provenBlock: number, neededBlock: number, elapsedMs: number) => void
  onFallback?: (fixedWaitMs: number) => void
}): Promise<{ proven: boolean; usedPoll: boolean }> {
  const {
    publicClient,
    blockNumberForProof,
    rollupAddress,
    pollIntervalMs = 120_000,
    maxWaitMs = 50 * 60 * 1000,
    fixedFallbackMs = 40 * 60 * 1000,
    onPoll,
    onFallback,
  } = params

  let blockProven = false
  let usedPoll = false

  if (rollupAddress) {
    try {
      usedPoll = true
      const startWait = Date.now()
      while (Date.now() - startWait < maxWaitMs) {
        const proven = await publicClient.readContract({
          address: rollupAddress as `0x${string}`,
          abi: RollupAbi,
          functionName: 'getProvenCheckpointNumber',
        })
        const provenBlock =
          typeof proven === 'bigint' ? Number(proven) : (proven as number)
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
  }

  if (!blockProven && !usedPoll) {
    // Fixed fallback wait when polling failed or rollupAddress unavailable.
    onFallback?.(fixedFallbackMs)
    await wait(fixedFallbackMs)
  }

  return { proven: blockProven, usedPoll }
}
