/**
 * CoinGecko price feed utility.
 *
 * Fetches live USD prices for bridge tokens from CoinGecko's free API.
 * Cached in-memory for 60s to stay within rate limits (10-30 calls/min).
 */

import { useQuery } from '@tanstack/react-query'

// CoinGecko ID mapping for our bridge tokens
const TOKEN_TO_COINGECKO_ID: Record<string, string> = {
  WETH: 'ethereum',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  WBTC: 'wrapped-bitcoin',
  AZTEC: 'aztec-protocol',
  FEE_JUICE: 'aztec-protocol',
}

const COINGECKO_API_URL = 'https://api.coingecko.com/api/v3/simple/price'
const CACHE_TTL_MS = 60_000

let cachedPrices: Record<string, number> | null = null
let cacheTimestamp = 0

/**
 * Fetch token prices in USD from CoinGecko.
 * Results are cached in-memory for 60s.
 */
export async function fetchTokenPricesUsd(): Promise<Record<string, number>> {
  const now = Date.now()
  if (cachedPrices && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedPrices
  }

  const ids = [...new Set(Object.values(TOKEN_TO_COINGECKO_ID))].join(',')
  const url = `${COINGECKO_API_URL}?ids=${ids}&vs_currencies=usd`

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  // Map CoinGecko response back to our token symbols
  const prices: Record<string, number> = {}
  for (const [symbol, cgId] of Object.entries(TOKEN_TO_COINGECKO_ID)) {
    const price = data[cgId]?.usd
    if (price != null) {
      prices[symbol] = price
    }
  }

  cachedPrices = prices
  cacheTimestamp = now
  return prices
}

/**
 * React hook that fetches live token prices via CoinGecko.
 * Uses react-query with 60s staleTime. No silent fallback — errors surface to caller.
 */
export function useTokenPrices() {
  const { data: prices, isLoading, error } = useQuery({
    queryKey: ['tokenPricesUsd'],
    queryFn: fetchTokenPricesUsd,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  return { prices: prices ?? null, isLoading, error }
}
