/**
 * Fuel swap quote utility.
 *
 * Builds a FuelQuote from a pre-computed expected output (e.g. from V4 Quoter).
 * The quote carries pool routing info (poolKeys, zeroForOnes) that the
 * SwapBridgeRouter contract needs to execute the multi-hop swap on-chain.
 */

import type { FuelQuote, PoolKeyParam } from './types'

export const FEE_JUICE_DECIMALS = 18

/**
 * Build a fuel quote for Uniswap V4-based fuel swaps.
 *
 * The caller is responsible for obtaining `expectedOutput` (e.g. via V4 Quoter
 * eth_call). This function applies slippage and packages the routing data.
 */
export function getUniswapFuelQuote(params: {
  expectedOutput: bigint
  slippageBps?: number
  poolKeys?: PoolKeyParam[]
  zeroForOnes?: boolean[]
}): FuelQuote {
  const { expectedOutput, slippageBps = 50, poolKeys, zeroForOnes } = params

  const minOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10000n

  return {
    expectedOutput,
    minOutput,
    poolKeys,
    zeroForOnes,
  }
}
