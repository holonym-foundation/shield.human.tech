import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { getAttesterAddress, getPassportSignerAddress } from '@/lib/attestation'

/**
 * GET /api/attestation/status
 *
 * Returns the current attestation state for the authenticated user:
 * - address binding (is it set, and what is it)
 * - POCH nonce (how many attestations issued)
 * - Passport nonce (how many attestations issued)
 * - Attester/signer addresses (for frontend display)
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const { l1Address, l2Address } = authResult.user

    // Check address binding
    const binding = await prisma.addressBinding.findFirst({
      where: {
        OR: [{ l1Address }, { l2Address }],
      },
    })

    let bindingStatus: 'unbound' | 'bound' | 'conflict' = 'unbound'
    if (binding) {
      bindingStatus = (binding.l1Address === l1Address && binding.l2Address === l2Address)
        ? 'bound'
        : 'conflict'
    }

    // Get nonces
    const [pochNonce, passportNonce] = await Promise.all([
      prisma.attestationNonce.findUnique({
        where: { l1Address_type: { l1Address, type: 'poch' } },
      }),
      prisma.attestationNonce.findUnique({
        where: { l1Address_type: { l1Address, type: 'passport' } },
      }),
    ])

    return NextResponse.json({
      binding: {
        status: bindingStatus,
        l1Address: binding?.l1Address ?? null,
        l2Address: binding?.l2Address ?? null,
      },
      poch: {
        noncesUsed: pochNonce?.nonce ?? 0,
      },
      passport: {
        noncesUsed: passportNonce?.nonce ?? 0,
      },
      config: {
        attesterAddress: getAttesterAddress(),
        passportSignerAddress: getPassportSignerAddress(),
      },
    })
  } catch (error) {
    console.error('[attestation/status]', error)
    return NextResponse.json(
      { error: 'Failed to fetch attestation status' },
      { status: 500 }
    )
  }
}
