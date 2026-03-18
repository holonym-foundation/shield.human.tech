// frontend/src/lib/siweNonceStore.ts
import { generateNonce } from 'siwe'
import { prisma } from './prisma'

const NONCE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX = 10 // max nonces per IP per minute

// Rate limiting stays in-memory (acceptable — it's best-effort, not security-critical)
const globalStore = globalThis as unknown as {
  __siweRateLimits?: Map<string, { count: number; windowStart: number }>
}
if (!globalStore.__siweRateLimits) {
  globalStore.__siweRateLimits = new Map()
}
const rateLimitMap = globalStore.__siweRateLimits

/**
 * Generate a new nonce and persist it in the database with a TTL.
 * Returns the nonce string.
 */
export async function createNonce(): Promise<string> {
  const nonce = generateNonce()
  await prisma.authNonce.create({
    data: {
      nonce,
      expiresAt: new Date(Date.now() + NONCE_TTL_MS),
    },
  })
  return nonce
}

/**
 * Consume a nonce: validate it exists and hasn't expired, then delete it.
 * Returns true if valid, false if invalid/expired/missing.
 */
export async function consumeNonce(nonce: string): Promise<boolean> {
  // Atomic delete — returns the row if it existed, throws if not found
  try {
    const entry = await prisma.authNonce.delete({
      where: { nonce },
    })
    // Check expiry after deletion (already consumed either way)
    return entry.expiresAt > new Date()
  } catch {
    // Row not found (already consumed or never existed)
    return false
  }
}

/**
 * Delete expired nonces from the database.
 * Call periodically or on a cron to keep the table clean.
 */
export async function cleanupExpiredNonces(): Promise<number> {
  const result = await prisma.authNonce.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  })
  return result.count
}

/**
 * Check IP rate limit for nonce requests.
 * Returns true if within limit, false if exceeded.
 * (In-memory — best-effort, resets on restart. Acceptable for rate limiting.)
 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now })
    return true
  }

  entry.count++
  return entry.count <= RATE_LIMIT_MAX
}
