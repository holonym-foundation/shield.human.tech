import { randomBytes } from 'node:crypto'
import { BridgeDirection, BridgeOperationStatus, Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { getTokenPriceUsd } from '@/utils/fuelPricing'
import { getBridgeMaxDepositUsd, getTravelRuleThresholdUsd } from './attestation'
import { ROLLUP_VERSION } from '@/config'

const CURRENT_ROLLUP_VERSION = BigInt(ROLLUP_VERSION)

// L1→L2 statuses where funds are locked on L1 (the deposit tx confirmed).
// Excludes 'pending' (operation row exists but no L1 deposit yet — this is the
// state of the in-flight deposit at attestation time, so excluding it avoids
// double-counting and prevents abandoned 'pending' rows from locking a user)
// and 'failed' (no funds moved).
const LOCKED_DEPOSIT_STATUSES: BridgeOperationStatus[] = [
  BridgeOperationStatus.deposited,
  BridgeOperationStatus.claimed,
  BridgeOperationStatus.submitted,
  BridgeOperationStatus.ready,
  BridgeOperationStatus.pending_finalize,
  BridgeOperationStatus.completed,
]

/**
 * Bindings that apply on the current rollup. Rows written before bindings were scoped per
 * rollup have a NULL rollupVersion; until they are backfilled they still count here, or a
 * wallet whose existing link is NULL could bind a second account.
 */
export function currentRollupBindingWhere(l1Address: string, l2Address: string) {
  return {
    AND: [
      { OR: [{ rollupVersion: CURRENT_ROLLUP_VERSION }, { rollupVersion: null }] },
      { OR: [{ l1Address }, { l2Address }] },
    ],
  }
}

/**
 * Enforce 1:1 binding between L1 and L2 addresses.
 * Creates the binding on first use; rejects if either address is already bound elsewhere.
 * Returns an error string if binding is violated, null if OK.
 */
export async function enforceAddressBinding(
  l1Address: string,
  l2Address: string,
  opts?: { l2NetworkVerified?: boolean | null },
): Promise<string | null> {
  const existing = await prisma.addressBinding.findFirst({
    where: currentRollupBindingWhere(l1Address, l2Address),
  })

  if (!existing) {
    // Creating the binding is irreversible, so it must not be done from an address whose
    // network we could not confirm. The connect-time check fails open (a wallet that cannot
    // report its network still connects), and #2295 showed Azguard handing over an
    // address derived on a different network than the one its UI displayed. Binding that
    // would lock the wallet out of this deployment permanently. Reading an existing binding
    // is unaffected, so an unverified wallet can still browse, resume and see balances.
    if (opts && opts.l2NetworkVerified !== true) {
      return (
        'Could not confirm which Aztec network your wallet is on, and linking it is permanent. ' +
        'Disconnect and reconnect your Aztec wallet, then try again.'
      )
    }
    try {
      await prisma.addressBinding.create({
        data: { l1Address, l2Address, rollupVersion: CURRENT_ROLLUP_VERSION },
      })
    } catch (err: any) {
      // P2002 = unique constraint violation (concurrent request created it first).
      // Re-check to see if the binding matches or conflicts.
      if (err?.code === 'P2002') {
        return enforceAddressBinding(l1Address, l2Address)
      }
      throw err
    }
    return null
  }

  if (existing.l1Address === l1Address && existing.l2Address === l2Address) {
    return null
  }

  // The binding is permanent by design: `User` is unique on (l1Address, l2Address) and the
  // deposit cap is summed per user, so allowing a rebind would hand out a fresh daily cap on
  // every Aztec account rotation. The message therefore has to explain a dead end rather than
  // hint at a fix that does not exist (#2065).
  if (existing.l1Address === l1Address) {
    // Safe to name the bound L2: the caller authenticated as this L1, so it is their own
    // binding, and it is the one fact that tells them which account to reconnect.
    return (
      `This wallet is already linked to Aztec account ${shortenAddress(existing.l2Address)}. ` +
      `Reconnect that account to continue. For security, links are permanent and cannot be changed.`
    )
  }

  // Deliberately does NOT name existing.l1Address: that is a THIRD PARTY's wallet, and the
  // caller has proven nothing about it. Naming it would leak one user's address to another.
  return (
    `This Aztec account is already linked to a different wallet. ` +
    `Connect the wallet you first used with it. For security, links are permanent and cannot be changed.`
  )
}

/** `0x1aff…c198` — enough to recognise an account without an unreadable wall of hex. */
function shortenAddress(address: string): string {
  if (address.length <= 14) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
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

/**
 * Sum a user's confirmed (funds-locked) L1→L2 deposits within the rolling
 * per-day window, in USD.
 *
 * Used by the attestation endpoints to enforce the Alpha per-day deposit cap.
 * The cap is per-user, per-24h (rolling): only deposits with createdAt within
 * DEPOSIT_CAP_WINDOW_MS of now are counted, so budget frees up as old deposits
 * age out. USDC (the only Alpha-mainnet token) is USD-pegged, so the hardcoded
 * fallback price (USDC=$1) is exact and no live price feed is needed.
 */
// Volume caps follow the human's L1 address across Aztec rollups: each rollup binds the same L1 to a
// new L2 account (a new User row), so summing per row would reset the caps at every migration.
async function userIdsSharingL1(userId: string, client: Prisma.TransactionClient): Promise<string[]> {
  const owner = await client.user.findUnique({ where: { id: userId }, select: { l1Address: true } })
  if (!owner) return [userId]
  const users = await client.user.findMany({ where: { l1Address: owner.l1Address }, select: { id: true } })
  return users.length > 0 ? users.map((u) => u.id) : [userId]
}

export async function getConfirmedDepositUsd(
  userId: string,
  windowMs: number | null = DEPOSIT_CAP_WINDOW_MS,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const userIds = await userIdsSharingL1(userId, client)
  const rows = await client.bridgeActivity.findMany({
    where: {
      fkUserId: { in: userIds },
      direction: BridgeDirection.L1_TO_L2,
      status: { in: LOCKED_DEPOSIT_STATUSES },
      // windowMs === null → all-time (Travel Rule cumulative sum); otherwise rolling window.
      ...(windowMs != null ? { createdAt: { gte: new Date(Date.now() - windowMs) } } : {}),
    },
    select: { amountL1: true, tokenDecimalsL1: true, tokenSymbolL1: true },
  })

  let total = 0
  for (const row of rows) {
    if (!row.amountL1) continue
    const decimals = row.tokenDecimalsL1 ?? 6
    const price = getTokenPriceUsd(row.tokenSymbolL1 ?? 'USDC', null)
    total += (Number(row.amountL1) / 10 ** decimals) * price
  }
  return total
}

/** Convert a USD amount to a token's base-unit bigint (for on-chain maxAmount). */
export function usdToTokenBaseUnits(usd: number, tokenSymbol: string, decimals: number): bigint {
  const price = getTokenPriceUsd(tokenSymbol, null)
  if (price <= 0 || usd <= 0) return 0n
  return BigInt(Math.floor((usd / price) * 10 ** decimals))
}

/**
 * Sum a user's outstanding attestation budget reservations, in USD.
 *
 * A reservation is written when a passport deposit attestation is signed, so this
 * counts budget that is authorized but not yet confirmed on-chain. Added to the
 * confirmed-deposit sum it closes the TOCTOU race where concurrent attestation
 * requests each read only confirmed usage and each receive a full-budget signature.
 *
 * Once the reservation's deposit settles on-chain (a confirmed deposit carrying
 * the same attestation nonce) getConfirmedDepositUsd already counts that deposit,
 * so a reservation must not re-charge the amount now confirmed against it —
 * otherwise a user's own confirmed deposit blocks their next one until the
 * reservation's TTL (<= the attestation deadline, <= 30m). Each reservation therefore
 * contributes only the portion of its signed ceiling NOT yet confirmed against it:
 * max(0, signedMax - confirmedForThisNonce). Combined with getConfirmedDepositUsd
 * the pair counts max(signedMax, confirmed) >= signedMax, so the reservation stays
 * a floor the client-supplied confirmed amount cannot dip below. Fully retiring it
 * would let a client under-report (or forge) a confirmed deposit's amount to free
 * the signed budget while the still-valid attestation is spent on-chain for its
 * full ceiling — reopening the cumulative-cap bypass. Matching counts confirmed
 * statuses only, never 'pending' (client-supplied, unverified).
 */
export async function getReservedDepositUsd(
  userId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<number> {
  const userIds = await userIdsSharingL1(userId, client)
  const rows = await client.attestationReservation.findMany({
    where: { fkUserId: { in: userIds }, expiresAt: { gt: new Date() } },
    select: { amountUsd: true, nonce: true },
  })
  if (rows.length === 0) return 0

  const settled = await client.bridgeActivity.findMany({
    where: {
      fkUserId: { in: userIds },
      direction: BridgeDirection.L1_TO_L2,
      status: { in: LOCKED_DEPOSIT_STATUSES },
      attestationNonce: { in: rows.map((r) => r.nonce) },
    },
    select: { attestationNonce: true, amountL1: true, tokenDecimalsL1: true, tokenSymbolL1: true },
  })
  const confirmedByNonce = new Map<string, number>()
  for (const d of settled) {
    if (!d.attestationNonce || !d.amountL1) continue
    const decimals = d.tokenDecimalsL1 ?? 6
    const price = getTokenPriceUsd(d.tokenSymbolL1 ?? 'USDC', null)
    const usd = (Number(d.amountL1) / 10 ** decimals) * price
    confirmedByNonce.set(d.attestationNonce, (confirmedByNonce.get(d.attestationNonce) ?? 0) + usd)
  }
  return rows.reduce((sum, r) => sum + Math.max(0, r.amountUsd - (confirmedByNonce.get(r.nonce) ?? 0)), 0)
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
 * Atomically evaluate the passport deposit caps AND reserve the resulting budget.
 *
 * Runs under a per-user advisory lock inside a transaction so the read (confirmed
 * deposits + outstanding reservations) and the write (this attestation's reservation)
 * cannot be interleaved by concurrent requests — the fix for the cumulative-cap
 * TOCTOU race. Usage counts confirmed deposits plus non-expired reservations against
 * both the lifetime Travel Rule threshold and the rolling-24h Alpha cap; the signed
 * maxAmount is capped to the smaller remaining budget, and that ceiling is reserved.
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
  const price = getTokenPriceUsd(params.tokenSymbol, null)

  return prisma.$transaction(async (tx) => {
    // Hold a per-user lock until commit so a concurrent request for the same user
    // blocks here and then reads the reservation this transaction wrote.
    // $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which the
    // query deserializer rejects ("cannot deserialize column of type 'void'").
    // Keyed on the L1 address, the scope the budget is summed over, so requests from the same human
    // on two rollups (two User rows) still serialize.
    const lockOwner = await tx.user.findUnique({ where: { id: params.userId }, select: { l1Address: true } })
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockOwner?.l1Address ?? params.userId}))`

    const reservedUsd = await getReservedDepositUsd(params.userId, tx)
    let maxAmount = params.perTxMaxAmount
    let confirmedUsd = 0
    let lifetimeUsd = 0

    if (thresholdUsd > 0) {
      lifetimeUsd = await getConfirmedDepositUsd(params.userId, null, tx)
      const remainingUsd = Math.max(0, thresholdUsd - (lifetimeUsd + reservedUsd))
      if (remainingUsd <= 0) {
        return { ok: false, reason: 'travel_rule', thresholdUsd, limitUsd, confirmedUsd, lifetimeUsd, reservedUsd, maxAmount: 0n }
      }
      const remainingBaseUnits = usdToTokenBaseUnits(remainingUsd, params.tokenSymbol, params.tokenDecimals)
      if (remainingBaseUnits < maxAmount) maxAmount = remainingBaseUnits
    }

    if (limitUsd > 0) {
      confirmedUsd = await getConfirmedDepositUsd(params.userId, DEPOSIT_CAP_WINDOW_MS, tx)
      const remainingUsd = Math.max(0, limitUsd - (confirmedUsd + reservedUsd))
      if (remainingUsd <= 0) {
        return { ok: false, reason: 'deposit_limit', thresholdUsd, limitUsd, confirmedUsd, lifetimeUsd, reservedUsd, maxAmount: 0n }
      }
      const remainingBaseUnits = usdToTokenBaseUnits(remainingUsd, params.tokenSymbol, params.tokenDecimals)
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

    const amountUsd = price > 0 ? (Number(maxAmount) / 10 ** params.tokenDecimals) * price : 0
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
 * Evaluate the Alpha per-day (rolling 24h) deposit cap for a user's L1→L2 deposit.
 * Only meaningful for deposits — callers must not gate withdrawals with this.
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

  const confirmedUsd = await getConfirmedDepositUsd(params.userId)
  const decimals = params.tokenDecimals ?? 6
  const requestedUsd = params.amount
    ? (Number(params.amount) / 10 ** decimals) * getTokenPriceUsd(params.tokenSymbol ?? 'USDC', null)
    : 0
  const remainingUsd = Math.max(0, limitUsd - confirmedUsd)
  // Small epsilon so float rounding (e.g. 10.000000001) doesn't false-trigger.
  const overLimit = confirmedUsd + requestedUsd > limitUsd + 1e-6
  return { enabled: true, overLimit, limitUsd, confirmedUsd, requestedUsd, remainingUsd }
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
 * Sums ALL-TIME confirmed L1→L2 deposits (no window) for the bound (L1,L2) User —
 * the only stable per-human anchor, since AddressBinding enforces 1 L1 ↔ 1 L2.
 * Only the passport tier consults this; POCH-verified humans are exempt.
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

  const lifetimeUsd = await getConfirmedDepositUsd(params.userId, null)
  const decimals = params.tokenDecimals ?? 6
  const requestedUsd = params.amount
    ? (Number(params.amount) / 10 ** decimals) * getTokenPriceUsd(params.tokenSymbol ?? 'USDC', null)
    : 0
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
