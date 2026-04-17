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

