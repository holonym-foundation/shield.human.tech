/**
 * Fuel swap quote utility.
 * On devnet: uses MockFuelSwap (1:1 rate, mint-based).
 * With Uniswap V4: real market-rate swap via UniswapFuelSwap contract.
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

/**
 * Build a real Uniswap V4 fuel quote.
 * Uses on-chain V4 Quoter output for slippage calculation.
 */
export function getUniswapFuelQuote(params: {
  uniswapFuelSwapAddress: `0x${string}`
  bridgeTokenAddress: `0x${string}`
  fuelAmount: bigint
  expectedOutput: bigint // from V4 Quoter (fetched separately)
  slippageBps: number // default 300 = 3%
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
