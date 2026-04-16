export interface TokenConfig {
  symbol: string
  decimals: number
  l1Name: string
  l1Symbol: string
  l2Name: string
  l2Symbol: string
  logo: string
  /** Pre-existing L1 token address. If set, skip TestERC20 deployment. */
  l1TokenAddress?: string
  /** Set to true to force redeploy even if already deployed */
  forceDeploy?: boolean
}

export const TOKEN_CONFIGS: TokenConfig[] = [
  {
    symbol: 'USDC',
    decimals: 6,
    l1Name: 'USDC',
    l1Symbol: 'USDC',
    l2Name: 'Clean USDC',
    l2Symbol: 'cUSDC',
    logo: '/assets/tokens/usdc-xl.svg',
    // forceDeploy: false
  },
  // {
  //   symbol: 'USDT',
  //   decimals: 6,
  //   l1Name: 'USDT',
  //   l1Symbol: 'USDT',
  //   l2Name: 'Clean USDT',
  //   l2Symbol: 'cUSDT',
  //   logo: '/assets/tokens/usdt-xl.svg',
  // },
  // {
  //   symbol: 'DAI',
  //   decimals: 6,
  //   l1Name: 'DAI',
  //   l1Symbol: 'DAI',
  //   l2Name: 'Clean DAI',
  //   l2Symbol: 'cDAI',
  //   logo: '/assets/tokens/dai-xl.svg',
  // },
  // {
  //   symbol: 'HUMN',
  //   decimals: 6,
  //   l1Name: 'HUMN',
  //   l1Symbol: 'HUMN',
  //   l2Name: 'Clean HUMN',
  //   l2Symbol: 'cHUMN',
  //   logo: '/assets/tokens/humn.jpg',
  // },
  // {
  //   symbol: 'GOAT',
  //   decimals: 6,
  //   l1Name: 'GOAT',
  //   l1Symbol: 'GOAT',
  //   l2Name: 'Clean GOAT',
  //   l2Symbol: 'cGOAT',
  //   logo: '/assets/tokens/goat.png',
  // },
  // {
  //   symbol: 'WBTC',
  //   decimals: 6,
  //   l1Name: 'WBTC',
  //   l1Symbol: 'WBTC',
  //   l2Name: 'Clean WBTC',
  //   l2Symbol: 'cWBTC',
  //   logo: '/assets/tokens/wbtc.png',
  // },
  // {
  //   symbol: 'WETH',
  //   decimals: 18,
  //   l1Name: 'Wrapped Ether',
  //   l1Symbol: 'WETH',
  //   l2Name: 'Clean WETH',
  //   l2Symbol: 'cWETH',
  //   logo: '/assets/tokens/weth-xl.svg',
  //   l1TokenAddress: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  // },
]

export interface Token {
  symbol: string
  decimals: number
  logo: string
  networks: {
    [chainId: number]: {
      chainName: string
      name: string
      tokenContract: string
      bridgeContract: string
      extraContracts: {
        feeAssetHandler?: string
        sponsoredFee?: string
      }
    }
  }
}

export const TOKENS: Token[] = [
  // This will be populated by the deployment script
]
