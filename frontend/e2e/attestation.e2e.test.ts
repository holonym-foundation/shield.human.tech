import { beforeEach, describe, expect, it } from 'vitest'
import { encodePacked, keccak256, recoverMessageAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { POST as passportRoute } from '@/app/api/attestation/passport/route'
import { GET as passportCheckRoute } from '@/app/api/attestation/passport/check/route'

import { db, resetDb, settleDeposit } from './helpers/db'
import { call } from './helpers/request'
import { aztecAddress, login, loginWithL2, type Session } from './helpers/session'
import { installUpstreams, type UpstreamState } from './helpers/upstreams'
import { E2E_ENV } from './helpers/env'

const PORTAL = '0x00000000000000000000000000000000000000aa'
const BRIDGE = `0x${'0'.repeat(62)}bb`

/** The address the TokenPortal recovers a passport attestation to. */
const PASSPORT_SIGNER = privateKeyToAccount(E2E_ENV.PASSPORT_SIGNER_PRIVATE_KEY as `0x${string}`).address

const USDC = 10n ** 6n

const attest = (session: Session, body: Record<string, unknown> = {}) =>
  call(passportRoute, '/api/attestation/passport', {
    method: 'POST',
    token: session.token,
    body: { portalAddress: PORTAL, ...body },
  })

const check = (session: Session) =>
  call(passportCheckRoute, '/api/attestation/passport/check', { token: session.token })

let upstreams: UpstreamState

// The sanctions module caches a verdict per address for a minute, in a map no
// truncation clears, so every test gets its own wallet rather than replaying a
// previous test's screening result.
let actor = 0
const otherActor = () => actor + 5000

beforeEach(async () => {
  actor++
  await resetDb()
  upstreams = installUpstreams()
})

describe('issuing a passport attestation', () => {
  it('returns a signature the TokenPortal can verify, bound to every field', async () => {
    const session = await login(actor)

    const result = await attest(session, { amount: (100n * USDC).toString() })

    expect(result.status).toBe(200)
    const { l1Signature, nonce, maxAmount, deadline } = result.body

    const digest = keccak256(
      encodePacked(
        ['address', 'uint256', 'uint256', 'uint256', 'address'],
        [session.l1Address as `0x${string}`, BigInt(maxAmount), BigInt(nonce), BigInt(deadline), PORTAL],
      ),
    )
    const recovered = await recoverMessageAddress({ message: { raw: digest }, signature: l1Signature })

    expect(recovered).toBe(PASSPORT_SIGNER)
  })

  it('does not verify against a different portal', async () => {
    // The portal binding is what stops a signature issued for one deployment
    // from being replayed against another.
    const session = await login(actor)
    const { body } = await attest(session, { amount: (100n * USDC).toString() })

    const digest = keccak256(
      encodePacked(
        ['address', 'uint256', 'uint256', 'uint256', 'address'],
        [
          session.l1Address as `0x${string}`,
          BigInt(body.maxAmount),
          BigInt(body.nonce),
          BigInt(body.deadline),
          '0x00000000000000000000000000000000000000ff',
        ],
      ),
    )
    const recovered = await recoverMessageAddress({ message: { raw: digest }, signature: body.l1Signature })

    expect(recovered).not.toBe(PASSPORT_SIGNER)
  })

  it('bounds the deadline server-side however far out the client asks', async () => {
    const session = await login(actor)
    const oneYear = Math.floor(Date.now() / 1000) + 365 * 24 * 3600

    const { body } = await attest(session, { deadline: oneYear, amount: (10n * USDC).toString() })

    expect(Number(body.deadline)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 60)
  })

  it('honours a client deadline that is shorter than the cap', async () => {
    const session = await login(actor)
    const inFiveMinutes = Math.floor(Date.now() / 1000) + 300

    const { body } = await attest(session, { deadline: inFiveMinutes })

    expect(Number(body.deadline)).toBe(inFiveMinutes)
  })

  it('writes a budget hold for the amount it signed', async () => {
    const session = await login(actor)

    const { body } = await attest(session, { amount: (250n * USDC).toString() })

    const reservation = await db.attestationReservation.findUnique({ where: { nonce: body.nonce } })
    expect(reservation?.fkUserId).toBe(session.userId)
    expect(reservation?.amountUsd).toBeCloseTo(250, 2)
    expect(reservation?.expiresAt.getTime()).toBe(Number(body.deadline) * 1000)
  })

  it('draws a fresh nonce for every attestation', async () => {
    const session = await login(actor)

    const first = await attest(session, { amount: (10n * USDC).toString() })
    const second = await attest(session, { amount: (10n * USDC).toString() })

    expect(first.body.nonce).not.toBe(second.body.nonce)
    expect(await db.attestationReservation.count()).toBe(2)
  })

  it('sizes the signed ceiling to the requested amount, not the per-tx max', async () => {
    // Signing the full ceiling for a small deposit would hold the user's whole
    // budget until the reservation expires.
    const session = await login(actor)

    const { body } = await attest(session, { amount: (25n * USDC).toString() })

    expect(BigInt(body.maxAmount)).toBe(25n * USDC)
  })

  it('ignores a requested amount above the per-tx max', async () => {
    const session = await login(actor)

    const { body } = await attest(session, { amount: (10_000n * USDC).toString() })

    expect(BigInt(body.maxAmount)).toBeLessThanOrEqual(BigInt(E2E_ENV.PASSPORT_MAX_AMOUNT))
  })

  it('only issues the L2 Schnorr signature when a bridge address is given', async () => {
    const session = await login(actor)

    const without = await attest(session, { amount: (10n * USDC).toString() })
    expect(without.body.l2Signature).toBeNull()

    const withBridge = await attest(session, { amount: (10n * USDC).toString(), bridgeAddress: BRIDGE })
    expect(Array.isArray(withBridge.body.l2Signature)).toBe(true)
    expect(withBridge.body.l2Signature).toHaveLength(64)
  })

  it('refuses without a session', async () => {
    const result = await call(passportRoute, '/api/attestation/passport', {
      method: 'POST',
      body: { portalAddress: PORTAL },
    })

    expect(result.status).toBe(401)
    expect(await db.attestationReservation.count()).toBe(0)
  })

  it('refuses without a portal address', async () => {
    const session = await login(actor)

    const result = await call(passportRoute, '/api/attestation/passport', {
      method: 'POST',
      token: session.token,
      body: {},
    })

    expect(result.status).toBe(400)
    expect(await db.attestationReservation.count()).toBe(0)
  })
})

describe('the cumulative Travel Rule threshold', () => {
  it('shrinks the signed ceiling to the volume left under the threshold', async () => {
    const session = await login(actor)
    await settleDeposit(session, 900)

    const { body } = await attest(session)

    expect(BigInt(body.maxAmount)).toBe(100n * USDC)
  })

  it('refuses once lifetime volume reaches the threshold', async () => {
    const session = await login(actor)
    await settleDeposit(session, 1000)

    const result = await attest(session)

    expect(result.status).toBe(403)
    expect(result.body.reason).toBe('travel_rule')
    expect(await db.attestationReservation.count()).toBe(0)
  })

  it('counts volume from outside the 24h window, unlike the daily cap', async () => {
    const session = await login(actor)
    await settleDeposit(session, 1000, { createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) })

    const result = await attest(session)

    expect(result.status).toBe(403)
    expect(result.body.reason).toBe('travel_rule')
  })

  it('cannot be skipped by omitting the direction field', async () => {
    // Omitting `direction` once bypassed the cap entirely: the gate only ran for
    // an explicit L1_TO_L2, so a body with no direction was signed uncapped.
    const session = await login(actor)
    await settleDeposit(session, 1000)

    const omitted = await attest(session, {})
    const explicit = await attest(session, { direction: 'L1_TO_L2' })

    expect(omitted.status).toBe(403)
    expect(omitted.body.reason).toBe(explicit.body.reason)
  })

  it('cannot be skipped by claiming the request is a withdrawal', async () => {
    // A withdrawal is not capped, so it must not come back with the L1
    // signature a deposit consumes.
    const session = await login(actor)
    await settleDeposit(session, 1000)

    const result = await attest(session, { direction: 'L2_TO_L1', bridgeAddress: BRIDGE })

    expect(result.status).toBe(200)
    expect(result.body.l1Signature).toBeNull()
    expect(await db.attestationReservation.count()).toBe(0)
  })

  it('ignores deposits belonging to another user', async () => {
    const other = await login(otherActor())
    await settleDeposit(other, 1000)
    const session = await login(actor)

    const result = await attest(session)

    expect(result.status).toBe(200)
  })

  it('does not count a failed or still-pending deposit', async () => {
    const session = await login(actor)
    await settleDeposit(session, 900, { status: 'failed' })
    await settleDeposit(session, 900, { status: 'pending' })

    const { body } = await attest(session, { amount: (500n * USDC).toString() })

    expect(BigInt(body.maxAmount)).toBe(500n * USDC)
  })
})

describe('outstanding holds', () => {
  it('charges a live hold against the next attestation', async () => {
    const session = await login(actor)

    const first = await attest(session, { amount: (600n * USDC).toString() })
    expect(BigInt(first.body.maxAmount)).toBe(600n * USDC)

    const second = await attest(session, { amount: (600n * USDC).toString() })

    expect(BigInt(second.body.maxAmount)).toBe(400n * USDC)
  })

  it('refuses when live holds have consumed the whole threshold', async () => {
    const session = await login(actor)
    await attest(session, { amount: (1000n * USDC).toString() })

    const result = await attest(session)

    expect(result.status).toBe(403)
    // A hold-driven refusal is temporary, so the user must not be told to go
    // verify with Clean Hands.
    expect(result.body.reason).toBe('pending_hold')
    expect(result.body.error).toMatch(/frees up/i)
  })

  it('releases the hold as the deposit it authorized settles', async () => {
    const session = await login(actor)
    const first = await attest(session, { amount: (600n * USDC).toString() })

    await settleDeposit(session, 600, { attestationNonce: first.body.nonce })
    const second = await attest(session, { amount: (600n * USDC).toString() })

    // 600 settled, its hold retired: 400 of the 1000 threshold is left.
    expect(BigInt(second.body.maxAmount)).toBe(400n * USDC)
  })

  it('stops counting a hold once it has expired', async () => {
    const session = await login(actor)
    const first = await attest(session, { amount: (1000n * USDC).toString() })
    await db.attestationReservation.update({
      where: { nonce: first.body.nonce },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const second = await attest(session, { amount: (1000n * USDC).toString() })

    expect(second.status).toBe(200)
    expect(BigInt(second.body.maxAmount)).toBe(1000n * USDC)
  })

  it('does not hand a full budget to each of several concurrent requests', async () => {
    // The read-then-write is serialized by a per-user advisory lock; without it
    // every parallel request reads "nothing used" and is signed for the lot.
    const session = await login(actor)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => attest(session, { amount: (1000n * USDC).toString() })),
    )

    const signed = results
      .filter((r) => r.status === 200)
      .reduce((sum, r) => sum + BigInt(r.body.maxAmount), 0n)

    expect(signed).toBeLessThanOrEqual(1000n * USDC)
  })
})

describe('sanctions screening', () => {
  it('refuses a screened address and issues nothing', async () => {
    upstreams.sanctionsHit = true
    const session = await login(actor)

    const result = await attest(session)

    expect(result.status).toBe(403)
    expect(result.body.reason).toBe('sanctions_match')
    expect(await db.attestationReservation.count()).toBe(0)
  })

  it('fails closed when the screening vendor is unreachable', async () => {
    upstreams.sanctionsDown = true
    const session = await login(actor)

    const result = await attest(session)

    expect(result.status).toBe(503)
    expect(await db.attestationReservation.count()).toBe(0)
  })

  it('screens before spending a passport API call', async () => {
    upstreams.sanctionsHit = true
    const session = await login(actor)

    await attest(session)

    expect(upstreams.calls.passport).toBe(0)
  })
})

describe('passport score', () => {
  it('refuses a score under the threshold', async () => {
    upstreams.passportScore = 5
    const session = await login(actor)

    const result = await attest(session)

    expect(result.status).toBe(403)
    expect(result.body.passing).toBe(false)
    expect(await db.attestationReservation.count()).toBe(0)
  })

  it('accepts a score exactly on the threshold', async () => {
    upstreams.passportScore = Number(E2E_ENV.PASSPORT_SCORE_THRESHOLD)
    const session = await login(actor)

    expect((await attest(session)).status).toBe(200)
  })
})

describe('address binding', () => {
  it('binds the L1 and L2 addresses on the first attestation', async () => {
    const session = await login(actor)

    await attest(session)

    const binding = await db.addressBinding.findFirst({ where: { l1Address: session.l1Address } })
    expect(binding?.l2Address).toBe(session.l2Address)
  })

  it('refuses a second L2 address for an already-bound wallet', async () => {
    const first = await login(actor)
    await attest(first)

    // Same L1 wallet, a different Aztec address: a distinct User row, but the
    // same human, so the binding has to refuse it.
    const rebound = await loginWithL2(actor, aztecAddress(actor + 90_000))
    const result = await attest(rebound)

    expect(result.status).toBe(403)
    expect(result.body.error).toMatch(/already linked/i)
  })

  it('refuses a second L1 wallet for an already-bound Aztec address', async () => {
    const first = await login(actor)
    await attest(first)

    const rebound = await loginWithL2(otherActor(), first.l2Address)
    const result = await attest(rebound)

    expect(result.status).toBe(403)
    expect(result.body.error).toMatch(/already linked/i)
  })
})

describe('the eligibility pre-check', () => {
  it('agrees with the signing route on a fresh user', async () => {
    const session = await login(actor)

    const result = await check(session)

    expect(result.status).toBe(200)
    expect(result.body.eligible).toBe(true)
    expect(result.body.score).toBe(upstreams.passportScore)
  })

  it('reports the remaining budget shrinking as deposits settle', async () => {
    const session = await login(actor)
    await settleDeposit(session, 900)

    const result = await check(session)

    expect(result.body.travelRuleRemainingUsd).toBeCloseTo(100, 2)
  })

  it('reports a live hold so the UI blocks where the signing route would', async () => {
    const session = await login(actor)
    await attest(session, { amount: (1000n * USDC).toString() })

    const result = await check(session)

    expect(result.body.reservedUsd).toBeCloseTo(1000, 2)
    expect(result.body.travelRuleRemainingUsd).toBe(0)
  })

  it('marks a user over the threshold as needing Clean Hands', async () => {
    const session = await login(actor)
    await settleDeposit(session, 1000)

    const result = await check(session)

    expect(result.body.eligible).toBe(false)
    expect(result.body.travelRuleExceeded).toBe(true)
  })

  it('fails closed on a screening outage, like the signing route', async () => {
    upstreams.sanctionsDown = true
    const session = await login(actor)

    expect((await check(session)).status).toBe(503)
  })

  it('refuses without a session', async () => {
    expect((await call(passportCheckRoute, '/api/attestation/passport/check')).status).toBe(401)
  })
})
