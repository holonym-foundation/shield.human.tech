/**
 * Fuel gas estimation utilities.
 *
 * Provides tight gas fee settings for L2 claim transactions paid with bridged
 * FeeJuice, and a pre-flight check to verify that the fuel swap's expected
 * output actually covers the L2 claim fee before sending the L1 deposit.
 *
 * Ported from main's frontend/src/utils/fuelGasEstimate.ts so SDK callers
 * can enforce fuel sufficiency before the irreversible L1 deposit.
 */

// ─── Gas Limit Ceiling (sufficiency check only — not passed to the wallet) ─
//
// A token claim (claim_public / claim_private) involves:
//   - Setup phase: claim_and_end_setup (FeeJuice L1→L2 message consumption)
//   - App phase: claim_public (token L1→L2 message consumption + mint)
//
// Actual usage varies by account contract: ~500K for vanilla Schnorr, ~1.5M
// for Azguard. We omit gasLimits/teardownGasLimits from buildClaimGasSettings()
// so the wallet runs its own preflight and sizes them correctly. These 2M/50K
// constants are ONLY used for the pre-deposit fuel-sufficiency check: a
// worst-case ceiling to decide whether the swap output definitely covers fees.
const CLAIM_L2_GAS_CEILING = 2_000_000
const CLAIM_DA_GAS_CEILING = 50_000

/**
 * Build gasSettings for an L2 claim transaction paid with bridged FeeJuice.
 *
 * Returns ONLY the fee-rate config. gasLimits / teardownGasLimits are
 * intentionally omitted so the wallet's preflight simulation can size them
 * per the account contract in use (Azguard ~1.5M, Schnorr ~500K — a single
 * hardcoded value breaks one or the other).
 *
 * Queries current base fees from the Aztec node and applies a 2× safety
 * multiplier for the max fee rate. Matches main's behavior.
 */
export async function buildClaimGasSettings(aztecNode: any) {
  const { GasFees } = await import('@aztec/stdlib/gas')
  const baseFees = await aztecNode.getCurrentMinFees()

  // 2× multiplier — provides headroom above current base fees while keeping
  // the fee limit achievable with reasonable fuel swap amounts.
  // (Wonderland uses 3×, wallet uses 1.5× — 2× is a practical middle ground.)
  const FEE_MULTIPLIER = 2n
  const maxFeesPerGas = new GasFees(
    BigInt(baseFees.feePerDaGas) * FEE_MULTIPLIER,
    BigInt(baseFees.feePerL2Gas) * FEE_MULTIPLIER,
  )

  return {
    maxFeesPerGas,
    maxPriorityFeesPerGas: GasFees.empty(),
  }
}

/**
 * Estimate the maximum FeeJuice cost for an L2 claim transaction.
 *
 * feeLimit = (maxFeePerL2Gas × l2GasLimit) + (maxFeePerDaGas × daGasLimit)
 *
 * For private fuel (BridgedFPC / mint_and_pay_fee) we use a 3× multiplier to
 * match what the orchestrator passes in gasSettings — keeping the pre-flight
 * threshold aligned with the contract's `assert(amount >= max_gas_cost)` check.
 *
 * For public fuel we use 2× (wallet estimates gas limits; the 2× fee-rate cap
 * is a practical middle ground between 3× and 1.5×).
 */
export async function estimateClaimFeeLimit(
  aztecNode: any,
  fuelType: 'public' | 'private' = 'public',
): Promise<bigint> {
  const baseFees = await aztecNode.getCurrentMinFees()

  const FEE_MULTIPLIER = fuelType === 'private' ? 3n : 2n
  const maxFeePerL2Gas = BigInt(baseFees.feePerL2Gas) * FEE_MULTIPLIER
  const maxFeePerDaGas = BigInt(baseFees.feePerDaGas) * FEE_MULTIPLIER

  return maxFeePerL2Gas * BigInt(CLAIM_L2_GAS_CEILING) + maxFeePerDaGas * BigInt(CLAIM_DA_GAS_CEILING)
}

/**
 * Check whether the expected FeeJuice output from a fuel swap covers the
 * L2 claim fee.
 *
 * @param expectedFjOutput - Expected FJ from the swap (wei, 18 decimals)
 * @param fuelType - 'private' (BridgedFPC, 3× multiplier) or 'public' (2×)
 */
export async function checkFuelSufficiency(
  aztecNode: any,
  expectedFjOutput: bigint,
  fuelType: 'public' | 'private' = 'public',
): Promise<{
  sufficient: boolean
  feeLimit: bigint
  feeLimitFj: string
  expectedFj: string
  shortfallFj: string | null
}> {
  const feeLimit = await estimateClaimFeeLimit(aztecNode, fuelType)
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
