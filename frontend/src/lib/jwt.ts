import jwt from 'jsonwebtoken'
import { JWT_SECRET, JWT_EXPIRES_IN } from '@/config/env.config'

function getSecret(): string {
  const secret = JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required. Please set it in your .env file.')
  }
  return secret
}

export interface JWTPayload {
  userId: string
  l1Address: string
  l2Address: string
  iat?: number
  exp?: number
}

export function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, getSecret(), {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRES_IN,
  } as jwt.SignOptions)
}

export function verifyJWT(token: string): JWTPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ['HS256'] }) as unknown as JWTPayload
    // Reject old tokens that have a string userId (pre-autoincrement migration)
    if (typeof decoded.userId !== 'string') {
      console.warn('[auth] Rejecting JWT with non-numeric userId — user must re-authenticate')
      return null
    }
    return decoded
  } catch (error) {
    console.error('JWT verification failed:', error)
    return null
  }
}

export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null
  }
  return authHeader.substring(7)
}
