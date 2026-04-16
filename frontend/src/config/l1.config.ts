import { parseUnits } from 'viem'
import { InitWaaPOptions } from '@human.tech/waap-sdk'
import { logo } from './logo'
import { L1_CHAIN_ID } from '@/config'
import { WALLETCONNECT_PROJECT_ID } from '@/config/env.config'

export const useStagingWaap = false

export const waapUrl = useStagingWaap ? 'https://staging-waap.xyz' : 'https://waap.xyz'

export const waapConfig: InitWaaPOptions = {
  config: {
    allowedSocials: ['google', 'twitter', 'discord', 'github'],
    authenticationMethods: ['email', 'phone', 'wallet', 'social'],
    styles: {
      darkMode: false,
    },
  },
  project: {
    entryTitle: 'Welcome Human',
    logo: logo,
  },
  walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
}

// Legacy exports for backward compatibility
export const silkConfig = waapConfig
export const silkUrl = waapUrl

// -------------------------------

export interface NetworkConfigItem {
  name?: string
  cmc_id?: number // Coin Market Cap ID
  currencyName?: string
  currencySymbol?: string
  logo: string
  rpcUrl?: string
  blockExplorer?: string
  chainId?: number
  isTestnet?: boolean
  //Property to be used on gas tank
  threshold?: any
}

export interface NetworkConfigInfo {
  [key: number]: NetworkConfigItem
}
export const networkConfig: NetworkConfigInfo = {
  1: {
    name: 'Ethereum',
    cmc_id: 1027,
    currencyName: 'Ether',
    currencySymbol: 'ETH',
    logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png?1595348880',
    blockExplorer: 'https://etherscan.io/',
    rpcUrl: '',
    chainId: 1,
    threshold: parseUnits('0.05', 18), // 0.1 ETH
    isTestnet: false,
  },
  // 5: {
  //   name: 'Ethereum Goerli',
  //   cmc_id: 23669,
  //   currencyName: 'Goerli Ether',
  //   currencySymbol: 'GETH',
  //   logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png?1595348880',
  //   blockExplorer: 'https://goerli.etherscan.io/',
  //   // rpcUrl: '',
  //   rpcUrl: '',
  //   chainId: 5,
  //   isTestnet: true
  // },
  [L1_CHAIN_ID]: {
    name: 'Ethereum Sepolia',
    cmc_id: 23669,
    currencyName: 'Sepolia Ether',
    currencySymbol: 'ETH',
    logo: 'https://assets.coingecko.com/coins/images/279/small/ethereum.png?1595348880',
    blockExplorer: 'https://sepolia.etherscan.io/',
    rpcUrl: '',
    chainId: L1_CHAIN_ID,
    isTestnet: true,
  },
  100: {
    name: 'Gnosis Chain',
    cmc_id: 8635,
    currencyName: 'xDAI',
    currencySymbol: 'XDAI',
    logo: 'https://assets.coingecko.com/coins/images/11062/standard/Identity-Primary-DarkBG.png?1696511004',
    blockExplorer: 'https://gnosis.blockscout.com/',
    rpcUrl: '',
    chainId: 100,
    isTestnet: false,
  },
  137: {
    name: 'Polygon',
    cmc_id: 3890,
    currencyName: 'Matic',
    currencySymbol: 'MATIC',
    logo: 'https://assets.coingecko.com/coins/images/4713/standard/matic-token-icon.png?1696505277',
    blockExplorer: 'https://polygonscan.com/',
    rpcUrl: '',
    chainId: 137,
    threshold: parseUnits('10', 18), // 5 MATIC
    isTestnet: false,
  },
  // 80001: {
  //   name: 'Mumbai',
  //   cmc_id: 3890,
  //   currencyName: 'Matic',
  //   currencySymbol: 'MATIC',
  //   logo: 'https://assets.coingecko.com/coins/images/4713/standard/matic-token-icon.png?1696505277',
  //   blockExplorer: 'https://mumbai.polygonscan.com/',
  //   rpcUrl: '',
  //   chainId: 80001
  // },
  80002: {
    name: 'Polygon Amoy',
    cmc_id: 3890,
    currencyName: 'Matic',
    currencySymbol: 'MATIC',
    logo: 'https://assets.coingecko.com/coins/images/4713/standard/matic-token-icon.png?1696505277',
    blockExplorer: 'https://www.oklink.com/amoy/',
    rpcUrl: '',
    chainId: 80002,
    isTestnet: true,
  },
  10: {
    name: 'Optimism',
    currencyName: 'Ether',
    currencySymbol: 'ETH',
    logo: 'https://assets.coingecko.com/coins/images/25244/standard/Optimism.png?1696524385',
    blockExplorer: 'https://optimistic.etherscan.io/',
    rpcUrl: '',
    chainId: 10,
    cmc_id: 1027,
    threshold: parseUnits('0.1', 18), // 0.1 ETH
    isTestnet: false,
  },
  420: {
    name: 'Optimism Goerli',
    currencyName: 'Ether',
    currencySymbol: 'ETH',
    logo: 'https://assets.coingecko.com/coins/images/14570/small/optimism.png?1617145168',
    blockExplorer: 'https://optimism-goerli.blockscout.com/',
    rpcUrl: '',
    chainId: 420,
    isTestnet: true,
  },
  // TODO: We need to eventually support Aurora on the backend. More details...
  // Tenderly doesn't support Aurora. This means Silk doesn't support it for now.
  // This could cause issues if a dapp asks the user to switch to Aurora. In the current
  // codebase (Feb 4, 2024), Aurora's presence in this object means that Silk will connect
  // to Aurora. However, the user will be unable to submit any transactions on Aurora.
  1313161554: {
    name: 'Aurora',
    cmc_id: 1027,
    currencyName: 'Ether',
    currencySymbol: 'ETH',
    logo: '/assets/svg/AuroraLogo.svg', // TODO: Add Aurora logo
    blockExplorer: 'https://aurorascan.dev/',
    rpcUrl: '',
    chainId: 1313161554,
    isTestnet: false,
  },
  43114: {
    name: 'Avalanche',
    cmc_id: 5805,
    currencyName: 'AVAX',
    currencySymbol: 'AVAX',
    logo: '/assets/svg/Avalanche_AVAX_Black.svg',
    blockExplorer: 'https://subnets.avax.network/c-chain',
    rpcUrl: '',
    chainId: 43114,
    threshold: parseUnits('1', 18), // 1 AVAX
    isTestnet: false,
  },
  42161: {
    name: 'Arbitrum One',
    cmc_id: 1027,
    currencyName: 'Ether',
    currencySymbol: 'ETH',
    logo: '/assets/svg/Arbitrum.svg',
    blockExplorer: 'https://arbiscan.io/',
    rpcUrl: '',
    chainId: 42161,
    threshold: parseUnits('0.1', 18), // 0.1 ETH
    isTestnet: false,
  },
  // 421614: {
  //   name: 'Arbitrum Sepolia',
  //   cmc_id: 1027,
  //   currencyName: 'Ether',
  //   currencySymbol: 'ETH',
  //   logo: '/assets/svg/Arbitrum.svg',
  //   blockExplorer: 'https://sepolia-explorer.arbitrum.io',
  //   rpcUrl: '',
  //   chainId: 421614,
  // },
  250: {
    name: 'Fantom',
    cmc_id: 3513,
    currencyName: 'Fantom',
    currencySymbol: 'FTM',
    logo: '/assets/svg/Fantom_round.svg',
    blockExplorer: 'https://ftmscan.com/',
    rpcUrl: '',
    chainId: 250,
    isTestnet: false,
  },
  84532: {
    name: 'Base Sepolia',
    cmc_id: 1027,
    currencyName: 'Sepolia Ether',
    currencySymbol: 'ETH',
    logo: '/assets/svg/base.svg',
    blockExplorer: 'https://base-sepolia.blockscout.com/',
    rpcUrl: '',
    chainId: 84532,
    isTestnet: true,
  },
  8453: {
    name: 'Base',
    cmc_id: 1027,
    currencyName: 'Ether',
    currencySymbol: 'ETH',
    logo: '/assets/svg/base.svg',
    blockExplorer: 'https://basescan.org/',
    rpcUrl: '',
    chainId: 8453,
    isTestnet: false,
  },
  42220: {
    name: 'Celo',
    cmc_id: 5567,
    currencyName: 'Celo',
    currencySymbol: 'CELO',
    logo: '/assets/images/celo.png',
    blockExplorer: 'https://explorer.celo.org/',
    rpcUrl: '',
    chainId: 42220,
    isTestnet: false,
  },

  // TODO: Finish adding zkSync
  // 324: {
  //   name: 'zkSync',
  //   rpcUrl: 'https://damp-multi-borough.zksync-mainnet.quiknode.pro/4a22deb478560c6f9ce5e40332fdd0d366c59599/',
  // }
  // PGN is being sunsetted. https://x.com/pgn_eth/status/1747652971419283744?s=12&t=sGHAXri3Qd5-ZpaQuibT7A
  // Keeping this commented out for now in case we want to record a demo before it is sunsetted.
  // 424: {
  //   name: 'Public Goods Network',
  //   cmc_id: 1027, // the same as Ethereum
  //   currencyName: 'Ether',
  //   currencySymbol: 'pgnETH',
  //   // logo: 'https://docs.publicgoods.network/favicon.ico',
  //   logo: '/assets/svg/pgn-favicon.svg',
  //   blockExplorer: 'https://explorer.publicgoods.network/',
  //   rpcUrl: '',
  //   chainId: 424,
  // }
}
