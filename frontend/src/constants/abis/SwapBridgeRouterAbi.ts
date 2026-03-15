/**
 * ABI for SwapBridgeRouter — Permit2-enabled bridge + fuel swap contract.
 * Covers: bridge(), bridgeWithFuel(), Bridge event, BridgeWithFuel event.
 */

const CleanHandsTuple = {
  name: 'cleanHands',
  type: 'tuple',
  components: [
    { name: 'nonce', type: 'uint256' },
    { name: 'actionId', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const

const PassportTuple = {
  name: 'passport',
  type: 'tuple',
  components: [
    { name: 'maxAmount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const

const PermitTuple = {
  name: 'permit',
  type: 'tuple',
  components: [
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'signature', type: 'bytes' },
  ],
} as const

export const SwapBridgeRouterAbi = [
  {
    type: 'function',
    name: 'bridge',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'tokenPortal', type: 'address' },
          { name: 'bridgeToken', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'aztecRecipient', type: 'bytes32' },
          { name: 'secretHash', type: 'bytes32' },
          { name: 'isPrivate', type: 'bool' },
          CleanHandsTuple,
          PassportTuple,
        ],
      },
      PermitTuple,
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
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
          { name: 'tokenSecretHash', type: 'bytes32' },
          { name: 'fuelSecretHash', type: 'bytes32' },
          { name: 'minFuelOutput', type: 'uint256' },
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
          { name: 'isPrivate', type: 'bool' },
          CleanHandsTuple,
          PassportTuple,
        ],
      },
      PermitTuple,
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'Bridge',
    inputs: [
      { name: 'aztecRecipient', type: 'bytes32', indexed: true },
      { name: 'key', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'secretHash', type: 'bytes32', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'BridgeWithFuel',
    inputs: [
      { name: 'aztecRecipient', type: 'bytes32', indexed: true },
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
