/**
 * Fuel pricing module.
 *
 * Real on-chain swap quotes via Uniswap V4 Quoter (eth_call, no gas cost).
 * USD price feeds from a caller-supplied map with a hardcoded testnet fallback.
 *
 * Ported from main's frontend/src/utils/fuelPricing.ts so the SDK can produce
 * fuel quotes without the frontend having to re-implement V4 route discovery.
 */

import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem'
import type { Chain } from 'viem'
import { V4QuoterAbi } from './contracts/abis/V4QuoterAbi'
import {
  V4_QUOTER,
  WETH_ADDRESS,
  NATIVE_ETH,
  INTERMEDIATE_POOL_FEE,
  INTERMEDIATE_POOL_TICK_SPACING,
  FEE_POOL_FEE,
  FEE_POOL_TICK_SPACING,
  FEE_POOL_USES_NATIVE_ETH,
  DIRECT_POOL_FEE,
  DIRECT_POOL_TICK_SPACING,
} from './config'
import type { PoolKeyParam } from './types'

export const FEE_JUICE_DECIMALS = 18

// ─── Price Feeds ─────────────────────────────────────────────────────

/**
 * Get the USD price of a token by symbol.
 * When `prices` is provided (e.g. from CoinGecko), uses live data.
 * Falls back to hardcoded testnet prices if no live prices available.
 */
export function getTokenPriceUsd(symbol: string, prices?: Record<string, number> | null): number {
  if (prices) {
    const price = prices[symbol.toUpperCase()]
    if (price != null) return price
  }
  // Fallback for Sepolia testnet (tokens have no real market price)
  const SEPOLIA_FALLBACK: Record<string, number> = {
    WETH: 2100,
    USDC: 1,
    USDT: 1,
    DAI: 1,
    WBTC: 60000,
    AZTEC: 0.02,
    FEE_JUICE: 0.02,
  }
  return SEPOLIA_FALLBACK[symbol.toUpperCase()] ?? 1.0
}

/** Get the USD price of one FeeJuice token. */
export function getFeeJuicePriceUsd(prices?: Record<string, number> | null): number {
  return getTokenPriceUsd('AZTEC', prices)
}

/** Format raw FJ (18-dec bigint) to a human-readable string, e.g. "5.00" */
export function formatFjAmount(rawFj: bigint, precision = 2): string {
  const whole = rawFj / 10n ** 18n
  const frac = rawFj % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Format raw FJ for display with USD equivalent, e.g. "5.00 FJ (~$0.10)" */
export function formatFuelDisplay(rawFj: bigint, prices?: Record<string, number> | null): string {
  const fjStr = formatFjAmount(rawFj)
  const usdValue = (Number(rawFj) / 1e18) * getFeeJuicePriceUsd(prices)
  return `${fjStr} FJ (~$${usdValue.toFixed(2)})`
}

/**
 * Convert a USD amount to the equivalent token amount (human-readable string).
 * e.g. usdToTokenAmount(5, "USDC") → "5" (at $1/USDC)
 *      usdToTokenAmount(5, "WETH") → "0.0024" (at $2100/WETH)
 */
export function usdToTokenAmount(
  usdAmount: number,
  tokenSymbol: string,
  prices?: Record<string, number> | null,
): string {
  const pricePerToken = getTokenPriceUsd(tokenSymbol, prices)
  if (pricePerToken <= 0) return '0'
  const tokenAmount = usdAmount / pricePerToken
  if (tokenAmount >= 1) return tokenAmount.toFixed(2)
  if (tokenAmount >= 0.01) return tokenAmount.toFixed(4)
  return tokenAmount.toFixed(6)
}

// ═════════════════════════════════════════════════════════════════════
// V4 Route Building
// ═════════════════════════════════════════════════════════════════════

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000' as `0x${string}`

/** Build a PoolKey with currencies sorted numerically (V4 requirement: currency0 < currency1). */
function buildPoolKey(tokenA: string, tokenB: string, fee: number, tickSpacing: number): PoolKeyParam {
  const a = BigInt(tokenA)
  const b = BigInt(tokenB)
  const [currency0, currency1] = a < b ? [tokenA, tokenB] : [tokenB, tokenA]
  return {
    currency0: currency0 as `0x${string}`,
    currency1: currency1 as `0x${string}`,
    fee,
    tickSpacing,
    hooks: ZERO_HOOKS,
  }
}

/** Determine swap direction: zeroForOne = true when selling currency0. */
function isZeroForOne(selling: string, buying: string): boolean {
  return BigInt(selling) < BigInt(buying)
}

export interface CandidateRoute {
  label: string
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
}

export interface RouteResult {
  route: CandidateRoute
  expectedOutput: bigint
}

/**
 * Build candidate V4 swap routes for a given input token → FeeJuice.
 *
 * Returns multiple candidates that should be quoted in parallel by getBestRoute().
 * Routes that hit non-existent pools revert during quoting and are skipped.
 */
export function buildSwapCandidates(
  inputToken: `0x${string}`,
  feeJuiceAddress: `0x${string}`,
): CandidateRoute[] {
  const weth = WETH_ADDRESS
  const feePoolBase = FEE_POOL_USES_NATIVE_ETH ? NATIVE_ETH : weth
  const candidates: CandidateRoute[] = []

  if (inputToken.toLowerCase() === weth.toLowerCase()) {
    candidates.push({
      label: 'direct-weth',
      poolKeys: [buildPoolKey(feePoolBase, feeJuiceAddress, FEE_POOL_FEE, FEE_POOL_TICK_SPACING)],
      zeroForOnes: [isZeroForOne(feePoolBase, feeJuiceAddress)],
    })
    return candidates
  }

  candidates.push({
    label: 'direct',
    poolKeys: [buildPoolKey(inputToken, feeJuiceAddress, DIRECT_POOL_FEE, DIRECT_POOL_TICK_SPACING)],
    zeroForOnes: [isZeroForOne(inputToken, feeJuiceAddress)],
  })

  candidates.push({
    label: 'via-weth',
    poolKeys: [
      buildPoolKey(inputToken, weth, INTERMEDIATE_POOL_FEE, INTERMEDIATE_POOL_TICK_SPACING),
      buildPoolKey(feePoolBase, feeJuiceAddress, FEE_POOL_FEE, FEE_POOL_TICK_SPACING),
    ],
    zeroForOnes: [isZeroForOne(inputToken, weth), isZeroForOne(feePoolBase, feeJuiceAddress)],
  })

  return candidates
}

/**
 * Legacy single-route builder. Returns the first candidate's routing data.
 * Callers that need smart routing should use buildSwapCandidates() + getBestRoute().
 */
export function buildSwapRoute(
  inputToken: `0x${string}`,
  feeJuiceAddress: `0x${string}`,
): { poolKeys: PoolKeyParam[]; zeroForOnes: boolean[] } {
  const candidates = buildSwapCandidates(inputToken, feeJuiceAddress)
  return { poolKeys: candidates[0].poolKeys, zeroForOnes: candidates[0].zeroForOnes }
}

// ═════════════════════════════════════════════════════════════════════
// V4 Quoter — On-Chain Quote via eth_call
// ═════════════════════════════════════════════════════════════════════

/** Cached public client keyed by L1 RPC URL. */
let _quoteClient: ReturnType<typeof createPublicClient> | null = null
let _quoteClientUrl: string | null = null
function getQuoteClient(l1RpcUrl: string, chain?: Chain): ReturnType<typeof createPublicClient> {
  if (!_quoteClient || _quoteClientUrl !== l1RpcUrl) {
    _quoteClient = createPublicClient({ chain, transport: http(l1RpcUrl) })
    _quoteClientUrl = l1RpcUrl
  }
  return _quoteClient
}

async function quoteExactInputSingleCall(
  client: ReturnType<typeof createPublicClient>,
  poolKey: PoolKeyParam,
  zeroForOne: boolean,
  exactAmount: bigint,
): Promise<bigint> {
  const callData = encodeFunctionData({
    abi: V4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey, zeroForOne, exactAmount, hookData: '0x' }] as const,
  })

  const { data } = await client.call({ to: V4_QUOTER as `0x${string}`, data: callData })
  if (!data) throw new Error('V4 Quoter returned empty data')

  const decoded = decodeFunctionResult({
    abi: V4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    data,
  })
  return (decoded as readonly [bigint, bigint])[0]
}

/** Get a real V4 swap quote via eth_call. Chains single-hop quotes for multi-hop routes. */
export async function getV4Quote(params: {
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
  inputAmount: bigint
  l1RpcUrl: string
  chain?: Chain
}): Promise<bigint> {
  const client = getQuoteClient(params.l1RpcUrl, params.chain)
  let currentAmount = params.inputAmount
  for (let i = 0; i < params.poolKeys.length; i++) {
    currentAmount = await quoteExactInputSingleCall(
      client,
      params.poolKeys[i],
      params.zeroForOnes[i],
      currentAmount,
    )
  }
  return currentAmount
}

/**
 * Quote all candidate routes in parallel, return the one with the highest output.
 * Non-existent pools revert during quoting and are silently skipped.
 */
export async function getBestRoute(params: {
  candidates: CandidateRoute[]
  inputAmount: bigint
  l1RpcUrl: string
  chain?: Chain
}): Promise<RouteResult> {
  const { candidates, inputAmount, l1RpcUrl, chain } = params

  const results = await Promise.allSettled(
    candidates.map(async (route) => {
      const output = await getV4Quote({
        poolKeys: route.poolKeys,
        zeroForOnes: route.zeroForOnes,
        inputAmount,
        l1RpcUrl,
        chain,
      })
      return { route, expectedOutput: output }
    }),
  )

  const fulfilled: RouteResult[] = []
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.expectedOutput > 0n) {
      fulfilled.push(r.value)
    }
  }

  if (fulfilled.length === 0) {
    throw new Error('All swap routes failed — no pool has liquidity for this token pair')
  }

  fulfilled.sort((a, b) => (b.expectedOutput > a.expectedOutput ? 1 : -1))
  return fulfilled[0]
}
