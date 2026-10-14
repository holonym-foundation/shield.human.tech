/**
 * Pure, dependency-free deposit-cap ledger logic.
 *
 * The compliance caps (cumulative Travel Rule threshold + rolling-24h Alpha cap)
 * are enforced against a durable ledger of the attestation "holds" the server
 * signs — never against client-authored deposit rows. The three security-critical
 * decisions live here so they can be unit-tested without a database or a live
 * chain: how a signed hold is valued (canonical decimals, not the client's), when
 * a hold settles vs frees, and how holds sum against a window. The DB/RPC glue in
 * address-binding.ts is a thin layer over these.
 */

export type ChargeStatus = 'active' | 'consumed' | 'released'

/** Minimal trusted token metadata (symbol → on-chain decimals). */
export interface TokenMeta {
  symbol: string
  decimals: number
}

/**
 * Canonical on-chain decimals for a symbol, resolved from the trusted deployment
 * registry — NEVER the client-supplied value. A client that over-states decimals
 * shrinks a deposit's computed USD value and slips under the cap while the signed
 * ceiling still authorizes the full real amount on-chain; resolving decimals
 * server-side removes that lever. An unknown symbol falls back to `fallback`
 * (default 6, USDC): using fewer-than-real decimals over-values the deposit
 * (fail-safe — the cap refuses earlier), it can never under-value.
 */
export function canonicalDecimals(symbol: string, registry: TokenMeta[], fallback = 6): number {
  const hit = registry.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase())
  return hit ? hit.decimals : fallback
}

/** USD value of a base-unit amount at the given decimals and unit price. */
export function valueBaseUnitsUsd(baseUnits: bigint, decimals: number, priceUsd: number): number {
  if (priceUsd <= 0 || baseUnits <= 0n) return 0
  return (Number(baseUnits) / 10 ** decimals) * priceUsd
}

/** Convert a USD budget to a token base-unit ceiling at the given decimals and price. */
export function usdToBaseUnits(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0 || usd <= 0) return 0n
  return BigInt(Math.floor((usd / priceUsd) * 10 ** decimals))
}

/**
 * Decide the terminal state of a hold once its deadline has passed, given whether
 * the chain shows its attestation nonce consumed.
 *
 * A hold is freed ONLY on a definitive on-chain `false` AND past a deadline the
 * contract itself enforces (`block.timestamp > deadline` rejects the deposit) — at
 * that point no deposit with the nonce can ever land, so the budget is provably
 * free. Two guards keep it from ever under-counting a real deposit:
 *   - `nonceConsumed === undefined` (RPC unreadable) → keep the hold active/counted;
 *     releasing on uncertainty could drop a real deposit from the cap.
 *   - `neverExpires` (clean-hands sigs carry no deadline, so the nonce can be
 *     consumed indefinitely) → never release on time; only settle when seen consumed.
 */
export function resolveHold(params: {
  status: ChargeStatus
  expired: boolean
  neverExpires: boolean
  nonceConsumed: boolean | undefined
}): ChargeStatus {
  if (params.status !== 'active') return params.status
  if (params.nonceConsumed === true) return 'consumed'
  if (params.nonceConsumed === undefined) return 'active'
  // nonceConsumed === false below.
  if (params.neverExpires) return 'active'
  if (params.expired) return 'released'
  return 'active'
}

export interface HeldRow {
  amountUsd: number
  status: ChargeStatus
  /** Server-set issuance time (ms). The window anchor — never a client value. */
  createdAtMs: number
}

/**
 * Derive a hold's charge state from the two columns the reservation row already
 * has — no dedicated status column, so no DB migration. `amountUsd <= 0` is the
 * "released" tombstone the on-chain resolver writes to free a proven-abandoned
 * hold. A live hold still inside its signed deposit window (`expiresAt > now`) is
 * `active` (the deposit may yet land or be abandoned); once past that window and
 * still charged it is `consumed` — a committed charge that counts until the
 * resolver proves the nonce was never used and tombstones it. This keeps
 * counting monotonic: a charge only ever leaves the sum by an on-chain-verified
 * release, never by the passage of time alone.
 */
export function synthStatus(amountUsd: number, expiresAtMs: number, nowMs: number): ChargeStatus {
  if (amountUsd <= 0) return 'released'
  return expiresAtMs > nowMs ? 'active' : 'consumed'
}

/**
 * Sum the USD a user currently holds against a cap. Non-released holds count; a
 * rolling window (windowMs) admits only holds issued within it (anchored on the
 * server-set createdAt, so the client can't age a hold out early). windowMs = null
 * → lifetime (no window). Each nonce has exactly one hold row, so a settled deposit
 * is counted once, at its signed ceiling — no double-count with any deposit record.
 */
export function sumHeldUsd(rows: HeldRow[], nowMs: number, windowMs: number | null): number {
  const cutoff = windowMs == null ? -Infinity : nowMs - windowMs
  let total = 0
  for (const r of rows) {
    if (r.status === 'released') continue
    if (r.createdAtMs < cutoff) continue
    total += r.amountUsd
  }
  return total
}
