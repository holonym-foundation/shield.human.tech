import { Network, Token } from '@/types/bridge'
// -------------------------------------

// Maintenance mode flag - set to true to enable maintenance overlay
export const MAINTENANCE_MODE = false

export const MAINTENANCE_MESSAGE =
  'We are currently performing scheduled maintenance. The bridge will be available shortly.'

export const MAINTENANCE_TITLE = 'Bridge Under Maintenance'

// -------------------------------------

// Import bundled deployments (auto-synced by deployment script)
import deploymentsData from '@/constants/deployments.json'

// ─── Deployment Selection ─────────────────────────────────────────────
// On the server, always uses the active deployment.
// On the client, checks localStorage for a user override.

export type DeploymentData = (typeof deploymentsData.deployments)[number]

/** All available deployments (for the version selector) */
export const ALL_DEPLOYMENTS = deploymentsData.deployments
export const ACTIVE_DEPLOYMENT_ID = deploymentsData.activeDeploymentId

function getSelectedDeployment(): DeploymentData {
  let selectedId = deploymentsData.activeDeploymentId
  // Allow deployment override only in development (prevents localStorage manipulation
  // from redirecting users to old/compromised contract addresses in production).
  const isDev = process.env.NODE_ENV === 'development'
  if (isDev && typeof window !== 'undefined') {
    try {
      const override = localStorage.getItem('selectedDeploymentId')
      if (override) {
        console.warn('[Config] Using deployment override from localStorage:', override)
        selectedId = override
      }
    } catch {
      // Ignore localStorage errors (SSR, security restrictions)
    }
  }
  return deploymentsData.deployments.find((d) => d.id === selectedId) ?? deploymentsData.deployments[0]
}

const activeDeployment = getSelectedDeployment()

// ─── Environment-aware Network Config ────────────────────────────────
// Reads all RPC/node URLs from env vars. The active network is determined
// by the deployment's l1ChainId — switch networks by changing the active
// deployment (or NEXT_PUBLIC_AZTEC_ENV override), not by editing env var names.

type AztecEnv = 'devnet' | 'testnet' | 'mainnet'

import {
  AZTEC_ENV as AZTEC_ENV_OVERRIDE,
  L1_RPC_SEPOLIA,
  L1_RPC_MAINNET,
  AZTEC_NODE_DEVNET,
  AZTEC_NODE_TESTNET,
  AZTEC_NODE_MAINNET,
} from './env.config'

function resolveAztecEnv(): AztecEnv {
  if (AZTEC_ENV_OVERRIDE && ['devnet', 'testnet', 'mainnet'].includes(AZTEC_ENV_OVERRIDE)) {
    return AZTEC_ENV_OVERRIDE as AztecEnv
  }
  const name = activeDeployment.network.name?.toLowerCase() ?? ''
  if (name.includes('mainnet')) return 'mainnet'
  if (name.includes('devnet')) return 'devnet'
  return 'testnet'
}

const AZTEC_ENV = resolveAztecEnv()

const ENV_CONFIG = {
  devnet: {
    l1RpcUrl: L1_RPC_SEPOLIA,
    l1ChainId: 11155111,
    aztecNodeUrl: AZTEC_NODE_DEVNET,
    aztecscanUrl: 'https://devnet.aztecscan.xyz',
    aztecExplorerUrl: 'https://aztecexplorer.xyz/?network=devnet',
    chainName: 'Aztec Devnet',
  },
  testnet: {
    l1RpcUrl: L1_RPC_SEPOLIA,
    l1ChainId: 11155111,
    aztecNodeUrl: AZTEC_NODE_TESTNET,
    aztecscanUrl: 'https://testnet.aztecscan.xyz',
    aztecExplorerUrl: 'https://aztecexplorer.xyz/?network=testnet',
    chainName: 'Aztec Testnet',
  },
  mainnet: {
    l1RpcUrl: L1_RPC_MAINNET,
    l1ChainId: 1,
    aztecNodeUrl: AZTEC_NODE_MAINNET,
    aztecscanUrl: 'https://aztecscan.xyz',
    aztecExplorerUrl: 'https://aztecexplorer.xyz/?network=mainnet',
    chainName: 'Aztec Mainnet',
  },
} as const

const activeEnvConfig = ENV_CONFIG[AZTEC_ENV]

// ─── Network Constants ───────────────────────────────────────────────

export const L1_CHAIN_ID = activeDeployment.network.l1ChainId
export const IS_MAINNET = L1_CHAIN_ID === 1
export const L2_CHAIN_ID = activeDeployment.network.l2ChainId
export const L2_CHAIN_KEY = `aztec:${L2_CHAIN_ID}`
export const L1_RPC_URL = activeEnvConfig.l1RpcUrl
export const L2_NODE_URL = activeEnvConfig.aztecNodeUrl
export const DEPLOYMENT_ID = activeDeployment.id
export const ROLLUP_VERSION = activeDeployment.network.rollupVersion
export const AZTEC_VERSION = activeDeployment.network.aztecVersion

// L1 Aztec protocol contract addresses (from deployment snapshot)
export const L1_CONTRACT_ADDRESSES = activeDeployment.l1ContractAddresses

// Explorer URLs (derived from active environment)
export const AZTECSCAN_URL = activeEnvConfig.aztecscanUrl
export const AZTEC_EXPLORER_URL = activeEnvConfig.aztecExplorerUrl

export const AZTECSCAN_URLS: Record<number, string> = {
  [L2_CHAIN_ID]: activeEnvConfig.aztecscanUrl,
}

export const getAztecscanUrl = (chainId: number): string => {
  return AZTECSCAN_URLS[chainId] || activeEnvConfig.aztecscanUrl
}

const ETHERSCAN_URLS: Record<number, string> = {
  1: 'https://etherscan.io',
  11155111: 'https://sepolia.etherscan.io',
}

export const getEtherscanUrl = (chainId: number): string => {
  return ETHERSCAN_URLS[chainId] || 'https://sepolia.etherscan.io'
}

export const FEE_JUICE_PORTAL_ADDRESS: `0x${string}` = (activeDeployment.nodeInfo?.l1ContractAddresses
  ?.feeJuicePortalAddress ?? '') as `0x${string}`
export const FEE_JUICE_ADDRESS: `0x${string}` = (activeDeployment.nodeInfo?.l1ContractAddresses?.feeJuiceAddress ??
  '') as `0x${string}`
export const BRIDGED_FPC_ADDRESS: string = ((activeDeployment as any).bridgedFpcAddress ?? '') as string

// ─── Permit2 + SwapBridgeRouter ──────────────────────────────────────
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
export const SWAP_BRIDGE_ROUTER_ADDRESS: `0x${string}` = ((activeDeployment as any).swapBridgeRouterAddress ??
  '') as `0x${string}`

// ─── Uniswap V4 + WETH (resolved by L1 chain id) ────────────────────
const V4_ADDRESSES_BY_CHAIN: Record<
  number,
  { poolManager: `0x${string}`; quoter: `0x${string}`; weth: `0x${string}` }
> = {
  1: {
    poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90',
    quoter: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203',
    weth: '0xc02aaa39b223fe8d0a0e8e4f27ead9083c756cc2',
  },
  11155111: {
    poolManager: '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543',
    quoter: '0x61b3f2011a92d183c7dbadbda940a7555ccf9227',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  },
}
const _v4 = V4_ADDRESSES_BY_CHAIN[L1_CHAIN_ID] ?? V4_ADDRESSES_BY_CHAIN[11155111]
export const V4_POOL_MANAGER = _v4.poolManager
export const V4_QUOTER = _v4.quoter
export const WETH_ADDRESS = _v4.weth
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const

// UniswapFuelSwap — deployed swap contract (set after running DeployUniswapFuelSwap)
export const UNISWAP_FUEL_SWAP_ADDRESS: `0x${string}` = ((activeDeployment as any).uniswapFuelSwapAddress ??
  '') as `0x${string}`

// Pool parameters for route building
// Intermediate hops (e.g. USDC/WETH) — 0.3% fee, 60 tick spacing
export const INTERMEDIATE_POOL_FEE = 3000 as const
export const INTERMEDIATE_POOL_TICK_SPACING = 60 as const
// Final hop (ETH/AZTEC pool) — 0.3% fee, 60 tick spacing
// Mainnet ETH/AZTEC V4 pool is fee=10000 / tickSpacing=200 (verified on-chain; fee=3000 is empty).
export const FEE_POOL_FEE = 10000 as const
export const FEE_POOL_TICK_SPACING = 200 as const
// Native ETH pool: mainnet uses native ETH (address(0)), Sepolia too
export const FEE_POOL_USES_NATIVE_ETH = true as const
// Direct pool (e.g. USDC/FeeJuice) — for smart routing when a direct path exists
export const DIRECT_POOL_FEE = 3000 as const
export const DIRECT_POOL_TICK_SPACING = 60 as const

// Non-token protocol addresses (SBT)
export const ADDRESS = {
  [L1_CHAIN_ID]: {
    CHAIN_ID: L1_CHAIN_ID,
    CHAIN_NAME: IS_MAINNET ? 'Ethereum' : 'Sepolia',
    L1: {
      PORTAL_SBT_CONTRACT: '0x983ad7bdc7701a77a6c22e2245d7eafe893b21fe',
    },
  },
  [L2_CHAIN_ID]: {
    CHAIN_ID: L2_CHAIN_ID,
    CHAIN_NAME: activeEnvConfig.chainName,
    L2: {},
  },
} as Record<number, any>

// -------------------------------------

export const L1_NETWORKS: Network[] = [
  {
    id: 1,
    img: '/assets/svg/ethereum.svg',
    title: IS_MAINNET ? 'Ethereum' : 'Eth Sepolia',
    chainId: L1_CHAIN_ID,
    network: IS_MAINNET ? 'ethereum' : 'sepolia',
    symbol: 'ETH',
  },
]

export const L2_NETWORKS: Network[] = [
  {
    id: 2,
    img: '/assets/svg/aztec.svg',
    title: activeEnvConfig.chainName,
    chainId: L2_CHAIN_ID,
    network: 'aztec',
    symbol: 'ETH',
  },
]

// ─── Dynamic Token Lists (generated from selected deployment) ─────────

export const L1_TOKENS: Token[] = activeDeployment.tokens.map((t, i) => ({
  id: i + 1,
  img: t.logo,
  title: t.symbol,
  symbol: t.symbol,
  decimals: t.decimals,
  address: t.l1TokenContract,
  l1TokenContract: t.l1TokenContract,
  l2TokenContract: t.l2TokenContract,
  l1PortalContract: t.l1PortalContract,
  l2BridgeContract: t.l2BridgeContract,
  l2ProxyContract: (t as any).l2ProxyContract ?? '',
  feeAssetHandler: t.feeAssetHandler,
  pairedSymbol: `c${t.symbol}`,
}))

export const L2_TOKENS: Token[] = activeDeployment.tokens.map((t, i) => ({
  id: i + 1,
  img: t.logo,
  title: `Clean ${t.symbol}`,
  symbol: `c${t.symbol}`,
  decimals: t.decimals,
  address: t.l2TokenContract,
  l1TokenContract: t.l1TokenContract,
  l2TokenContract: t.l2TokenContract,
  l1PortalContract: t.l1PortalContract,
  l2BridgeContract: t.l2BridgeContract,
  l2ProxyContract: (t as any).l2ProxyContract ?? '',
  feeAssetHandler: t.feeAssetHandler,
  pairedSymbol: t.symbol,
}))

// ─── Token Lookup Helpers ───────────────────────────────────────────

/** Get the L2 paired token for an L1 token (by matching deployment data) */
export function getL2PairedToken(l1Token: Token): Token | undefined {
  return L2_TOKENS.find((t) => t.l1TokenContract === l1Token.l1TokenContract)
}

/** Get the L1 paired token for an L2 token (by matching deployment data) */
export function getL1PairedToken(l2Token: Token): Token | undefined {
  return L1_TOKENS.find((t) => t.l1TokenContract === l2Token.l1TokenContract)
}

/** Get all contract addresses for a token by symbol (L1 symbol, e.g. "USDC") */
export function getTokenContracts(symbol: string) {
  const deployed = activeDeployment.tokens.find((t) => t.symbol === symbol)
  if (!deployed) return null
  return {
    l1TokenContract: deployed.l1TokenContract,
    l2TokenContract: deployed.l2TokenContract,
    l1PortalContract: deployed.l1PortalContract,
    l2BridgeContract: deployed.l2BridgeContract,
    feeAssetHandler: deployed.feeAssetHandler,
  }
}

// ─── Token Metadata (derived from first token for backward compat) ──

export const L1_TOKEN_METADATA = {
  name: activeDeployment.tokens[0]?.symbol || 'USDC',
  symbol: activeDeployment.tokens[0]?.symbol || 'USDC',
  decimals: activeDeployment.tokens[0]?.decimals || 6,
} as const

export const L2_TOKEN_METADATA = {
  name: `Clean ${activeDeployment.tokens[0]?.symbol || 'USDC'}`,
  symbol: `c${activeDeployment.tokens[0]?.symbol || 'USDC'}`,
  decimals: activeDeployment.tokens[0]?.decimals || 6,
} as const
