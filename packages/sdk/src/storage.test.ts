import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  pushFailedPatch,
  getFailedPatches,
  removeFailedPatch,
  clearFailedPatches,
  STORAGE_KEYS,
  type FailedPatch,
} from './storage'

function makePatch(overrides?: Partial<FailedPatch>): FailedPatch {
  return {
    operationId: 1,
    data: { foo: 'bar' },
    label: 'test-patch',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('pushFailedPatch — basic behavior', () => {
  beforeEach(() => {
    clearFailedPatches()
  })

  it('stores a single patch', () => {
    const patch = makePatch()
    pushFailedPatch(patch)
    expect(getFailedPatches()).toEqual([patch])
  })

  it('appends multiple patches in order', () => {
    pushFailedPatch(makePatch({ label: 'a' }))
    pushFailedPatch(makePatch({ label: 'b' }))
    pushFailedPatch(makePatch({ label: 'c' }))
    expect(getFailedPatches().map((p) => p.label)).toEqual(['a', 'b', 'c'])
  })

  it('removeFailedPatch targets by operationId + label', () => {
    pushFailedPatch(makePatch({ operationId: 1, label: 'a' }))
    pushFailedPatch(makePatch({ operationId: 1, label: 'b' }))
    pushFailedPatch(makePatch({ operationId: 2, label: 'a' }))
    removeFailedPatch(1, 'a')
    const remaining = getFailedPatches().map((p) => `${p.operationId}:${p.label}`)
    expect(remaining).toEqual(['1:b', '2:a'])
  })

  it('clearFailedPatches empties the queue', () => {
    pushFailedPatch(makePatch())
    pushFailedPatch(makePatch())
    clearFailedPatches()
    expect(getFailedPatches()).toEqual([])
  })
})

describe('pushFailedPatch — TTL pruning', () => {
  beforeEach(() => {
    clearFailedPatches()
  })

  it('drops entries older than 7 days on new push', () => {
    const now = Date.now()
    const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000

    // Seed queue directly with an expired entry (bypass pushFailedPatch so
    // the TTL filter doesn't run on insertion).
    const staleRaw = [{ ...makePatch({ label: 'stale', timestamp: now - EIGHT_DAYS }) }]
    localStorage.setItem(STORAGE_KEYS.failedPatches, JSON.stringify(staleRaw))
    expect(getFailedPatches()).toHaveLength(1)

    // New push should prune the stale entry.
    pushFailedPatch(makePatch({ label: 'fresh' }))
    const patches = getFailedPatches()
    expect(patches.map((p) => p.label)).toEqual(['fresh'])
  })

  it('keeps entries within the 7-day window', () => {
    const now = Date.now()
    const SIX_DAYS = 6 * 24 * 60 * 60 * 1000

    const recentRaw = [{ ...makePatch({ label: 'recent', timestamp: now - SIX_DAYS }) }]
    localStorage.setItem(STORAGE_KEYS.failedPatches, JSON.stringify(recentRaw))

    pushFailedPatch(makePatch({ label: 'new' }))
    const patches = getFailedPatches()
    expect(patches.map((p) => p.label)).toEqual(['recent', 'new'])
  })

  it('keeps legacy entries with no timestamp (benefit of doubt)', () => {
    // Legacy entries written before TTL-aware pushFailedPatch shouldn't get
    // dropped on first touch — only TTL-expired ones should.
    const legacyRaw = [{ operationId: 99, data: {}, label: 'legacy' }]
    localStorage.setItem(STORAGE_KEYS.failedPatches, JSON.stringify(legacyRaw))

    pushFailedPatch(makePatch({ label: 'new' }))
    const labels = getFailedPatches().map((p) => p.label)
    expect(labels).toContain('legacy')
    expect(labels).toContain('new')
  })
})

describe('pushFailedPatch — size cap', () => {
  beforeEach(() => {
    clearFailedPatches()
  })

  it('caps queue at 100 entries, evicting oldest', () => {
    // Seed 100 entries then push one more — oldest should be evicted.
    const seed: FailedPatch[] = []
    for (let i = 0; i < 100; i++) {
      seed.push(makePatch({ operationId: i, label: `p${i}`, timestamp: Date.now() - i }))
    }
    localStorage.setItem(STORAGE_KEYS.failedPatches, JSON.stringify(seed))

    pushFailedPatch(makePatch({ operationId: 999, label: 'newest' }))
    const patches = getFailedPatches()

    expect(patches).toHaveLength(100)
    // Oldest (p0) was evicted; newest is at the end.
    expect(patches[0].label).toBe('p1')
    expect(patches[patches.length - 1].label).toBe('newest')
  })

  it('warns when cap is hit', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const seed: FailedPatch[] = []
    for (let i = 0; i < 100; i++) {
      seed.push(makePatch({ operationId: i, label: `p${i}` }))
    }
    localStorage.setItem(STORAGE_KEYS.failedPatches, JSON.stringify(seed))

    pushFailedPatch(makePatch({ label: 'overflow' }))
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('queue reached 100'))
    warnSpy.mockRestore()
  })
})

describe('pushFailedPatch — localStorage unavailable', () => {
  let original: Storage

  beforeEach(() => {
    original = globalThis.localStorage
    // Simulate no-localStorage environment (SSR / private mode / etc.)
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: original,
      configurable: true,
    })
  })

  it('does not throw when localStorage is unavailable', () => {
    expect(() => pushFailedPatch(makePatch())).not.toThrow()
    expect(getFailedPatches()).toEqual([])
  })
})
