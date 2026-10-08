import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { PassportAttestationSchema } from '@/lib/validation'
import {
  enforceAddressBinding,
  getNextNonce,
  reservePassportBudget,
  ATTESTATION_TTL_SECONDS,
  ATTESTATION_TTL_MINUTES,
} from '@/lib/address-binding'
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
    const bindingError = await enforceAddressBinding(l1Address, l2Address, {
      l2NetworkVerified: authResult.user.l2NetworkVerified,
    })
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
          error: 'Human Passport score too low',
          score,
          threshold: getPassportScoreThreshold(),
          passing: false,
        },
        { status: 403 },
      )
    }

    // A passport attestation is a deposit authorization unless the request is an
    // explicit withdrawal. `direction` is client-controlled, so it may gate policy
    // but must never be trusted to relax it: a missing or spoofed direction is
    // treated as a deposit, so the cumulative caps can't be skipped by omitting the
    // field, and the L1 signature — the only artifact a TokenPortal deposit
    // consumes — is issued for deposits only, so a withdrawal request can never
    // hand back a deposit authorization.
    const isDeposit = data.direction !== 'L2_TO_L1'

    // 4. Issue signed attestation (L1 ECDSA + L2 Schnorr)
    const nonce = getNextNonce()

    // Bound the deadline server-side: never further out than ATTESTATION_TTL_SECONDS,
    // regardless of client input, so an attestation can't be signed far in the
    // future and banked. This deadline is also the reservation's TTL below.
    const nowSeconds = Math.floor(Date.now() / 1000)
    const maxDeadline = nowSeconds + ATTESTATION_TTL_SECONDS
    const deadlineSeconds = BigInt(data.deadline ? Math.min(data.deadline, maxDeadline) : maxDeadline)

    let maxAmount = getPassportMaxAmount()

    // Cap the signed ceiling to the amount the client will actually deposit. The
    // portal accepts any deposit <= maxAmount, so signing the full per-tx ceiling
    // reserves the user's whole budget for a smaller deposit and blocks their next
    // one until the reservation's TTL (<= 30 min). Sizing the signature to the requested
    // amount lets the reservation retire against the confirmed deposit instead. The
    // value is client-supplied, so it can only tighten the ceiling here — the
    // budget-derived cap below still applies, and the portal rejects any deposit
    // above the signed amount.
    if (isDeposit && data.amount) {
      const requested = BigInt(data.amount)
      if (requested > 0n && requested < maxAmount) maxAmount = requested
    }

    // Deposit caps (cumulative Travel Rule threshold + Alpha rolling-24h cap).
    // Evaluated AND reserved atomically under a per-user lock, so concurrent requests
    // can't each pass a stale budget check and each get a full-budget signature
    // (TOCTOU). `amount` is optional, so the binding enforcement is capping the signed
    // maxAmount to the remaining budget — not the requested-amount comparison alone.
    if (isDeposit) {
      const reservation = await reservePassportBudget({
        userId: authResult.user.id,
        nonce,
        expiresAt: new Date(Number(deadlineSeconds) * 1000),
        perTxMaxAmount: maxAmount,
        tokenSymbol: data.tokenSymbol ?? 'USDC',
        tokenDecimals: data.tokenDecimals ?? 6,
      })
      if (!reservation.ok) {
        if (reservation.reason === 'travel_rule') {
          // A hold-driven block (settled lifetime is still under the threshold, but an
          // outstanding reservation tips it over) is temporary — say so instead of telling
          // the user to go verify with Clean Hands, which they don't need to do to bridge more.
          const holdDriven =
            reservation.reservedUsd > 0 && reservation.lifetimeUsd + 1e-6 < reservation.thresholdUsd
          return NextResponse.json(
            {
              error: holdDriven
                ? `A pending deposit is holding $${reservation.reservedUsd.toFixed(2)} of your $${reservation.thresholdUsd.toFixed(0)} verification limit. It frees up once that deposit confirms, or within ${ATTESTATION_TTL_MINUTES} minutes.`
                : `You've reached the $${reservation.thresholdUsd.toFixed(0)} verification threshold. Verify with Clean Hands to bridge more.`,
              reason: holdDriven ? 'pending_hold' : 'travel_rule',
            },
            { status: 403 },
          )
        }
        const holdDriven =
          reservation.reservedUsd > 0 && reservation.confirmedUsd + 1e-6 < reservation.limitUsd
        return NextResponse.json(
          {
            error: holdDriven
              ? `A pending deposit is holding $${reservation.reservedUsd.toFixed(2)} of your $${reservation.limitUsd.toFixed(0)}/day limit. It frees up once that deposit confirms, or within ${ATTESTATION_TTL_MINUTES} minutes.`
              : `Alpha deposit limit reached ($${reservation.limitUsd.toFixed(0)} per user / day). You have $${reservation.confirmedUsd.toFixed(2)} of $${reservation.limitUsd.toFixed(2)} used in the last 24h.`,
            reason: holdDriven ? 'pending_hold' : 'deposit_limit',
          },
          { status: 403 },
        )
      }
      maxAmount = reservation.maxAmount
    }

    // Only a deposit needs the L1 (portal) attestation; a withdrawal is verified by
    // the L2 Schnorr signature below. Issuing an L1 signature for a withdrawal would
    // be a deposit authorization that skipped the caps above.
    const l1Signature = isDeposit
      ? await signPassportAttestation({
          userAddress: l1Address,
          maxAmount,
          nonce,
          deadline: deadlineSeconds,
          portalAddress: data.portalAddress,
        })
      : null

    // L2 Schnorr signature (only if bridgeAddress provided)
    let l2Signature: number[] | null = null
    if (bridgeAddress) {
      l2Signature = await signL2PassportAttestation({
        userAztecAddress: l2Address,
        maxAmount,
        nonce,
        deadline: deadlineSeconds,
        bridgeAddress,
      })
    }

    return NextResponse.json({
      l1Signature,
      l2Signature,
      nonce: nonce.toString(),
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
