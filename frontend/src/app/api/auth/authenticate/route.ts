// frontend/src/app/api/auth/authenticate/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { SiweMessage } from 'siwe'
import { prisma } from '@/lib/prisma'
import { signJWT } from '@/lib/jwt'
import { consumeNonce } from '@/lib/siweNonceStore'
import { AuthenticateSchema, getClientIp } from '@/lib/validation'
import { getAllowedAppHosts, getAllowedAppOrigins, isLocalDevHost } from '@/lib/domainAllowlist'

/** Aztec address: 0x followed by 64 hex chars */
const AZTEC_ADDRESS_REGEX = /^0x[a-fA-F0-9]{64}$/

function isAllowedSiweDomain(domain: string): boolean {
  return getAllowedAppHosts().has(domain) || isLocalDevHost(domain)
}

function isAllowedResourceOrigin(origin: string): boolean {
  return getAllowedAppOrigins().has(origin) || isLocalDevHost(origin)
}

/**
 * Extract and validate the L2 (Aztec) address from SIWE resources.
 * Returns lowercase address or null if invalid.
 */
function extractL2Address(
  resources: string[] | undefined,
  isAllowedOrigin: (origin: string) => boolean,
): string | null {
  if (!resources || resources.length === 0) return null

  for (const resource of resources) {
    try {
      const url = new URL(resource)
      if (!isAllowedOrigin(url.origin)) continue

      const match = url.pathname.match(/^\/aztec\/address\/(0x[a-fA-F0-9]{64})$/)
      if (!match) continue

      const address = match[1]
      if (!AZTEC_ADDRESS_REGEX.test(address)) continue
      return address.toLowerCase()
    } catch {
      continue
    }
  }

  return null
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
    // The accepted domain comes from this deployment's own network, never from
    // the request: a proxy that let an attacker set Host would otherwise let
    // them choose the domain the user was shown before signing.
    if (!isAllowedSiweDomain(siweMessage.domain)) {
      return NextResponse.json({ error: `Invalid SIWE domain: ${siweMessage.domain}` }, { status: 401 })
    }

    try {
      await siweMessage.verify({
        signature: data.signature as string,
        nonce: messageNonce,
        domain: siweMessage.domain,
      })
    } catch {
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
    // The uri is signed but attacker-chosen, so it is checked against the
    // allow-list rather than used to widen it.
    let siweUriOrigin: string
    try {
      siweUriOrigin = new URL(siweMessage.uri).origin
    } catch {
      return NextResponse.json({ error: 'Invalid SIWE uri' }, { status: 400 })
    }
    if (!isAllowedResourceOrigin(siweUriOrigin)) {
      return NextResponse.json({ error: `Invalid SIWE uri origin: ${siweUriOrigin}` }, { status: 401 })
    }

    const normalizedL2 = extractL2Address(siweMessage.resources, isAllowedResourceOrigin)
    if (!normalizedL2) {
      return NextResponse.json(
        { error: 'L2 address required in resources (must be a valid Aztec address URL for this origin)' },
        { status: 400 },
      )
    }

    // ── Upsert user ──────────────────────────────────────────────────
    const clientIp = getClientIp(request.headers) ?? null

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
    const message = error instanceof Error ? error.message : 'Authentication failed'
    if (message.includes('JWT_SECRET')) {
      return NextResponse.json({ error: 'Authentication server misconfigured' }, { status: 500 })
    }
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 })
  }
}
