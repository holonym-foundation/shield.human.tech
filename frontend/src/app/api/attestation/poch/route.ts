import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { PochAttestationSchema } from '@/lib/validation'
import { enforceAddressBinding, getNextNonce, evaluateDepositLimit } from '@/lib/address-binding'
import {
  checkCleanHands,
  signCleanHandsAttestation,
  signL2CleanHandsAttestation,
  getCircuitId,
  getDefaultActionId,
} from '@/lib/attestation'
import { screenAddress, SanctionsScreeningUnavailableError } from '@/lib/sanctions'

/**
 * POST /api/attestation/poch
 *
 * 1. Authenticate user (JWT)
 * 2. Enforce 1:1 address binding (l1Address <-> l2Address)
 * 3. Sanctions screening (fail closed on vendor outage)
 * 4. Verify clean hands via Holonym sandbox API
 * 5. Issue signed attestation from our POCH attester (L1 ECDSA + L2 Schnorr)
 *
 * Body: { l2Address: string, isPrivate?: boolean }
 * Returns: { l1Signature, l2Signature, nonce, circuitId, actionId }
 */
export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate
    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const { l1Address, l2Address } = authResult.user

    const body = await request.json()

    // ── Validate + sanitize inputs via Zod ──────────────────────────────
    const parsed = PochAttestationSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json(
        { error: `Validation error: ${firstError.path.join('.')} — ${firstError.message}` },
        { status: 400 },
      )
    }

    const data = parsed.data

    // 2. Enforce 1:1 address binding
    const bindingError = await enforceAddressBinding(l1Address, l2Address)
    if (bindingError) {
      return NextResponse.json({ error: bindingError }, { status: 403 })
    }

    // 2b. Sanctions screening — fail closed on vendor outage.
    try {
      const screening = await screenAddress(l1Address)
      if (!screening.clear) {
        return NextResponse.json({ error: screening.reason, reason: 'sanctions_match' }, { status: 403 })
      }
    } catch (err) {
      if (err instanceof SanctionsScreeningUnavailableError) {
        console.error('[attestation/poch] sanctions screening unavailable:', err.message)
        return NextResponse.json(
          { error: 'Compliance screening temporarily unavailable. Please try again shortly.' },
          { status: 503 },
        )
      }
      throw err
    }

    // 3. Check clean hands via Holonym
    const actionId = getDefaultActionId()
    const holonymResult = await checkCleanHands(l1Address, actionId)

    if (!holonymResult.isUnique) {
      return NextResponse.json(
        { error: 'Clean hands check failed: address does not have a valid attestation', isUnique: false },
        { status: 403 },
      )
    }

    // 3b. Alpha cumulative deposit cap (L1→L2 only). POCH has no on-chain
    // amount binding, so this refuses to issue a signature once the user is
    // over budget — the honest-client / UI guardrail.
    if (data.direction === 'L1_TO_L2') {
      const limit = await evaluateDepositLimit({
        userId: authResult.user.id,
        amount: data.amount,
        tokenSymbol: data.tokenSymbol,
        tokenDecimals: data.tokenDecimals,
      })
      if (limit.enabled && limit.overLimit) {
        return NextResponse.json(
          {
            error: `Alpha deposit limit reached ($${limit.limitUsd.toFixed(0)} per user). You have $${limit.confirmedUsd.toFixed(2)} of $${limit.limitUsd.toFixed(2)} used.`,
            reason: 'deposit_limit',
          },
          { status: 403 },
        )
      }
    }

    // 4. Get next nonce and sign attestations (L1 ECDSA + L2 Schnorr)
    const circuitId = getCircuitId()
    const nonce = await getNextNonce(l1Address, 'poch')

    const l1Signature = await signCleanHandsAttestation({
      nonce: BigInt(nonce),
      circuitId,
      actionId,
      userAddress: l1Address,
    })

    const l2Signature = await signL2CleanHandsAttestation({
      circuitId,
      actionId,
      nonce: BigInt(nonce),
      userAztecAddress: l2Address,
    })

    return NextResponse.json({
      l1Signature,
      l2Signature,
      nonce,
      circuitId: circuitId.toString(),
      actionId: actionId.toString(),
    })
  } catch (error) {
    console.error('[attestation/poch]', error)
    return NextResponse.json({ error: 'Failed to issue POCH attestation' }, { status: 500 })
  }
}
