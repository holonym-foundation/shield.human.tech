import { Network, Token } from '@/types/bridge'
import {
  ALL_DEPLOYMENTS,
  ACTIVE_DEPLOYMENT_ID as SDK_ACTIVE_DEPLOYMENT_ID,
  getDeployment,
  getAztecscanUrl as sdkGetAztecscanUrl,
  getEtherscanUrl as sdkGetEtherscanUrl,
  type DeploymentData,
} from '@human.tech/aztec-bridge-sdk'

// -------------------------------------

// Maintenance mode flag - set to true to enable maintenance overlay
export const MAINTENANCE_MODE = false

export const MAINTENANCE_MESSAGE =
  'We are currently performing scheduled maintenance. The bridge will be available shortly.'

export const MAINTENANCE_TITLE = 'Bridge Under Maintenance'

// ─── Deployment Selection ─────────────────────────────────────────────
// On the server, always uses the active deployment.
// On the client, checks localStorage for a user override.

export type { DeploymentData }

export { ALL_DEPLOYMENTS }
export const ACTIVE_DEPLOYMENT_ID = SDK_ACTIVE_DEPLOYMENT_ID

function getSelectedDeployment(): DeploymentData {
  let selectedId = SDK_ACTIVE_DEPLOYMENT_ID
  if (typeof window !== 'undefined') {
    try {
      const override = localStorage.getItem('selectedDeploymentId')
      if (override && ALL_DEPLOYMENTS.some((d) => d.id === override)) {
        selectedId = override
      }
    } catch {
      // Ignore localStorage errors (SSR, security restrictions)
    }
  }
  return getDeployment(selectedId) ?? ALL_DEPLOYMENTS[0]
}

const activeDeployment = getSelectedDeployment()

// ─── Network Constants (from selected deployment) ─────────────────────

export const L1_CHAIN_ID = activeDeployment.network.l1ChainId
export const L2_CHAIN_ID = activeDeployment.network.l2ChainId
export const L2_NODE_URL = activeDeployment.network.nodeUrl
export const DEPLOYMENT_ID = activeDeployment.id
export const ROLLUP_VERSION = activeDeployment.network.rollupVersion

export const getAztecscanUrl = sdkGetAztecscanUrl
export const getEtherscanUrl = sdkGetEtherscanUrl

export const BRIDGE_AND_FUEL_ADDRESS: `0x${string}` =
  (activeDeployment.bridgeAndFuelAddress ?? '') as `0x${string}`
export const MOCK_FUEL_SWAP_ADDRESS: `0x${string}` =
  (activeDeployment.mockFuelSwapAddress ?? '') as `0x${string}`

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

// ─── Token Metadata (derived from first token) ──

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
