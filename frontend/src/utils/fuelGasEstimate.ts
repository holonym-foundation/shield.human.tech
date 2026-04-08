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

// ─── Gas Limit Ceiling (sufficiency check only — not passed to the wallet) ─
//
// A token claim (claim_public / claim_private) involves:
//   - Setup phase: claim_and_end_setup (FeeJuice L1→L2 message consumption)
//   - App phase: claim_public (token L1→L2 message consumption + mint)
//
// Actual usage varies significantly by account contract: ~500K for vanilla
// Schnorr, ~1.5M for Azguard. Rather than picking a single number that fits
// every account (per Aztec dev guidance), we omit gasLimits/teardownGasLimits
// from the gasSettings we hand to FeeJuicePaymentMethodWithClaim — the wallet
// then runs a preflight simulation to size the limits correctly for whatever
// account contract is paying.
//
// This 2M constant is ONLY used for the pre-deposit fuel-sufficiency check:
// a worst-case ceiling we use to decide "does the fuel swap output enough FJ
// to definitely cover the claim?" before sending the L1 deposit. If the
// wallet later picks a smaller real limit during preflight, that's fine —
// the user just has slightly more FJ than strictly required.
const CLAIM_L2_GAS_CEILING = 2_000_000
const CLAIM_DA_GAS_CEILING = 50_000

/**
 * Build gasSettings for an L2 claim transaction paid with bridged FeeJuice.
 *
 * Returns ONLY the fee-rate config (maxFeesPerGas / maxPriorityFeesPerGas).
 * gasLimits and teardownGasLimits are intentionally omitted so the wallet
 * estimates them from a preflight simulation per the account contract in use
 * (Azguard needs ~1.5M, Schnorr ~500K — a single hardcoded value breaks one
 * or the other).
 *
 * Queries current base fees from the Aztec node and applies a 2x safety
 * multiplier for the max fee rate.
 */
export async function buildClaimGasSettings() {
  const { createAztecNodeClient } = await import('@aztec/aztec.js/node')
  const { GasFees } = await import('@aztec/stdlib/gas')

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

  return maxFeePerL2Gas * BigInt(CLAIM_L2_GAS_CEILING) + maxFeePerDaGas * BigInt(CLAIM_DA_GAS_CEILING)
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
