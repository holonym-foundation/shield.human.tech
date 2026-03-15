/**
 * Hand-crafted ABI for the BridgeAndFuel orchestrator contract.
 * Covers: bridgeWithFuel function, BridgeWithFuel event, MockFuelSwap.swap.
 */

export const BridgeAndFuelAbi = [
  {
    type: 'function',
    name: 'bridgeWithFuel',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'tokenPortal', type: 'address' },
          { name: 'bridgeToken', type: 'address' },
          { name: 'totalAmount', type: 'uint256' },
          { name: 'fuelAmount', type: 'uint256' },
          { name: 'aztecRecipient', type: 'bytes32' },
          { name: 'fuelRecipient', type: 'bytes32' },
          { name: 'tokenSecretHash', type: 'bytes32' },
          { name: 'fuelSecretHash', type: 'bytes32' },
          { name: 'feeJuicePortal', type: 'address' },
          { name: 'swapTarget', type: 'address' },
          { name: 'swapAllowanceTarget', type: 'address' },
          { name: 'minFuelOutput', type: 'uint256' },
        ],
      },
      { name: 'swapData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'BridgeWithFuel',
    inputs: [
      { name: 'aztecRecipient', type: 'bytes32', indexed: true },
      { name: 'fuelRecipient', type: 'bytes32', indexed: false },
      { name: 'tokenKey', type: 'bytes32', indexed: false },
      { name: 'tokenIndex', type: 'uint256', indexed: false },
      { name: 'tokenAmount', type: 'uint256', indexed: false },
      { name: 'tokenSecretHash', type: 'bytes32', indexed: false },
      { name: 'fuelKey', type: 'bytes32', indexed: false },
      { name: 'fuelIndex', type: 'uint256', indexed: false },
      { name: 'fuelAmount', type: 'uint256', indexed: false },
      { name: 'fuelSecretHash', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
] as const

