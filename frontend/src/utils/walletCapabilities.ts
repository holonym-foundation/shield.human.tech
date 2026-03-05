/**
 * Least-privilege capability manifest for the Aztec Bridge dApp.
 *
 * Instead of requesting wildcard ('*') access, we declare exactly which
 * contract functions the bridge needs. This gives the wallet user a clear
 * picture of what the app can do and limits blast radius if the dApp is
 * compromised.
 */

import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { L1_TOKENS } from '@/config'
import type { ContractFunctionPattern } from '@aztec/aztec.js/wallet'

// ============================================================================
// HELPERS
// ============================================================================

/** Build a scoped pattern for a specific contract + function. */
function pattern(
  contract: AztecAddress,
  fn: string,
): ContractFunctionPattern {
  return { contract, function: fn }
}

/** Build multiple patterns for one contract with several functions. */
function patternsFor(
  contract: AztecAddress,
  fns: string[],
): ContractFunctionPattern[] {
  return fns.map((fn) => pattern(contract, fn))
}

// ============================================================================
// CONTRACT FUNCTIONS WE ACTUALLY USE
// ============================================================================

/** Private balance queries — simulated as utilities (no public state). */
const TOKEN_UTILITY_SIMULATION_METHODS = [
  'balance_of_private',
] as const

/** Public balance queries — simulated as transactions (reads public state). */
const TOKEN_TRANSACTION_SIMULATION_METHODS = [
  'balance_of_public',
] as const

const TOKEN_TRANSACTION_METHODS = [
  'transfer',
  'transfer_to_private',
  'burn_public',
  'burn_private',
] as const

/** Bridge contract methods we call (via sendTx). */
const BRIDGE_TRANSACTION_METHODS = [
  'claim_public',
  'claim_private',
  'exit_to_l1_public',
  'exit_to_l1_private',
] as const

// ============================================================================
// MANIFEST BUILDER
// ============================================================================

/**
 * Build a scoped capability manifest based on the configured L1_TOKENS.
 *
 * Dynamically reads token and bridge contract addresses from config so
 * the manifest stays correct when new tokens are added.
 */
export function buildCapabilityManifest() {
  // Collect unique L2 contract addresses
  const tokenAddresses = L1_TOKENS
    .map((t) => t.l2TokenContract)
    .filter((addr): addr is string => !!addr)
    .map((addr) => AztecAddress.fromString(addr))

  const bridgeAddresses = L1_TOKENS
    .map((t) => t.l2BridgeContract)
    .filter((addr): addr is string => !!addr)
    .map((addr) => AztecAddress.fromString(addr))

  const allContracts = [...tokenAddresses, ...bridgeAddresses]

  // Build simulation scopes
  // Private balance queries → utility simulations (no public state involved)
  const simulationUtilities: ContractFunctionPattern[] = tokenAddresses.flatMap(
    (addr) => patternsFor(addr, [...TOKEN_UTILITY_SIMULATION_METHODS]),
  )
  // Public balance queries → transaction simulations (reads public state)
  const simulationTransactions: ContractFunctionPattern[] = tokenAddresses.flatMap(
    (addr) => patternsFor(addr, [...TOKEN_TRANSACTION_SIMULATION_METHODS]),
  )

  // Build transaction scope (token transfers/burns + bridge claims/exits)
  const transactionScope: ContractFunctionPattern[] = [
    ...tokenAddresses.flatMap((addr) =>
      patternsFor(addr, [...TOKEN_TRANSACTION_METHODS]),
    ),
    ...bridgeAddresses.flatMap((addr) =>
      patternsFor(addr, [...BRIDGE_TRANSACTION_METHODS]),
    ),
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
      // Accounts: get accounts + create auth witnesses for withdrawals
      { type: 'accounts' as const, canGet: true, canCreateAuthWit: true },

      // Contracts: register only token + bridge contracts with the PXE
      ...(allContracts.length > 0
        ? [
            {
              type: 'contracts' as const,
              contracts: allContracts,
              canRegister: true,
            },
          ]
        : []),

      // Simulation: balance queries split by public (tx) vs private (utility)
      {
        type: 'simulation' as const,
        utilities: { scope: simulationUtilities },
        transactions: { scope: simulationTransactions },
      },

      // Transactions: specific methods on token + bridge contracts
      {
        type: 'transaction' as const,
        scope: transactionScope,
      },
    ],
  }
}
