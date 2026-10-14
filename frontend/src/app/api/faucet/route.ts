import { NextResponse } from 'next/server'

/**
 * POST /api/faucet — disabled.
 *
 * The handler body is deliberately gone rather than left unreachable below the
 * 503: it sent ETH from FAUCET_PRIVATE_KEY to any address in the request body,
 * with no authentication and no server-side rate limit, so re-enabling it was
 * one deleted line away from an open drain on the faucet wallet. Recover it
 * from history if the internal faucet is wanted again, and give it auth and a
 * session-derived recipient the way /api/mint-tokens does.
 */
export async function POST() {
  return NextResponse.json({ error: 'Faucet API is currently disabled' }, { status: 503 })
}
