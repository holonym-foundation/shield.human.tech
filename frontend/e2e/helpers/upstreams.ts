import { vi } from 'vitest'

/**
 * The three third-party services the attestation path calls, all through global
 * fetch. Everything else in the flow — SIWE verification, the JWT, the caps,
 * the signatures, the database — runs for real; only the network boundary is
 * replaced, and a request to an unexpected host fails the test loudly instead
 * of escaping to the internet.
 */
export interface UpstreamState {
  passportScore: number
  /** Season 1 HUMN points, before the multiplier. */
  passportPoints: number
  passportMultiplier: number
  /** Force the Passport lookup to fail, the way an outage would. */
  passportDown: boolean
  /** null → no sanctions hit. */
  sanctionsHit: boolean
  /** Force the sanctions vendor to look unreachable. */
  sanctionsDown: boolean
  cleanHandsUnique: boolean
  /** Force the Holonym lookup to fail, the way an outage would. */
  cleanHandsDown: boolean
  /**
   * What the L1 portals report for an attestation nonce, which is what decides
   * whether an expired hold is freed. `null` makes the RPC unreadable — the
   * default, because the resolver must never free a hold it could not verify.
   */
  l1NonceConsumed: boolean | null
  calls: { passport: number; sanctions: number; cleanHands: number; l1: number }
}

export function installUpstreams(overrides: Partial<UpstreamState> = {}): UpstreamState {
  const realFetch = globalThis.fetch
  const state: UpstreamState = {
    passportScore: 30,
    passportPoints: 250,
    passportMultiplier: 1,
    passportDown: false,
    sanctionsHit: false,
    sanctionsDown: false,
    cleanHandsUnique: true,
    cleanHandsDown: false,
    l1NonceConsumed: null,
    calls: { passport: 0, sanctions: 0, cleanHands: 0, l1: 0 },
    ...overrides,
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      // barretenberg pulls its structured reference string on the first Grumpkin
      // operation, then caches it under ~/.bb-crs. Stubbing it out would mean
      // never running the L2 Schnorr signing the Aztec bridge contract verifies.
      if (url.includes('crs.aztec-labs.com')) return realFetch(input, init)

      if (url.includes('api.passport.xyz')) {
        state.calls.passport++
        if (state.passportDown) return json({ error: 'upstream' }, 500)
        // One endpoint serves both the score and the HUMN points balance.
        return json({
          score: String(state.passportScore),
          points_data: { total_points: state.passportPoints, multiplier: state.passportMultiplier },
        })
      }

      if (url.includes('sanctions.io')) {
        state.calls.sanctions++
        if (state.sanctionsDown) throw new Error('ECONNRESET')
        return json({ count: state.sanctionsHit ? 1 : 0, results: state.sanctionsHit ? [{ name: 'hit' }] : [] })
      }

      if (url.includes('api.holonym.io')) {
        state.calls.cleanHands++
        if (state.cleanHandsDown) return json({ error: 'upstream' }, 500)
        return json({ isUnique: state.cleanHandsUnique })
      }

      if (url.includes('l1-rpc.e2e.test')) {
        state.calls.l1++
        if (state.l1NonceConsumed === null) return json({ error: 'unreachable' }, 502)
        const word = state.l1NonceConsumed ? '1'.padStart(64, '0') : '0'.repeat(64)
        const { id } = JSON.parse(String(init?.body ?? '{}'))
        return json({ jsonrpc: '2.0', id, result: `0x${word}` })
      }

      throw new Error(`e2e: unexpected outbound request to ${url}`)
    }),
  )

  return state
}
