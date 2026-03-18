/**
 * SDK configuration module
 *
 * Loads deployment data and resolves all network/contract/token configuration.
 * No browser APIs (localStorage, window) — fully portable.
 *
 * The SDK exports available deployments. The consumer (frontend) selects
 * which deployment to use and passes the ID to HumanTechBridge constructor.
 */

import type { ResolvedConfig, TokenConfig, L1ContractAddresses } from './types'
import deploymentsData from './contracts/deployments.json'

// ─── Deployment Data Types ──────────────────────────────────────────

export type DeploymentData = (typeof deploymentsData.deployments)[number]

/** All available deployments */
export const ALL_DEPLOYMENTS = deploymentsData.deployments

/** The default active deployment ID from the bundled config */
export const ACTIVE_DEPLOYMENT_ID = deploymentsData.activeDeploymentId

/**
 * Get a deployment by ID. Returns undefined if not found.
 */
export function getDeployment(id: string): DeploymentData | undefined {
  return ALL_DEPLOYMENTS.find((d) => d.id === id)
}

// ─── Config Creation ────────────────────────────────────────────────

/**
 * Create a resolved configuration from a deployment ID and optional overrides.
 */
export function createConfig(
  deployment: string,
  overrides?: { l1RpcUrl?: string; l2NodeUrl?: string },
): ResolvedConfig {
  const dep = getDeployment(deployment)
  if (!dep) {
    const available = ALL_DEPLOYMENTS.map((d) => d.id).join(', ')
    throw new Error(
      `Unknown deployment: "${deployment}". Available deployments: ${available}`,
    )
  }

  const nodeInfoAddresses = dep.nodeInfo?.l1ContractAddresses ?? {}

  return {
    deploymentId: dep.id,
    l1ChainId: dep.network.l1ChainId,
    l2ChainId: dep.network.l2ChainId,
    l1RpcUrl: overrides?.l1RpcUrl ?? dep.network.l1RpcUrl,
    l2NodeUrl: overrides?.l2NodeUrl ?? dep.network.nodeUrl,
    rollupVersion: dep.network.rollupVersion,
    aztecVersion: dep.network.aztecVersion,
    tokens: dep.tokens as TokenConfig[],
    l1ContractAddresses: dep.l1ContractAddresses as L1ContractAddresses,
    bridgeAndFuelAddress: dep.bridgeAndFuelAddress ?? '',
    mockFuelSwapAddress: dep.mockFuelSwapAddress ?? '',
    feeJuicePortalAddress: nodeInfoAddresses.feeJuicePortalAddress ?? '',
    feeJuiceAddress: nodeInfoAddresses.feeJuiceAddress ?? '',
    sponsoredFeeAddress: dep.sponsoredFeeAddress ?? '',
  }
}

// ─── Token Resolution ───────────────────────────────────────────────

/**
 * Resolve a token by symbol or contract address.
 */
export function resolveToken(
  config: ResolvedConfig,
  tokenOrSymbol: string,
): TokenConfig {
  const normalized = tokenOrSymbol.toLowerCase()

  const bySymbol = config.tokens.find(
    (t) => t.symbol.toLowerCase() === normalized,
  )
  if (bySymbol) return bySymbol

  const byPairedSymbol = config.tokens.find(
    (t) => `c${t.symbol}`.toLowerCase() === normalized,
  )
  if (byPairedSymbol) return byPairedSymbol

  const byAddress = config.tokens.find(
    (t) => t.l1TokenContract.toLowerCase() === normalized,
  )
  if (byAddress) return byAddress

  const byL2Address = config.tokens.find(
    (t) => t.l2TokenContract.toLowerCase() === normalized,
  )
  if (byL2Address) return byL2Address

  const available = config.tokens.map((t) => t.symbol).join(', ')
  throw new Error(
    `Unknown token: "${tokenOrSymbol}". Available tokens: ${available}`,
  )
}

// ─── URL Helpers ────────────────────────────────────────────────────

const AZTECSCAN_URLS: Record<number, string> = {
  604129785: 'https://devnet.aztecscan.xyz',
}

export function getAztecscanUrl(chainId: number): string {
  return AZTECSCAN_URLS[chainId] || 'https://aztecscan.xyz'
}

export function getEtherscanUrl(chainId: number): string {
  if (chainId === 11155111) return 'https://sepolia.etherscan.io'
  return 'https://etherscan.io'
}
