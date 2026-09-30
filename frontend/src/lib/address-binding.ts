import { randomBytes } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { createPublicClient, http } from 'viem'
import { prisma } from './prisma'
import { getTokenPriceUsd } from '@/utils/fuelPricing'
import { getBridgeMaxDepositUsd, getTravelRuleThresholdUsd } from './attestation'
import { L1_TOKENS, L1_RPC_URL } from '@/config'
import {
  canonicalDecimals,
  resolveHold,
  sumHeldUsd,
  synthStatus,
  usdToBaseUnits,
  valueBaseUnitsUsd,
  type ChargeStatus,
  type HeldRow,
  type TokenMeta,
} from './deposit-ledger'

/**
 * A binding is looked up by its L1 address alone.
 *
 * SIWE proves the L1 address; the L2 half is taken from caller-chosen SIWE
 * `resources` and is never proven. Matching on the L2 side therefore let anyone
 * pair a throwaway L1 with a stranger's Aztec account and lock that account out
 * of the bridge for good — the row is permanent and there is no unbind path —
 * and it disclosed the claiming L1 back to the victim. Deposit caps do not rely
 * on the pair being exclusive: they are counted per L1 address (see capSubject).
 */
function findBindingForL1(l1Address: string) {
  return prisma.addressBinding.findUnique({ where: { l1Address } })
}

/**
 * Report an existing binding that conflicts with this pair, without creating
 * one. Pre-flight callers use this: creating the binding is irreversible, so a
 * read-shaped request must not be able to consume an address.
 */
export async function checkAddressBindingConflict(
  l1Address: string,
  l2Address: string,
): Promise<string | null> {
  const existing = await findBindingForL1(l1Address)
  return existing ? describeBindingConflict(existing, l1Address, l2Address) : null
}

function describeBindingConflict(
  existing: { l2Address: string },
  l1Address: string,
  l2Address: string,
): string | null {
  if (existing.l2Address === l2Address) {
    return null
  }
  return `L1 address ${l1Address} is already bound to a different L2 address`
}

export async function enforceAddressBinding(l1Address: string, l2Address: string): Promise<string | null> {
  const existing = await findBindingForL1(l1Address)
  if (existing) {
    return describeBindingConflict(existing, l1Address, l2Address)
  }

  try {
    await prisma.addressBinding.create({
      data: { l1Address, l2Address },
    })
  } catch (err: any) {
    if (err?.code !== 'P2002') throw err
    // Either this L1 raced itself, or the L2 half is already recorded under a
    // different L1. Only the former can conflict: an unproven L2 collision must
    // never block, so leaving this L1 unrecorded is the correct outcome.
    const raced = await findBindingForL1(l1Address)
    return raced ? describeBindingConflict(raced, l1Address, l2Address) : null
  }

  return null
}

/** Rolling window (ms) over which per-user deposits are summed for the cap. */
export const DEPOSIT_CAP_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Max attestation lifetime, in seconds. Bounds the signed deadline (so a signature
 * can't be minted far in the future and banked) AND is the reservation's TTL — a
 * hold frees this long after issuance if the deposit never confirms.
 */
export const ATTESTATION_TTL_SECONDS = 30 * 60

/** ATTESTATION_TTL_SECONDS in whole minutes, for user-facing "retry in N min" copy. */
export const ATTESTATION_TTL_MINUTES = Math.round(ATTESTATION_TTL_SECONDS / 60)

// ─── Durable deposit-cap ledger (on-chain-anchored, client-report-free) ─────
//
// The compliance caps are enforced against the holds the server SIGNS — a hold
// counts from the moment its attestation is signed and keeps counting until the
// chain proves its nonce was never used, at which point it is tombstoned. This
// replaces summing client-authored bridge-activity rows (amount / decimals /
// status all attacker-supplied), which let cumulative volume be under-reported.
// No schema change: `amountUsd = 0` is the released tombstone, and each row's
// charge state is synthesized from (amountUsd, expiresAt) — see synthStatus.

/** Trusted token metadata from the active deployment (symbol → on-chain decimals). */
const TOKEN_REGISTRY: TokenMeta[] = L1_TOKENS.map((t) => ({ symbol: t.symbol, decimals: t.decimals }))

/** Distinct canonical L1 portal contracts a real deposit can settle against. */
const CANONICAL_PORTALS: `0x${string}`[] = Array.from(
  new Set(L1_TOKENS.map((t) => t.l1PortalContract).filter((a): a is string => !!a)),
).map((a) => a as `0x${string}`)

const NONCE_ABI = [
  {
    type: 'function',
    name: 'passportNonces',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'cleanHandsNonces',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const

let cachedL1Client: ReturnType<typeof createPublicClient> | null = null
function l1Client() {
  if (!L1_RPC_URL) return null
  if (!cachedL1Client) cachedL1Client = createPublicClient({ transport: http(L1_RPC_URL) })
  return cachedL1Client
}

export type NonceMethod = 'passport' | 'poch'

/**
 * Reader signature: whether an attestation nonce has been consumed on-chain by
 * `l1Address`. `undefined` means the chain could not be read — callers MUST treat
 * that as "unknown" and never free a hold on it.
 */
export type NonceReader = (l1Address: string, nonce: bigint, method: NonceMethod) => Promise<boolean | undefined>

/**
 * Read the canonical portals' public `passportNonces`/`cleanHandsNonces` mappings.
 * `true` as soon as any portal shows the nonce used; `false` only when every portal
 * is readable and none has it; `undefined` on no-RPC / any read error (fail-safe).
 */
const readNonceConsumedOnChain: NonceReader = async (l1Address, nonce, method) => {
  const client = l1Client()
  if (!client || CANONICAL_PORTALS.length === 0) return undefined
  const fn = method === 'passport' ? 'passportNonces' : 'cleanHandsNonces'
  let sawError = false
  for (const portal of CANONICAL_PORTALS) {
    try {
      const used = (await client.readContract({
        address: portal,
        abi: NONCE_ABI,
        functionName: fn,
        args: [l1Address as `0x${string}`, nonce],
      })) as boolean
      if (used) return true
    } catch {
      sawError = true
    }
  }
  return sawError ? undefined : false
}

interface RawHold {
  amountUsd: number
  expiresAtMs: number
  createdAtMs: number
  method: string
}

/**
 * The identity a cap is counted against: the L1 address, plus every user row
 * that shares it. A `User` is a (l1Address, l2Address) pair, so counting per
 * user row would hand the same L1 address a fresh allowance for each L2 address
 * it pairs with. The L1 address is the one half SIWE actually proves.
 */
async function capSubject(
  userId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<{ l1Address: string; userIds: string[] }> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { l1Address: true } })
  // Falling back to the single row keeps counting at least as strict as before.
  if (!user) return { l1Address: userId, userIds: [userId] }
  const peers = await client.user.findMany({
    where: { l1Address: user.l1Address },
    select: { id: true },
  })
  const userIds = peers.map((p) => p.id)
  return { l1Address: user.l1Address, userIds: userIds.length > 0 ? userIds : [userId] }
}

/** Non-tombstoned (amountUsd > 0) holds for a cap subject, optionally by method. */
async function fetchHeldRows(
  userIds: string[],
  client: Prisma.TransactionClient,
  methods?: NonceMethod[],
): Promise<RawHold[]> {
  const rows = await client.attestationReservation.findMany({
    where: { fkUserId: { in: userIds }, amountUsd: { gt: 0 }, ...(methods ? { method: { in: methods } } : {}) },
    select: { amountUsd: true, expiresAt: true, createdAt: true, method: true },
  })
  return rows.map((r) => ({
    amountUsd: r.amountUsd,
    expiresAtMs: r.expiresAt.getTime(),
    createdAtMs: r.createdAt.getTime(),
    method: r.method,
  }))
}

/** Sum held USD at `now` — synthesizes each row's charge state, then applies the
 *  optional rolling window (on createdAt) and status filter. */
function sumAt(raw: RawHold[], now: number, windowMs: number | null, statuses?: ChargeStatus[]): number {
  const rows: HeldRow[] = raw.map((r) => ({
    amountUsd: r.amountUsd,
    status: synthStatus(r.amountUsd, r.expiresAtMs, now),
    createdAtMs: r.createdAtMs,
  }))
  const filtered = statuses ? rows.filter((r) => statuses.includes(r.status)) : rows
  return sumHeldUsd(filtered, now, windowMs)
}

/**
 * Free a user's proven-abandoned passport holds against on-chain reality: a hold
 * past its (contract-enforced) deadline whose nonce is definitively unused is
 * tombstoned (amountUsd → 0). A consumed or unreadable nonce is left untouched, so
 * a real deposit is never dropped from the cap. Best-effort — any failure leaves
 * holds charged. POCH holds are NOT resolved here: their clean-hands signature
 * carries no deadline, so a nonce can be consumed indefinitely and time can never
 * prove non-consumption; POCH holds age out of the rolling window instead.
 */
export async function resolveExpiredHolds(
  userId: string,
  reader: NonceReader = readNonceConsumedOnChain,
  client: Prisma.TransactionClient = prisma,
): Promise<void> {
  try {
    const subject = await capSubject(userId, client)
    const stale = await client.attestationReservation.findMany({
      where: {
        fkUserId: { in: subject.userIds },
        method: 'passport',
        amountUsd: { gt: 0 },
        expiresAt: { lt: new Date() },
      },
      select: { id: true, nonce: true },
    })
    for (const row of stale) {
      const consumed = await reader(subject.l1Address, BigInt(row.nonce), 'passport')
      const next = resolveHold({ status: 'active', expired: true, neverExpires: false, nonceConsumed: consumed })
      if (next !== 'released') continue
      // Guard on amountUsd > 0 so a concurrent settle can't be clobbered.
      await client.attestationReservation.updateMany({
        where: { id: row.id, amountUsd: { gt: 0 } },
        data: { amountUsd: 0 },
      })
    }
  } catch (err) {
    console.error('[address-binding] resolveExpiredHolds failed (holds left charged):', err)
  }
}

/** Convert a USD amount to a token's base-unit bigint (for on-chain maxAmount). */
export function usdToTokenBaseUnits(usd: number, tokenSymbol: string, decimals: number): bigint {
  const price = getTokenPriceUsd(tokenSymbol, null)
  if (price <= 0 || usd <= 0) return 0n
  return BigInt(Math.floor((usd / price) * 10 ** decimals))
}

/**
 * A user's outstanding (unsettled) hold budget in USD — holds still inside their
 * signed deposit window (`expiresAt > now`), i.e. a deposit that may yet land or be
 * abandoned. Surfaced to the UI as the amount a pending deposit is temporarily
 * holding; settled (past-window) charges are reported by the evaluate* helpers.
 */
export async function getReservedDepositUsd(
  userId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  await resolveExpiredHolds(userId, readNonceConsumedOnChain, client)
  const subject = await capSubject(userId, client)
  const raw = await fetchHeldRows(subject.userIds, client)
  return sumAt(raw, Date.now(), null, ['active'])
}

export interface PassportReservationResult {
  ok: boolean
  reason?: 'travel_rule' | 'deposit_limit'
  thresholdUsd: number
  limitUsd: number
  /** 24h confirmed usage, for the deposit_limit error message. */
  confirmedUsd: number
  /** All-time confirmed usage, for distinguishing a hold-driven travel_rule block from a genuine one. */
  lifetimeUsd: number
  /** Outstanding (non-expired) reservation budget counted into this evaluation. When a block
   *  is charged to this rather than settled deposits, it clears within the reservation TTL. */
  reservedUsd: number
  /** The signed maxAmount to authorize (capped to the smaller remaining budget). */
  maxAmount: bigint
}

/**
 * Atomically evaluate the passport deposit caps AND record a durable budget hold.
 *
 * Runs under a per-user advisory lock inside a transaction so the read (held
 * budget) and the write (this hold) cannot interleave with a concurrent request —
 * the cumulative-cap TOCTOU fix. Usage is the durable held ledger — the signed
 * ceilings the server has issued, valued with CANONICAL token decimals (never the
 * client's, which could shrink a deposit's USD value while the ceiling still
 * authorizes the full real amount on-chain) and freed only when the chain proves
 * the nonce unused — NOT client-authored deposit rows. The signed maxAmount is
 * capped to the smaller remaining budget and that ceiling is charged. On-chain
 * settlement is resolved BEFORE the lock so no network read happens while it's held.
 */
export async function reservePassportBudget(params: {
  userId: string
  nonce: bigint
  expiresAt: Date
  perTxMaxAmount: bigint
  tokenSymbol: string
  tokenDecimals: number
}): Promise<PassportReservationResult> {
  const thresholdUsd = getTravelRuleThresholdUsd()
  const limitUsd = getBridgeMaxDepositUsd()
  const decimals = canonicalDecimals(params.tokenSymbol, TOKEN_REGISTRY)
  const price = getTokenPriceUsd(params.tokenSymbol, null)

  await resolveExpiredHolds(params.userId)

  return prisma.$transaction(async (tx) => {
    // Hold a per-user lock until commit so a concurrent request for the same user
    // blocks here and then reads the hold this transaction wrote.
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which the
    // query deserializer rejects ("cannot deserialize column of type 'void'").
    const subject = await capSubject(params.userId, tx)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subject.l1Address}))`

    const now = Date.now()
    const passportRows = await fetchHeldRows(subject.userIds, tx, ['passport'])
    const allRows = await fetchHeldRows(subject.userIds, tx)

    let maxAmount = params.perTxMaxAmount
    let confirmedUsd = 0
    let lifetimeUsd = 0
    let reservedUsd = 0

    if (thresholdUsd > 0) {
      // Travel Rule is passport-tier only; POCH-verified humans are exempt.
      const settledLifetime = sumAt(passportRows, now, null, ['consumed'])
      const heldLifetime = sumAt(passportRows, now, null)
      lifetimeUsd = settledLifetime
      reservedUsd = Math.max(0, heldLifetime - settledLifetime)
      const remainingUsd = Math.max(0, thresholdUsd - heldLifetime)
      if (remainingUsd <= 0) {
        return { ok: false, reason: 'travel_rule', thresholdUsd, limitUsd, confirmedUsd, lifetimeUsd, reservedUsd, maxAmount: 0n }
      }
      const remainingBaseUnits = usdToBaseUnits(remainingUsd, price, decimals)
      if (remainingBaseUnits < maxAmount) maxAmount = remainingBaseUnits
    }

    if (limitUsd > 0) {
      // Rolling-24h Alpha cap spans all tiers.
      const settled24h = sumAt(allRows, now, DEPOSIT_CAP_WINDOW_MS, ['consumed'])
      const held24h = sumAt(allRows, now, DEPOSIT_CAP_WINDOW_MS)
      confirmedUsd = settled24h
      reservedUsd = Math.max(reservedUsd, held24h - settled24h)
      const remainingUsd = Math.max(0, limitUsd - held24h)
      if (remainingUsd <= 0) {
        return { ok: false, reason: 'deposit_limit', thresholdUsd, limitUsd, confirmedUsd, lifetimeUsd, reservedUsd, maxAmount: 0n }
      }
      const remainingBaseUnits = usdToBaseUnits(remainingUsd, price, decimals)
      if (remainingBaseUnits < maxAmount) maxAmount = remainingBaseUnits
    }

    if (maxAmount <= 0n) {
      return {
        ok: false,
        reason: thresholdUsd > 0 ? 'travel_rule' : 'deposit_limit',
        thresholdUsd,
        limitUsd,
        confirmedUsd,
        lifetimeUsd,
        reservedUsd,
        maxAmount: 0n,
      }
    }

    const amountUsd = valueBaseUnitsUsd(maxAmount, decimals, price)
    await tx.attestationReservation.create({
      data: {
        fkUserId: params.userId,
        nonce: params.nonce.toString(),
        amountUsd,
        method: 'passport',
        expiresAt: params.expiresAt,
      },
    })

    return { ok: true, thresholdUsd, limitUsd, confirmedUsd, lifetimeUsd, reservedUsd, maxAmount }
  })
}

export interface PochReservationResult {
  ok: boolean
  limitUsd: number
  /** Settled (past-window) 24h usage, for the deposit_limit error message. */
  confirmedUsd: number
  /** Outstanding (unsettled) hold budget counted into this evaluation. */
  reservedUsd: number
}

/**
 * Atomically evaluate the Alpha rolling-24h cap for a POCH (clean-hands) deposit
 * and record a durable hold, under the same per-user lock as the passport path.
 *
 * LIMITATION: the clean-hands signature binds NO amount and the portal enforces none
 * on-chain (TokenPortal `_validateAttestations` checks `_amount <= maxAmount` for the
 * passport branch only), so `amount` here is the client's self-reported figure — a
 * caller can under-state it. The cap therefore counts honest usage and serializes
 * concurrent requests, but is NOT a hard on-chain bound: truly bounding POCH volume
 * requires a signed maxAmount + `_amount <= maxAmount` check added to the clean-hands
 * attestation in TokenPortal.
 */
export async function reservePochBudget(params: {
  userId: string
  nonce: bigint
  expiresAt: Date
  amount?: string
  tokenSymbol?: string
}): Promise<PochReservationResult> {
  const limitUsd = getBridgeMaxDepositUsd()
  const symbol = params.tokenSymbol ?? 'USDC'
  const decimals = canonicalDecimals(symbol, TOKEN_REGISTRY)
  const price = getTokenPriceUsd(symbol, null)
  const requestedUsd = params.amount ? valueBaseUnitsUsd(BigInt(params.amount), decimals, price) : 0

  await resolveExpiredHolds(params.userId)

  return prisma.$transaction(async (tx) => {
    const subject = await capSubject(params.userId, tx)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subject.l1Address}))`
    const now = Date.now()
    const allRows = await fetchHeldRows(subject.userIds, tx)
    const held24h = sumAt(allRows, now, DEPOSIT_CAP_WINDOW_MS)
    const settled24h = sumAt(allRows, now, DEPOSIT_CAP_WINDOW_MS, ['consumed'])
    const reservedUsd = Math.max(0, held24h - settled24h)

    if (limitUsd > 0 && held24h + requestedUsd > limitUsd + 1e-6) {
      return { ok: false, limitUsd, confirmedUsd: settled24h, reservedUsd }
    }

    if (requestedUsd > 0) {
      await tx.attestationReservation.create({
        data: {
          fkUserId: params.userId,
          nonce: params.nonce.toString(),
          amountUsd: requestedUsd,
          method: 'poch',
          expiresAt: params.expiresAt,
        },
      })
    }
    return { ok: true, limitUsd, confirmedUsd: settled24h, reservedUsd }
  })
}

export interface DepositLimitResult {
  /** Whether the cap is configured (BRIDGE_MAX_DEPOSIT_USD > 0). */
  enabled: boolean
  /** True when confirmed + requested would exceed the cap. */
  overLimit: boolean
  limitUsd: number
  confirmedUsd: number
  requestedUsd: number
  /** Budget left for this user (cap − confirmed), floored at 0. */
  remainingUsd: number
}

/**
 * Read-only view of the Alpha per-day (rolling 24h) deposit cap for a user, for
 * the pre-check routes and UI. `confirmedUsd` is settled (past-window) 24h usage;
 * `overLimit` folds in unsettled holds too so the button pre-blocks a deposit the
 * signing path would reject. Gating + charging is done atomically by
 * reservePassportBudget / reservePochBudget, not here.
 */
export async function evaluateDepositLimit(params: {
  userId: string
  amount?: string
  tokenSymbol?: string
  tokenDecimals?: number
}): Promise<DepositLimitResult> {
  const limitUsd = getBridgeMaxDepositUsd()
  if (limitUsd <= 0) {
    return { enabled: false, overLimit: false, limitUsd: 0, confirmedUsd: 0, requestedUsd: 0, remainingUsd: Infinity }
  }

  await resolveExpiredHolds(params.userId)
  const raw = await fetchHeldRows((await capSubject(params.userId)).userIds, prisma)
  const now = Date.now()
  const settled24h = sumAt(raw, now, DEPOSIT_CAP_WINDOW_MS, ['consumed'])
  const held24h = sumAt(raw, now, DEPOSIT_CAP_WINDOW_MS)
  const symbol = params.tokenSymbol ?? 'USDC'
  const decimals = canonicalDecimals(symbol, TOKEN_REGISTRY)
  const requestedUsd = params.amount ? valueBaseUnitsUsd(BigInt(params.amount), decimals, getTokenPriceUsd(symbol, null)) : 0
  const remainingUsd = Math.max(0, limitUsd - settled24h)
  // Small epsilon so float rounding (e.g. 10.000000001) doesn't false-trigger.
  const overLimit = held24h + requestedUsd > limitUsd + 1e-6
  return { enabled: true, overLimit, limitUsd, confirmedUsd: settled24h, requestedUsd, remainingUsd }
}

export interface TravelRuleResult {
  /** Whether the threshold is configured (TRAVEL_RULE_THRESHOLD_USD > 0). */
  enabled: boolean
  /** True when lifetime + requested reaches the threshold (passport tier must upgrade to POCH). */
  exceeded: boolean
  thresholdUsd: number
  lifetimeUsd: number
  requestedUsd: number
  /** Budget left before the threshold (threshold − lifetime), floored at 0; Infinity when disabled. */
  remainingUsd: number
}

/**
 * Evaluate the cumulative per-human Travel Rule threshold for a user's L1→L2 deposit.
 *
 * Uses SETTLED lifetime volume from the durable held ledger (no window) for the
 * L1 address — the only half SIWE proves, and so the only stable anchor.
 * `exceeded` is settled-only so a transient hold does not route the user to Clean
 * Hands. Only the passport tier consults this; POCH-verified humans are exempt
 * (POCH holds are excluded from this lifetime sum).
 */
export async function evaluateTravelRuleThreshold(params: {
  userId: string
  amount?: string
  tokenSymbol?: string
  tokenDecimals?: number
}): Promise<TravelRuleResult> {
  const thresholdUsd = getTravelRuleThresholdUsd()
  if (thresholdUsd <= 0) {
    return { enabled: false, exceeded: false, thresholdUsd: 0, lifetimeUsd: 0, requestedUsd: 0, remainingUsd: Infinity }
  }

  await resolveExpiredHolds(params.userId)
  const raw = await fetchHeldRows((await capSubject(params.userId)).userIds, prisma, ['passport'])
  const now = Date.now()
  const lifetimeUsd = sumAt(raw, now, null, ['consumed'])
  const symbol = params.tokenSymbol ?? 'USDC'
  const decimals = canonicalDecimals(symbol, TOKEN_REGISTRY)
  const requestedUsd = params.amount ? valueBaseUnitsUsd(BigInt(params.amount), decimals, getTokenPriceUsd(symbol, null)) : 0
  const remainingUsd = Math.max(0, thresholdUsd - lifetimeUsd)
  // Legal threshold triggers at "$1,000 or more" → `>=`; epsilon guards float rounding.
  const exceeded = lifetimeUsd + requestedUsd >= thresholdUsd - 1e-6
  return { enabled: true, exceeded, thresholdUsd, lifetimeUsd, requestedUsd, remainingUsd }
}

/**
 * Issue a fresh attestation nonce.
 *
 * A DB counter can't be the source of truth here: the authoritative used-nonce
 * state lives on-chain in `TokenPortal.cleanHandsNonces`/`passportNonces`, which
 * persists for the life of the deployed portal. Whenever the app DB is reset or
 * redeployed (routine on testnet) the counter falls behind on-chain reality and
 * re-issues an already-consumed nonce, so the deposit reverts with
 * `CleanHandsNonceUsed()` / `PassportNonceUsed()`.
 *
 * Drawing a random nonce sidesteps that entirely: the on-chain mapping is keyed
 * by the full nonce value, so a random draw is effectively collision-free
 * (2^-128) and cannot desync across resets. Kept to 128 bits so it also fits a
 * BN254 field element — the L2 Schnorr attestation does `new Fr(nonce)`.
 */
export function getNextNonce(): bigint {
  const bytes = randomBytes(16)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}
