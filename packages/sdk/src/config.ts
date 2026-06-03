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

// ─── Hardcoded Protocol Constants ──────────────────────────────────
// These addresses are the same across all deployments on the same L1.

/** Uniswap Permit2 contract (canonical deployment, same on all EVM chains) */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

// ─── Per-chain Uniswap V4 + WETH addresses ─────────────────────────
// Resolved by L1 chain id so one SDK build serves both mainnet and Sepolia.
// Used by the on-chain fuel quoter (fuelPricing.ts) and the SwapBridgeRouter callers.
// Kept in sync with frontend/src/config/index.ts.
const V4_ADDRESSES_BY_CHAIN: Record<
  number,
  { weth: `0x${string}`; quoter: `0x${string}`; poolManager: `0x${string}` }
> = {
  1: {
    weth: '0xc02aaa39b223fe8d0a0e8e4f27ead9083c756cc2',
    quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
    poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
  },
  11155111: {
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
    poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
  },
}

export function getV4Addresses(chainId: number) {
  return V4_ADDRESSES_BY_CHAIN[chainId] ?? V4_ADDRESSES_BY_CHAIN[11155111]
}

/** Wrapped ETH — Sepolia default; mainnet resolved per-deployment in createConfig. */
export const WETH_ADDRESS = V4_ADDRESSES_BY_CHAIN[11155111].weth

/** Uniswap V4 Quoter — Sepolia default; mainnet resolved per-deployment in createConfig. */
export const V4_QUOTER = V4_ADDRESSES_BY_CHAIN[11155111].quoter

/** Native ETH sentinel in V4 pools (currency0 can be zero address) */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const

/** Fees and tick spacings for the canonical fuel swap pools */
export const INTERMEDIATE_POOL_FEE = 3000 as const
export const INTERMEDIATE_POOL_TICK_SPACING = 60 as const
// Mainnet ETH/AZTEC V4 pool is fee=10000 / tickSpacing=200 (verified on-chain; fee=3000 is empty).
export const FEE_POOL_FEE = 10000 as const
export const FEE_POOL_TICK_SPACING = 200 as const
export const DIRECT_POOL_FEE = 3000 as const
export const DIRECT_POOL_TICK_SPACING = 60 as const

/**
 * When true, the fuel pool pairs AZTEC/FeeJuice with NATIVE ETH rather than WETH.
 * Matches main's deployment (Uniswap V4 Sepolia pool was seeded against ETH).
 */
export const FEE_POOL_USES_NATIVE_ETH = true as const

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
    l1RpcUrl: overrides?.l1RpcUrl ?? '',
    l2NodeUrl: overrides?.l2NodeUrl ?? dep.network.nodeUrl,
    rollupVersion: dep.network.rollupVersion,
    aztecVersion: dep.network.aztecVersion,
    tokens: dep.tokens as TokenConfig[],
    l1ContractAddresses: dep.l1ContractAddresses as L1ContractAddresses,
    swapBridgeRouterAddress: dep.swapBridgeRouterAddress ?? '',
    uniswapFuelSwapAddress: dep.uniswapFuelSwapAddress ?? '',
    bridgedFpcAddress: dep.bridgedFpcAddress ?? '',
    permit2Address: PERMIT2_ADDRESS,
    wethAddress: getV4Addresses(dep.network.l1ChainId).weth,
    v4QuoterAddress: getV4Addresses(dep.network.l1ChainId).quoter,
    feeJuicePortalAddress: (nodeInfoAddresses as any).feeJuicePortalAddress ?? '',
    feeJuiceAddress: (nodeInfoAddresses as any).feeJuiceAddress ?? '',
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
  604129785: 'https://testnet.aztecscan.xyz',
}

export function getAztecscanUrl(chainId: number): string {
  return AZTECSCAN_URLS[chainId] || 'https://aztecscan.xyz'
}

export function getEtherscanUrl(chainId: number): string {
  if (chainId === 11155111) return 'https://sepolia.etherscan.io'
  return 'https://etherscan.io'
}
