import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import {
  fetchPassportScore,
  getPassportScoreThreshold,
  getPassportMaxAmount,
} from '@/lib/attestation'
import { enforceAddressBinding } from '@/lib/address-binding'
import { screenAddress, SanctionsScreeningUnavailableError } from '@/lib/sanctions'

/**
 * GET /api/attestation/passport/check
 *
 * Lightweight pre-check for Passport attestation eligibility:
 * 1. Authenticate (JWT)
 * 2. Verify address binding (l1 <-> l2)
 * 3. Fetch Gitcoin Passport score
 *
 * Returns { eligible, score, threshold, maxAmount, reason? } without issuing
 * any attestation or incrementing nonces.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const { l1Address, l2Address } = authResult.user

    // Check address binding (l1 <-> l2 must be 1:1)
    const bindingError = await enforceAddressBinding(l1Address, l2Address)
    if (bindingError) {
      return NextResponse.json({
        eligible: false,
        score: 0,
        threshold: getPassportScoreThreshold(),
        maxAmount: getPassportMaxAmount().toString(),
        reason: bindingError,
      })
    }

    // Sanctions screening — fail closed on vendor outage.
    try {
      const screening = await screenAddress(l1Address)
      if (!screening.clear) {
        return NextResponse.json({
          eligible: false,
          score: 0,
          threshold: getPassportScoreThreshold(),
          maxAmount: getPassportMaxAmount().toString(),
          reason: screening.reason,
        })
      }
    } catch (err) {
      if (err instanceof SanctionsScreeningUnavailableError) {
        console.error('[attestation/passport/check] sanctions screening unavailable:', err.message)
        return NextResponse.json(
          { error: 'Compliance screening temporarily unavailable. Please try again shortly.' },
          { status: 503 },
        )
      }
      throw err
    }

    // Fetch Gitcoin Passport score
    const { score, passing } = await fetchPassportScore(l1Address)

    return NextResponse.json({
      eligible: passing,
      score,
      threshold: getPassportScoreThreshold(),
      maxAmount: getPassportMaxAmount().toString(),
      reason: passing
        ? undefined
        : `Passport score too low (${score}/${getPassportScoreThreshold()} required)`,
    })
  } catch (error) {
    console.error('[attestation/passport/check]', error)
    return NextResponse.json(
      { error: 'Failed to check Passport eligibility' },
      { status: 500 }
    )
  }
}
