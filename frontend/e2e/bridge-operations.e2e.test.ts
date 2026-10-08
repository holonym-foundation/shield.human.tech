import { beforeEach, describe, expect, it } from 'vitest'

import { GET as listRoute, POST as createRoute } from '@/app/api/bridge/operations/route'
import { GET as getRoute, PATCH as patchRoute } from '@/app/api/bridge/operations/[id]/route'

import { db, resetDb } from './helpers/db'
import { call, routeParams } from './helpers/request'
import { login, type Session } from './helpers/session'
import { E2E_ORIGIN } from './helpers/env'

const TX_HASH = `0x${'ab'.repeat(32)}`

function depositBody(session: Session, overrides: Record<string, unknown> = {}) {
  return {
    direction: 'L1_TO_L2',
    l1Address: session.l1Address,
    l2Address: session.l2Address,
    encryptedCiphertext: 'ciphertext',
    encryptedIv: 'iv',
    encryptedTag: 'tag',
    keyDerivationMessage: 'Sign to derive your backup key',
    keyDerivationDomain: E2E_ORIGIN,
    amountL1: '1000000',
    amountL2: '1000000',
    amountDisplayL1: '1',
    tokenSymbolL1: 'USDC',
    tokenDecimalsL1: 6,
    ...overrides,
  }
}

const create = (session: Session, overrides: Record<string, unknown> = {}) =>
  call(createRoute, '/api/bridge/operations', {
    method: 'POST',
    token: session.token,
    body: depositBody(session, overrides),
  })

const list = (session: Session) =>
  call(listRoute, '/api/bridge/operations', { token: session.token })

const read = (session: Session, id: string) =>
  call(getRoute, `/api/bridge/operations/${id}`, { token: session.token }, routeParams({ id }))

const patch = (session: Session, id: string, body: Record<string, unknown>) =>
  call(patchRoute, `/api/bridge/operations/${id}`, { method: 'PATCH', token: session.token, body }, routeParams({ id }))

let actor = 0
const otherActor = () => actor + 5000

beforeEach(async () => {
  actor++
  await resetDb()
})

describe('creating an operation', () => {
  it('stores a deposit and returns its id', async () => {
    const session = await login(actor)

    const result = await create(session)

    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)

    const stored = await db.bridgeActivity.findUnique({ where: { id: result.body.operationId } })
    expect(stored?.fkUserId).toBe(session.userId)
    expect(stored?.direction).toBe('L1_TO_L2')
    expect(stored?.status).toBe('pending')
    expect(stored?.encryptedCiphertext).toBe('ciphertext')
  })

  it('labels the networks from the direction rather than the client', async () => {
    const session = await login(actor)

    const deposit = await create(session)
    const withdrawal = await create(session, { direction: 'L2_TO_L1', fromNetworkName: 'Lies' })

    const stored = await db.bridgeActivity.findMany({ orderBy: { createdAt: 'asc' } })
    expect(stored.map((o) => [o.fromNetworkName, o.toNetworkName])).toEqual([
      ['Ethereum', 'Aztec'],
      ['Aztec', 'Ethereum'],
    ])
    expect(deposit.status).toBe(200)
    expect(withdrawal.status).toBe(200)
  })

  it('refuses without a session', async () => {
    const session = await login(actor)

    const result = await call(createRoute, '/api/bridge/operations', {
      method: 'POST',
      body: depositBody(session),
    })

    expect(result.status).toBe(401)
    expect(await db.bridgeActivity.count()).toBe(0)
  })

  it('refuses to file an operation under someone else’s wallet', async () => {
    const session = await login(actor)
    const victim = await login(otherActor())

    const result = await create(session, { l1Address: victim.l1Address })

    expect(result.status).toBe(403)
    expect(await db.bridgeActivity.count()).toBe(0)
  })

  it('refuses an L2 address that is not the session’s', async () => {
    const session = await login(actor)
    const victim = await login(otherActor())

    const result = await create(session, { l2Address: victim.l2Address })

    expect(result.status).toBe(403)
  })

  it('rejects a body carrying plaintext secrets', async () => {
    const session = await login(actor)

    for (const field of ['claimSecret', 'fuelSecret', 'privateFuelSecret', 'privateFuelSalt', 'nonce']) {
      const result = await create(session, { [field]: '0xdeadbeef' })
      expect(result.status, field).toBe(400)
      expect(result.body.error).toContain(field)
    }

    expect(await db.bridgeActivity.count()).toBe(0)
  })

  it('rejects a key derivation domain the app does not own', async () => {
    // The domain is half of the backup key derivation, so accepting an
    // attacker-chosen one would let them steer a victim's key material.
    const session = await login(actor)

    const result = await create(session, { keyDerivationDomain: 'https://evil.example' })

    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/keyDerivationDomain/i)
  })

  it('requires the encrypted payload, the amounts and a known direction', async () => {
    const session = await login(actor)

    expect((await create(session, { encryptedCiphertext: undefined })).status).toBe(400)
    expect((await create(session, { amountL1: undefined })).status).toBe(400)
    expect((await create(session, { amountL1: 'not-a-number' })).status).toBe(400)
    expect((await create(session, { direction: 'L1_TO_L1' })).status).toBe(400)
    expect(await db.bridgeActivity.count()).toBe(0)
  })

  it('drops a fuel recipient on a withdrawal, where it has no meaning', async () => {
    const session = await login(actor)

    const result = await create(session, { direction: 'L2_TO_L1', fuelRecipient: `0x${'11'.repeat(32)}` })

    const stored = await db.bridgeActivity.findUnique({ where: { id: result.body.operationId } })
    expect(stored?.fuelRecipient).toBeNull()
  })
})

describe('reading operations', () => {
  it('lists only the caller’s own operations', async () => {
    const session = await login(actor)
    const other = await login(otherActor())
    await create(session)
    await create(other)

    const result = await list(session)

    expect(result.status).toBe(200)
    expect(result.body.operations).toHaveLength(1)
    expect(result.body.operations[0].id).toBe((await db.bridgeActivity.findFirst({
      where: { fkUserId: session.userId },
    }))?.id)
  })

  it('does not return the key derivation message in the list', async () => {
    // The list is the broadest response; the message only ships on the single
    // read, where resume actually needs it.
    const session = await login(actor)
    await create(session)

    const result = await list(session)

    expect(result.body.operations[0]).not.toHaveProperty('keyDerivationMessage')
  })

  it('never returns another user’s operation by id', async () => {
    const victim = await login(otherActor())
    const created = await create(victim)
    const attacker = await login(actor)

    const result = await read(attacker, created.body.operationId)

    expect(result.status).toBe(404)
  })

  it('returns the key derivation message the backup was encrypted with', async () => {
    // Resume re-derives the key from this exact string; a changed byte loses the backup.
    const session = await login(actor)
    const created = await create(session)

    const result = await read(session, created.body.operationId)

    expect(result.status).toBe(200)
    expect(result.body.keyDerivationMessage).toBe('Sign to derive your backup key')
  })

  it('rejects a malformed id before touching the database', async () => {
    const session = await login(actor)

    const result = await read(session, '../../etc/passwd')

    expect(result.status).toBe(400)
  })

  it('refuses without a session', async () => {
    expect((await call(listRoute, '/api/bridge/operations')).status).toBe(401)
  })
})

describe('updating an operation', () => {
  it('walks a deposit through its status transitions', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    expect((await patch(session, body.operationId, { status: 'deposited', l1TxHash: TX_HASH })).status).toBe(200)
    expect((await patch(session, body.operationId, { status: 'claimed' })).status).toBe(200)
    expect((await patch(session, body.operationId, { status: 'completed' })).status).toBe(200)

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.status).toBe('completed')
    expect(stored?.l1TxHash).toBe(TX_HASH)
    expect(stored?.completedAt).toBeInstanceOf(Date)
  })

  it('clears the error from an earlier attempt once the operation completes', async () => {
    const session = await login(actor)
    const { body } = await create(session)
    await patch(session, body.operationId, { status: 'deposited', lastErrorMessage: 'L1 withdraw transaction reverted' })

    await patch(session, body.operationId, { status: 'completed' })

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.lastErrorMessage).toBeNull()
  })

  it('keeps rollup versions and L2 chain ids above 2^31', async () => {
    const session = await login(actor)
    const { body } = await create(session, { rollupVersion: 2914217885, chainIdL2: 2904119610 })

    const result = await read(session, body.operationId)

    expect(result.status).toBe(200)
    expect(result.body.rollupVersion).toBe(2914217885)
    expect(result.body.chainIdL2).toBe(2904119610)
  })

  it('refuses a backwards status transition', async () => {
    const session = await login(actor)
    const { body } = await create(session)
    await patch(session, body.operationId, { status: 'completed' })

    const result = await patch(session, body.operationId, { status: 'pending' })

    expect(result.status).toBe(400)
    expect(result.body.error).toMatch(/transition/i)
  })

  it('refuses an unknown status', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    expect((await patch(session, body.operationId, { status: 'teleported' })).status).toBe(400)
  })

  it('refuses to overwrite a field fixed at creation', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    const result = await patch(session, body.operationId, {
      amountL1: '999999999',
      encryptedCiphertext: 'swapped',
    })

    expect(result.status).toBe(400)
    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.amountL1).toBe('1000000')
    expect(stored?.encryptedCiphertext).toBe('ciphertext')
  })

  it('rejects a patch carrying plaintext secrets', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    const result = await patch(session, body.operationId, { claimSecret: '0xdeadbeef' })

    expect(result.status).toBe(400)
  })

  it('never lets one user patch another user’s operation', async () => {
    const victim = await login(otherActor())
    const created = await create(victim)
    const attacker = await login(actor)

    const result = await patch(attacker, created.body.operationId, { status: 'failed' })

    expect(result.status).toBe(404)
    const stored = await db.bridgeActivity.findUnique({ where: { id: created.body.operationId } })
    expect(stored?.status).toBe('pending')
  })

  it('drops an explorer url pointing at an unknown host', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    await patch(session, body.operationId, {
      status: 'deposited',
      l1TxUrl: 'https://evil.example/tx/0xabc',
    })

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.l1TxUrl).toBeNull()
  })

  it('keeps a known explorer url', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    await patch(session, body.operationId, {
      status: 'deposited',
      l1TxUrl: `https://sepolia.etherscan.io/tx/${TX_HASH}`,
    })

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.l1TxUrl).toBe(`https://sepolia.etherscan.io/tx/${TX_HASH}`)
  })

  it('drops a sibling path with an invalid entry rather than storing half of it', async () => {
    const session = await login(actor)
    const { body } = await create(session, { direction: 'L2_TO_L1' })

    await patch(session, body.operationId, {
      status: 'submitted',
      siblingPath: [`0x${'11'.repeat(32)}`, 'not-hex'],
    })

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.siblingPath).toBeNull()
  })

  it('stores a well-formed sibling path', async () => {
    const session = await login(actor)
    const { body } = await create(session, { direction: 'L2_TO_L1' })

    const path = [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`]
    await patch(session, body.operationId, { status: 'submitted', siblingPath: path })

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.siblingPath).toEqual(path)
  })

  it('records the attestation nonce that authorized the deposit', async () => {
    // This is the link the budget ledger uses to retire a hold against the
    // deposit it authorized.
    const session = await login(actor)
    const { body } = await create(session)

    await patch(session, body.operationId, { status: 'deposited', attestationNonce: '123456789' })

    const stored = await db.bridgeActivity.findUnique({ where: { id: body.operationId } })
    expect(stored?.attestationNonce).toBe('123456789')
  })

  it('returns 404 for an operation that does not exist', async () => {
    const session = await login(actor)

    expect((await patch(session, 'doesnotexist1234', { status: 'failed' })).status).toBe(404)
  })

  it('refuses without a session', async () => {
    const session = await login(actor)
    const { body } = await create(session)

    const result = await call(
      patchRoute,
      `/api/bridge/operations/${body.operationId}`,
      { method: 'PATCH', body: { status: 'failed' } },
      routeParams({ id: body.operationId }),
    )

    expect(result.status).toBe(401)
  })
})
