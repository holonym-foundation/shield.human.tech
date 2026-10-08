import { beforeEach, describe, expect, it, vi } from 'vitest'

const { prismaMock, caps } = vi.hoisted(() => ({
  prismaMock: {
    addressBinding: { findFirst: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn() },
    bridgeActivity: { findMany: vi.fn() },
    attestationReservation: { findMany: vi.fn(), create: vi.fn() },
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
  enforceAddressBinding,
  evaluateDepositLimit,
  evaluateTravelRuleThreshold,
  getConfirmedDepositUsd,
  getNextNonce,
  getReservedDepositUsd,
  reservePassportBudget,
  usdToTokenBaseUnits,
} from './address-binding'

/** A confirmed USDC deposit row as `getConfirmedDepositUsd` selects it. */
const usdcDeposit = (usd: number, extra: Record<string, unknown> = {}) => ({
  amountL1: String(BigInt(Math.round(usd * 1e6))),
  tokenDecimalsL1: 6,
  tokenSymbolL1: 'USDC',
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  caps.limitUsd = 25_000
  caps.thresholdUsd = 1_000
  prismaMock.user.findUnique.mockResolvedValue({ l1Address: '0xl1' })
  prismaMock.user.findMany.mockResolvedValue([{ id: 'user-1' }])
  prismaMock.bridgeActivity.findMany.mockResolvedValue([])
  prismaMock.attestationReservation.findMany.mockResolvedValue([])
  prismaMock.attestationReservation.create.mockResolvedValue({})
  prismaMock.$executeRaw.mockResolvedValue(1)
  prismaMock.$transaction.mockImplementation((fn: any) => fn(prismaMock))
})

describe('getConfirmedDepositUsd', () => {
  it('sums deposits across every account the L1 address has bound on any rollup', async () => {
    // The same human on a later rollup is a new User row; their volume must carry over.
    prismaMock.user.findMany.mockResolvedValue([{ id: 'user-1' }, { id: 'user-on-next-rollup' }])

    await getConfirmedDepositUsd('user-1')
    const { where } = prismaMock.bridgeActivity.findMany.mock.calls[0][0]
    expect(where.fkUserId).toEqual({ in: ['user-1', 'user-on-next-rollup'] })
  })

  it('converts base units to USD using the row decimals and symbol', async () => {
    prismaMock.bridgeActivity.findMany.mockResolvedValue([
      usdcDeposit(400),
      { amountL1: String(10n ** 18n), tokenDecimalsL1: 18, tokenSymbolL1: 'WETH' },
    ])

    // WETH has no live feed here, so the Sepolia fallback ($2100) applies.
    expect(await getConfirmedDepositUsd('user-1')).toBeCloseTo(2500, 6)
  })

  it('defaults a row with no decimals/symbol to 6-decimal USDC', async () => {
    prismaMock.bridgeActivity.findMany.mockResolvedValue([
      { amountL1: '1500000', tokenDecimalsL1: null, tokenSymbolL1: null },
    ])

    expect(await getConfirmedDepositUsd('user-1')).toBeCloseTo(1.5, 6)
  })

  it('ignores rows with no L1 amount instead of counting them as zero-decimals', async () => {
    prismaMock.bridgeActivity.findMany.mockResolvedValue([
      { amountL1: null, tokenDecimalsL1: 6, tokenSymbolL1: 'USDC' },
      usdcDeposit(10),
    ])

    expect(await getConfirmedDepositUsd('user-1')).toBeCloseTo(10, 6)
  })

  it('scopes the query to the rolling window by default', async () => {
    const before = Date.now()
    await getConfirmedDepositUsd('user-1')
    const after = Date.now()

    const { where } = prismaMock.bridgeActivity.findMany.mock.calls[0][0]
    expect(where.fkUserId).toEqual({ in: ['user-1'] })
    expect(where.direction).toBe('L1_TO_L2')
    const gte = where.createdAt.gte.getTime()
    expect(gte).toBeGreaterThanOrEqual(before - DEPOSIT_CAP_WINDOW_MS)
    expect(gte).toBeLessThanOrEqual(after - DEPOSIT_CAP_WINDOW_MS)
  })

  it('drops the date filter entirely when the window is null (Travel Rule lifetime sum)', async () => {
    await getConfirmedDepositUsd('user-1', null)

    const { where } = prismaMock.bridgeActivity.findMany.mock.calls[0][0]
    expect(where).not.toHaveProperty('createdAt')
  })

  it('never counts pending or failed deposits toward the cap', async () => {
    await getConfirmedDepositUsd('user-1')

    const { where } = prismaMock.bridgeActivity.findMany.mock.calls[0][0]
    expect(where.status.in).not.toContain('pending')
    expect(where.status.in).not.toContain('failed')
  })
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
    expect(prismaMock.bridgeActivity.findMany).not.toHaveBeenCalled()
  })

  it('only looks at reservations that have not expired', async () => {
    await getReservedDepositUsd('user-1')

    const { where } = prismaMock.attestationReservation.findMany.mock.calls[0][0]
    expect(where.fkUserId).toEqual({ in: ['user-1'] })
    expect(where.expiresAt.gt).toBeInstanceOf(Date)
  })

  it('sums the full ceiling of a hold whose deposit has not settled', async () => {
    prismaMock.attestationReservation.findMany.mockResolvedValue([
      { amountUsd: 400, nonce: '1' },
      { amountUsd: 250, nonce: '2' },
    ])

    expect(await getReservedDepositUsd('user-1')).toBe(650)
  })

  it('nets a settled deposit against its own hold so the user is not charged twice', async () => {
    prismaMock.attestationReservation.findMany.mockResolvedValue([{ amountUsd: 400, nonce: '1' }])
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(300, { attestationNonce: '1' })])

    expect(await getReservedDepositUsd('user-1')).toBeCloseTo(100, 6)
  })

  it('keeps the signed ceiling as a floor when the settled deposit exceeds it', async () => {
    prismaMock.attestationReservation.findMany.mockResolvedValue([{ amountUsd: 400, nonce: '1' }])
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(900, { attestationNonce: '1' })])

    // Clamped at 0: a hold can only ever add budget usage, never refund it.
    expect(await getReservedDepositUsd('user-1')).toBe(0)
  })

  it('does not let a deposit settled under one nonce discharge another hold', async () => {
    prismaMock.attestationReservation.findMany.mockResolvedValue([
      { amountUsd: 400, nonce: '1' },
      { amountUsd: 400, nonce: '2' },
    ])
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(400, { attestationNonce: '1' })])

    expect(await getReservedDepositUsd('user-1')).toBeCloseTo(400, 6)
  })
})

describe('evaluateDepositLimit', () => {
  it('reports the cap as disabled when it is not configured', async () => {
    caps.limitUsd = 0

    const result = await evaluateDepositLimit({ userId: 'user-1', amount: '999999000000' })

    expect(result).toMatchObject({ enabled: false, overLimit: false, remainingUsd: Infinity })
    expect(prismaMock.bridgeActivity.findMany).not.toHaveBeenCalled()
  })

  it('allows a deposit that lands exactly on the cap', async () => {
    caps.limitUsd = 1_000
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(600)])

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
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(600)])

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
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(600)])

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
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(1_500)])

    const result = await evaluateDepositLimit({ userId: 'user-1' })

    expect(result.remainingUsd).toBe(0)
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
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(900)])

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
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(900)])

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
    await evaluateTravelRuleThreshold({ userId: 'user-1' })

    const { where } = prismaMock.bridgeActivity.findMany.mock.calls[0][0]
    expect(where).not.toHaveProperty('createdAt')
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
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(700)])

    const result = await reservePassportBudget(params)

    expect(result.ok).toBe(true)
    // Travel Rule leaves $300, well below both the per-tx max and the daily cap.
    expect(result.maxAmount).toBe(300_000_000n)
  })

  it('charges outstanding holds against the remaining budget', async () => {
    caps.thresholdUsd = 1_000
    prismaMock.attestationReservation.findMany.mockResolvedValue([{ amountUsd: 400, nonce: '7' }])
    prismaMock.bridgeActivity.findMany.mockResolvedValue([])

    const result = await reservePassportBudget(params)

    expect(result.reservedUsd).toBe(400)
    expect(result.maxAmount).toBe(600_000_000n)
  })

  it('refuses once lifetime volume reaches the Travel Rule threshold', async () => {
    caps.thresholdUsd = 1_000
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(1_000)])

    const result = await reservePassportBudget(params)

    expect(result).toMatchObject({ ok: false, reason: 'travel_rule', maxAmount: 0n })
    expect(prismaMock.attestationReservation.create).not.toHaveBeenCalled()
  })

  it('refuses once the rolling daily cap is spent', async () => {
    caps.thresholdUsd = 0
    caps.limitUsd = 1_000
    prismaMock.bridgeActivity.findMany.mockResolvedValue([usdcDeposit(1_000)])

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
    prismaMock.addressBinding.findFirst.mockResolvedValue(null)
    prismaMock.addressBinding.create.mockResolvedValue({})

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.create).toHaveBeenCalledWith({
      data: { l1Address: '0xl1', l2Address: '0xl2', rollupVersion: expect.any(BigInt) },
    })
  })

  it('only looks for bindings on the current rollup', async () => {
    // A binding made on a previous Aztec rollup names an account that does not exist on this one,
    // so it must not block the wallet from binding its new account here.
    prismaMock.addressBinding.findFirst.mockResolvedValue(null)
    prismaMock.addressBinding.create.mockResolvedValue({})

    await enforceAddressBinding('0xl1', '0xl2')
    const { where } = prismaMock.addressBinding.findFirst.mock.calls[0][0]
    const [rollup] = where.AND
    expect(typeof rollup.OR[0].rollupVersion).toBe('bigint')
  })

  it('still honours bindings written before they were scoped per rollup', async () => {
    // Unbackfilled rows have a NULL rollupVersion; ignoring them would let the wallet
    // bind a second account.
    prismaMock.addressBinding.findFirst.mockResolvedValue(null)
    prismaMock.addressBinding.create.mockResolvedValue({})

    await enforceAddressBinding('0xl1', '0xl2')
    const { where } = prismaMock.addressBinding.findFirst.mock.calls[0][0]
    expect(where.AND[0].OR).toContainEqual({ rollupVersion: null })
  })

  it('accepts the same pair again', async () => {
    prismaMock.addressBinding.findFirst.mockResolvedValue({ l1Address: '0xl1', l2Address: '0xl2' })

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.create).not.toHaveBeenCalled()
  })

  it('refuses to CREATE a binding when the wallet network was not verified', async () => {
    prismaMock.addressBinding.findFirst.mockResolvedValue(null)

    const msg = await enforceAddressBinding('0xl1', '0xl2', { l2NetworkVerified: null })
    expect(msg).toMatch(/Could not confirm which Aztec network/)
    // The whole point: nothing irreversible is written.
    expect(prismaMock.addressBinding.create).not.toHaveBeenCalled()
  })

  it('creates the binding once the network is verified', async () => {
    prismaMock.addressBinding.findFirst.mockResolvedValue(null)

    expect(await enforceAddressBinding('0xl1', '0xl2', { l2NetworkVerified: true })).toBeNull()
    expect(prismaMock.addressBinding.create).toHaveBeenCalled()
  })

  it('still READS an existing matching binding when the network is unverified', async () => {
    // An unverified wallet must keep working for everything that is not a permanent write.
    prismaMock.addressBinding.findFirst.mockResolvedValue({ l1Address: '0xl1', l2Address: '0xl2' })

    expect(await enforceAddressBinding('0xl1', '0xl2', { l2NetworkVerified: null })).toBeNull()
  })

  it('rejects a second L2 address for an already-bound L1 address', async () => {
    prismaMock.addressBinding.findFirst.mockResolvedValue({ l1Address: '0xl1', l2Address: '0xother' })

    const msg = await enforceAddressBinding('0xl1', '0xl2')
    // Names the bound Aztec account, because that is what tells the user which one to reconnect.
    expect(msg).toMatch(/already linked to Aztec account/)
    expect(msg).toMatch(/permanent/)
  })

  it('rejects a second L1 address for an already-bound L2 address', async () => {
    prismaMock.addressBinding.findFirst.mockResolvedValue({ l1Address: '0xother', l2Address: '0xl2' })

    const msg = await enforceAddressBinding('0xl1', '0xl2')
    expect(msg).toMatch(/already linked to a different wallet/)
    // Must never leak the third party's L1 address to this caller.
    expect(msg).not.toContain('0xother')
  })

  it('re-reads instead of failing when a concurrent request wins the insert', async () => {
    prismaMock.addressBinding.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ l1Address: '0xl1', l2Address: '0xl2' })
    prismaMock.addressBinding.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))

    expect(await enforceAddressBinding('0xl1', '0xl2')).toBeNull()
    expect(prismaMock.addressBinding.findFirst).toHaveBeenCalledTimes(2)
  })

  it('propagates any error that is not a unique-constraint race', async () => {
    prismaMock.addressBinding.findFirst.mockResolvedValue(null)
    prismaMock.addressBinding.create.mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' }))

    await expect(enforceAddressBinding('0xl1', '0xl2')).rejects.toThrow('down')
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
