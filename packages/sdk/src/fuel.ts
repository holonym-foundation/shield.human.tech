/**
 * Fuel swap quote utility.
 * On devnet: uses MockFuelSwap (1:1 rate, mint-based).
 * On mainnet: would call a DEX API.
 */

import { encodeFunctionData } from 'viem'
import { MockFuelSwapAbi } from './contracts/abis/BridgeAndFuelAbi'
import type { FuelQuote } from './types'

export const FEE_JUICE_DECIMALS = 18
export const MOCK_FUEL_SWAP_RATE = 10n ** 18n

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

/**
 * Build a mock fuel quote for devnet.
 * MockFuelSwap mints FeeJuice at 1:1 rate.
 */
export function getMockFuelQuote(params: {
  mockFuelSwapAddress: string
  bridgeTokenAddress: string
  fuelAmount: bigint
  inputDecimals: number
  slippageBps?: number
}): FuelQuote {
  const { mockFuelSwapAddress, bridgeTokenAddress, fuelAmount, inputDecimals, slippageBps = 0 } = params

  const expectedOutput = computeSwapOutput(fuelAmount, inputDecimals, MOCK_FUEL_SWAP_RATE)
  const minOutput = expectedOutput - (expectedOutput * BigInt(slippageBps)) / 10000n

  const swapData = encodeFunctionData({
    abi: MockFuelSwapAbi,
    functionName: 'swap',
    args: [bridgeTokenAddress as `0x${string}`, fuelAmount, minOutput],
  })

  return {
    swapTarget: mockFuelSwapAddress,
    swapAllowanceTarget: mockFuelSwapAddress,
    swapData,
    expectedOutput,
    minOutput,
  }
}
