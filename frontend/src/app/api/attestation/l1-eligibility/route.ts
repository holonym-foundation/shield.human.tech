import { NextRequest, NextResponse } from 'next/server'
import { isAddress } from 'viem'
import {
  checkCleanHands,
  fetchPassportScore,
  getDefaultActionId,
  getPassportScoreThreshold,
  getPassportMaxAmount,
} from '@/lib/attestation'
import { checkRateLimit } from '@/lib/siweNonceStore'
import { getClientIp } from '@/lib/validation'
import { screenAddress, SanctionsScreeningUnavailableError } from '@/lib/sanctions'

/**
 * GET /api/attestation/l1-eligibility?address=<l1>
 *
 * Public, L1-only humanity pre-check. Runs the same POCH → Passport cascade and
 * sanctions screen as the authenticated poch/check + passport/check routes, but:
 * - requires NO JWT (no session, no L2 wallet)
 * - creates NO address binding (never touches AddressBinding)
 *
 * This lets the UI show a human's POCH/Passport standing as soon as their L1
 * wallet connects, before the L2 wallet is linked. It exposes only already-public
 * signals for the supplied address (Holonym clean-hands, api.passport.xyz score,
 * sanctions match) — the same lookups anyone can run against those APIs — and has
 * no side effects on our own state.
 *
 * Deposit-cap / Travel-Rule fields are intentionally absent here: those are
 * per-user (DB-backed) and require an authenticated session.
 *
 * Rate limited per IP (in-memory, best-effort per server instance) because it proxies two upstream
 * APIs and would otherwise be a free lookup/enumeration proxy.
 */
export async function GET(request: NextRequest) {
  try {
    const ip = getClientIp(request.headers) ?? 'unknown'
    if (!checkRateLimit(`l1-eligibility:${ip}`, 30)) {
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }

    const address = request.nextUrl.searchParams.get('address')

    if (!address || !isAddress(address)) {
      return NextResponse.json({ error: 'A valid EVM `address` query param is required' }, { status: 400 })
    }

    const threshold = getPassportScoreThreshold()
    const passportMaxAmount = getPassportMaxAmount().toString()

    // Sanctions screening — fail closed on vendor outage (same policy as check routes).
    try {
      const screening = await screenAddress(address)
      if (!screening.clear) {
        return NextResponse.json({
          address,
          eligible: false,
          method: null,
          sanctioned: true,
          reason: screening.reason,
        })
      }
    } catch (err) {
      if (err instanceof SanctionsScreeningUnavailableError) {
        console.error('[attestation/l1-eligibility] sanctions screening unavailable:', err.message)
        return NextResponse.json(
          { error: 'Sanctions screening temporarily unavailable. Please try again shortly.' },
          { status: 503 },
        )
      }
      throw err
    }

    // Step 1: POCH (clean hands). A POCH failure must not block the Passport tier.
    try {
      const poch = await checkCleanHands(address, getDefaultActionId())
      if (poch.isUnique) {
        return NextResponse.json({
          address,
          eligible: true,
          method: 'poch',
          sanctioned: false,
        })
      }
    } catch (err) {
      console.warn(
        '[attestation/l1-eligibility] POCH check failed, trying Passport:',
        err instanceof Error ? err.message : String(err),
      )
    }

    // Step 2: Passport fallback.
    const { score, passing } = await fetchPassportScore(address)
    return NextResponse.json({
      address,
      eligible: passing,
      method: passing ? 'passport' : null,
      sanctioned: false,
      passportScore: score,
      passportThreshold: threshold,
      passportMaxAmount,
      reason: passing ? undefined : `Human Passport score too low (${score}/${threshold} required)`,
    })
  } catch (error) {
    console.error('[attestation/l1-eligibility]', error)
    return NextResponse.json({ error: 'Failed to check L1 humanity eligibility' }, { status: 500 })
  }
}
