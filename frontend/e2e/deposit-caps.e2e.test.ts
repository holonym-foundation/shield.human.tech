/**
 * A User row is an (l1Address, l2Address) pair, so the caps have to be counted
 * against the L1 address rather than the row: SIWE proves only that half, and a
 * per-row count handed the same wallet a fresh allowance for every Aztec address
 * it paired with. Rotating the L2 half was free, and it bought a whole new cap.
 *
 * These drive the real routes with two sessions that share one wallet.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { POST as pochRoute } from '@/app/api/attestation/poch/route'
import { GET as pochCheckRoute } from '@/app/api/attestation/poch/check/route'
import { GET as passportCheckRoute } from '@/app/api/attestation/passport/check/route'

import { db, liveHold, resetDb, settleHold } from './helpers/db'
import { call } from './helpers/request'
import { aztecAddress, login, loginWithL2, type Session } from './helpers/session'
import { installUpstreams } from './helpers/upstreams'
import { E2E_ENV } from './helpers/env'

const USDC = 10n ** 6n
const DAILY_CAP = Number(E2E_ENV.BRIDGE_MAX_DEPOSIT_USD)
const THRESHOLD = Number(E2E_ENV.TRAVEL_RULE_THRESHOLD_USD)

const attestPoch = (session: Session, body: Record<string, unknown> = {}) =>
  call(pochRoute, '/api/attestation/poch', { method: 'POST', token: session.token, body })

const pochCheck = (session: Session) =>
  call(pochCheckRoute, '/api/attestation/poch/check', { token: session.token })

const passportCheck = (session: Session) =>
  call(passportCheckRoute, '/api/attestation/passport/check', { token: session.token })

let actor = 2000

beforeEach(async () => {
  actor++
  await resetDb()
  installUpstreams()
})

/** Two sessions for one wallet: the same proven L1, two different Aztec accounts. */
async function bothAccounts(): Promise<[Session, Session]> {
  const first = await login(actor)
  const second = await loginWithL2(actor, aztecAddress(actor + 90_000))
  expect(second.l1Address).toBe(first.l1Address)
  expect(second.userId).not.toBe(first.userId)
  return [first, second]
}

describe('one wallet, several Aztec accounts', () => {
  it('shares a single outstanding-hold total across both accounts', async () => {
    const [first, second] = await bothAccounts()
    await liveHold(first, 400, { method: 'poch' })
    await liveHold(second, 350, { method: 'poch' })

    expect((await passportCheck(first)).body.reservedUsd).toBeCloseTo(750, 2)
    expect((await passportCheck(second)).body.reservedUsd).toBeCloseTo(750, 2)
  })

  it('spends one daily cap between them, not one each', async () => {
    const [first, second] = await bothAccounts()
    await settleHold(first, DAILY_CAP - 5_000, { method: 'poch' })
    await settleHold(second, 5_000, { method: 'poch' })

    const result = await attestPoch(second, { amount: (100n * USDC).toString() })

    expect(result.status).toBe(403)
    expect(result.body.reason).toBe('deposit_limit')
  })

  it('reaches the Travel Rule threshold on the two accounts combined', async () => {
    const [first, second] = await bothAccounts()
    await settleHold(first, THRESHOLD * 0.6)
    await settleHold(second, THRESHOLD * 0.6)

    const { body } = await passportCheck(first)

    expect(body.travelRuleExceeded).toBe(true)
    expect(body.eligible).toBe(false)
  })

  it('keeps a POCH charge out of the Travel Rule sum, however it is spread', async () => {
    // The threshold is what routes the passport tier to Clean Hands; volume from
    // an already-verified human must not push them toward it a second time.
    const [first, second] = await bothAccounts()
    await settleHold(first, THRESHOLD * 0.6)
    await settleHold(second, THRESHOLD * 0.6, { method: 'poch' })

    const { body } = await passportCheck(first)

    expect(body.travelRuleExceeded).toBeUndefined()
    expect(body.eligible).toBe(true)
  })

  it('never counts a different wallet, whatever Aztec account it uses', async () => {
    const [first] = await bothAccounts()
    const stranger = await login(actor + 5_000)
    await settleHold(stranger, DAILY_CAP, { method: 'poch' })
    await settleHold(first, 400, { method: 'poch' })

    const { body } = await pochCheck(first)

    expect(body.remainingUsd).toBeCloseTo(DAILY_CAP - 400, 2)
    expect(body.depositLimitReached).toBe(false)
  })

  it('charges the hold the signing route writes against the same wallet total', async () => {
    // Seeded holds are aggregated above; this is the one the route itself writes,
    // so the ledger the caps read is the ledger the signing path feeds.
    const session = await login(actor)

    const signed = await attestPoch(session, { amount: (1_000n * USDC).toString() })
    expect(signed.status).toBe(200)

    const hold = await db.attestationReservation.findUnique({ where: { nonce: signed.body.nonce } })
    expect(hold?.fkUserId).toBe(session.userId)
    expect((await passportCheck(session)).body.reservedUsd).toBeCloseTo(1_000, 2)
  })
})
