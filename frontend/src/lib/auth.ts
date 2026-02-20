import { NextRequest } from 'next/server'
import { verifyJWT, extractTokenFromHeader, type JWTPayload } from './jwt'
import { prisma } from './prisma'

export interface AuthUser {
  id: string
  l1Address: string
  l2Address: string
  l1LoginMethod: string | null
  l1WalletProvider: string | null
  l2LoginMethod: string | null
  l2WalletProvider: string | null
}

export async function authenticateRequest(request: NextRequest): Promise<{
  success: boolean
  user?: AuthUser
  error?: string
}> {
  try {
    const authHeader = request.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return {
        success: false,
        error: 'No authentication token provided',
      }
    }

    const payload = verifyJWT(token)
    if (!payload) {
      return {
        success: false,
        error: 'Invalid or expired token',
      }
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        l1Address: true,
        l2Address: true,
        l1LoginMethod: true,
        l1WalletProvider: true,
        l2LoginMethod: true,
        l2WalletProvider: true,
      },
    })

    if (!user) {
      return {
        success: false,
        error: 'User not found',
      }
    }

    return {
      success: true,
      user: {
        id: user.id,
        l1Address: user.l1Address,
        l2Address: user.l2Address,
        l1LoginMethod: user.l1LoginMethod,
        l1WalletProvider: user.l1WalletProvider,
        l2LoginMethod: user.l2LoginMethod,
        l2WalletProvider: user.l2WalletProvider,
      },
    }
  } catch (error) {
    console.error('Authentication error:', error)
    return {
      success: false,
      error: 'Authentication failed',
    }
  }
}

export function createAuthErrorResponse(error: string, status: number = 401) {
  return Response.json({ error, message: error }, { status })
}
