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

