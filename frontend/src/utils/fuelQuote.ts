/**
 * Fuel swap quote utility.
 *
 * - Mock mode (devnet): uses MockFuelSwap (1:1 rate, mint-based).
 * - V4 mode: real on-chain Uniswap V4 swap via UniswapFuelSwap contract.
 *
 * Both return a FuelQuote with swapTarget, swapData, and expected output —
 * compatible with BridgeAndFuel's generic `.call(swapData)` pattern.
 */

import { encodeFunctionData } from 'viem'
import { MockFuelSwapAbi } from '@/constants/abis/BridgeAndFuelAbi'
import { UniswapFuelSwapAbi } from '@/constants/abis/UniswapFuelSwapAbi'
import { computeSwapOutput, MOCK_FUEL_SWAP_RATE, type PoolKeyParam } from './fuelPricing'

export interface FuelQuote {
  swapTarget: `0x${string}`
  swapAllowanceTarget: `0x${string}`
  swapData: `0x${string}`
  expectedOutput: bigint
  minOutput: bigint
}

// ─── Mock Quote (devnet) ────────────────────────────────────────────

/**
 * Build a mock fuel quote for devnet.
 * MockFuelSwap mints FeeJuice at 1:1 rate.
 */
export function getMockFuelQuote(params: {
  mockFuelSwapAddress: `0x${string}`
  bridgeTokenAddress: `0x${string}`
  fuelAmount: bigint
  inputDecimals: number
  slippageBps?: number // basis points, default 0 for devnet mock
}): FuelQuote {
  const { mockFuelSwapAddress, bridgeTokenAddress, fuelAmount, inputDecimals, slippageBps = 0 } = params

  // Compute expected FJ output (18-dec) from token input amount using contract math
  const expectedOutput = computeSwapOutput(fuelAmount, inputDecimals, MOCK_FUEL_SWAP_RATE)
  const minOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10000n

  const swapData = encodeFunctionData({
    abi: MockFuelSwapAbi,
    functionName: 'swap',
    args: [bridgeTokenAddress, fuelAmount, minOutput],
  })

  return {
    swapTarget: mockFuelSwapAddress,
    swapAllowanceTarget: mockFuelSwapAddress,
    swapData: swapData as `0x${string}`,
    expectedOutput,
    minOutput,
  }
}

// ─── Uniswap V4 Quote (production) ─────────────────────────────────

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
  }
}
