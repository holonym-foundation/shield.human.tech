import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { PassportAttestationSchema } from '@/lib/validation'
import { enforceAddressBinding, getNextNonce } from '@/lib/address-binding'
import {
  fetchPassportScore,
  signPassportAttestation,
  signL2PassportAttestation,
  getPassportMaxAmount,
  getPassportScoreThreshold,
} from '@/lib/attestation'
import { screenAddress, SanctionsScreeningUnavailableError } from '@/lib/sanctions'

/**
 * POST /api/attestation/passport
 *
 * 1. Authenticate user (JWT)
 * 2. Enforce 1:1 address binding
 * 3. Fetch passport score from Gitcoin Passport API
 * 4. If score >= threshold, issue signed max-amount attestation (L1 ECDSA + L2 Schnorr)
 *
 * Body: { portalAddress: string, bridgeAddress?: string, deadline?: number }
 * Returns: { l1Signature, l2Signature, nonce, maxAmount, deadline, score, threshold }
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
    const parsed = PassportAttestationSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json(
        { error: `Validation error: ${firstError.path.join('.')} — ${firstError.message}` },
        { status: 400 },
      )
    }

    const data = parsed.data

    // bridgeAddress is needed for L2 Schnorr signing (message binding)
    const bridgeAddress = data.bridgeAddress

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
        console.error('[attestation/passport] sanctions screening unavailable:', err.message)
        return NextResponse.json(
          { error: 'Compliance screening temporarily unavailable. Please try again shortly.' },
          { status: 503 },
        )
      }
      throw err
    }

    // 3. Fetch passport score
    const { score, passing } = await fetchPassportScore(l1Address)

    if (!passing) {
      return NextResponse.json(
        {
          error: 'Passport score too low',
          score,
          threshold: getPassportScoreThreshold(),
          passing: false,
        },
        { status: 403 },
      )
    }

    // 4. Issue signed attestation (L1 ECDSA + L2 Schnorr)
    const maxAmount = getPassportMaxAmount()
    const nonce = await getNextNonce(l1Address, 'passport')

    // Default deadline: 1 hour from now
    const deadlineSeconds = data.deadline ? BigInt(data.deadline) : BigInt(Math.floor(Date.now() / 1000) + 3600)

    const l1Signature = await signPassportAttestation({
      userAddress: l1Address,
      maxAmount,
      nonce: BigInt(nonce),
      deadline: deadlineSeconds,
      // F7: Zod schema now requires portalAddress; no `?? ''` wildcard fallback.
      portalAddress: data.portalAddress,
    })

    // L2 Schnorr signature (only if bridgeAddress provided)
    let l2Signature: number[] | null = null
    if (bridgeAddress) {
      l2Signature = await signL2PassportAttestation({
        userAztecAddress: l2Address,
        maxAmount,
        nonce: BigInt(nonce),
        deadline: deadlineSeconds,
        bridgeAddress,
      })
    }

    return NextResponse.json({
      l1Signature,
      l2Signature,
      nonce,
      maxAmount: maxAmount.toString(),
      deadline: deadlineSeconds.toString(),
      score,
      threshold: getPassportScoreThreshold(),
    })
  } catch (error) {
    console.error('[attestation/passport]', error)
    return NextResponse.json({ error: 'Failed to issue passport attestation' }, { status: 500 })
  }
}
