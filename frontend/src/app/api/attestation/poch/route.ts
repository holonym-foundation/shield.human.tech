import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { PochAttestationSchema } from '@/lib/validation'
import { enforceAddressBinding, getNextNonce, reservePochBudget, ATTESTATION_TTL_SECONDS } from '@/lib/address-binding'
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
 * 4. Verify clean hands via Holonym (sandbox on testnet, production on mainnet)
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

    const isDeposit = data.direction !== 'L2_TO_L1'

    // 4. Get next nonce (needed to key the durable budget hold below) and circuitId.
    const circuitId = getCircuitId()
    const nonce = getNextNonce()

    // 3b. Alpha per-day (rolling 24h) deposit cap — evaluated AND held atomically
    // under a per-user advisory lock (mirroring the passport path). `direction` is
    // client-controlled and must never relax the check: anything but an explicit
    // withdrawal is treated as a deposit, and the L1 signature — the only artifact a
    // TokenPortal deposit consumes — is issued for deposits only, so a withdrawal
    // request can't skip the cap and still deposit. Note the clean-hands attestation
    // binds no on-chain amount, so the held figure is the client's self-reported
    // `amount`; a hard POCH volume cap requires a signed maxAmount on the attestation
    // (a TokenPortal change).
    if (isDeposit) {
      const poch = await reservePochBudget({
        userId: authResult.user.id,
        nonce,
        expiresAt: new Date(Date.now() + ATTESTATION_TTL_SECONDS * 1000),
        amount: data.amount,
        tokenSymbol: data.tokenSymbol,
      })
      if (!poch.ok) {
        return NextResponse.json(
          {
            error: `Alpha deposit limit reached ($${poch.limitUsd.toFixed(0)} per user / day). You have $${poch.confirmedUsd.toFixed(2)} of $${poch.limitUsd.toFixed(2)} used in the last 24h.`,
            reason: 'deposit_limit',
          },
          { status: 403 },
        )
      }
    }

    // Only a deposit needs the L1 (portal) CleanHands signature; a withdrawal is
    // verified by the L2 Schnorr signature below. Issuing an L1 signature for a
    // withdrawal would let it authorize a deposit that skipped the cap above.
    const l1Signature = isDeposit
      ? await signCleanHandsAttestation({
          nonce,
          circuitId,
          actionId,
          userAddress: l1Address,
        })
      : null

    const l2Signature = await signL2CleanHandsAttestation({
      circuitId,
      actionId,
      nonce,
      userAztecAddress: l2Address,
    })

    return NextResponse.json({
      l1Signature,
      l2Signature,
      nonce: nonce.toString(),
      circuitId: circuitId.toString(),
      actionId: actionId.toString(),
    })
  } catch (error) {
    console.error('[attestation/poch]', error)
    return NextResponse.json({ error: 'Failed to issue POCH attestation' }, { status: 500 })
  }
}
