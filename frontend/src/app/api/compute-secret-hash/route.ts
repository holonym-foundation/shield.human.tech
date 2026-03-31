import { NextRequest, NextResponse } from 'next/server'
import { Fr } from '@aztec/aztec.js/fields'
import { computeSecretHash } from '@aztec/aztec.js/crypto'
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon'

/**
 * POST /api/compute-secret-hash
 *
 * Computes poseidon2 secret hash server-side so the browser doesn't need
 * SharedArrayBuffer / cross-origin isolation (which blocks wallet popups).
 *
 * Standard mode (default):
 *   Body: { secret: string }
 *   Returns: { secretHash: string }
 *
 * FPC bridge mode (type: 'fpc-bridge'):
 *   Body: { type: 'fpc-bridge', salt: string, claimer: string }
 *   Returns: { secret: string, secretHash: string }
 *
 *   The PrivateFPC contract derives the bridge secret as:
 *     secret = poseidon2HashWithSeparator([salt, claimer], DOM_SEP_FPC_BRIDGE_SECRET)
 *   where DOM_SEP_FPC_BRIDGE_SECRET = 3952304070 and claimer = user's Aztec address
 *   (the contract uses msg_sender() as the claimer in mint/mint_and_pay_fee).
 */

const DOM_SEP_FPC_BRIDGE_SECRET = 3952304070

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    if (body.type === 'fpc-bridge') {
      const { salt, claimer } = body
      if (!salt || !claimer) {
        return NextResponse.json(
          { error: 'Missing salt or claimer for fpc-bridge mode' },
          { status: 400 },
        )
      }

      const saltFr = Fr.fromString(salt)
      const claimerFr = Fr.fromString(claimer)

      const secret = await poseidon2HashWithSeparator(
        [saltFr, claimerFr],
        DOM_SEP_FPC_BRIDGE_SECRET,
      )
      const secretHash = await computeSecretHash(secret)

      return NextResponse.json({
        secret: secret.toString(),
        secretHash: secretHash.toString(),
      })
    }

    // Standard mode
    const { secret } = body

    if (!secret || typeof secret !== 'string') {
      return NextResponse.json({ error: 'Missing secret' }, { status: 400 })
    }

    const secretFr = Fr.fromString(secret)
    const hash = await computeSecretHash(secretFr)

    return NextResponse.json({ secretHash: hash.toString() })
  } catch (error) {
    console.error('[compute-secret-hash] Error:', error)
    return NextResponse.json(
      { error: 'Failed to compute secret hash' },
      { status: 500 },
    )
  }
}
