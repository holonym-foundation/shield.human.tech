// frontend/src/app/api/auth/authenticate/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { prisma } from '@/lib/prisma'
import { signJWT } from '@/lib/jwt'
import { consumeNonce } from '@/lib/siweNonceStore'
import { AuthenticateSchema } from '@/lib/validation'
import { AUTH_EXPECTED_DOMAIN } from '@/config/env.config'
import { L2_RESOURCE_PREFIX } from '@human.tech/aztec-bridge-sdk'

/** Aztec address: 0x followed by 64 hex chars */
const AZTEC_ADDRESS_REGEX = /^0x[a-fA-F0-9]{64}$/

/**
 * Extract and validate the L2 (Aztec) address from SIWE resources.
 * Returns lowercase address or null if invalid.
 */
function extractL2Address(resources: string[] | undefined): string | null {
  if (!resources || resources.length === 0) return null
  const resource = resources[0]
  if (!resource.startsWith(L2_RESOURCE_PREFIX)) return null
  const address = resource.slice(L2_RESOURCE_PREFIX.length)
  if (!AZTEC_ADDRESS_REGEX.test(address)) return null
  return address.toLowerCase()
}

/**
 * POST /api/auth/authenticate
 *
 * Verifies a SIWE (EIP-4361) signed message to prove L1 wallet ownership.
 * Extracts L2 address from the message's resources field.
 * Issues a JWT on success.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // ── Validate + sanitize inputs via Zod ──────────────────────────────
    const parsed = AuthenticateSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json(
        { error: `Validation error: ${firstError.path.join('.')} — ${firstError.message}` },
        { status: 400 },
      )
    }

    const data = parsed.data

    // ── Parse SIWE message ────────────────────────────────────────────
    let siweMessage: SiweMessage
    try {
      siweMessage = new SiweMessage(data.message)
    } catch {
      return NextResponse.json({ error: 'Invalid SIWE message format' }, { status: 400 })
    }

    // ── Validate nonce exists (check without consuming) ────────────────
    const messageNonce = siweMessage.nonce
    if (!messageNonce) {
      return NextResponse.json({ error: 'Missing nonce in SIWE message.' }, { status: 400 })
    }

    // ── Verify SIWE signature BEFORE consuming the nonce ──────────────
    // This prevents a DoS where an attacker submits a valid nonce with an
    // invalid signature, burning the nonce before the legitimate user.
    //
    // pin the expected domain to env (AUTH_EXPECTED_DOMAIN) instead of
    // trusting the request Host header. A misconfigured proxy that lets an
    // attacker send Host: evil.com would otherwise verify a SIWE message
    // signed for evil.com. localhost is still allowed for dev convenience.
    const requestHost = request.headers.get('host') ?? ''
    const isLocalhost = requestHost.startsWith('localhost') || requestHost.startsWith('127.0.0.1')
    const expectedDomain = isLocalhost ? requestHost : AUTH_EXPECTED_DOMAIN
    try {
      await siweMessage.verify({
        signature: data.signature as string,
        nonce: messageNonce,
        domain: expectedDomain,
      })
    } catch (err) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // ── Consume nonce AFTER signature is verified ─────────────────────
    // Atomic: lookup + delete in one DB call. If the nonce was already
    // consumed (replay) or expired, reject.
    if (!(await consumeNonce(messageNonce))) {
      return NextResponse.json({ error: 'Invalid or expired nonce. Please try again.' }, { status: 401 })
    }

    // ── Extract addresses from verified message ───────────────────────
    // L1 address: from the SIWE message (cryptographically verified)
    const normalizedL1 = siweMessage.address.toLowerCase()

    // L2 address: from resources field (validated format)
    const normalizedL2 = extractL2Address(siweMessage.resources)
    if (!normalizedL2) {
      return NextResponse.json(
        { error: 'L2 address required in resources (must be valid Aztec address format)' },
        { status: 400 },
      )
    }

    // ── Upsert user ──────────────────────────────────────────────────
    const clientIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? null

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
        l1LoginMethod: data.l1LoginMethod ?? null,
        l1WalletProvider: data.l1WalletProvider ?? null,
        l2LoginMethod: data.l2LoginMethod ?? null,
        l2WalletProvider: data.l2WalletProvider ?? null,
        lastLoginAt: new Date(),
        lastLoginIp: clientIp,
      },
      update: {
        ...(data.l1LoginMethod !== undefined && { l1LoginMethod: data.l1LoginMethod }),
        ...(data.l1WalletProvider !== undefined && { l1WalletProvider: data.l1WalletProvider }),
        ...(data.l2LoginMethod !== undefined && { l2LoginMethod: data.l2LoginMethod }),
        ...(data.l2WalletProvider !== undefined && { l2WalletProvider: data.l2WalletProvider }),
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
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 })
  }
}
