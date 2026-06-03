/**
 * Fuel pricing module.
 *
 * Real on-chain quotes via Uniswap V4 Quoter.
 * USD price feeds via CoinGecko (with Sepolia fallback).
 */

import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem'
import { sepolia } from 'viem/chains'
import { V4QuoterAbi } from '@/constants/abis/V4QuoterAbi'
import {
  V4_QUOTER,
  WETH_ADDRESS,
  FEE_JUICE_ADDRESS,
  NATIVE_ETH,
  INTERMEDIATE_POOL_FEE,
  INTERMEDIATE_POOL_TICK_SPACING,
  FEE_POOL_FEE,
  FEE_POOL_TICK_SPACING,
  FEE_POOL_USES_NATIVE_ETH,
  DIRECT_POOL_FEE,
  DIRECT_POOL_TICK_SPACING,
} from '@/config'

export const FEE_JUICE_DECIMALS = 18

// ─── Price Feeds ─────────────────────────────────────────────────────

/**
 * Get the USD price of a token by symbol.
 * When `prices` is provided (from CoinGecko), uses live data.
 * Falls back to hardcoded Sepolia prices if no live prices available.
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

// ─── Convenience Helpers ────────────────────────────────────────────

/** Format raw FJ (18-dec bigint) to a human-readable string, e.g. "5.00" */
export function formatFjAmount(rawFj: bigint, precision = 2): string {
  const whole = rawFj / 10n ** 18n
  const frac = rawFj % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Format raw FJ for display with USD equivalent, e.g. "5.00 FJ (~$0.10)" */
export function formatFuelDisplay(rawFj: bigint): string {
  const fjStr = formatFjAmount(rawFj)
  const usdValue = (Number(rawFj) / 1e18) * getFeeJuicePriceUsd()
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

/**
 * Compute the L1 TokenPortal fee for a bridge, in token base units.
 *
 * Mirrors TokenPortal.calculateFee on-chain: `fee = base * feeBps / 10000`
 * (integer division). Fuel is carved out of the deposit before the portal
 * charges its fee, so the fee base is `amount - fuelAmount` when fuel is on.
 */
export function computePortalFee(params: {
  amount: bigint
  fuelAmount: bigint
  fuelEnabled: boolean
  feeBps: bigint
}): { baseRaw: bigint; feeRaw: bigint; receiveRaw: bigint } {
  const { amount, fuelAmount, fuelEnabled, feeBps } = params
  const fuel = fuelEnabled ? fuelAmount : 0n
  const baseRaw = amount > fuel ? amount - fuel : 0n
  const feeRaw = (baseRaw * feeBps) / 10000n
  return { baseRaw, feeRaw, receiveRaw: baseRaw - feeRaw }
}

// ═════════════════════════════════════════════════════════════════════
// Uniswap V4 Types & Route Building
// ═════════════════════════════════════════════════════════════════════

export interface PoolKeyParam {
  currency0: `0x${string}`
  currency1: `0x${string}`
  fee: number
  tickSpacing: number
  hooks: `0x${string}`
}

const ZERO_HOOKS = '0x0000000000000000000000000000000000000000' as `0x${string}`

/**
 * Build a PoolKey with currencies sorted numerically (V4 requirement: currency0 < currency1).
 */
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

/**
 * Determine swap direction: zeroForOne = true when selling currency0.
 */
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
 * Returns multiple candidates that are quoted in parallel by getBestRoute().
 * Routes that hit non-existent pools revert during quoting and are skipped.
 */
export function buildSwapCandidates(inputToken: `0x${string}`): CandidateRoute[] {
  const weth = WETH_ADDRESS
  const aztec = FEE_JUICE_ADDRESS
  const feePoolBase = FEE_POOL_USES_NATIVE_ETH ? NATIVE_ETH : weth
  const candidates: CandidateRoute[] = []

  if (inputToken.toLowerCase() === weth.toLowerCase()) {
    // WETH only has one route: WETH → FeeJuice
    candidates.push({
      label: 'direct-weth',
      poolKeys: [buildPoolKey(feePoolBase, aztec, FEE_POOL_FEE, FEE_POOL_TICK_SPACING)],
      zeroForOnes: [isZeroForOne(feePoolBase, aztec)],
    })
    return candidates
  }

  // Route A: Direct (inputToken → FeeJuice) — pool may not exist
  candidates.push({
    label: 'direct',
    poolKeys: [buildPoolKey(inputToken, aztec, DIRECT_POOL_FEE, DIRECT_POOL_TICK_SPACING)],
    zeroForOnes: [isZeroForOne(inputToken, aztec)],
  })

  // Route B: Via ETH (inputToken → ETH → FeeJuice) — multi-hop.
  // Mainnet V4 pairs the input token with NATIVE ETH (address(0)), not wrapped WETH,
  // so the intermediate hop must use native ETH. Quote the common fee tiers; getBestRoute
  // discards candidates whose pool doesn't exist and keeps the highest-output survivor.
  const intermediateTiers = [
    { fee: 500, tickSpacing: 10 },
    { fee: INTERMEDIATE_POOL_FEE, tickSpacing: INTERMEDIATE_POOL_TICK_SPACING },
  ]
  for (const tier of intermediateTiers) {
    candidates.push({
      label: `via-eth-${tier.fee}`,
      poolKeys: [
        buildPoolKey(inputToken, NATIVE_ETH, tier.fee, tier.tickSpacing),
        buildPoolKey(feePoolBase, aztec, FEE_POOL_FEE, FEE_POOL_TICK_SPACING),
      ],
      zeroForOnes: [isZeroForOne(inputToken, NATIVE_ETH), isZeroForOne(feePoolBase, aztec)],
    })
  }

  return candidates
}

/**
 * Legacy single-route builder. Returns the best route's poolKeys/zeroForOnes.
 * Kept for backward compatibility with callers that don't use getBestRoute().
 */
export function buildSwapRoute(inputToken: `0x${string}`): {
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
} {
  // Prefer direct route when available; callers that need smart routing
  // should use buildSwapCandidates() + getBestRoute() instead.
  const candidates = buildSwapCandidates(inputToken)
  return candidates[0]
}

// ═════════════════════════════════════════════════════════════════════
// V4 Quoter — On-Chain Quote via eth_call
// ═════════════════════════════════════════════════════════════════════

/**
 * Call V4 Quoter's quoteExactInputSingle via eth_call for a single pool hop.
 * This is a simulation — no gas is consumed.
 */
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

  const { data } = await client.call({
    to: V4_QUOTER as `0x${string}`,
    data: callData,
  })

  if (!data) throw new Error('V4 Quoter returned empty data')

  const decoded = decodeFunctionResult({
    abi: V4QuoterAbi,
    functionName: 'quoteExactInputSingle',
    data,
  })
  // Returns [amountOut, gasEstimate]
  return (decoded as readonly [bigint, bigint])[0]
}

/**
 * Get a real swap quote from V4 Quoter via eth_call (no gas cost).
 * Chains single-hop quotes for multi-hop routes.
 *
 * @returns Expected output in FeeJuice (18 decimals).
 */
let _quoteClient: ReturnType<typeof createPublicClient> | null = null
let _quoteClientUrl: string | null = null
function getQuoteClient(l1RpcUrl: string) {
  if (!_quoteClient || _quoteClientUrl !== l1RpcUrl) {
    _quoteClient = createPublicClient({ chain: sepolia, transport: http(l1RpcUrl) })
    _quoteClientUrl = l1RpcUrl
  }
  return _quoteClient
}

export async function getV4Quote(params: {
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
  inputAmount: bigint
  l1RpcUrl: string
}): Promise<bigint> {
  const client = getQuoteClient(params.l1RpcUrl)

  let currentAmount = params.inputAmount
  for (let i = 0; i < params.poolKeys.length; i++) {
    currentAmount = await quoteExactInputSingleCall(client, params.poolKeys[i], params.zeroForOnes[i], currentAmount)
  }
  return currentAmount
}

/**
 * Quote all candidate routes in parallel, return the best one.
 * Non-existent pools revert during quoting and are silently skipped.
 */
export async function getBestRoute(params: {
  candidates: CandidateRoute[]
  inputAmount: bigint
  l1RpcUrl: string
}): Promise<RouteResult> {
  const { candidates, inputAmount, l1RpcUrl } = params

  const results = await Promise.allSettled(
    candidates.map(async (route) => {
      const output = await getV4Quote({
        poolKeys: route.poolKeys,
        zeroForOnes: route.zeroForOnes,
        inputAmount,
        l1RpcUrl,
      })
      return { route, expectedOutput: output }
    }),
  )

  const fulfilled: RouteResult[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled' && r.value.expectedOutput > 0n) {
      fulfilled.push(r.value)
    }
  }

  if (fulfilled.length === 0) {
    throw new Error('All swap routes failed — no pool has liquidity for this token pair')
  }

  // Pick the route with the highest output
  fulfilled.sort((a, b) => (b.expectedOutput > a.expectedOutput ? 1 : -1))
  return fulfilled[0]
}
