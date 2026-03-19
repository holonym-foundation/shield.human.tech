import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'

/**
 * GET /api/auth/verify
 * Lightweight session validation — checks if the JWT is valid and the user exists.
 * Returns structured { valid, user/reason } so callers can branch without parsing errors.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)

    if (authResult.success && authResult.user) {
      return NextResponse.json({ valid: true, user: authResult.user })
    }

    const error = authResult.error ?? ''
    let reason: string

    if (error.includes('No authentication token')) {
      reason = 'no_token'
    } else if (error.includes('expired') || error.includes('Invalid')) {
      reason = 'token_expired'
    } else if (error.includes('User not found')) {
      reason = 'user_not_found'
    } else {
      return NextResponse.json(
        { valid: false, reason: 'network_error' },
        { status: 500 },
      )
    }

    return NextResponse.json(
      { valid: false, reason },
      { status: 401 },
    )
  } catch (error) {
    console.error('[auth/verify]', error)
    return NextResponse.json(
      { valid: false, reason: 'network_error' },
      { status: 500 },
    )
  }
}
