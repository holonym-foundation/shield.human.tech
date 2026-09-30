import { beforeEach, describe, expect, it } from 'vitest'
import { encodePacked, keccak256, recoverMessageAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { POST as pochRoute } from '@/app/api/attestation/poch/route'
import { GET as pochCheckRoute } from '@/app/api/attestation/poch/check/route'
import { GET as statusRoute } from '@/app/api/attestation/status/route'
import { GET as l1EligibilityRoute } from '@/app/api/attestation/l1-eligibility/route'

import { db, resetDb, settleHold } from './helpers/db'
import { call } from './helpers/request'
import { aztecAddress, login, loginWithL2, wallet, type Session } from './helpers/session'
import { installUpstreams, type UpstreamState } from './helpers/upstreams'
import { E2E_ENV } from './helpers/env'

/** The address the TokenPortal recovers a clean-hands attestation to. */
const POCH_ATTESTER = privateKeyToAccount(E2E_ENV.POCH_ATTESTER_PRIVATE_KEY as `0x${string}`).address
const PASSPORT_SIGNER = privateKeyToAccount(E2E_ENV.PASSPORT_SIGNER_PRIVATE_KEY as `0x${string}`).address

const USDC = 10n ** 6n
const DAILY_CAP = Number(E2E_ENV.BRIDGE_MAX_DEPOSIT_USD)

const attest = (session: Session, body: Record<string, unknown> = {}) =>
  call(pochRoute, '/api/attestation/poch', { method: 'POST', token: session.token, body })

const check = (session: Session) =>
  call(pochCheckRoute, '/api/attestation/poch/check', { token: session.token })

const status = (session: Session) =>
  call(statusRoute, '/api/attestation/status', { token: session.token })

const eligibility = (address: string) =>
  call(l1EligibilityRoute, '/api/attestation/l1-eligibility', { query: `address=${address}` })

/** The digest the portal rebuilds before recovering the attester. */
const pochDigest = (body: any, userAddress: string) =>
  keccak256(
    encodePacked(
      ['uint256', 'uint256', 'uint256', 'address'],
      [BigInt(body.nonce), BigInt(body.circuitId), BigInt(body.actionId), userAddress as `0x${string}`],
    ),
  )

let upstreams: UpstreamState

// The sanctions module caches a verdict per address for a minute, in a map no
// truncation clears, so every test gets its own wallet rather than replaying a
// previous test's screening result.
let actor = 1000
const otherActor = () => actor + 5000

beforeEach(async () => {
  actor++
  await resetDb()
  upstreams = installUpstreams()
})

describe('issuing a POCH attestation', () => {
  it('returns a signature the TokenPortal can verify, bound to every field', async () => {
    const session = await login(actor)

    const result = await attest(session)

    expect(result.status).toBe(200)
    const recovered = await recoverMessageAddress({
      message: { raw: pochDigest(result.body, session.l1Address) },
      signature: result.body.l1Signature,
    })
    expect(recovered).toBe(POCH_ATTESTER)
  })

  it('does not verify for a different depositor', async () => {
    // The user binding is what stops one human's clean-hands proof from being
    // replayed by another address against the same portal.
    const session = await login(actor)
    const { body } = await attest(session)

    const recovered = await recoverMessageAddress({
      message: { raw: pochDigest(body, wallet(otherActor()).address) },
      signature: body.l1Signature,
    })

    expect(recovered).not.toBe(POCH_ATTESTER)
  })

  it('signs the L2 attestation with the Schnorr key, not the L1 one', async () => {
    const session = await login(actor)

    const { body } = await attest(session)

    expect(Array.isArray(body.l2Signature)).toBe(true)
    expect(body.l2Signature).toHaveLength(64)
  })

  it('draws a fresh nonce for every attestation', async () => {
    const session = await login(actor)

    const first = await attest(session)
    const second = await attest(session)

    expect(first.body.nonce).not.toBe(second.body.nonce)
  })

  it('refuses without a session', async () => {
    const result = await call(pochRoute, '/api/attestation/poch', { method: 'POST', body: {} })

    expect(result.status).toBe(401)
    expect(upstreams.calls.cleanHands).toBe(0)
  })

  it('rejects a malformed body before touching any upstream', async () => {
    const session = await login(actor)

    const result = await attest(session, { isPrivate: 'yes' })

    expect(result.status).toBe(400)
    expect(upstreams.calls.sanctions).toBe(0)
    expect(upstreams.calls.cleanHands).toBe(0)
  })

  it('refuses a human without a clean hands attestation', async () => {
    const session = await login(actor)
    upstreams.cleanHandsUnique = false

    const result = await attest(session)

    expect(result.status).toBe(403)
    expect(result.body.isUnique).toBe(false)
  })

  it('screens for sanctions before asking Holonym anything', async () => {
    // Order matters: a sanctioned address must not have its identity looked up
    // at a third party we then have to explain the query to.
    const session = await login(actor)
    upstreams.sanctionsHit = true

    const result = await attest(session)

    expect(result.status).toBe(403)
    expect(result.body.reason).toBe('sanctions_match')
    expect(upstreams.calls.cleanHands).toBe(0)
  })

  it('fails closed when the sanctions vendor is unreachable', async () => {
    const session = await login(actor)
    upstreams.sanctionsDown = true

    const result = await attest(session)

    expect(result.status).toBe(503)
    expect(upstreams.calls.cleanHands).toBe(0)
  })

  it('does not let a claim on the Aztec address lock its owner out', async () => {
    // Only the L1 half is proven by SIWE. Refusing on the L2 half let any wallet
    // name a stranger's Aztec account and bar them from the bridge permanently.
    const shared = aztecAddress(actor)
    const first = await loginWithL2(actor, shared)
    await attest(first)

    const second = await loginWithL2(otherActor(), shared)
    const result = await attest(second)

    expect(result.status).toBe(200)
    // The first claimant keeps their binding; the second simply stays unbound.
    expect((await db.addressBinding.findUnique({ where: { l1Address: first.l1Address } }))?.l2Address).toBe(shared)
    expect(await db.addressBinding.findUnique({ where: { l1Address: second.l1Address } })).toBeNull()
  })
})

describe('the daily deposit cap on POCH', () => {
  it('refuses once the day\'s confirmed volume plus this request passes the cap', async () => {
    const session = await login(actor)
    await settleHold(session, DAILY_CAP - 10, { method: 'poch' })

    const result = await attest(session, {
      direction: 'L1_TO_L2',
      amount: (100n * USDC).toString(),
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
    })

    expect(result.status).toBe(403)
    expect(result.body.reason).toBe('deposit_limit')
  })

  it('cannot be skipped by omitting the direction field', async () => {
    // The PR #27 class of bug: gating on an explicit L1_TO_L2 let a body with no
    // direction through uncapped.
    const session = await login(actor)
    await settleHold(session, DAILY_CAP, { method: 'poch' })

    const omitted = await attest(session, { amount: (100n * USDC).toString() })
    const explicit = await attest(session, { direction: 'L1_TO_L2', amount: (100n * USDC).toString() })

    expect(omitted.status).toBe(403)
    expect(omitted.body.reason).toBe(explicit.body.reason)
  })

  it('cannot be skipped by claiming the request is a withdrawal', async () => {
    // A withdrawal is uncapped, so it must not come back with the L1 signature a
    // deposit consumes.
    const session = await login(actor)
    await settleHold(session, DAILY_CAP, { method: 'poch' })

    const result = await attest(session, { direction: 'L2_TO_L1', amount: (100n * USDC).toString() })

    expect(result.status).toBe(200)
    expect(result.body.l1Signature).toBeNull()
    expect(result.body.l2Signature).toHaveLength(64)
  })

  it('drops deposits that fell out of the rolling window', async () => {
    const session = await login(actor)
    await settleHold(session, DAILY_CAP, { method: 'poch', createdAt: new Date(Date.now() - 25 * 3600 * 1000) })

    const result = await attest(session, { amount: (100n * USDC).toString() })

    expect(result.status).toBe(200)
  })

  it('ignores deposits belonging to another user', async () => {
    const other = await login(otherActor())
    await settleHold(other, DAILY_CAP, { method: 'poch' })
    const session = await login(actor)

    const result = await attest(session, { amount: (100n * USDC).toString() })

    expect(result.status).toBe(200)
  })

  it('exempts a POCH-verified human from the Travel Rule threshold', async () => {
    // The threshold is what forces the passport tier to upgrade to POCH. Applying
    // it here too would leave a verified human with nowhere left to upgrade.
    const session = await login(actor)
    // Passport-tier volume, five times over the threshold, and well under the day's cap.
    await settleHold(session, Number(E2E_ENV.TRAVEL_RULE_THRESHOLD_USD) * 5)

    const result = await attest(session, { amount: (100n * USDC).toString() })

    expect(result.status).toBe(200)
    expect(result.body.l1Signature).not.toBeNull()
  })
})

describe('the POCH pre-check', () => {
  it('clears a human with a clean hands attestation', async () => {
    const session = await login(actor)

    const result = await check(session)

    expect(result.status).toBe(200)
    expect(result.body.eligible).toBe(true)
  })

  it('reports why a human without one is not eligible', async () => {
    const session = await login(actor)
    upstreams.cleanHandsUnique = false

    const { body } = await check(session)

    expect(body.eligible).toBe(false)
    expect(body.reason).toBeTruthy()
  })

  it('surfaces the budget left for today', async () => {
    const session = await login(actor)
    await settleHold(session, 400, { method: 'poch' })

    const { body } = await check(session)

    expect(body.remainingUsd).toBeCloseTo(DAILY_CAP - 400, 2)
    expect(body.depositLimitReached).toBe(false)
  })

  it('flags a spent budget so the UI can block before signing', async () => {
    const session = await login(actor)
    await settleHold(session, DAILY_CAP, { method: 'poch' })

    const { body } = await check(session)

    expect(body.depositLimitReached).toBe(true)
    expect(body.remainingUsd).toBe(0)
  })

  it('agrees with the signing route on a sanctioned address', async () => {
    const session = await login(actor)
    upstreams.sanctionsHit = true

    const precheck = await check(session)
    const signed = await attest(session)

    expect(precheck.body.eligible).toBe(false)
    expect(signed.status).toBe(403)
  })

  it('fails closed when the sanctions vendor is unreachable', async () => {
    const session = await login(actor)
    upstreams.sanctionsDown = true

    const result = await check(session)

    expect(result.status).toBe(503)
  })

  it('refuses without a session', async () => {
    const result = await call(pochCheckRoute, '/api/attestation/poch/check')

    expect(result.status).toBe(401)
  })
})

describe('attestation status', () => {
  it('reports an unbound user before any attestation', async () => {
    const session = await login(actor)

    const { body } = await status(session)

    expect(body.binding.status).toBe('unbound')
    expect(body.binding.l1Address).toBeNull()
  })

  it('reports the pair once an attestation has bound it', async () => {
    const session = await login(actor)
    await attest(session)

    const { body } = await status(session)

    expect(body.binding.status).toBe('bound')
    expect(body.binding.l1Address).toBe(session.l1Address)
    expect(body.binding.l2Address).toBe(session.l2Address)
  })

  it('reports a conflict on the proven half, when the caller changes Aztec account', async () => {
    const owner = await loginWithL2(actor, aztecAddress(actor))
    await attest(owner)

    const moved = await loginWithL2(actor, aztecAddress(actor + 90_000))
    const { body } = await status(moved)

    expect(body.binding.status).toBe('conflict')
    expect(body.binding.l2Address).toBe(owner.l2Address)
  })

  it('discloses nothing to a wallet that merely names someone else’s Aztec account', async () => {
    const shared = aztecAddress(actor)
    const owner = await loginWithL2(actor, shared)
    await attest(owner)

    const intruder = await loginWithL2(otherActor(), shared)
    const { body } = await status(intruder)

    // Reading a binding made by some other L1 both told the intruder the account
    // was taken and handed them the L1 address that took it.
    expect(body.binding.status).toBe('unbound')
    expect(body.binding.l1Address).toBeNull()
    expect(body.binding.l2Address).toBeNull()
  })

  it('exposes the signer addresses the contracts are configured with', async () => {
    const session = await login(actor)

    const { body } = await status(session)

    expect(body.config.attesterAddress).toBe(POCH_ATTESTER)
    expect(body.config.passportSignerAddress).toBe(PASSPORT_SIGNER)
  })

  it('refuses without a session', async () => {
    const result = await call(statusRoute, '/api/attestation/status')

    expect(result.status).toBe(401)
  })
})

describe('the public L1 eligibility lookup', () => {
  it('answers without a session', async () => {
    const result = await eligibility(wallet(actor).address)

    expect(result.status).toBe(200)
    expect(result.body.eligible).toBe(true)
    expect(result.body.method).toBe('poch')
  })

  it('rejects anything that is not an EVM address', async () => {
    const result = await eligibility('not-an-address')

    expect(result.status).toBe(400)
    expect(upstreams.calls.sanctions).toBe(0)
  })

  it('does not spend a passport lookup once POCH has cleared the address', async () => {
    await eligibility(wallet(actor).address)

    expect(upstreams.calls.passport).toBe(0)
  })

  it('falls back to the passport tier when clean hands does not clear', async () => {
    upstreams.cleanHandsUnique = false

    const { body } = await eligibility(wallet(actor).address)

    expect(body.eligible).toBe(true)
    expect(body.method).toBe('passport')
    expect(body.passportScore).toBe(upstreams.passportScore)
  })

  it('still reaches the passport tier when the Holonym lookup itself fails', async () => {
    // A POCH outage must degrade to the lower tier, not deny a human outright.
    upstreams.cleanHandsDown = true

    const { body } = await eligibility(wallet(actor).address)

    expect(body.method).toBe('passport')
  })

  it('reports ineligible when the passport score is under the threshold', async () => {
    upstreams.cleanHandsUnique = false
    upstreams.passportScore = Number(E2E_ENV.PASSPORT_SCORE_THRESHOLD) - 1

    const { body } = await eligibility(wallet(actor).address)

    expect(body.eligible).toBe(false)
    expect(body.method).toBeNull()
    expect(body.reason).toContain('score too low')
  })

  it('reports a sanctions hit without running either humanity lookup', async () => {
    upstreams.sanctionsHit = true

    const { body } = await eligibility(wallet(actor).address)

    expect(body.sanctioned).toBe(true)
    expect(body.eligible).toBe(false)
    expect(upstreams.calls.cleanHands).toBe(0)
    expect(upstreams.calls.passport).toBe(0)
  })

  it('fails closed when the sanctions vendor is unreachable', async () => {
    upstreams.sanctionsDown = true

    const result = await eligibility(wallet(actor).address)

    expect(result.status).toBe(503)
  })

  it('creates no binding and no user for the address it was asked about', async () => {
    // The route is public: a lookup must not be able to seed our own state, or
    // anyone could bind an address they do not control.
    await eligibility(wallet(actor).address)

    expect(await db.addressBinding.count()).toBe(0)
    expect(await db.user.count()).toBe(0)
  })
})
