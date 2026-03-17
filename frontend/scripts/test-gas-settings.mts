/**
 * Standalone script to test BridgedFPC gas settings against the live devnet.
 *
 * Queries the Aztec node for current base fees, computes max_gas_cost under
 * different gas settings configurations, and compares against fuel amounts.
 *
 * Run from frontend/:
 *   npx tsx scripts/test-gas-settings.mts
 */

import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Gas, GasFees, GasSettings } from '@aztec/stdlib/gas'

// ── Config ──────────────────────────────────────────────────────────────
const NODE_URL = process.env.NODE_URL ?? 'https://v4-devnet-2.aztec-labs.com'

// Default Aztec gas limit constants (from @aztec/constants)
const DEFAULT_L2_GAS_LIMIT = 6_000_000
const DEFAULT_DA_GAS_LIMIT = 786_432
const DEFAULT_TEARDOWN_L2_GAS_LIMIT = 1_000_000
const DEFAULT_TEARDOWN_DA_GAS_LIMIT = 393_216

const DEFAULT_FEE_MULTIPLIER = 3n

// Mock 1:1 swap rate: $X USDC (6 decimals) -> X * 10^18 FJ
const FUEL_PRESETS_USD = [1, 5, 10, 25, 50]
const usdToFj = (usd: number) => BigInt(usd) * 10n ** 18n

function formatFJ(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(4)
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== BridgedFPC Gas Settings Diagnostic ===\n')
  console.log(`Node URL: ${NODE_URL}\n`)

  // 1. Connect and query base fees
  const node = createAztecNodeClient(NODE_URL)
  const baseFees = await node.getCurrentMinFees()

  console.log('--- Current Base Fees ---')
  console.log(`  feePerDaGas: ${baseFees.feePerDaGas}`)
  console.log(`  feePerL2Gas: ${baseFees.feePerL2Gas}`)
  console.log()

  // 2. Compute maxFeesPerGas with 3x multiplier
  const maxFeePerDaGas = BigInt(baseFees.feePerDaGas) * DEFAULT_FEE_MULTIPLIER
  const maxFeePerL2Gas = BigInt(baseFees.feePerL2Gas) * DEFAULT_FEE_MULTIPLIER

  console.log('--- Max Fees Per Gas (3x multiplier) ---')
  console.log(`  feePerDaGas: ${maxFeePerDaGas}`)
  console.log(`  feePerL2Gas: ${maxFeePerL2Gas}`)
  console.log()

  // 3. Gas limits
  console.log('--- Gas Limits ---')
  console.log(`  DEFAULT_DA_GAS_LIMIT:          ${DEFAULT_DA_GAS_LIMIT}`)
  console.log(`  DEFAULT_L2_GAS_LIMIT:          ${DEFAULT_L2_GAS_LIMIT}`)
  console.log(`  DEFAULT_TEARDOWN_DA_GAS_LIMIT: ${DEFAULT_TEARDOWN_DA_GAS_LIMIT}`)
  console.log(`  DEFAULT_TEARDOWN_L2_GAS_LIMIT: ${DEFAULT_TEARDOWN_L2_GAS_LIMIT}`)
  console.log()

  // 4. Compute max_gas_cost under different configurations
  // Contract formula: maxFeePerDaGas * (daGasLimit + teardownDaGasLimit) + maxFeePerL2Gas * (l2GasLimit + teardownL2GasLimit)

  const costZeroTeardown =
    maxFeePerDaGas * BigInt(DEFAULT_DA_GAS_LIMIT) +
    maxFeePerL2Gas * BigInt(DEFAULT_L2_GAS_LIMIT)

  const costWithTeardown =
    maxFeePerDaGas * (BigInt(DEFAULT_DA_GAS_LIMIT) + BigInt(DEFAULT_TEARDOWN_DA_GAS_LIMIT)) +
    maxFeePerL2Gas * (BigInt(DEFAULT_L2_GAS_LIMIT) + BigInt(DEFAULT_TEARDOWN_L2_GAS_LIMIT))

  // What if the wallet uses a HIGHER multiplier (e.g. 5x)?
  const costHighMultiplier =
    (BigInt(baseFees.feePerDaGas) * 5n) * (BigInt(DEFAULT_DA_GAS_LIMIT) + BigInt(DEFAULT_TEARDOWN_DA_GAS_LIMIT)) +
    (BigInt(baseFees.feePerL2Gas) * 5n) * (BigInt(DEFAULT_L2_GAS_LIMIT) + BigInt(DEFAULT_TEARDOWN_L2_GAS_LIMIT))

  console.log('--- Max Gas Cost Calculations ---')
  console.log(`  teardown=0, 3x multiplier:   ${costZeroTeardown}  (${formatFJ(costZeroTeardown)} FJ)`)
  console.log(`  default teardown, 3x:         ${costWithTeardown}  (${formatFJ(costWithTeardown)} FJ)`)
  console.log(`  default teardown, 5x:         ${costHighMultiplier}  (${formatFJ(costHighMultiplier)} FJ)`)
  console.log()

  // 5. Compare against fuel amounts
  console.log('--- Fuel Amount Sufficiency ---')
  console.log('  (Contract assertion: amount >= max_gas_cost)')
  console.log()
  console.log(`  ${'USD'.padEnd(6)} ${'FJ Amount'.padEnd(25)} ${'t=0 3x'.padEnd(10)} ${'t=def 3x'.padEnd(10)} ${'t=def 5x'.padEnd(10)}`)
  console.log(`  ${'---'.padEnd(6)} ${'---'.padEnd(25)} ${'---'.padEnd(10)} ${'---'.padEnd(10)} ${'---'.padEnd(10)}`)

  for (const usd of FUEL_PRESETS_USD) {
    const fj = usdToFj(usd)
    const p1 = fj >= costZeroTeardown ? 'PASS' : 'FAIL'
    const p2 = fj >= costWithTeardown ? 'PASS' : 'FAIL'
    const p3 = fj >= costHighMultiplier ? 'PASS' : 'FAIL'
    console.log(
      `  $${String(usd).padEnd(5)} ${fj.toString().padEnd(25)} ${p1.padEnd(10)} ${p2.padEnd(10)} ${p3.padEnd(10)}`
    )
  }
  console.log()

  // 6. Minimum fuel needed
  console.log('--- Minimum Fuel Needed ---')
  console.log(`  teardown=0, 3x:    $${(Number(costZeroTeardown) / 1e18).toFixed(2)}`)
  console.log(`  default td, 3x:    $${(Number(costWithTeardown) / 1e18).toFixed(2)}`)
  console.log(`  default td, 5x:    $${(Number(costHighMultiplier) / 1e18).toFixed(2)}`)
  console.log()

  // 7. Test GasSettings.default() — what the SDK uses when no explicit gasSettings
  console.log('--- GasSettings.default() (what SDK uses internally) ---')
  try {
    const maxFeesPerGas = new GasFees(maxFeePerDaGas, maxFeePerL2Gas)
    const defaultGs = GasSettings.default({ maxFeesPerGas })
    const defaultCost =
      BigInt(defaultGs.maxFeesPerGas.feePerDaGas) * (BigInt(defaultGs.gasLimits.daGas) + BigInt(defaultGs.teardownGasLimits.daGas)) +
      BigInt(defaultGs.maxFeesPerGas.feePerL2Gas) * (BigInt(defaultGs.gasLimits.l2Gas) + BigInt(defaultGs.teardownGasLimits.l2Gas))
    console.log(`  gasLimits:         { daGas: ${defaultGs.gasLimits.daGas}, l2Gas: ${defaultGs.gasLimits.l2Gas} }`)
    console.log(`  teardownGasLimits: { daGas: ${defaultGs.teardownGasLimits.daGas}, l2Gas: ${defaultGs.teardownGasLimits.l2Gas} }`)
    console.log(`  maxFeesPerGas:     { da: ${defaultGs.maxFeesPerGas.feePerDaGas}, l2: ${defaultGs.maxFeesPerGas.feePerL2Gas} }`)
    console.log(`  maxPriorityFees:   { da: ${defaultGs.maxPriorityFeesPerGas.feePerDaGas}, l2: ${defaultGs.maxPriorityFeesPerGas.feePerL2Gas} }`)
    console.log(`  max_gas_cost:      ${defaultCost}  (${formatFJ(defaultCost)} FJ)`)
  } catch (err) {
    console.log(`  GasSettings.default() FAILED: ${err}`)
  }
  console.log()

  // 8. Test creating a full GasSettings with teardown=0
  console.log('--- GasSettings.from() with teardown=0 ---')
  try {
    const maxFeesPerGas = new GasFees(maxFeePerDaGas, maxFeePerL2Gas)
    const gs = GasSettings.from({
      gasLimits: Gas.from({ daGas: DEFAULT_DA_GAS_LIMIT, l2Gas: DEFAULT_L2_GAS_LIMIT }),
      teardownGasLimits: Gas.from({ l2Gas: 0, daGas: 0 }),
      maxFeesPerGas,
      maxPriorityFeesPerGas: GasFees.empty(),
    })
    console.log(`  gasLimits:         { daGas: ${gs.gasLimits.daGas}, l2Gas: ${gs.gasLimits.l2Gas} }`)
    console.log(`  teardownGasLimits: { daGas: ${gs.teardownGasLimits.daGas}, l2Gas: ${gs.teardownGasLimits.l2Gas} }`)
    console.log(`  JSON serializable: ${JSON.stringify(gs) !== undefined ? 'yes' : 'no'}`)
  } catch (err) {
    console.log(`  GasSettings.from() FAILED: ${err}`)
  }
  console.log()

  console.log('=== Done ===')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
