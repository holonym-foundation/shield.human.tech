import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import { CreateOperationSchema } from '@/lib/validation'

/**
 * Validate keyDerivationMessage matches the expected format from `createSigningMessage()`.
 * Must start with the known header and contain a valid wallet address.
 * Prevents garbage data that would break resume decryption.
 */
const KEY_DERIVATION_MESSAGE_PATTERN = /^Aztec Bridge - Unlock My Secrets\n[\s\S]*Wallet: 0x[a-f0-9]{40}$/i

function isValidKeyDerivationMessage(message: string): boolean {
  return KEY_DERIVATION_MESSAGE_PATTERN.test(message)
}

/**
 * Validate keyDerivationDomain is a well-formed HTTPS origin (or localhost in dev).
 * The SDK can be used by any dapp on any domain — we do NOT enforce a specific domain.
 * We only check it's a valid URL to prevent garbage data in the DB.
 */
function isValidKeyDerivationDomain(domain: string): boolean {
  try {
    const u = new URL(domain)
    // Must be https in production, allow http for localhost in dev
    if (u.protocol === 'https:') return true
    if (process.env.NODE_ENV !== 'production' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
      return true
    }
    return false
  } catch {
    return false
  }
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
        // Confirmed block numbers
        l1BlockNumber: true,
        // L1→L2 recovery fields
        messageHash: true,
        messageLeafIndex: true,
        l1BlockNumberBeforeTx: true,
        // L1→L2 post-fee amount (for correct claim on resume)
        amountAfterFee: true,
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
        tokenNameL1: true,
        tokenNameL2: true,
        tokenDecimalsL1: true,
        tokenDecimalsL2: true,
        tokenLogoUrlL1: true,
        tokenLogoUrlL2: true,
        tokenAddressL1: true,
        tokenAddressL2: true,
        // Encrypted fields for client-side decryption
        encryptedCiphertext: true,
        encryptedIv: true,
        encryptedTag: true,
        keyDerivationMessage: true,
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

    // ── Validate + sanitize all inputs via Zod ────────────────────────────
    const parsed = CreateOperationSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json(
        { error: `Validation error: ${firstError.path.join('.')} — ${firstError.message}` },
        { status: 400 },
      )
    }

    const data = parsed.data

    // ── Business logic validations ────────────────────────────────────────
    if (!isValidKeyDerivationDomain(data.keyDerivationDomain)) {
      return NextResponse.json(
        { error: 'Invalid keyDerivationDomain' },
        { status: 400 },
      )
    }
    if (!isValidKeyDerivationMessage(data.keyDerivationMessage)) {
      return NextResponse.json(
        { error: 'Invalid keyDerivationMessage format' },
        { status: 400 },
      )
    }
    if (data.l1Address !== authResult.user.l1Address) {
      return NextResponse.json(
        { error: 'l1Address does not match authenticated wallet' },
        { status: 403 },
      )
    }
    if (data.l2Address !== authResult.user.l2Address) {
      return NextResponse.json(
        { error: 'l2Address does not match authenticated Aztec address' },
        { status: 403 },
      )
    }

    const isL2ToL1 = data.direction === 'L2_TO_L1'

    console.log('[bridge/operations POST] Creating operation →', {
      direction: data.direction,
      amountL1: data.amountL1,
      amountL2: data.amountL2,
      amountDisplayL1: data.amountDisplayL1,
      amountDisplayL2: data.amountDisplayL2,
      tokenSymbol: data.tokenSymbol,
      tokenSymbolL1: data.tokenSymbolL1,
      tokenSymbolL2: data.tokenSymbolL2,
      tokenNameL1: data.tokenNameL1,
      tokenNameL2: data.tokenNameL2,
      tokenDecimalsL1: data.tokenDecimalsL1,
      tokenDecimalsL2: data.tokenDecimalsL2,
      tokenLogoUrlL1: data.tokenLogoUrlL1,
      tokenLogoUrlL2: data.tokenLogoUrlL2,
      tokenAddressL1: data.tokenAddressL1,
      tokenAddressL2: data.tokenAddressL2,
      l1BlockNumberBeforeTx: data.l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx: data.l2BlockNumberBeforeTx,
      rollupVersion: data.rollupVersion,
      chainIdL1: data.chainIdL1,
      chainIdL2: data.chainIdL2,
      portalAddressL1: data.portalAddressL1,
      bridgeAddressL2: data.bridgeAddressL2,
      recipientL1Address: data.recipientL1Address,
      currentStep: data.currentStep,
    })
    const operation = await prisma.bridgeActivity.create({
      data: {
        fkUserId: authResult.user.id,
        direction: isL2ToL1
          ? BridgeDirection.L2_TO_L1
          : BridgeDirection.L1_TO_L2,
        status: BridgeOperationStatus.pending,
        encryptedCiphertext: data.encryptedCiphertext,
        encryptedIv: data.encryptedIv,
        encryptedTag: data.encryptedTag,
        keyDerivationMessage: data.keyDerivationMessage,
        keyDerivationDomain: data.keyDerivationDomain,
        amountL1: data.amountL1,
        amountL2: data.amountL2,
        amountDisplayL1: data.amountDisplayL1 ?? undefined,
        amountDisplayL2: data.amountDisplayL2 ?? undefined,
        isPrivacyModeEnabled: data.isPrivacyModeEnabled ?? null,
        l1BlockNumberBeforeTx: data.l1BlockNumberBeforeTx ?? undefined,
        l2BlockNumberBeforeTx: data.l2BlockNumberBeforeTx ?? undefined,
        recipientL1Address: isL2ToL1 ? data.recipientL1Address : undefined,
        nodeInfo: (data.nodeInfo ?? undefined) as Prisma.InputJsonValue | undefined,
        fromNetworkName: isL2ToL1 ? 'Aztec' : 'Ethereum',
        toNetworkName: isL2ToL1 ? 'Ethereum' : 'Aztec',
        // Recovery-critical contract & version snapshot
        rollupVersion: data.rollupVersion ?? undefined,
        chainIdL1: data.chainIdL1 ?? undefined,
        chainIdL2: data.chainIdL2 ?? undefined,
        portalAddressL1: data.portalAddressL1 ?? undefined,
        bridgeAddressL2: data.bridgeAddressL2 ?? undefined,
        l1RollupAddress: data.l1RollupAddress ?? undefined,
        l1OutboxAddress: data.l1OutboxAddress ?? undefined,
        l1InboxAddress: data.l1InboxAddress ?? undefined,
        l1RegistryAddress: data.l1RegistryAddress ?? undefined,
        // Token info for activity page display
        tokenSymbol: data.tokenSymbol ?? undefined,
        tokenSymbolL1: data.tokenSymbolL1 ?? undefined,
        tokenSymbolL2: data.tokenSymbolL2 ?? undefined,
        tokenNameL1: data.tokenNameL1 ?? undefined,
        tokenNameL2: data.tokenNameL2 ?? undefined,
        tokenAddressL1: data.tokenAddressL1 ?? undefined,
        tokenAddressL2: data.tokenAddressL2 ?? undefined,
        tokenDecimalsL1: data.tokenDecimalsL1 ?? undefined,
        tokenDecimalsL2: data.tokenDecimalsL2 ?? undefined,
        tokenLogoUrlL1: data.tokenLogoUrlL1 ?? undefined,
        tokenLogoUrlL2: data.tokenLogoUrlL2 ?? undefined,
        currentStep: (data.currentStep != null && data.currentStep >= 1) ? data.currentStep : 1,
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
    })
  } catch (error) {
    console.error('[bridge/operations]', error)
    return NextResponse.json(
      { error: 'Failed to store encrypted backup' },
      { status: 500 },
    )
  }
}
