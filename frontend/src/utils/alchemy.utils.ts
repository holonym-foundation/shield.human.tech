
// Chain ID to Alchemy network mapping
const CHAIN_TO_NETWORK = {
  // ethereum
  1: 'eth-mainnet',
  11155111: 'eth-sepolia',
  // optimism
  10: 'opt-mainnet',
  11155420: 'opt-sepolia',
  // polygon
  137: 'matic-mainnet',
  // 80002: 'polygon-amoy', // not supported by alchemy yet
  // base
  8453: 'base-mainnet',
  84532: 'base-sepolia',
  // arbitrum
  42161: 'arb-mainnet',
  421614: 'arb-sepolia',
  // gnosis
  100: 'gnosis-mainnet',
  // avalanche
  43114: 'avax-mainnet',
  43113: 'avax-fuji',
  // celo
  42220: 'celo-mainnet',
  // 44787: 'celo-alfajores' // not supported by alchemy yet
} as const

export type ChainId = keyof typeof CHAIN_TO_NETWORK
export type NetworkName = typeof CHAIN_TO_NETWORK[ChainId]

// Helper function to convert any chain ID format to number
export const toChainId = (chainId: string | number): number => {
  if (typeof chainId === 'number') return chainId

  if (typeof chainId === 'string') {
    if (chainId.startsWith('0x')) {
      return parseInt(chainId, 16)
    }

    return parseInt(chainId, 10)
  }

  throw new Error('Invalid chain ID format')
}

// Helper function to get supported networks from chain IDs
export const getSupportedNetworks = (chains: (string | number)[]): string[] => {
  return chains
    .map((chainId) => {
      try {
        const numericChainId = toChainId(chainId)

        return CHAIN_TO_NETWORK[numericChainId as ChainId]
      } catch (error) {
        throw new Error(`Invalid chain ID: ${chainId}`)

      }
    })
    .filter(Boolean) as string[]
}

// The API key is a path segment of every Alchemy URL, so an AxiosError — which
// carries `config.url` — leaks it to whatever consumes the logs. Never log or
// return one directly; summarise it through here instead.
export const describeAlchemyError = (error: unknown, apiKey: string): string => {
  const status = (error as { response?: { status?: number } })?.response?.status
  const code = (error as { code?: string })?.code
  const message = error instanceof Error ? error.message : String(error)

  return [
    status ? `status=${status}` : null,
    code ? `code=${code}` : null,
    apiKey ? message.split(apiKey).join('***') : message,
  ]
    .filter(Boolean)
    .join(' ')
}

// Helper function to get chain ID from network name
export const getChainIdFromNetwork = (network: string): number | undefined => {
  const chainId = Object.entries(CHAIN_TO_NETWORK).find(
    ([_, networkName]) => networkName === network
  )?.[0]

  return chainId ? Number(chainId) : undefined
}
