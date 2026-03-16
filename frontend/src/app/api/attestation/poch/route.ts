import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { sanitizeEthAddress } from '@/lib/validation'
import { enforceAddressBinding, getNextNonce } from '@/lib/address-binding'
import {
  checkCleanHands,
  signCleanHandsAttestation,
  signL2CleanHandsAttestation,
  getCircuitId,
  getDefaultActionId,
} from '@/lib/attestation'

/**
 * POST /api/attestation/poch
 *
 * 1. Authenticate user (JWT)
 * 2. Enforce 1:1 address binding (l1Address <-> l2Address)
 * 3. Verify clean hands via Holonym sandbox API
 * 4. Issue signed attestation from our POCH attester (L1 ECDSA + L2 Schnorr)
 *
 * Body: { portalAddress: string }
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

    // 3. Check clean hands via Holonym
    const actionId = getDefaultActionId()
    const holonymResult = await checkCleanHands(l1Address, actionId)

    if (!holonymResult.isUnique) {
      return NextResponse.json(
        { error: 'Clean hands check failed: address does not have a valid attestation', isUnique: false },
        { status: 403 }
      )
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
    return NextResponse.json(
      { error: 'Failed to issue POCH attestation' },
      { status: 500 }
    )
  }
}
