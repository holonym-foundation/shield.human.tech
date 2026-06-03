/**
 * Shared bridge utilities used by L1→L2 and L2→L1 modules.
 */

import { createPublicClient, http, type Chain } from 'viem'
import { sepolia, mainnet } from 'viem/chains'
import type { ResolvedConfig } from '../types'

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  11155111: sepolia,
}

/**
 * Create a viem public client for L1 reads/polling.
 */
export function createL1PublicClient(config: ResolvedConfig) {
  return createPublicClient({
    chain: CHAIN_MAP[config.l1ChainId] ?? sepolia,
    transport: http(config.l1RpcUrl),
  })
}

/**
 * Serialize Aztec node info to a plain object for storage.
 * Skips null/undefined values to prevent downstream truthy checks
 * from treating the string 'null' as a valid address.
 */
export function serializeNodeInfo(nodeInfo: any): Record<string, unknown> {
  if (!nodeInfo) return {}

  const l1ContractAddresses: Record<string, string> = {}
  if (nodeInfo.l1ContractAddresses) {
    for (const [key, val] of Object.entries(nodeInfo.l1ContractAddresses)) {
      if (val == null) continue
      l1ContractAddresses[key] =
        typeof (val as any).toString === 'function'
          ? (val as any).toString()
          : String(val)
    }
  }

  const protocolContractAddresses: Record<string, string> = {}
  if (nodeInfo.protocolContractAddresses) {
    for (const [key, val] of Object.entries(
      nodeInfo.protocolContractAddresses,
    )) {
      if (val == null) continue
      protocolContractAddresses[key] =
        typeof (val as any).toString === 'function'
          ? (val as any).toString()
          : String(val)
    }
  }

  // Coerce numeric fields — Aztec node may return BigInt, Fr, or custom types
  // that don't survive JSON serialization. Convert to plain numbers.
  const l1ChainId = nodeInfo.l1ChainId != null ? Number(nodeInfo.l1ChainId) : undefined
  const rollupVersion = nodeInfo.rollupVersion != null ? Number(nodeInfo.rollupVersion) : undefined

  return {
    enr: nodeInfo.enr,
    nodeVersion: nodeInfo.nodeVersion,
    l1ChainId,
    rollupVersion,
    l1ContractAddresses,
    protocolContractAddresses,
    realProofs: nodeInfo.realProofs,
  }
}

/**
 * Sleep for the given number of milliseconds.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * ABI for TokenPortal.calculateFee(uint256) → uint256.
 * Used as a last-resort fallback when neither the DB nor the receipt event
 * provides an authoritative post-fee amount.
 */
const calculateFeeAbi = [
  {
    name: 'calculateFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '_amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/** ABI for TokenPortal.feeBasisPoints() → uint256 (the fee rate in bps). */
const feeBasisPointsAbi = [
  {
    name: 'feeBasisPoints',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

/**
 * Read the TokenPortal's fee rate (basis points). The portal deducts
 * `amount * feeBasisPoints / 10000` from every deposit/withdrawal. Reading the
 * rate once lets the UI compute the fee locally for any amount without an RPC
 * per keystroke.
 */
export async function getPortalFeeBasisPoints(config: ResolvedConfig, portalAddress: string): Promise<bigint> {
  const publicClient = createL1PublicClient(config)
  return (await publicClient.readContract({
    address: portalAddress as `0x${string}`,
    abi: feeBasisPointsAbi,
    functionName: 'feeBasisPoints',
  } as any)) as bigint
}

/**
 * Query TokenPortal.calculateFee to derive the post-fee claim amount from the
 * pre-fee input amount. The custom TokenPortal deducts a fee before producing
 * the L1→L2 content hash, so the L2 claim must use `amount - fee` or the
 * content hash won't match.
 */
export async function getPostFeeClaimAmount(
  config: ResolvedConfig,
  portalAddress: string,
  amount: bigint,
): Promise<bigint> {
  const publicClient = createL1PublicClient(config)
  try {
    const fee = (await publicClient.readContract({
      address: portalAddress as `0x${string}`,
      abi: calculateFeeAbi,
      functionName: 'calculateFee',
      args: [amount],
    } as any)) as bigint
    return amount - fee
  } catch (err) {
    throw new Error(
      `Failed to query portal fee at ${portalAddress}. Cannot safely determine the claim amount. ` +
        'Please check your RPC connection and try again.',
    )
  }
}

/**
 * Validate that a Passport attestation's deadline has enough buffer left to
 * survive the tx-mining window. Passport is rejected on-chain once
 * `block.timestamp >= deadline`, so issuing a tx with a tight deadline means
 * the user pays gas for a guaranteed revert.
 *
 * @param deadline Attestation deadline in Unix seconds (bigint)
 * @param minBufferSeconds Minimum seconds the deadline must exceed "now"
 * @param context Human-readable label used in the thrown error
 * @throws Error with actionable retry guidance if the buffer is insufficient.
 *
 * Treats `deadline === 0n` as "no passport attestation issued" (CleanHands
 * path) and is a no-op — the caller shouldn't have to branch on which
 * attestation method succeeded.
 */
export function assertPassportDeadlineBuffer(
  deadline: bigint,
  minBufferSeconds: bigint,
  context: string,
): void {
  if (deadline <= 0n) return
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  if (deadline <= nowSec + minBufferSeconds) {
    const remaining = deadline > nowSec ? (deadline - nowSec).toString() : '0'
    throw new Error(
      `Passport attestation expires in ${remaining}s — too short to safely submit ${context}. ` +
      `Retry the operation so a fresh attestation is issued.`,
    )
  }
}

/**
 * Validate that a block-scan range is not so large it would wedge the browser
 * (synchronous work + RPC rate-limits). Thrown errors include the actionable
 * recovery path (provide the tx hash for direct lookup instead of scanning).
 *
 * @param fromBlock Inclusive lower bound
 * @param toBlock Inclusive upper bound (current head)
 * @param maxRange Maximum allowed range in blocks
 * @param chain "L1" | "L2" (for error messaging)
 */
export function assertBlockScanRange(
  fromBlock: bigint | number,
  toBlock: bigint | number,
  maxRange: bigint | number,
  chain: 'L1' | 'L2',
): void {
  const from = BigInt(fromBlock)
  const to = BigInt(toBlock)
  const max = BigInt(maxRange)
  if (to < from) {
    // Degenerate case — fromBlock after current head. Treat as OK (zero-range
    // scan is a no-op, will just find nothing and error elsewhere).
    return
  }
  const range = to - from
  if (range > max) {
    throw new Error(
      `${chain} block scan range too large (${range.toString()} blocks). ` +
      `Provide ${chain === 'L1' ? 'l1TxHash' : 'l2TxHash'} for direct receipt recovery, ` +
      `or contact support with your operation ID. Max scan range: ${max.toString()} blocks.`,
    )
  }
}

/**
 * Classify a `readContract` failure as fatal (the check can never succeed —
 * wrong address, missing ABI, invalid selector) vs. transient (RPC timeout,
 * rate-limit). Used by the L1 outbox idempotency pre-check so we don't
 * blindly send a withdraw tx when the pre-check is structurally broken.
 */
export function isFatalContractReadError(errMsg: string): boolean {
  return /contract.*does not exist|no contract|invalid address|unknown (function|method|selector)|function.*not found|returned no data|ContractFunctionZeroDataError/i.test(
    errMsg,
  )
}

/**
 * Validate that an L2→L1 epoch is present and non-zero before using it in the
 * L1 TokenPortal.withdraw proof. A zero/undefined epoch produces a proof that
 * never matches a real L2→L1 message and the tx reverts with a cryptic error.
 * Funds are safe (burn is on L2, witness is persisted) — resume from Activity
 * will re-derive once the rollup contract can resolve the epoch.
 */
export function assertValidEpoch(epoch: bigint | null | undefined, l2BlockNumber: number | string): bigint {
  if (epoch == null || epoch === 0n) {
    throw new Error(
      `Could not determine epoch for L1 withdraw (block ${l2BlockNumber}). ` +
      `Your L2 burn succeeded and witness data is saved — resume this withdrawal ` +
      `from the Activity page once the rollup contract can resolve the epoch.`,
    )
  }
  return epoch
}

/**
 * Detect errors that indicate a bridge message has already been consumed on
 * the target chain — i.e. the operation is actually complete, we just didn't
 * finalize the DB state. Used by both happy-path and resume flows so that a
 * race (e.g. another device finalized, or a prior resume settled but its
 * completion PATCH never landed) resolves as 'completed' instead of 'failed'.
 *
 * NOTE: Do NOT add generic patterns like /execution reverted/ — that would
 * silently swallow real L1 failures (wrong epoch, bad proof, contract paused)
 * and mark the operation as completed when funds never arrived.
 */
export function isAlreadyConsumedError(errMsg: string): boolean {
  const patterns = [
    /already\s*(nullified|consumed)/i,
    /nothing\s*to\s*consume/i,
    /NothingToConsumeAtBlock/i,
    /AlreadyConsumed/i,
    /message.*already.*consumed/i,
    /note.*already.*consumed/i,
    /nonexistent L1-to-L2 message/i,
    /l1_to_l2_msg_exists/i,
    // NothingToConsumeAtBlock(uint256,uint256) = keccak256 selector 0x945d8c59
    /0x945d8c59/i,
  ]
  return patterns.some((p) => p.test(errMsg))
}

/**
 * Extract a human-readable error string from an unknown thrown value.
 * Prevents `String({...})` from producing "[object Object]" in error messages.
 */
export function extractErrorString(error: unknown): string {
  if (!error) return 'Unknown error'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (typeof obj.message === 'string') return obj.message
    if (typeof obj.error === 'string') return obj.error
    if (typeof obj.reason === 'string') return obj.reason
    if (typeof obj.shortMessage === 'string') return obj.shortMessage
    try { return JSON.stringify(error) } catch { /* circular ref */ }
  }
  return String(error)
}

