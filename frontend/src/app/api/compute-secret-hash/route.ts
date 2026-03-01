import { NextRequest, NextResponse } from 'next/server'
import { Fr } from '@aztec/aztec.js/fields'
import { computeSecretHash } from '@aztec/aztec.js/crypto'

/**
 * POST /api/compute-secret-hash
 *
 * Computes poseidon2 secret hash server-side so the browser doesn't need
 * SharedArrayBuffer / cross-origin isolation (which blocks wallet popups).
 *
 * Body: { secret: string }   — Fr hex string
 * Returns: { secretHash: string } — Fr hex string
 */
export async function POST(request: NextRequest) {
  try {
    const { secret } = await request.json()

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
