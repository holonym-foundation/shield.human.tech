import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import {
  sanitizeString,
  sanitizeEthAddress,
  sanitizeHexString,
  sanitizeNumericString,
  sanitizeInt,
  sanitizeBoolean,
  sanitizeNodeInfo,
  sanitizeCiphertext,
  MAX_STRING_LENGTH,
} from '@/lib/validation'

const KEY_DERIVATION_DOMAIN = 'https://bridge.human.tech/'

/** Valid direction values. */
const VALID_DIRECTIONS = new Set(['L1_TO_L2', 'L2_TO_L1'])

/** Allow localhost in development for key derivation domain */
function isAllowedKeyDerivationDomain(domain: string): boolean {
  if (domain === KEY_DERIVATION_DOMAIN) return true
  if (process.env.NODE_ENV !== 'production') {
    try {
      const u = new URL(domain)
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
    } catch {
      return false
    }
  }
  return false
}

/**
 * GET /api/bridge/operations
 * List all bridge operations for the authenticated user.
 * Returns operations ordered by createdAt desc, including encrypted fields
 * so the client can decrypt them with the user's wallet signature.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const operations = await prisma.bridgeActivity.findMany({
      where: { fkUserId: authResult.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        direction: true,
        status: true,
        amountL1: true,
        amountL2: true,
        amountDisplayL1: true,
        amountDisplayL2: true,
        tokenSymbolL1: true,
        tokenSymbolL2: true,
        l1TxHash: true,
        l1TxUrl: true,
        l2TxHash: true,
        l2TxUrl: true,
        // L1→L2 recovery fields
        messageHash: true,
        messageLeafIndex: true,
        l1BlockNumberBeforeTx: true,
        claimAmount: true,
        // L1→L2 fuel recovery fields
        fuelMessageHash: true,
        fuelMessageLeafIndex: true,
        fuelAmount: true,
        // L2→L1 recovery fields
        l2BlockNumber: true,
        l2BlockNumberBeforeTx: true,
        l2ToL1MessageIndex: true,
        siblingPath: true,
        epoch: true,
        recipientL1Address: true,
        // Progress tracking
        currentStep: true,
        // Common
        isPrivacyModeEnabled: true,
        lastErrorMessage: true,
        nodeInfo: true,
        createdAt: true,
        completedAt: true,
        // Recovery-critical contract & version snapshot
        rollupVersion: true,
        chainIdL1: true,
        portalAddressL1: true,
        bridgeAddressL2: true,
        l1RollupAddress: true,
        l1OutboxAddress: true,
        // Token info for activity display
        tokenSymbol: true,
        tokenAddressL1: true,
        tokenAddressL2: true,
        tokenDecimalsL1: true,
        tokenDecimalsL2: true,
        tokenNameL1: true,
        tokenNameL2: true,
        // Network names
        fromNetworkName: true,
        toNetworkName: true,
        // Additional contract snapshot
        chainIdL2: true,
        l1InboxAddress: true,
        l1RegistryAddress: true,
        // Encrypted fields for client-side decryption
        encryptedCiphertext: true,
        encryptedIv: true,
        encryptedTag: true,
        // keyDerivationMessage omitted — client can reconstruct from createSigningMessage(l1Address)
        keyDerivationDomain: true,
      },
    })

    return NextResponse.json({ operations })
  } catch (error) {
    console.error('[bridge/operations GET]', error)
    return NextResponse.json(
      { error: 'Failed to fetch operations' },
      { status: 500 },
    )
  }
}

/**
 * POST /api/bridge/operations
 * Store encrypted bridge backup before the user starts the bridge flow.
 * Works for both L1→L2 (deposit) and L2→L1 (withdrawal).
 * Requires auth; body.l1Address must match authenticated user.
 * Server cannot read plaintext; decryption requires the same wallet signature.
 */
export async function POST(request: NextRequest) {
  try {
    if (request.method !== 'POST') {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
    }

    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const body = await request.json()

    // ── Sanitize all inputs ─────────────────────────────────────────────
    const encryptedCiphertext = sanitizeCiphertext(body.encryptedCiphertext)
    const encryptedIv = sanitizeString(body.encryptedIv, 128)
    const encryptedTag = sanitizeString(body.encryptedTag, 128)
    const keyDerivationMessage = sanitizeString(
      body.keyDerivationMessage,
      MAX_STRING_LENGTH,
    )
    const keyDerivationDomain = sanitizeString(
      body.keyDerivationDomain,
      MAX_STRING_LENGTH,
    )
    const direction = sanitizeString(body.direction, 10)
    const l1Address = sanitizeEthAddress(body.l1Address)
    const l2Address = sanitizeHexString(body.l2Address, 130) // Aztec addresses are longer than ETH
    const amountL1 = sanitizeNumericString(body.amountL1)
    const amountL2 = sanitizeNumericString(body.amountL2)
    const amountDisplayL1 = sanitizeString(body.amountDisplayL1, 64)
    const amountDisplayL2 = sanitizeString(body.amountDisplayL2, 64)
    const claimId = sanitizeString(body.claimId, 64)
    const isPrivacyModeEnabled = sanitizeBoolean(body.isPrivacyModeEnabled)
    const l1BlockNumberBeforeTx = sanitizeNumericString(
      body.l1BlockNumberBeforeTx,
    )
    const l2BlockNumberBeforeTx = sanitizeNumericString(
      body.l2BlockNumberBeforeTx,
    )
    const recipientL1Address = sanitizeEthAddress(body.recipientL1Address)
    const nodeInfo = sanitizeNodeInfo(body.nodeInfo)
    // Recovery-critical contract & version snapshot
    const rollupVersion = sanitizeInt(body.rollupVersion, 0, 1_000_000)
    const chainIdL1 = sanitizeInt(body.chainIdL1, 1, 1_000_000_000)
    const chainIdL2 = sanitizeInt(body.chainIdL2, 1, 1_000_000_000)
    const portalAddressL1 = sanitizeEthAddress(body.portalAddressL1)
    const bridgeAddressL2 = sanitizeHexString(body.bridgeAddressL2, 130)
    const l1RollupAddress = sanitizeEthAddress(body.l1RollupAddress)
    const l1OutboxAddress = sanitizeEthAddress(body.l1OutboxAddress)
    const l1InboxAddress = sanitizeEthAddress(body.l1InboxAddress)
    const l1RegistryAddress = sanitizeEthAddress(body.l1RegistryAddress)
    // Token info
    const tokenSymbol = sanitizeString(body.tokenSymbol, 20)
    const tokenSymbolL1 = sanitizeString(body.tokenSymbolL1, 20)
    const tokenSymbolL2 = sanitizeString(body.tokenSymbolL2, 20)
    const tokenNameL1 = sanitizeString(body.tokenNameL1, 100)
    const tokenNameL2 = sanitizeString(body.tokenNameL2, 100)
    const tokenAddressL1 = sanitizeEthAddress(body.tokenAddressL1)
    const tokenAddressL2 = sanitizeHexString(body.tokenAddressL2, 130)
    const tokenDecimalsL1 = sanitizeInt(body.tokenDecimalsL1, 0, 77)
    const tokenDecimalsL2 = sanitizeInt(body.tokenDecimalsL2, 0, 77)
    const currentStep = sanitizeInt(body.currentStep, 0, 10)
    // Fuel secret hashes (plaintext for querying; actual secrets are in encrypted blob)
    const fuelSecretHash = sanitizeHexString(body.fuelSecretHash, 130)
    const privateFuelSecretHash = sanitizeHexString(body.privateFuelSecretHash, 130)

    // ── Validate required fields ────────────────────────────────────────
    if (!encryptedCiphertext || !encryptedIv || !encryptedTag) {
      return NextResponse.json(
        {
          error:
            'Missing encrypted payload (encryptedCiphertext, encryptedIv, encryptedTag)',
        },
        { status: 400 },
      )
    }
    if (!keyDerivationMessage || !keyDerivationDomain) {
      return NextResponse.json(
        {
          error:
            'Missing key derivation (keyDerivationMessage, keyDerivationDomain)',
        },
        { status: 400 },
      )
    }
    if (!isAllowedKeyDerivationDomain(keyDerivationDomain)) {
      return NextResponse.json(
        { error: 'Invalid keyDerivationDomain' },
        { status: 400 },
      )
    }
    if (!l1Address) {
      return NextResponse.json(
        { error: 'Invalid l1Address (must be 0x + 40 hex chars)' },
        { status: 400 },
      )
    }
    if (!l2Address) {
      return NextResponse.json(
        { error: 'Invalid l2Address (must be a hex string)' },
        { status: 400 },
      )
    }
    if (l1Address !== authResult.user.l1Address) {
      return NextResponse.json(
        { error: 'l1Address does not match authenticated wallet' },
        { status: 403 },
      )
    }
    if (l2Address !== authResult.user.l2Address) {
      return NextResponse.json(
        { error: 'l2Address does not match authenticated Aztec address' },
        { status: 403 },
      )
    }
    if (!amountL1) {
      return NextResponse.json(
        { error: 'Invalid amountL1 (must be a numeric string)' },
        { status: 400 },
      )
    }
    if (!amountL2) {
      return NextResponse.json(
        { error: 'Invalid amountL2 (must be a numeric string)' },
        { status: 400 },
      )
    }
    if (!direction || !VALID_DIRECTIONS.has(direction)) {
      return NextResponse.json(
        { error: 'Invalid direction (must be L1_TO_L2 or L2_TO_L1)' },
        { status: 400 },
      )
    }

    const isL2ToL1 = direction === 'L2_TO_L1'

    const operation = await prisma.bridgeActivity.create({
      data: {
        fkUserId: authResult.user.id,
        direction: isL2ToL1
          ? BridgeDirection.L2_TO_L1
          : BridgeDirection.L1_TO_L2,
        status: BridgeOperationStatus.pending,
        encryptedCiphertext,
        encryptedIv,
        encryptedTag,
        keyDerivationMessage,
        keyDerivationDomain,
        amountL1,
        amountL2,
        amountDisplayL1: amountDisplayL1 ?? undefined,
        amountDisplayL2: amountDisplayL2 ?? undefined,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? null,
        l1BlockNumberBeforeTx: l1BlockNumberBeforeTx ?? undefined,
        l2BlockNumberBeforeTx: l2BlockNumberBeforeTx ?? undefined,
        recipientL1Address: isL2ToL1 ? recipientL1Address : undefined,
        nodeInfo: (nodeInfo ?? undefined) as Prisma.InputJsonValue | undefined,
        fromNetworkName: isL2ToL1 ? 'Aztec' : 'Ethereum',
        toNetworkName: isL2ToL1 ? 'Ethereum' : 'Aztec',
        // Recovery-critical contract & version snapshot
        rollupVersion: rollupVersion ?? undefined,
        chainIdL1: chainIdL1 ?? undefined,
        chainIdL2: chainIdL2 ?? undefined,
        portalAddressL1: portalAddressL1 ?? undefined,
        bridgeAddressL2: bridgeAddressL2 ?? undefined,
        l1RollupAddress: l1RollupAddress ?? undefined,
        l1OutboxAddress: l1OutboxAddress ?? undefined,
        l1InboxAddress: l1InboxAddress ?? undefined,
        l1RegistryAddress: l1RegistryAddress ?? undefined,
        // Token info for activity page display
        tokenSymbol: tokenSymbol ?? undefined,
        tokenSymbolL1: tokenSymbolL1 ?? undefined,
        tokenSymbolL2: tokenSymbolL2 ?? undefined,
        tokenNameL1: tokenNameL1 ?? undefined,
        tokenNameL2: tokenNameL2 ?? undefined,
        tokenAddressL1: tokenAddressL1 ?? undefined,
        tokenAddressL2: tokenAddressL2 ?? undefined,
        tokenDecimalsL1: tokenDecimalsL1 ?? undefined,
        tokenDecimalsL2: tokenDecimalsL2 ?? undefined,
        currentStep: currentStep ?? 1,
        // Fuel secret hashes (plaintext for querying; actual secrets in encrypted blob)
        fuelSecretHash: fuelSecretHash ?? undefined,
        privateFuelSecretHash: privateFuelSecretHash ?? undefined,
        // Client IP for audit trail
        clientIp:
          request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
          request.headers.get('x-real-ip') ??
          undefined,
      },
    })

    return NextResponse.json({
      ok: true,
      operationId: operation.id,
      claimId: claimId ?? operation.id,
    })
  } catch (error) {
    console.error('[bridge/operations]', error)
    return NextResponse.json(
      { error: 'Failed to store encrypted backup' },
      { status: 500 },
    )
  }
}
