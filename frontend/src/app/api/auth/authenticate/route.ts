import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { signJWT } from '@/lib/jwt'
import {
  sanitizeEthAddress,
  sanitizeHexString,
  sanitizeString,
} from '@/lib/validation'


/**
 * POST /api/auth/authenticate
 * Find or create User by (l1Address, l2Address); store L1/L2 login method and provider.
 * Auth when both L1 and L2 are connected. See frontend/prisma/USER_AND_AUTH_DESIGN.md.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // ── Sanitize inputs ─────────────────────────────────────────────────
    const normalizedL1 = sanitizeEthAddress(body.l1Address)
    const normalizedL2 = sanitizeHexString(body.l2Address, 130)
    const l1LoginMethod = sanitizeString(body.l1LoginMethod, 50)
    const l1WalletProvider = sanitizeString(body.l1WalletProvider, 100)
    const l2LoginMethod = sanitizeString(body.l2LoginMethod, 50)
    const l2WalletProvider = sanitizeString(body.l2WalletProvider, 100)

    if (!normalizedL1) {
      return NextResponse.json(
        { error: 'Invalid L1 address (must be 0x + 40 hex chars)' },
        { status: 400 }
      )
    }
    if (!normalizedL2) {
      return NextResponse.json(
        { error: 'Invalid L2 address (must be a hex string)' },
        { status: 400 }
      )
    }

    const user = await prisma.user.upsert({
      where: {
        l1Address_l2Address: {
          l1Address: normalizedL1,
          l2Address: normalizedL2,
        },
      },
      create: {
        l1Address: normalizedL1,
        l2Address: normalizedL2,
        l1LoginMethod: l1LoginMethod ?? null,
        l1WalletProvider: l1WalletProvider ?? null,
        l2LoginMethod: l2LoginMethod ?? null,
        l2WalletProvider: l2WalletProvider ?? null,
      },
      update: {
        ...(l1LoginMethod !== undefined && { l1LoginMethod }),
        ...(l1WalletProvider !== undefined && { l1WalletProvider }),
        ...(l2LoginMethod !== undefined && { l2LoginMethod }),
        ...(l2WalletProvider !== undefined && { l2WalletProvider }),
      },
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

    const token = signJWT({
      userId: user.id,
      l1Address: user.l1Address,
      l2Address: user.l2Address,
    })

    return NextResponse.json({
      success: true,
      token,
      user: {
        id: user.id,
        l1Address: user.l1Address,
        l2Address: user.l2Address,
        l1LoginMethod: user.l1LoginMethod,
        l1WalletProvider: user.l1WalletProvider,
        l2LoginMethod: user.l2LoginMethod,
        l2WalletProvider: user.l2WalletProvider,
      },
    })
  } catch (error) {
    console.error('[auth/authenticate]', error)
    return NextResponse.json(
      { error: 'Authentication failed' },
      { status: 500 }
    )
  }
}
