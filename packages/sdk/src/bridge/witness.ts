/**
 * L2→L1 message witness computation.
 *
 * Computes the L2-to-L1 message leaf hash and membership witness
 * needed for the L1 withdrawal transaction.
 */

import { Fr } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { sha256ToField } from '@aztec/foundation/crypto/sha256'
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash'
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging'
import { RollupAbi } from '@aztec/l1-artifacts'
import { toFunctionSelector } from 'viem'

import type { WitnessResult } from '../types'

/**
 * Compute the L2-to-L1 message leaf hash from withdrawal parameters.
 * Pure computation — no network calls.
 */
export function computeL2ToL1MessageLeaf(params: {
  l1Recipient: string
  amount: bigint
  l2BridgeAddress: string
  portalAddress: string
  rollupVersion: number
  chainId: number
}): Fr {
  const { l1Recipient, amount, l2BridgeAddress, portalAddress, rollupVersion, chainId } = params

  const selectorBuf = Buffer.from(
    toFunctionSelector('withdraw(address,uint256,address)').slice(2),
    'hex',
  )
  const recipient = EthAddress.fromString(l1Recipient)
  const callerOnL1 = EthAddress.ZERO
  const content = sha256ToField([
    selectorBuf,
    recipient.toBuffer32(),
    new Fr(amount).toBuffer(),
    callerOnL1.toBuffer32(),
  ])

  return computeL2ToL1MessageHash({
    l2Sender: AztecAddress.fromString(l2BridgeAddress),
    l1Recipient: EthAddress.fromString(portalAddress),
    content,
    rollupVersion: new Fr(rollupVersion),
    chainId: new Fr(chainId),
  })
}

/**
 * Compute L2-to-L1 membership witness (leaf index + sibling path) for a block.
 *
 * Converts blockNumber → epoch via the L1 Rollup's `getEpochForCheckpoint`,
 * then calls `computeL2ToL1MembershipWitness(node, epoch, msgLeaf)`.
 */
export async function computeWitness(
  aztecNode: any,
  publicClient: any,
  blockNumber: number,
  msgLeaf: Fr,
  rollupAddress: string,
): Promise<WitnessResult> {
  // Convert block number → epoch.
  // The checkpoint may not be available immediately after the block is proven,
  // so retry up to 5 times with a 30 s delay (matches old frontend behavior).
  let epoch!: bigint
  const maxRetries = 5
  const retryDelayMs = 30_000
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const epochRaw = await publicClient.readContract({
        address: rollupAddress as `0x${string}`,
        abi: RollupAbi,
        functionName: 'getEpochForCheckpoint',
        args: [BigInt(blockNumber)],
      })
      epoch = typeof epochRaw === 'bigint' ? epochRaw : BigInt(epochRaw as number)
      break
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to get epoch for block ${blockNumber} after ${maxRetries} attempts: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      console.warn(`[SDK Witness] getEpochForCheckpoint attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelayMs / 1000}s...`)
      await new Promise((r) => setTimeout(r, retryDelayMs))
    }
  }

  const witness = await computeL2ToL1MembershipWitness(
    aztecNode,
    epoch as unknown as Parameters<typeof computeL2ToL1MembershipWitness>[1],
    msgLeaf,
  )

  if (!witness) {
    throw new Error(
      `L2→L1 message not found in epoch ${epoch} (block ${blockNumber}). ` +
        'The block may not be finalized yet, or the message leaf does not match.',
    )
  }

  const leafIndex =
    typeof witness.leafIndex === 'bigint'
      ? witness.leafIndex.toString()
      : String(witness.leafIndex)

  const siblingPath = witness.siblingPath
    .toBufferArray()
    .map((buf: Buffer) => `0x${buf.toString('hex')}`)

  return { leafIndex, siblingPath, epoch }
}
