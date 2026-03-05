/**
 * Fuel pricing module — mirrors MockFuelSwap's decimal-aware math on the frontend.
 *
 * On devnet: 1:1 rate with mock prices.
 * With Uniswap V4: real on-chain quotes via V4 Quoter eth_call.
 */

import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem'
import { sepolia } from 'viem/chains'
import { V4QuoterAbi } from '@/constants/abis/V4QuoterAbi'
import {
  V4_QUOTER,
  WETH_ADDRESS,
  FEE_JUICE_ADDRESS,
  AZTEC_WETH_POOL_FEE,
  AZTEC_WETH_POOL_TICK_SPACING,
  FEE_POOL_FEE,
  FEE_POOL_TICK_SPACING,
  FEE_POOL_USES_NATIVE_ETH,
  NATIVE_ETH,
} from '@/config'

export const FEE_JUICE_DECIMALS = 18
export const MOCK_FUEL_SWAP_RATE = 10n ** 18n // 1e18 = "1 token buys 1 FJ"

// ─── Price Feeds (mock) ─────────────────────────────────────────────

/** TODO: Replace with CoinGecko API or on-chain oracle for mainnet. */
export function getTokenPriceUsd(_symbol: string): number {
  return 1.0 // devnet: all tokens are $1
}

/** TODO: Replace with DEX oracle for mainnet. */
export function getFeeJuicePriceUsd(): number {
  return 1.0 // devnet: 1 FJ = $1
}

// ─── Swap Output (mirrors contract math) ────────────────────────────

/**
 * Compute FeeJuice output from a raw token input amount.
 * Formula: (inputAmountRaw * 10^(18 - inputDecimals) * rate) / 1e18
 */
export function computeSwapOutput(
  inputAmountRaw: bigint,
  inputDecimals: number,
  swapRate: bigint = MOCK_FUEL_SWAP_RATE,
): bigint {
  const normalized = inputAmountRaw * 10n ** BigInt(18 - inputDecimals)
  return (normalized * swapRate) / 10n ** 18n
}

// ─── Convenience Helpers ────────────────────────────────────────────

/**
 * Compute FeeJuice output from a human-readable token amount string.
 * e.g. computeFuelOutput("5", 6, "USDC") → 5e18n
 */
export function computeFuelOutput(
  humanAmount: string,
  inputDecimals: number,
  _tokenSymbol: string,
): bigint {
  const raw = BigInt(Math.floor(Number(humanAmount) * 10 ** inputDecimals))
  return computeSwapOutput(raw, inputDecimals)
}

/** Format raw FJ (18-dec bigint) to a human-readable string, e.g. "5.00" */
export function formatFjAmount(rawFj: bigint, precision = 2): string {
  const whole = rawFj / 10n ** 18n
  const frac = rawFj % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Format raw FJ for display with USD equivalent, e.g. "5.00 FJ (~$5.00)" */
export function formatFuelDisplay(rawFj: bigint): string {
  const fjStr = formatFjAmount(rawFj)
  const usdValue = (Number(rawFj) / 1e18) * getFeeJuicePriceUsd()
  return `${fjStr} FJ (~$${usdValue.toFixed(2)})`
}

/**
 * Convert a USD amount to the equivalent token amount (human-readable string).
 * e.g. usdToTokenAmount(5, "USDC") → "5" (at $1/USDC)
 *      usdToTokenAmount(5, "ETH")  → "0.002" (at $2500/ETH)
 */
export function usdToTokenAmount(usdAmount: number, tokenSymbol: string): string {
  const pricePerToken = getTokenPriceUsd(tokenSymbol)
  if (pricePerToken <= 0) return '0'
  const tokenAmount = usdAmount / pricePerToken
  // Use enough precision to avoid rounding to 0 for expensive tokens
  if (tokenAmount >= 1) return tokenAmount.toFixed(2)
  if (tokenAmount >= 0.01) return tokenAmount.toFixed(4)
  return tokenAmount.toFixed(6)
}

// ─── Uniswap V4 Types & Route Building ──────────────────────────────

export interface PoolKeyParam {
  currency0: `0x${string}`
  currency1: `0x${string}`
  fee: number
  tickSpacing: number
  hooks: `0x${string}`
}

/**
 * Build a PoolKey with currencies sorted numerically (V4 requirement).
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
    hooks: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  }
}

/**
 * Determine swap direction: zeroForOne = true when selling currency0.
 */
function isZeroForOne(selling: string, buying: string): boolean {
  return BigInt(selling) < BigInt(buying)
}

/**
 * Build the V4 swap route for a given input token → FeeJuice.
 * Single-hop if inputToken is WETH, otherwise multi-hop via WETH.
 *
 * When FEE_POOL_USES_NATIVE_ETH is true (mainnet), the FeeJuice pool is keyed
 * to native ETH (address(0)) instead of WETH. The contract handles WETH→ETH
 * unwrapping internally.
 */
export function buildSwapRoute(inputToken: `0x${string}`): {
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
} {
  const weth = WETH_ADDRESS
  const aztec = FEE_JUICE_ADDRESS
  const feePoolBase = FEE_POOL_USES_NATIVE_ETH ? NATIVE_ETH : weth

  if (inputToken.toLowerCase() === weth.toLowerCase()) {
    // Single hop: WETH → FEE (via ETH/FEE or WETH/FEE pool)
    return {
      poolKeys: [buildPoolKey(feePoolBase, aztec, FEE_POOL_FEE, FEE_POOL_TICK_SPACING)],
      zeroForOnes: [isZeroForOne(feePoolBase, aztec)],
    }
  }

  // Multi-hop: Token → WETH → FEE
  return {
    poolKeys: [
      buildPoolKey(inputToken, weth, AZTEC_WETH_POOL_FEE, AZTEC_WETH_POOL_TICK_SPACING),
      buildPoolKey(feePoolBase, aztec, FEE_POOL_FEE, FEE_POOL_TICK_SPACING),
    ],
    zeroForOnes: [isZeroForOne(inputToken, weth), isZeroForOne(feePoolBase, aztec)],
  }
}

// ─── V4 Quoter On-Chain Quote ───────────────────────────────────────

/**
 * Call V4 Quoter's quoteExactInputSingle via eth_call for a single pool hop.
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
 * Get a real swap quote from V4 Quoter via eth_call (simulation, no gas cost).
 * Returns expected output in FeeJuice (18 decimals).
 */
export async function getV4Quote(params: {
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
  inputAmount: bigint
  l1RpcUrl: string
}): Promise<bigint> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(params.l1RpcUrl),
  })

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
