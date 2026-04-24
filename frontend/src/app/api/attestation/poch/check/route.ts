import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { checkCleanHands, getDefaultActionId } from '@/lib/attestation'
import { enforceAddressBinding } from '@/lib/address-binding'
import { screenAddress, SanctionsScreeningUnavailableError } from '@/lib/sanctions'

/**
 * GET /api/attestation/poch/check
 *
 * Lightweight pre-check for private deposits:
 * 1. Authenticate (JWT)
 * 2. Verify address binding (l1 ↔ l2)
 * 3. Check clean hands via Holonym
 *
 * Returns { eligible: boolean, reason?: string } without issuing any attestation
 * or incrementing nonces.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const { l1Address, l2Address } = authResult.user

    // Check address binding (l1 ↔ l2 must be 1:1)
    const bindingError = await enforceAddressBinding(l1Address, l2Address)
    if (bindingError) {
      return NextResponse.json({ eligible: false, reason: bindingError })
    }

    // Sanctions screening — fail closed on vendor outage.
    try {
      const screening = await screenAddress(l1Address)
      if (!screening.clear) {
        return NextResponse.json({ eligible: false, reason: screening.reason })
      }
    } catch (err) {
      if (err instanceof SanctionsScreeningUnavailableError) {
        console.error('[attestation/poch/check] sanctions screening unavailable:', err.message)
        return NextResponse.json(
          { error: 'Compliance screening temporarily unavailable. Please try again shortly.' },
          { status: 503 },
        )
      }
      throw err
    }

    // Check clean hands via Holonym
    const actionId = getDefaultActionId()
    const result = await checkCleanHands(l1Address, actionId)

    return NextResponse.json({
      eligible: result.isUnique,
      reason: result.isUnique ? undefined : 'Address does not have a valid clean hands attestation',
    })
  } catch (error) {
    console.error('[attestation/poch/check]', error)
    return NextResponse.json(
      { error: 'Failed to check POCH eligibility' },
      { status: 500 }
    )
  }
}
