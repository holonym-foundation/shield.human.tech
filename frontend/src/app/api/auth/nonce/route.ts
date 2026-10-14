// frontend/src/app/api/auth/nonce/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createNonce, checkRateLimit, cleanupExpiredNonces } from '@/lib/siweNonceStore'
import { getClientIp } from '@/lib/validation'

export async function GET(request: NextRequest) {
  // Rate limit by IP
  const ip = getClientIp(request.headers) ?? 'unknown'

  if (!checkRateLimit(ip)) {
    return new NextResponse('Too many requests', { status: 429 })
  }

  // Opportunistic cleanup: ~5% of requests clean expired nonces (non-blocking).
  // On Vercel serverless there is no cron, so this prevents unbounded table growth.
  if (Math.random() < 0.05) {
    cleanupExpiredNonces().catch(() => {})
  }

  const nonce = await createNonce()
  return new NextResponse(nonce, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}
