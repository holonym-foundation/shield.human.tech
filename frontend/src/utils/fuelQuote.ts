/**
 * Fuel swap quote utility.
 * On devnet: uses MockFuelSwap (1:1 rate, mint-based).
 * On mainnet: would call a DEX API.
 */

import { encodeFunctionData } from 'viem'
import { MockFuelSwapAbi } from '@/constants/abis/BridgeAndFuelAbi'
import { computeSwapOutput, MOCK_FUEL_SWAP_RATE } from './fuelPricing'

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
