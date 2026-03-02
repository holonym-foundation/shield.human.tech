import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { sanitizeEthAddress } from '@/lib/validation'
import { enforceAddressBinding, getNextNonce } from '@/lib/address-binding'
import {
  fetchPassportScore,
  signPassportAttestation,
  getPassportMaxAmount,
  getPassportScoreThreshold,
} from '@/lib/attestation'

/**
 * POST /api/attestation/passport
 *
 * 1. Authenticate user (JWT)
 * 2. Enforce 1:1 address binding
 * 3. Fetch passport score from Gitcoin Passport API
 * 4. If score >= threshold, issue signed max-amount attestation
 *
 * Body: { portalAddress: string, deadline?: number }
 * Returns: { signature, nonce, maxAmount, deadline, score, threshold }
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
    const portalAddress = sanitizeEthAddress(body.portalAddress)
    if (!portalAddress) {
      return NextResponse.json(
        { error: 'Invalid portalAddress (must be 0x + 40 hex chars)' },
        { status: 400 }
      )
    }

    // 2. Enforce 1:1 address binding
    const bindingError = await enforceAddressBinding(l1Address, l2Address)
    if (bindingError) {
      return NextResponse.json({ error: bindingError }, { status: 403 })
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
        { status: 403 }
      )
    }

    // 4. Issue signed attestation
    const maxAmount = getPassportMaxAmount()
    const nonce = await getNextNonce(l1Address, 'passport')

    // Default deadline: 1 hour from now
    const deadlineSeconds = body.deadline
      ? BigInt(body.deadline)
      : BigInt(Math.floor(Date.now() / 1000) + 3600)

    const signature = await signPassportAttestation({
      userAddress: l1Address,
      maxAmount,
      nonce: BigInt(nonce),
      deadline: deadlineSeconds,
      portalAddress,
    })

    return NextResponse.json({
      signature,
      nonce,
      maxAmount: maxAmount.toString(),
      deadline: deadlineSeconds.toString(),
      score,
      threshold: getPassportScoreThreshold(),
    })
  } catch (error) {
    console.error('[attestation/passport]', error)
    return NextResponse.json(
      { error: 'Failed to issue passport attestation' },
      { status: 500 }
    )
  }
}
