/**
 * ABI for UniswapFuelSwap contract — swap via Uniswap V4 PoolManager.
 */
export const UniswapFuelSwapAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: '_poolManager', type: 'address' },
      { name: '_feeJuice', type: 'address' },
      { name: '_weth', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'swap',
    inputs: [
      { name: 'inputToken', type: 'address' },
      { name: 'inputAmount', type: 'uint256' },
      { name: 'minOutput', type: 'uint256' },
      {
        name: 'path',
        type: 'tuple[]',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      { name: 'zeroForOnes', type: 'bool[]' },
    ],
    outputs: [{ name: 'output', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const
