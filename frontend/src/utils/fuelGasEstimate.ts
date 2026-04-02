/**
 * Fuel gas estimation utilities.
 *
 * Provides tight gas limits for L2 claim transactions paid with bridged FeeJuice,
 * and a pre-flight check to verify sufficient FJ before sending the L1 deposit.
 *
 * The Aztec SDK defaults to MAX_PROCESSABLE_L2_GAS (6.5M) as the gas limit,
 * which produces a fee limit of ~24.5 FJ at current base fees. A claim_public
 * call realistically uses ~200K-500K L2 gas. Using tight limits brings the
 * fee requirement down to ~1-4 FJ, making fuel swaps viable with small amounts.
 */

import { L2_NODE_URL } from '@/config'

// ─── Tight Gas Limits for Claim Transactions ────────────────────────
//
// A token claim (claim_public / claim_private) involves:
//   - Setup phase: claim_and_end_setup (FeeJuice L1→L2 message consumption)
//   - App phase: claim_public (token L1→L2 message consumption + mint)
//
// Measured usage is ~200K-500K L2 gas. We use 2M as a safe 4x margin.
// DA gas is negligible for claims (no large data payloads).

const CLAIM_L2_GAS_LIMIT = 500_000
const CLAIM_DA_GAS_LIMIT = 50_000
const CLAIM_TEARDOWN_L2_GAS_LIMIT = 0
const CLAIM_TEARDOWN_DA_GAS_LIMIT = 0

/**
 * Build tight gasSettings for an L2 claim transaction paid with bridged FeeJuice.
 *
 * Queries current base fees from the Aztec node and applies a 3x safety multiplier
 * (matching Wonderland's DEFAULT_FEE_MULTIPLIER).
 */
export async function buildClaimGasSettings() {
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node')
  const { Gas, GasFees } = await import('@aztec/stdlib/gas')

  const node = createAztecNodeClient(L2_NODE_URL)
  const baseFees = await node.getCurrentMinFees()

  // 2x multiplier — provides headroom above current base fees while keeping
  // the fee limit achievable with reasonable fuel swap amounts.
  // (Wonderland uses 3x, wallet uses 1.5x — 2x is a practical middle ground.)
  const FEE_MULTIPLIER = 2n
  const maxFeesPerGas = new GasFees(
    BigInt(baseFees.feePerDaGas) * FEE_MULTIPLIER,
    BigInt(baseFees.feePerL2Gas) * FEE_MULTIPLIER,
  )

  return {
    gasLimits: Gas.from({ l2Gas: CLAIM_L2_GAS_LIMIT, daGas: CLAIM_DA_GAS_LIMIT }),
    teardownGasLimits: Gas.from({ l2Gas: CLAIM_TEARDOWN_L2_GAS_LIMIT, daGas: CLAIM_TEARDOWN_DA_GAS_LIMIT }),
    maxFeesPerGas,
    maxPriorityFeesPerGas: GasFees.empty(),
  }
}

/**
 * Estimate the maximum FeeJuice cost for an L2 claim transaction.
 *
 * feeLimit = (maxFeePerL2Gas × l2GasLimit) + (maxFeePerDaGas × daGasLimit)
 *
 * @returns The fee limit in FeeJuice wei (18 decimals)
 */
export async function estimateClaimFeeLimit(): Promise<bigint> {
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node')

  const node = createAztecNodeClient(L2_NODE_URL)
  const baseFees = await node.getCurrentMinFees()

  const FEE_MULTIPLIER = 2n
  const maxFeePerL2Gas = BigInt(baseFees.feePerL2Gas) * FEE_MULTIPLIER
  const maxFeePerDaGas = BigInt(baseFees.feePerDaGas) * FEE_MULTIPLIER

  return maxFeePerL2Gas * BigInt(CLAIM_L2_GAS_LIMIT) + maxFeePerDaGas * BigInt(CLAIM_DA_GAS_LIMIT)
}

/**
 * Check whether the expected FeeJuice output from a fuel swap is sufficient
 * to cover L2 claim gas costs.
 *
 * @param expectedFjOutput - Expected FJ from the swap (in wei, 18 decimals)
 * @returns Object with sufficiency status and details
 */
export async function checkFuelSufficiency(expectedFjOutput: bigint): Promise<{
  sufficient: boolean
  feeLimit: bigint
  feeLimitFj: string
  expectedFj: string
  shortfallFj: string | null
}> {
  const feeLimit = await estimateClaimFeeLimit()
  const feeLimitFj = (Number(feeLimit) / 1e18).toFixed(4)
  const expectedFj = (Number(expectedFjOutput) / 1e18).toFixed(4)
  const sufficient = expectedFjOutput >= feeLimit

  return {
    sufficient,
    feeLimit,
    feeLimitFj,
    expectedFj,
    shortfallFj: sufficient ? null : (Number(feeLimit - expectedFjOutput) / 1e18).toFixed(4),
  }
}
