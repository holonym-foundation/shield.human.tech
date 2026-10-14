import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prismaMock, caps } = vi.hoisted(() => ({
  prismaMock: {
    addressBinding: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    attestationReservation: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  caps: { limitUsd: 25_000, thresholdUsd: 1_000 },
}))

vi.mock('./prisma', () => ({ prisma: prismaMock }))
vi.mock('./attestation', () => ({
  getBridgeMaxDepositUsd: () => caps.limitUsd,
  getTravelRuleThresholdUsd: () => caps.thresholdUsd,
}))

import {
  ATTESTATION_TTL_SECONDS,
  DEPOSIT_CAP_WINDOW_MS,
  checkAddressBindingConflict,
  enforceAddressBinding,
  evaluateDepositLimit,
  evaluateTravelRuleThreshold,
  getNextNonce,
  getReservedDepositUsd,
  reservePassportBudget,
  usdToTokenBaseUnits,
} from './address-binding'

const HOUR_MS = 3_600_000

interface HoldFixture {
  amountUsd: number
  createdAt: Date
  expiresAt: Date
  method: string
}

/** A hold past its signed deposit window: a committed charge against the caps. */
const settledHold = (usd: number, extra: Partial<HoldFixture> = {}): HoldFixture => ({
  amountUsd: usd,
  createdAt: new Date(Date.now() - 2 * HOUR_MS),
  expiresAt: new Date(Date.now() - HOUR_MS),
  method: 'passport',
  ...extra,
})

/** A live hold: signed, still inside its deposit window, deposit not yet landed. */
const outstandingHold = (usd: number, extra: Partial<HoldFixture> = {}): HoldFixture => ({
  amountUsd: usd,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + HOUR_MS),
  method: 'passport',
  ...extra,
})

/**
 * Every cap read first sweeps expired holds off the same table, so a fixture fed
 * to a single `mockResolvedValue` would come back as a stale row and be sent to
 * the on-chain resolver. Discriminate on the sweep's `expiresAt` filter, and
 * apply the method filter the way the database would.
 */
const seedHolds = (rows: HoldFixture[]) => {
  prismaMock.attestationReservation.findMany.mockImplementation(async ({ where }: any) => {
    if (where.expiresAt) return []
    const methods: string[] | undefined = where.method?.in
    return methods ? rows.filter((r) => methods.includes(r.method)) : rows
  })
}

/** The hold read itself, skipping the expiry sweep that shares this mock. */
const heldRowsQuery = () =>
  prismaMock.attestationReservation.findMany.mock.calls
    .map(([args]: any) => args)
    .find((args: any) => !args.where.expiresAt)

beforeEach(() => {
  vi.clearAllMocks()
  caps.limitUsd = 25_000
  caps.thresholdUsd = 1_000
  seedHolds([])
  prismaMock.attestationReservation.create.mockResolvedValue({})
  prismaMock.attestationReservation.updateMany.mockResolvedValue({ count: 0 })
  prismaMock.addressBinding.findUnique.mockResolvedValue(null)
  prismaMock.user.findUnique.mockResolvedValue(null)
  prismaMock.user.findMany.mockResolvedValue([])
  prismaMock.$executeRaw.mockResolvedValue(1)
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock))
})

describe('usdToTokenBaseUnits', () => {
  it('converts through the token price and floors to whole base units', () => {
    expect(usdToTokenBaseUnits(1000, 'USDC', 6)).toBe(1_000_000_000n)
    expect(usdToTokenBaseUnits(2100, 'WETH', 18)).toBe(10n ** 18n)
  })

  it('returns zero rather than a negative allowance for a non-positive budget', () => {
    expect(usdToTokenBaseUnits(0, 'USDC', 6)).toBe(0n)
    expect(usdToTokenBaseUnits(-5, 'USDC', 6)).toBe(0n)
  })
})

describe('getReservedDepositUsd', () => {
  it('is zero when the user holds no live reservation', async () => {
    expect(await getReservedDepositUsd('user-1')).toBe(0)
  })

  it('counts every account sharing the proven L1 address, not just the calling one', async () => {
    // A User is an (l1Address, l2Address) pair, so counting per user row would
    // hand the same L1 address a fresh allowance for every L2 address it pairs with.
    prismaMock.user.findUnique.mockResolvedValue({ l1Address: '0xl1' })
    prismaMock.user.findMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }])
    seedHolds([outstandingHold(400)])

    expect(await getReservedDepositUsd('user-1')).toBe(400)
    expect(heldRowsQuery().where).toMatchObject({
      fkUserId: { in: ['user-1', 'user-2'] },
      amountUsd: { gt: 0 },
    })
  })

  it('sums the full ceiling of a hold whose deposit has not settled', async () => {
    seedHolds([outstandingHold(400), outstandingHold(250)])

    expect(await getReservedDepositUsd('user-1')).toBe(650)
  })

  it('stops reporting a hold as reserved once its deposit window has closed', async () => {
    seedHolds([outstandingHold(400), settledHold(250)])

    // The closed one is a spent charge, not budget still held for a pending deposit.
    expect(await getReservedDepositUsd('user-1')).toBe(400)
  })
})

describe('evaluateDepositLimit', () => {
  it('reports the cap as disabled when it is not configured', async () => {
    caps.limitUsd = 0

    const result = await evaluateDepositLimit({ userId: 'user-1', amount: '999999000000' })

    expect(result).toMatchObject({ enabled: false, overLimit: false, remainingUsd: Infinity })
    expect(prismaMock.attestationReservation.findMany).not.toHaveBeenCalled()
  })

  it('allows a deposit that lands exactly on the cap', async () => {
    caps.limitUsd = 1_000
    seedHolds([settledHold(600)])

    const result = await evaluateDepositLimit({
      userId: 'user-1',
      amount: '400000000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    expect(result.overLimit).toBe(false)
    expect(result.remainingUsd).toBeCloseTo(400, 6)
  })

  it('blocks the first deposit that crosses the cap', async () => {
    caps.limitUsd = 1_000
    seedHolds([settledHold(600)])

    const result = await evaluateDepositLimit({
      userId: 'user-1',
      amount: '400010000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    expect(result.overLimit).toBe(true)
  })

  it('does not trip the cap on float rounding noise below one micro-dollar', async () => {
    caps.limitUsd = 1_000
    seedHolds([settledHold(600)])

    const result = await evaluateDepositLimit({
      userId: 'user-1',
      amount: '400000001',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    expect(result.overLimit).toBe(false)
  })

  it('floors the remaining budget at zero once the cap is already spent', async () => {
    caps.limitUsd = 1_000
    seedHolds([settledHold(1_500)])

    const result = await evaluateDepositLimit({ userId: 'user-1' })

    expect(result.remainingUsd).toBe(0)
  })

  it('charges a settled hold once, at the ceiling the server signed', async () => {
    caps.limitUsd = 1_000
    seedHolds([settledHold(400)])

    const result = await evaluateDepositLimit({ userId: 'user-1' })

    // One row per nonce, valued at its signed ceiling: a deposit that lands under
    // the ceiling refunds nothing, and no client-authored deposit row can either
    // discharge the hold or be counted a second time beside it.
    expect(result.confirmedUsd).toBeCloseTo(400, 6)
    expect(result.remainingUsd).toBeCloseTo(600, 6)
  })

  it('pre-blocks against an outstanding hold, not only settled usage', async () => {
    caps.limitUsd = 1_000
    seedHolds([outstandingHold(900)])

    const result = await evaluateDepositLimit({
      userId: 'user-1',
      amount: '200000000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    // Nothing has settled, so the reported budget is still whole...
    expect(result.remainingUsd).toBeCloseTo(1_000, 6)
    // ...but the signing path would refuse this, so the UI has to refuse it first.
    expect(result.overLimit).toBe(true)
  })

  it('ages a charge out of the window on the server-set issuance time', async () => {
    caps.limitUsd = 1_000
    seedHolds([settledHold(600, { createdAt: new Date(Date.now() - DEPOSIT_CAP_WINDOW_MS - HOUR_MS) })])

    const result = await evaluateDepositLimit({ userId: 'user-1' })

    expect(result.confirmedUsd).toBe(0)
    expect(result.remainingUsd).toBeCloseTo(1_000, 6)
  })
})

describe('evaluateTravelRuleThreshold', () => {
  it('reports the threshold as disabled when it is not configured', async () => {
    caps.thresholdUsd = 0

    const result = await evaluateTravelRuleThreshold({ userId: 'user-1', amount: '999999000000' })

    expect(result).toMatchObject({ enabled: false, exceeded: false, remainingUsd: Infinity })
  })

  it('triggers at the threshold, not above it', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([settledHold(900)])

    const result = await evaluateTravelRuleThreshold({
      userId: 'user-1',
      amount: '100000000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    // The rule is "$1,000 or more", so landing exactly on it must already require POCH.
    expect(result.exceeded).toBe(true)
  })

  it('leaves a deposit just under the threshold on the passport tier', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([settledHold(900)])

    const result = await evaluateTravelRuleThreshold({
      userId: 'user-1',
      amount: '99000000',
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    expect(result.exceeded).toBe(false)
    expect(result.remainingUsd).toBeCloseTo(100, 6)
  })

  it('sums lifetime volume, not the rolling window', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([settledHold(600, { createdAt: new Date(Date.now() - 30 * 24 * HOUR_MS) })])

    const result = await evaluateTravelRuleThreshold({ userId: 'user-1' })

    // A charge from a month ago still counts: the threshold is cumulative, so
    // aging it out would let a user reset it by waiting a day.
    expect(result.lifetimeUsd).toBeCloseTo(600, 6)
  })

  it('does not count a POCH hold against the passport threshold', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([settledHold(600, { method: 'poch' }), settledHold(100)])

    const result = await evaluateTravelRuleThreshold({ userId: 'user-1' })

    // POCH-verified humans are exempt, so their volume must not push the passport
    // tier toward a Clean Hands upgrade it does not owe.
    expect(result.lifetimeUsd).toBeCloseTo(100, 6)
    expect(heldRowsQuery().where.method).toEqual({ in: ['passport'] })
  })

  it('does not route a user to Clean Hands on an outstanding hold alone', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([outstandingHold(1_000)])

    const result = await evaluateTravelRuleThreshold({ userId: 'user-1' })

    // The deposit may never land; only settled volume decides the tier.
    expect(result.exceeded).toBe(false)
  })
})

describe('reservePassportBudget', () => {
  const params = {
    userId: 'user-1',
    nonce: 42n,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    perTxMaxAmount: 1_000_000_000n,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
  }

  it('takes a per-user advisory lock before reading usage', async () => {
    await reservePassportBudget(params)

    expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(1)
    const [strings] = prismaMock.$executeRaw.mock.calls[0]
    expect(strings.join('')).toContain('pg_advisory_xact_lock')
  })

  it('caps the signed amount to the smallest remaining budget', async () => {
    caps.thresholdUsd = 1_000
    caps.limitUsd = 25_000
    seedHolds([settledHold(700)])

    const result = await reservePassportBudget(params)

    expect(result.ok).toBe(true)
    // Travel Rule leaves $300, well below both the per-tx max and the daily cap.
    expect(result.maxAmount).toBe(300_000_000n)
  })

  it('charges outstanding holds against the remaining budget', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([outstandingHold(400)])

    const result = await reservePassportBudget(params)

    expect(result.reservedUsd).toBe(400)
    expect(result.maxAmount).toBe(600_000_000n)
  })

  it('refuses once lifetime volume reaches the Travel Rule threshold', async () => {
    caps.thresholdUsd = 1_000
    seedHolds([settledHold(1_000)])

    const result = await reservePassportBudget(params)

    expect(result).toMatchObject({ ok: false, reason: 'travel_rule', maxAmount: 0n })
    expect(prismaMock.attestationReservation.create).not.toHaveBeenCalled()
  })

  it('refuses once the rolling daily cap is spent', async () => {
    caps.thresholdUsd = 0
    caps.limitUsd = 1_000
    seedHolds([settledHold(1_000)])

    const result = await reservePassportBudget(params)

    expect(result).toMatchObject({ ok: false, reason: 'deposit_limit', maxAmount: 0n })
    expect(prismaMock.attestationReservation.create).not.toHaveBeenCalled()
  })

  it('records the hold in USD against the nonce it signed', async () => {
    caps.thresholdUsd = 0
    caps.limitUsd = 25_000

    const result = await reservePassportBudget(params)

    expect(result.ok).toBe(true)
    const { data } = prismaMock.attestationReservation.create.mock.calls[0][0]
    expect(data).toMatchObject({
      fkUserId: 'user-1',
      nonce: '42',
      method: 'passport',
      expiresAt: params.expiresAt,
    })
    expect(data.amountUsd).toBeCloseTo(1_000, 6)
  })

  it('does not sign a zero allowance', async () => {
    caps.thresholdUsd = 0
    caps.limitUsd = 25_000
    const result = await reservePassportBudget({ ...params, perTxMaxAmount: 0n })

    expect(result.ok).toBe(false)
    expect(prismaMock.attestationReservation.create).not.toHaveBeenCalled()
  })

  it('expires holds within the attestation lifetime', () => {
    // A hold outliving the signature it guards would lock a user out for no reason.
    expect(ATTESTATION_TTL_SECONDS).toBeLessThanOrEqual(DEPOSIT_CAP_WINDOW_MS / 1000)
  })
})

describe('enforceAddressBinding', () => {
  it('creates the binding on first use', async () => {
    prismaMock.addressBinding.create.mockResolvedValue({})

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.create).toHaveBeenCalledWith({
      data: { l1Address: '0xl1', l2Address: '0xl2' },
    })
  })

  it('accepts the same pair again', async () => {
    prismaMock.addressBinding.findUnique.mockResolvedValue({ l1Address: '0xl1', l2Address: '0xl2' })

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.create).not.toHaveBeenCalled()
  })

  it('rejects a second L2 address for an already-bound L1 address', async () => {
    prismaMock.addressBinding.findUnique.mockResolvedValue({ l1Address: '0xl1', l2Address: '0xother' })

    expect(await enforceAddressBinding('0xl1', '0xl2')).toMatch(/L1 address .* already bound/)
  })

  it('looks the binding up by the L1 address alone', async () => {
    await enforceAddressBinding('0xl1', '0xl2')

    // SIWE proves the L1 half; the L2 half comes from caller-chosen `resources`
    // and is never proven. Matching on it would let a throwaway L1 claim a
    // stranger's Aztec account, and the row is permanent with no unbind path.
    expect(prismaMock.addressBinding.findUnique).toHaveBeenCalledWith({ where: { l1Address: '0xl1' } })
  })

  it('does not let an unproven L2 collision lock the claiming L1 out', async () => {
    // Someone else already recorded this L2 address under their own L1. The
    // insert loses the unique constraint, but this L1 has no binding of its own,
    // so it must be left free rather than refused for a pair it never proved.
    prismaMock.addressBinding.findUnique.mockResolvedValue(null)
    prismaMock.addressBinding.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
  })

  it('re-reads instead of failing when a concurrent request wins the insert', async () => {
    prismaMock.addressBinding.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ l1Address: '0xl1', l2Address: '0xl2' })
    prismaMock.addressBinding.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.findUnique).toHaveBeenCalledTimes(2)
  })

  it('propagates any error that is not a unique-constraint race', async () => {
    prismaMock.addressBinding.create.mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }))

    await expect(enforceAddressBinding('0xl1', '0xl2')).rejects.toThrow('down')
  })
})

describe('checkAddressBindingConflict', () => {
  it('reports a conflict without ever creating a binding', async () => {
    prismaMock.addressBinding.findUnique.mockResolvedValue({ l1Address: '0xl1', l2Address: '0xother' })

    expect(await checkAddressBindingConflict('0xl1', '0xl2')).toMatch(/L1 address .* already bound/)
    // The pre-check routes call this. A binding is permanent, so a read-shaped
    // request must never be able to consume an address on the user's behalf.
    expect(prismaMock.addressBinding.create).not.toHaveBeenCalled()
  })

  it('reports nothing, and still writes nothing, when the address is free', async () => {
    expect(await checkAddressBindingConflict('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.create).not.toHaveBeenCalled()
  })
})

describe('getNextNonce', () => {
  it('draws a 128-bit value that fits a BN254 field element', () => {
    for (let i = 0; i < 50; i++) {
      const nonce = getNextNonce()
      expect(nonce).toBeGreaterThanOrEqual(0n)
      expect(nonce).toBeLessThan(2n ** 128n)
    }
  })

  it('does not repeat, so a DB reset cannot replay a consumed nonce', () => {
    const seen = new Set(Array.from({ length: 200 }, () => getNextNonce().toString()))
    expect(seen.size).toBe(200)
  })
})
