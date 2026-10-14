import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { getAttesterAddress, getPassportSignerAddress } from '@/lib/attestation'

/**
 * GET /api/attestation/status
 *
 * Returns the current attestation state for the authenticated user:
 * - address binding (is it set, and what is it)
 * - Attester/signer addresses (for frontend display)
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const { l1Address, l2Address } = authResult.user

    // Keyed on L1 only — SIWE proves that half, so both addresses disclosed
    // below are the caller's own. Matching on L2 would report a binding some
    // other L1 made against this Aztec account, and disclose that L1.
    const binding = await prisma.addressBinding.findUnique({
      where: { l1Address },
    })

    let bindingStatus: 'unbound' | 'bound' | 'conflict' = 'unbound'
    if (binding) {
      bindingStatus = binding.l2Address === l2Address ? 'bound' : 'conflict'
    }

    return NextResponse.json({
      binding: {
        status: bindingStatus,
        l1Address: binding?.l1Address ?? null,
        l2Address: binding?.l2Address ?? null,
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
