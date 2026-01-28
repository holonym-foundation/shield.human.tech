import { Network, Token } from '@/types/bridge'
// -------------------------------------

// Maintenance mode flag - set to true to enable maintenance overlay
export const MAINTENANCE_MODE = false

export const MAINTENANCE_MESSAGE =
  'We are currently performing scheduled maintenance. The bridge will be available shortly.'

export const MAINTENANCE_TITLE = 'Bridge Under Maintenance'

// -------------------------------------

// since aztec does not have a chain ID yet, i propose to use these values to organise token lists:
// - testnet: 418719321 // keccak256('aztec-testnet')[0:4]
// - sandbox:: 147120760, // keccak256('aztec-sandbox')[0:4]

// Import deployed tokens from bridge-script
import deployedTokensData from '@/constants/deployed-tokens.json'

export const L1_CHAIN_ID = 11155111
export const L2_CHAIN_ID = 1654394782
export const L2_CHAIN_KEY = `aztec:${L2_CHAIN_ID}`

// Aztecscan URLs for different networks
export const AZTECSCAN_URLS = {
  [L2_CHAIN_ID]: 'https://devnet.aztecscan.xyz', // Aztec Devnet
  // Add other chain IDs as needed
  // testnet: 'https://testnet.aztecscan.xyz',
} as const

// Helper function to get Aztecscan URL for a given chain ID
export const getAztecscanUrl = (chainId: number): string => {
  return AZTECSCAN_URLS[chainId as keyof typeof AZTECSCAN_URLS] || 'https://aztecscan.xyz'
}

export const ADDRESS = {
  [L1_CHAIN_ID]: {
    // Sepolia
    CHAIN_ID: 11155111,
    CHAIN_NAME: 'Sepolia',
    L1: {
      PORTAL_SBT_CONTRACT: '0x983ad7bdc7701a77a6c22e2245d7eafe893b21fe',
      TOKEN_CONTRACT: deployedTokensData.tokens[0]?.l1TokenContract,
      FEE_ASSET_HANDLER_CONTRACT: deployedTokensData.tokens[0]?.feeAssetHandler,
      PORTAL_CONTRACT: deployedTokensData.tokens[0]?.l1PortalContract,
    },
  },
  [L2_CHAIN_ID]: {
    // Aztec Devnet (l2ChainId = l1ChainId ^ rollupVersion)
    CHAIN_ID: L2_CHAIN_ID,
    CHAIN_NAME: 'Aztec Devnet',
    L2: {
      TOKEN_CONTRACT: deployedTokensData.tokens[0]?.l2TokenContract,
      TOKEN_BRIDGE_CONTRACT: deployedTokensData.tokens[0]?.l2BridgeContract,
      SPONSORED_FEE_PAYMENT_CONTRACT: deployedTokensData.sponsoredFeeAddress,
    },
  },
} as const

// L1: {
//   CHAIN_NAME: 'Sepolia',
//   NAME: 'Test USDC',
//   SYMBOL: 'USDC',
//   TOKEN_CONTRACT: '0x24ca8bf6d17d0f6844eacee733fa183d343c1dc4',
// }

// L2: {
// CHAIN_NAME: 'Aztec Testnet',
//   NAME: 'Clean USDC',
//   SYMBOL: 'USDC',
//   TOKEN_CONTRACT: '0x2ab7cf582347c8a2834e0faf98339372118275997e14c5a77054bb345362e878',
// }
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
  // {
  //   id: 2,
  //   img: '/assets/svg/op.svg',
  //   title: 'Optimism',
  // },
  // {
  //   id: 3,
  //   img: '/assets/svg/polygon.svg',
  //   title: 'Polygon',
  // },
  // {
  //   id: 4,
  //   img: '/assets/svg/arbitrum.svg',
  //   title: 'Arbitrum',
  // },
  // {
  //   id: 5,
  //   img: '/assets/svg/gn.svg',
  //   title: 'Gnosis',
  // },
]

export const L2_NETWORKS: Network[] = [
  {
    id: 2,
    img: '/assets/svg/aztec.svg',
    title: 'Aztec Tesnet',
    chainId: L2_CHAIN_ID,
    network: 'aztec',
    symbol: 'ETH',
  },
  // {
  //   id: 1,
  //   img: '/assets/svg/aztec.svg',
  //   title: 'Aztec Optimistic',
  //   chainId: 1337,
  //   network: 'aztec',
  //   symbol: 'ETH',
  // },
]
// -----------------------------
export const L1_TOKENS: Token[] = [
  {
    id: 1,
    img: '/assets/svg/USDC.svg',
    title: 'USDC',
    symbol: 'USDC',
    decimals: deployedTokensData.tokens[0]?.decimals || 6,
    address: deployedTokensData.tokens[0]?.l1TokenContract,
  },
  // {
  //   id: 2,
  //   img: '/assets/svg/USDT.svg',
  //   title: 'Test USDT',
  //   symbol: 'USDT',
  // },
  // {
  //   id: 3,
  //   img: '/assets/svg/ETH.svg',
  //   title: 'Test ETH',
  //   symbol: 'ETH',
  // },
  // {
  //   id: 4,
  //   img: '/assets/svg/XDAI.svg',
  //   title: 'Test XDAI',
  //   symbol: 'XDAI',
  // },
]

export const L2_TOKENS: Token[] = [
  {
    id: 1,
    img: '/assets/svg/USDC.svg',
    title: 'Clean USDC',
    symbol: 'cUSDC',
    decimals: deployedTokensData.tokens[0]?.decimals || 6,
    address: deployedTokensData.tokens[0]?.l2TokenContract,
  },
  // {
  //   id: 2,
  //   img: '/assets/svg/USDT.svg',
  //   title: 'Clean USDT',
  //   symbol: 'USDT',
  // },
]

// L2 Token Metadata (static configuration)
export const L2_TOKEN_METADATA = {
  name: 'Test USDC',
  symbol: 'USDC',
  decimals: deployedTokensData.tokens[0]?.decimals || 6,
} as const