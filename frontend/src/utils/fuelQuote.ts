/**
 * Fuel swap quote utility.
 *
 * Builds a FuelQuote for real on-chain Uniswap V4 swaps via UniswapFuelSwap.
 * Includes only the typed route data consumed by SwapBridgeRouter.
 */
import { type PoolKeyParam } from './fuelPricing'

export interface FuelQuote {
  expectedOutput: bigint
  minOutput: bigint
  poolKeys?: PoolKeyParam[]
  zeroForOnes?: boolean[]
}

// ─── Uniswap V4 Quote ───────────────────────────────────────────────

/**
 * Build a real Uniswap V4 fuel quote.
 * Uses on-chain V4 Quoter output for slippage calculation.
 *
 * @param expectedOutput — from getV4Quote() (fetched separately via eth_call).
 * @param slippageBps    — slippage tolerance in basis points (default 300 = 3%).
 * @param poolKeys       — ordered PoolKey array from buildSwapRoute().
 * @param zeroForOnes    — swap direction per hop from buildSwapRoute().
 */
export function getUniswapFuelQuote(params: {
  expectedOutput: bigint
  slippageBps: number
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
}): FuelQuote {
  const {
    expectedOutput,
    slippageBps,
    poolKeys,
    zeroForOnes,
  } = params

  const minOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10000n

  return {
    expectedOutput,
    minOutput,
    poolKeys,
    zeroForOnes,
  }
}
