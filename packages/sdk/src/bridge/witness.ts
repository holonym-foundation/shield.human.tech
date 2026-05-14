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
import { TxHash } from '@aztec/stdlib/tx'
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
 * Compute L2-to-L1 membership witness (leaf index + sibling path) for a message.
 *
 * Uses `computeL2ToL1MembershipWitness(node, message, txHash)` (4.2 API) which
 * internally resolves the block/epoch from the tx receipt.
 *
 * @param aztecNode - Aztec node client
 * @param blockNumber - L2 block number (used for error messages only)
 * @param msgLeaf - The L2-to-L1 message leaf hash
 * @param l2TxHash - The L2 transaction hash (required for 4.2+ witness computation)
 */
export async function computeWitness(
  aztecNode: any,
  blockNumber: number,
  msgLeaf: Fr,
  l2TxHash: string,
): Promise<WitnessResult> {
  if (!l2TxHash) {
    throw new Error(
      'l2TxHash is required for computing L2→L1 membership witness in SDK 4.2+',
    )
  }

  const txHash = TxHash.fromString(l2TxHash)

  // Retry — the epoch proof may not be available yet
  const maxRetries = 5
  const retryDelayMs = 30_000
  let witness: Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>> | undefined
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      witness = await computeL2ToL1MembershipWitness(
        aztecNode,
        msgLeaf,
        txHash,
      )
      if (witness) break
      if (attempt < maxRetries) {
        console.warn(
          `[SDK Witness] Witness not found (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs / 1000}s...`,
        )
        await new Promise((r) => setTimeout(r, retryDelayMs))
      }
    } catch (err) {
      if (attempt < maxRetries) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(
          `[SDK Witness] computeL2ToL1MembershipWitness failed (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs / 1000}s...`,
          msg,
        )
        await new Promise((r) => setTimeout(r, retryDelayMs))
        continue
      }
      throw err
    }
  }

  if (!witness) {
    throw new Error(
      `L2→L1 message not found (block ${blockNumber}, txHash ${l2TxHash}). ` +
        'The block may not be finalized yet, or the message leaf does not match.',
    )
  }

  // Get epoch from witness (4.2 API returns epochNumber on the witness object)
  const epoch = witness.epochNumber

  const leafIndex =
    typeof witness.leafIndex === 'bigint'
      ? witness.leafIndex.toString()
      : String(witness.leafIndex)

  const siblingPath = witness.siblingPath
    .toBufferArray()
    .map((buf: Buffer) => `0x${buf.toString('hex')}`)

  return { leafIndex, siblingPath, epoch: BigInt(epoch) }
}
