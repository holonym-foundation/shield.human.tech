import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createOperation,
  patchOperationWithRetry,
  retryFailedPatches,
} from './operations'
import { pushFailedPatch, getFailedPatches, clearFailedPatches } from './storage'

// Minimal stub for BridgeApiClient — createOperation only calls .post()
function makeApiStub(returnValue: unknown = { operationId: 123 }) {
  return {
    post: vi.fn(async () => returnValue),
  } as any
}

const FULL_L1_TO_L2 = {
  direction: 'L1_TO_L2',
  portalAddressL1: '0xportal',
  bridgeAddressL2: '0xbridge',
  encryptedCiphertext: 'ciphertext',
  keyDerivationDomain: 'https://bridge.human.tech/',
  isPrivacyModeEnabled: false,
} as const

const FULL_L2_TO_L1 = {
  direction: 'L2_TO_L1',
  portalAddressL1: '0xportal',
  bridgeAddressL2: '0xbridge',
  encryptedCiphertext: 'ciphertext',
  keyDerivationDomain: 'https://bridge.human.tech/',
  isPrivacyModeEnabled: true,
  l2BlockNumberBeforeTx: '1234',
  rollupVersion: 5,
} as const

describe('createOperation — direction validation', () => {
  it('rejects missing direction', async () => {
    const api = makeApiStub()
    await expect(createOperation(api, {})).rejects.toThrow(/invalid direction/)
    expect(api.post).not.toHaveBeenCalled()
  })

  it('rejects unknown direction', async () => {
    const api = makeApiStub()
    await expect(createOperation(api, { direction: 'SIDEWAYS' })).rejects.toThrow(/invalid direction/)
    expect(api.post).not.toHaveBeenCalled()
  })

  it.each(['L1_TO_L2', 'L2_TO_L1'])('accepts %s when all required fields present', async (dir) => {
    const api = makeApiStub()
    const payload = dir === 'L1_TO_L2' ? FULL_L1_TO_L2 : FULL_L2_TO_L1
    const res = await createOperation(api, { ...payload })
    expect(res.operationId).toBe(123)
    expect(api.post).toHaveBeenCalledOnce()
  })
})

describe('createOperation — L1_TO_L2 required fields', () => {
  it.each([
    'portalAddressL1',
    'bridgeAddressL2',
    'encryptedCiphertext',
    'keyDerivationDomain',
    'isPrivacyModeEnabled',
  ])('rejects when %s is missing', async (field) => {
    const api = makeApiStub()
    const payload: Record<string, unknown> = { ...FULL_L1_TO_L2 }
    delete payload[field]
    await expect(createOperation(api, payload)).rejects.toThrow(new RegExp(field))
    expect(api.post).not.toHaveBeenCalled()
  })

  it('rejects empty-string values (treated as missing)', async () => {
    const api = makeApiStub()
    await expect(
      createOperation(api, { ...FULL_L1_TO_L2, portalAddressL1: '' }),
    ).rejects.toThrow(/portalAddressL1/)
  })

  it('accepts isPrivacyModeEnabled=false (false is a valid value, not missing)', async () => {
    const api = makeApiStub()
    await expect(
      createOperation(api, { ...FULL_L1_TO_L2, isPrivacyModeEnabled: false }),
    ).resolves.toEqual({ operationId: 123 })
  })
})

describe('createOperation — L2_TO_L1 required fields', () => {
  it.each([
    'portalAddressL1',
    'bridgeAddressL2',
    'encryptedCiphertext',
    'keyDerivationDomain',
    'isPrivacyModeEnabled',
    'l2BlockNumberBeforeTx',
    'rollupVersion',
  ])('rejects when %s is missing', async (field) => {
    const api = makeApiStub()
    const payload: Record<string, unknown> = { ...FULL_L2_TO_L1 }
    delete payload[field]
    await expect(createOperation(api, payload)).rejects.toThrow(new RegExp(field))
    expect(api.post).not.toHaveBeenCalled()
  })

  it('rejects rollupVersion=0 only if zero treated as missing — actually accepts (valid value)', async () => {
    // rollupVersion=0 is a legal value; validation should NOT reject it just
    // because 0 is falsy in JS. Guards against over-eager validation.
    const api = makeApiStub()
    await expect(
      createOperation(api, { ...FULL_L2_TO_L1, rollupVersion: 0 }),
    ).resolves.toEqual({ operationId: 123 })
  })
})

describe('createOperation — server response', () => {
  it('throws when server returns no operationId', async () => {
    const api = makeApiStub({})
    await expect(createOperation(api, { ...FULL_L1_TO_L2 })).rejects.toThrow(/did not return operationId/)
  })
})

// ─── Fix 1 + 2: retry-drain wiring ──────────────────────────────────

function makePatchingApiStub(opts?: { failOnce?: boolean }) {
  const calls: Array<{ path: string; body: unknown }> = []
  let failed = false
  const patch = vi.fn(async (path: string, body: unknown) => {
    calls.push({ path, body })
    if (opts?.failOnce && !failed) {
      failed = true
      throw new Error('transient network error')
    }
    return {}
  })
  return { patch, calls } as any
}

describe('patchOperationWithRetry', () => {
  beforeEach(() => clearFailedPatches())

  it('returns true on first-try success', async () => {
    const api = makePatchingApiStub()
    const ok = await patchOperationWithRetry(api, 7, { status: 'deposited' }, {
      label: 'l1TxHash',
      retryDelayMs: 0,
    })
    expect(ok).toBe(true)
    expect(api.patch).toHaveBeenCalledOnce()
    expect(getFailedPatches()).toHaveLength(0)
  })

  it('retries on failure and succeeds on second attempt', async () => {
    const api = makePatchingApiStub({ failOnce: true })
    const ok = await patchOperationWithRetry(api, 7, { status: 'deposited' }, {
      label: 'l1TxHash',
      retryDelayMs: 0,
    })
    expect(ok).toBe(true)
    expect(api.patch).toHaveBeenCalledTimes(2)
    expect(getFailedPatches()).toHaveLength(0)
  })

  it('queues to localStorage after exhausting all retries', async () => {
    const api = {
      patch: vi.fn(async () => {
        throw new Error('persistent error')
      }),
    } as any
    const ok = await patchOperationWithRetry(api, 42, { status: 'ready' }, {
      label: 'witness data',
      retryDelayMs: 0,
    })
    expect(ok).toBe(false)
    expect(api.patch).toHaveBeenCalledTimes(3) // default maxAttempts
    const queue = getFailedPatches()
    expect(queue).toHaveLength(1)
    expect(queue[0].operationId).toBe(42)
    expect(queue[0].label).toBe('witness data')
    expect(queue[0].data).toEqual({ status: 'ready' })
  })
})

describe('retryFailedPatches — Fix 1 + 2 drain behavior', () => {
  beforeEach(() => clearFailedPatches())

  it('returns early with 0 total when queue empty', async () => {
    const api = makePatchingApiStub()
    const res = await retryFailedPatches(api)
    expect(res).toEqual({ succeeded: 0, failed: 0, total: 0 })
    expect(api.patch).not.toHaveBeenCalled()
  })

  it('drains all queued patches via real PATCH calls', async () => {
    pushFailedPatch({ operationId: 1, data: { l1TxHash: '0xaa' }, label: 'a', timestamp: Date.now() })
    pushFailedPatch({ operationId: 2, data: { l1TxHash: '0xbb' }, label: 'b', timestamp: Date.now() })
    pushFailedPatch({ operationId: 3, data: { l1TxHash: '0xcc' }, label: 'c', timestamp: Date.now() })

    const api = makePatchingApiStub()
    const res = await retryFailedPatches(api)
    expect(res).toEqual({ succeeded: 3, failed: 0, total: 3 })
    expect(api.patch).toHaveBeenCalledTimes(3)
    // Each queued patch hits /api/bridge/operations/:id
    expect(api.calls.map((c: any) => c.path)).toEqual([
      '/api/bridge/operations/1',
      '/api/bridge/operations/2',
      '/api/bridge/operations/3',
    ])
    // Queue is cleared when all succeed
    expect(getFailedPatches()).toEqual([])
  })

  it('keeps failed entries in queue, removes succeeded ones', async () => {
    pushFailedPatch({ operationId: 1, data: { a: 1 }, label: 'first', timestamp: Date.now() })
    pushFailedPatch({ operationId: 2, data: { a: 2 }, label: 'second', timestamp: Date.now() })

    // API: succeed on odd operationIds, fail on even
    const api = {
      patch: vi.fn(async (path: string) => {
        const m = path.match(/operations\/(\d+)/)
        const id = m ? Number(m[1]) : 0
        if (id % 2 === 0) throw new Error('still broken')
        return {}
      }),
    } as any

    const res = await retryFailedPatches(api)
    expect(res).toEqual({ succeeded: 1, failed: 1, total: 2 })
    // Succeeded entry (op 1) removed; failed entry (op 2) retained for next retry.
    const remaining = getFailedPatches()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].operationId).toBe(2)
  })

  it('handles duplicate-key patches (same opId + label) independently', async () => {
    // pushFailedPatch appends — duplicates are allowed. retryFailedPatches
    // processes each and removeFailedPatch(opId, label) removes ALL matches.
    // This test pins that contract.
    pushFailedPatch({ operationId: 1, data: { v: 1 }, label: 'x', timestamp: Date.now() })
    pushFailedPatch({ operationId: 1, data: { v: 2 }, label: 'x', timestamp: Date.now() })

    const api = makePatchingApiStub()
    await retryFailedPatches(api)
    // Both patches get PATCH'd, then removeFailedPatch(1, 'x') nukes both.
    expect(api.patch).toHaveBeenCalledTimes(2)
    expect(getFailedPatches()).toEqual([])
  })
})
