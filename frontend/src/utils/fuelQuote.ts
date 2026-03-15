/**
 * Fuel swap quote utility.
 *
 * Builds a FuelQuote for real on-chain Uniswap V4 swaps via UniswapFuelSwap.
 * Includes typed pool keys for SwapBridgeRouter's Permit2 path.
 */

import { encodeFunctionData } from 'viem'
import { UniswapFuelSwapAbi } from '@/constants/abis/UniswapFuelSwapAbi'
import { type PoolKeyParam } from './fuelPricing'

export interface FuelQuote {
  swapTarget: `0x${string}`
  swapAllowanceTarget: `0x${string}`
  swapData: `0x${string}`
  expectedOutput: bigint
  minOutput: bigint
  /** Typed pool keys for SwapBridgeRouter (replaces opaque swapData blob). */
  poolKeys?: PoolKeyParam[]
  /** Swap direction per hop for SwapBridgeRouter. */
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
  uniswapFuelSwapAddress: `0x${string}`
  bridgeTokenAddress: `0x${string}`
  fuelAmount: bigint
  expectedOutput: bigint
  slippageBps: number
  poolKeys: PoolKeyParam[]
  zeroForOnes: boolean[]
}): FuelQuote {
  const {
    uniswapFuelSwapAddress,
    bridgeTokenAddress,
    fuelAmount,
    expectedOutput,
    slippageBps,
    poolKeys,
    zeroForOnes,
  } = params

  const minOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10000n

  const swapData = encodeFunctionData({
    abi: UniswapFuelSwapAbi,
    functionName: 'swap',
    args: [bridgeTokenAddress, fuelAmount, minOutput, poolKeys, zeroForOnes],
  })

  return {
    swapTarget: uniswapFuelSwapAddress,
    swapAllowanceTarget: uniswapFuelSwapAddress,
    swapData: swapData as `0x${string}`,
    expectedOutput,
    minOutput,
    poolKeys,
    zeroForOnes,
  }
}
