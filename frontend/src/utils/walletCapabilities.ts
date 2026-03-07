import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { BRIDGED_FPC_ADDRESS, L1_TOKENS } from '@/config'
import type { ContractFunctionPattern } from '@aztec/aztec.js/wallet'

function pattern(
  contract: AztecAddress,
  fn: string,
): ContractFunctionPattern {
  return { contract, function: fn }
}

function patternsFor(
  contract: AztecAddress,
  fns: string[],
): ContractFunctionPattern[] {
  return fns.map((fn) => pattern(contract, fn))
}

const TOKEN_UTILITY_SIMULATION_METHODS = [
  'balance_of_private',
] as const

const TOKEN_TRANSACTION_SIMULATION_METHODS = [
  'balance_of_public',
] as const

const TOKEN_TRANSACTION_METHODS = [
  'transfer',
  'transfer_to_private',
  'burn_public',
  'burn_private',
] as const

const BRIDGE_TRANSACTION_METHODS = [
  'claim_public',
  'claim_private',
  'exit_to_l1_public',
  'exit_to_l1_private',
] as const

const BRIDGED_FPC_SIMULATION_METHODS = [
  'balance_of',
] as const

const BRIDGED_FPC_TRANSACTION_METHODS = [
  'mint',
  'mint_and_pay_fee',
  'pay_fee',
] as const

export function buildCapabilityManifest() {
  const tokenAddresses = L1_TOKENS
    .map((t) => t.l2TokenContract)
    .filter((addr): addr is string => !!addr)
    .map((addr) => AztecAddress.fromString(addr))

  const bridgeAddresses = L1_TOKENS
    .map((t) => t.l2BridgeContract)
    .filter((addr): addr is string => !!addr)
    .map((addr) => AztecAddress.fromString(addr))

  const fpcAddress = BRIDGED_FPC_ADDRESS
    ? AztecAddress.fromString(BRIDGED_FPC_ADDRESS)
    : null

  const allContracts = [
    ...tokenAddresses,
    ...bridgeAddresses,
    ...(fpcAddress ? [fpcAddress] : []),
  ]

  const simulationUtilities: ContractFunctionPattern[] = [
    ...tokenAddresses.flatMap(
      (addr) => patternsFor(addr, [...TOKEN_UTILITY_SIMULATION_METHODS]),
    ),
    ...(fpcAddress
      ? patternsFor(fpcAddress, [...BRIDGED_FPC_SIMULATION_METHODS])
      : []),
  ]
  const simulationTransactions: ContractFunctionPattern[] = tokenAddresses.flatMap(
    (addr) => patternsFor(addr, [...TOKEN_TRANSACTION_SIMULATION_METHODS]),
  )

  const transactionScope: ContractFunctionPattern[] = [
    ...tokenAddresses.flatMap((addr) =>
      patternsFor(addr, [...TOKEN_TRANSACTION_METHODS]),
    ),
    ...bridgeAddresses.flatMap((addr) =>
      patternsFor(addr, [...BRIDGE_TRANSACTION_METHODS]),
    ),
    ...(fpcAddress
      ? patternsFor(fpcAddress, [...BRIDGED_FPC_TRANSACTION_METHODS])
      : []),
  ]

  return {
    version: '1.0' as const,
    metadata: {
      name: 'Human Tech',
      version: '1.0.0',
      description: 'Bridge assets between L1 and Aztec L2',
      url: typeof window !== 'undefined' ? window.location.origin : '',
    },
    capabilities: [
      { type: 'accounts' as const, canGet: true, canCreateAuthWit: true },

      ...(allContracts.length > 0
        ? [
            {
              type: 'contracts' as const,
              contracts: allContracts,
              canRegister: true,
            },
          ]
        : []),

      {
        type: 'simulation' as const,
        utilities: { scope: simulationUtilities },
        transactions: { scope: simulationTransactions },
      },

      {
        type: 'transaction' as const,
        scope: transactionScope,
      },
    ],
  }
}
