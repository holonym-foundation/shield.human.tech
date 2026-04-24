import {
  SANCTIONS_IO_API_KEY,
  SANCTIONS_IO_API_URL,
  SANCTIONS_IO_API_VERSION,
  SANCTIONS_IO_MIN_SCORE,
  SANCTIONS_SCREENING_ENABLED,
} from '@/config/env.config'

export interface ScreeningResult {
  clear: boolean
  reason?: string
}

export class SanctionsScreeningUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SanctionsScreeningUnavailableError'
  }
}

// Short-lived in-memory cache so the handful of attestation endpoints hit in one
// bridge session (poch/check, passport/check, poch issue, passport issue) collapse
// into a single upstream call. Resets on deploy — by design, we want fresh data
// after every release.
interface CacheEntry {
  result: ScreeningResult
  expiresAt: number
}

const CACHE_TTL_MS = 60_000
const cache = new Map<string, CacheEntry>()

const REQUEST_TIMEOUT_MS = 8_000

interface SanctionsIoResponse {
  count?: number
  results?: unknown[]
}

/**
 * Screen an L1 address against sanctions.io (`GET /search/`).
 *
 * sanctions.io describes `identifier` as the supplementary field for
 * "passport number, email address, company domain, business ID" — wallet
 * addresses fit the same slot. `name` and `data_source` are required by the
 * spec, so we pass the address as `name` too (it won't fuzzy-match any real
 * sanctioned name, and the hit — if any — comes from the `identifier` match).
 *
 * Returns `{ clear: true }` on no match. Throws
 * `SanctionsScreeningUnavailableError` when the vendor is unreachable or
 * returns a non-2xx — callers MUST fail closed on that error.
 */
export async function screenAddress(address: string): Promise<ScreeningResult> {
  if (!SANCTIONS_SCREENING_ENABLED) {
    return { clear: true }
  }

  const key = address.toLowerCase()
  const now = Date.now()
  const cached = cache.get(key)
  if (cached && cached.expiresAt > now) return cached.result

  if (!SANCTIONS_IO_API_KEY) {
    throw new SanctionsScreeningUnavailableError('SANCTIONS_IO_API_KEY not configured')
  }

  const url = new URL(SANCTIONS_IO_API_URL)
  url.searchParams.set('identifier', address)
  url.searchParams.set('min_score', SANCTIONS_IO_MIN_SCORE)

  let resp: Response
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${SANCTIONS_IO_API_KEY}`,
        Accept: `application/json; version=${SANCTIONS_IO_API_VERSION}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new SanctionsScreeningUnavailableError(
      `sanctions.io request failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!resp.ok) {
    throw new SanctionsScreeningUnavailableError(
      `sanctions.io returned ${resp.status} ${resp.statusText}`,
    )
  }

  const data = (await resp.json()) as SanctionsIoResponse
  const hits = Array.isArray(data.results) ? data.results : []
  const hasMatch = hits.length > 0

  const result: ScreeningResult = hasMatch
    ? { clear: false, reason: 'Address failed compliance screening. Please contact support.' }
    : { clear: true }

  cache.set(key, { result, expiresAt: now + CACHE_TTL_MS })
  return result
}
