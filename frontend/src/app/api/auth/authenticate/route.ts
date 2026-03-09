import { NextRequest, NextResponse } from 'next/server'
import { verifyMessage } from 'viem'
import { prisma } from '@/lib/prisma'
import { signJWT } from '@/lib/jwt'
import {
  sanitizeEthAddress,
  sanitizeHexString,
  sanitizeString,
} from '@/lib/validation'

/**
 * Build the deterministic auth message that the frontend signs.
 * Must match the message constructed in AuthSync.tsx.
 */
function buildAuthMessage(l1Address: string, l2Address: string): string {
  return [
    'Aztec Bridge - Authenticate',
    '',
    'Sign this message to prove you own this wallet.',
    'This does not cost any gas.',
    '',
    `L1 Wallet: ${l1Address.toLowerCase()}`,
    `L2 Wallet: ${l2Address.toLowerCase()}`,
  ].join('\n')
}

/**
 * POST /api/auth/authenticate
 * Find or create User by (l1Address, l2Address); store L1/L2 login method and provider.
 * Requires a wallet signature to prove ownership of the L1 address.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // ── Sanitize inputs ─────────────────────────────────────────────────
    const normalizedL1 = sanitizeEthAddress(body.l1Address)
    const normalizedL2 = sanitizeHexString(body.l2Address, 130)
    const signature = sanitizeString(body.signature, 200)
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
    if (!signature) {
      return NextResponse.json(
        { error: 'Missing wallet signature. Please sign to prove wallet ownership.' },
        { status: 400 }
      )
    }

    // ── Verify wallet signature ─────────────────────────────────────────
    const message = buildAuthMessage(normalizedL1, normalizedL2)
    const isValid = await verifyMessage({
      address: normalizedL1 as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    })

    if (!isValid) {
      console.warn('[auth/authenticate] Invalid signature for', normalizedL1)
      return NextResponse.json(
        { error: 'Invalid wallet signature. The signature does not match the claimed L1 address.' },
        { status: 401 }
      )
    }

    // Extract client IP from headers (works behind proxies / Vercel)
    const clientIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null

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
        lastLoginAt: new Date(),
        lastLoginIp: clientIp,
      },
      update: {
        ...(l1LoginMethod !== undefined && { l1LoginMethod }),
        ...(l1WalletProvider !== undefined && { l1WalletProvider }),
        ...(l2LoginMethod !== undefined && { l2LoginMethod }),
        ...(l2WalletProvider !== undefined && { l2WalletProvider }),
        lastLoginAt: new Date(),
        lastLoginIp: clientIp,
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
