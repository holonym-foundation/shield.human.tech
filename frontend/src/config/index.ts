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
  return (
    deploymentsData.deployments.find((d) => d.id === selectedId) ??
    deploymentsData.deployments[0]
  )
}

const activeDeployment = getSelectedDeployment()

// ─── Network Constants (from selected deployment) ─────────────────────

export const L1_CHAIN_ID = activeDeployment.network.l1ChainId
export const L2_CHAIN_ID = activeDeployment.network.l2ChainId
export const L2_CHAIN_KEY = `aztec:${L2_CHAIN_ID}`
export const L2_NODE_URL = activeDeployment.network.nodeUrl
export const DEPLOYMENT_ID = activeDeployment.id
export const ROLLUP_VERSION = activeDeployment.network.rollupVersion
export const AZTEC_VERSION = activeDeployment.network.aztecVersion

// L1 Aztec protocol contract addresses (from deployment snapshot)
export const L1_CONTRACT_ADDRESSES = activeDeployment.l1ContractAddresses

// Aztecscan URLs for different networks
export const AZTECSCAN_URLS: Record<number, string> = {
  [L2_CHAIN_ID]: 'https://devnet.aztecscan.xyz', // Aztec Devnet
}


export const getAztecscanUrl = (chainId: number): string => {
  return AZTECSCAN_URLS[chainId] || 'https://aztecscan.xyz'
}

export const FEE_JUICE_PORTAL_ADDRESS: `0x${string}` =
  (activeDeployment.nodeInfo?.l1ContractAddresses?.feeJuicePortalAddress ?? '') as `0x${string}`
export const FEE_JUICE_ADDRESS: `0x${string}` =
  (activeDeployment.nodeInfo?.l1ContractAddresses?.feeJuiceAddress ?? '') as `0x${string}`
export const BRIDGED_FPC_ADDRESS: string =
  ((activeDeployment as any).bridgedFpcAddress ?? '') as string

// ─── Permit2 + SwapBridgeRouter ──────────────────────────────────────
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
export const SWAP_BRIDGE_ROUTER_ADDRESS: `0x${string}` =
  ((activeDeployment as any).swapBridgeRouterAddress ?? '') as `0x${string}`

// ─── Uniswap V4 Sepolia Constants ───────────────────────────────────
export const V4_POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as const
export const V4_QUOTER = '0x61b3f2011a92d183c7dbadbda940a7555ccf9227' as const
export const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as const
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000' as const

// UniswapFuelSwap — deployed swap contract (set after running DeployUniswapFuelSwap)
export const UNISWAP_FUEL_SWAP_ADDRESS: `0x${string}` =
  ((activeDeployment as any).uniswapFuelSwapAddress ?? '') as `0x${string}`

// Pool parameters for route building
// Intermediate hops (e.g. USDC/WETH) — 0.3% fee, 60 tick spacing
export const INTERMEDIATE_POOL_FEE = 3000 as const
export const INTERMEDIATE_POOL_TICK_SPACING = 60 as const
// Final hop (ETH/AZTEC pool) — 0.3% fee, 60 tick spacing
export const FEE_POOL_FEE = 3000 as const
export const FEE_POOL_TICK_SPACING = 60 as const
// Native ETH pool: mainnet uses native ETH (address(0)), Sepolia too
export const FEE_POOL_USES_NATIVE_ETH = true as const

// Non-token protocol addresses (SBT)
export const ADDRESS = {
  [L1_CHAIN_ID]: {
    CHAIN_ID: L1_CHAIN_ID,
    CHAIN_NAME: 'Sepolia',
    L1: {
      PORTAL_SBT_CONTRACT: '0x983ad7bdc7701a77a6c22e2245d7eafe893b21fe',
    },
  },
  [L2_CHAIN_ID]: {
    CHAIN_ID: L2_CHAIN_ID,
    CHAIN_NAME: 'Aztec Devnet',
    L2: {},
  },
} as Record<number, any>

// -------------------------------------

export const L1_NETWORKS: Network[] = [
  {
    id: 1,
    img: '/assets/svg/ethereum.svg',
    title: 'Eth Sepolia',
    chainId: L1_CHAIN_ID,
    network: 'sepolia',
    symbol: 'ETH',
  },
]

export const L2_NETWORKS: Network[] = [
  {
    id: 2,
    img: '/assets/svg/aztec.svg',
    title: 'Aztec Testnet',
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
  l2ProxyContract: t.l2ProxyContract,
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
  l2ProxyContract: t.l2ProxyContract,
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
