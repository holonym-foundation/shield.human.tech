import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import {
  fetchPassportScore,
  getPassportScoreThreshold,
  getPassportMaxAmount,
} from '@/lib/attestation'
import {
  checkAddressBindingConflict,
  evaluateDepositLimit,
  evaluateTravelRuleThreshold,
  getReservedDepositUsd,
  usdToTokenBaseUnits,
} from '@/lib/address-binding'
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
    const bindingError = await checkAddressBindingConflict(l1Address, l2Address)
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

    // Outstanding reservation holds count against both caps below, exactly as the
    // signing route charges them — so the UI pre-blocks a deposit the signing route
    // would reject on a hold, instead of enabling the button and dead-ending there.
    const reservedUsd = await getReservedDepositUsd(authResult.user.id)
    const reservedRounded = Math.round(reservedUsd * 100) / 100

    // Cumulative per-human Travel Rule threshold: once lifetime volume reaches it,
    // the passport tier is no longer eligible — the user must upgrade to POCH. This
    // uses settled volume only (travelRule.exceeded), so a temporary hold does NOT
    // route the user to Clean Hands; it only shrinks the remaining budget below.
    const travelRule = await evaluateTravelRuleThreshold({ userId: authResult.user.id })
    if (travelRule.enabled && travelRule.exceeded) {
      return NextResponse.json({
        eligible: false,
        score,
        threshold: getPassportScoreThreshold(),
        maxAmount: getPassportMaxAmount().toString(),
        travelRuleExceeded: true,
        reason: `You've reached the $${travelRule.thresholdUsd.toFixed(0)} verification threshold. Verify with Clean Hands to bridge more.`,
      })
    }

    // Reflect the Alpha per-day (rolling 24h) cap: the displayed per-tx max is the lesser
    // of the global Passport max and the user's remaining settled deposit budget. The hold
    // is NOT folded into the per-tx max (it's transient) — it only zeroes the remaining
    // budget so the button disables with a hold-specific label.
    let maxAmount = getPassportMaxAmount()
    const limit = await evaluateDepositLimit({ userId: authResult.user.id })
    if (limit.enabled) {
      const remainingBaseUnits = usdToTokenBaseUnits(limit.remainingUsd, 'USDC', 6)
      if (remainingBaseUnits < maxAmount) maxAmount = remainingBaseUnits
    }

    const depositRemainingUsd = limit.enabled ? Math.max(0, limit.remainingUsd - reservedUsd) : undefined
    const travelRuleRemainingUsd = travelRule.enabled ? Math.max(0, travelRule.remainingUsd - reservedUsd) : undefined

    return NextResponse.json({
      eligible: passing,
      score,
      threshold: getPassportScoreThreshold(),
      maxAmount: maxAmount.toString(),
      ...(depositRemainingUsd != null
        ? { depositLimitReached: depositRemainingUsd <= 0, remainingUsd: depositRemainingUsd }
        : {}),
      ...(travelRuleRemainingUsd != null ? { travelRuleRemainingUsd } : {}),
      ...(reservedRounded > 0 ? { reservedUsd: reservedRounded } : {}),
      reason: passing
        ? undefined
        : `Human Passport score too low (${score}/${getPassportScoreThreshold()} required)`,
    })
  } catch (error) {
    console.error('[attestation/passport/check]', error)
    return NextResponse.json(
      { error: 'Failed to check Human Passport eligibility' },
      { status: 500 }
    )
  }
}
