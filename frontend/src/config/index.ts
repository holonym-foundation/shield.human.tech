import { Network, Token } from '@/types/bridge'
// -------------------------------------

// Maintenance mode flag - set to true to enable maintenance overlay
export const MAINTENANCE_MODE = true

export const MAINTENANCE_MESSAGE =
  'We are currently performing scheduled maintenance. The bridge will be available shortly.'

export const MAINTENANCE_TITLE = 'Bridge Under Maintenance'

// -------------------------------------

// since aztec does not have a chain ID yet, i propose to use these values to organise token lists:
// - testnet: 418719321 // keccak256('aztec-testnet')[0:4]
// - sandbox:: 147120760, // keccak256('aztec-sandbox')[0:4]

export const ADDRESS = {
  11155111: {
    // Sepolia
    CHAIN_ID: 11155111,
    CHAIN_NAME: 'Sepolia',
    L1: {
      PORTAL_SBT_CONTRACT: '0x983ad7bdc7701a77a6c22e2245d7eafe893b21fe',
      TOKEN_CONTRACT: '0x93527f0552bef5fafc340bceac6a5a37b6c34496',
      FEE_ASSET_HANDLER_CONTRACT: '0x57860b112fc6890c4ddfeccb83714aa988dc382c',
      PORTAL_CONTRACT: '0x069840ae19473e452792c8e17fee77d78a3fcecb',
    },
  },
  1337: {
    // Aztec Testnet
    CHAIN_ID: 1337,
    CHAIN_NAME: 'Aztec Testnet',
    L2: {
      TOKEN_CONTRACT: '0x011bbe04d65430ca1e05b8b7d092b9ede275b4380f34d4aea1e80ae750e645be',
      TOKEN_BRIDGE_CONTRACT: '0x0a8ba03e74bea383e790265f23d6b042435bf1f78038806f8e4319006815a1e2',
      SPONSORED_FEE_PAYMENT_CONTRACT: '0x299f255076aa461e4e94a843f0275303470a6b8ebe7cb44a471c66711151e529',
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
    chainId: 11155111,
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
    chainId: 1337,
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
    decimals: 6,
    address: '0x93527f0552bef5fafc340bceac6a5a37b6c34496',
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
    decimals: 6,
    address: '0x011bbe04d65430ca1e05b8b7d092b9ede275b4380f34d4aea1e80ae750e645be',
  },
  // {
  //   id: 2,
  //   img: '/assets/svg/USDT.svg',
  //   title: 'Clean USDT',
  //   symbol: 'USDT',
  // },
]
