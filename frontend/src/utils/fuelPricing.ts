/**
 * Fuel pricing module — mirrors MockFuelSwap's decimal-aware math on the frontend.
 *
 * On devnet: 1:1 rate with mock prices.
 * TODO: Replace mock price feeds with CoinGecko / DEX oracle for mainnet.
 */

export const FEE_JUICE_DECIMALS = 18
export const MOCK_FUEL_SWAP_RATE = 10n ** 18n // 1e18 = "1 token buys 1 FJ"

// ─── Price Feeds (mock) ─────────────────────────────────────────────

/** TODO: Replace with CoinGecko API or on-chain oracle for mainnet. */
export function getTokenPriceUsd(_symbol: string): number {
  return 1.0 // devnet: all tokens are $1
}

/** TODO: Replace with DEX oracle for mainnet. */
export function getFeeJuicePriceUsd(): number {
  return 1.0 // devnet: 1 FJ = $1
}

// ─── Swap Output (mirrors contract math) ────────────────────────────

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

// ─── Convenience Helpers ────────────────────────────────────────────

/**
 * Compute FeeJuice output from a human-readable token amount string.
 * e.g. computeFuelOutput("5", 6, "USDC") → 5e18n
 */
export function computeFuelOutput(
  humanAmount: string,
  inputDecimals: number,
  _tokenSymbol: string,
): bigint {
  const raw = BigInt(Math.floor(Number(humanAmount) * 10 ** inputDecimals))
  return computeSwapOutput(raw, inputDecimals)
}

/** Format raw FJ (18-dec bigint) to a human-readable string, e.g. "5.00" */
export function formatFjAmount(rawFj: bigint, precision = 2): string {
  const whole = rawFj / 10n ** 18n
  const frac = rawFj % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, precision)
  return `${whole}.${fracStr}`
}

/** Format raw FJ for display with USD equivalent, e.g. "5.00 FJ (~$5.00)" */
export function formatFuelDisplay(rawFj: bigint): string {
  const fjStr = formatFjAmount(rawFj)
  const usdValue = (Number(rawFj) / 1e18) * getFeeJuicePriceUsd()
  return `${fjStr} FJ (~$${usdValue.toFixed(2)})`
}
