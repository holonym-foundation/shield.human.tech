import { NextRequest, NextResponse } from 'next/server'
import { BridgeOperationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import {
  sanitizeString,
  sanitizeTxHash,
  sanitizeHexString,
  sanitizeNumericString,
  sanitizeUrl,
  sanitizeInt,
  sanitizeEthAddress,
  sanitizeSiblingPath,
  MAX_ERROR_LENGTH,
} from '@/lib/validation'

/** Valid forward-only status transitions. Any status can transition to 'failed'. */
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['submitted', 'deposited', 'completed', 'failed'],
  deposited: ['claimed', 'completed', 'failed'],
  claimed: ['completed', 'failed'],
  submitted: ['ready', 'pending_finalize', 'completed', 'failed'],
  ready: ['pending_finalize', 'completed', 'failed'],
  pending_finalize: ['completed', 'failed'],
}

/**
 * PATCH /api/bridge/operations/:id
 *
 * Update a bridge operation at each stage of the bridge flow.
 * Auth required; user must own the operation.
 * Status transitions must be forward-only (except any → failed).
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params

    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const operation = await prisma.bridgeActivity.findFirst({
      where: { id, fkUserId: authResult.user.id },
    })

    if (!operation) {
      return NextResponse.json({ error: 'Operation not found or access denied' }, { status: 404 })
    }

    const body = await request.json()

    // ── Sanitize all inputs ─────────────────────────────────────────────
    const status = sanitizeString(body.status, 20)
    const l1TxHash = sanitizeTxHash(body.l1TxHash)
    const l1TxUrl = sanitizeUrl(body.l1TxUrl)
    const messageHash = sanitizeHexString(body.messageHash, 130)
    const messageLeafIndex = sanitizeNumericString(body.messageLeafIndex)
    const l2TxHash = sanitizeHexString(body.l2TxHash, 130)
    const l2TxUrl = sanitizeUrl(body.l2TxUrl)
    const lastErrorMessage =
      body.lastErrorMessage !== undefined ? (sanitizeString(body.lastErrorMessage, MAX_ERROR_LENGTH) ?? '') : undefined
    const completedAt = sanitizeString(body.completedAt, 30) // ISO date string
    // L2→L1 withdrawal fields
    const l2BlockNumber = sanitizeNumericString(body.l2BlockNumber)
    const l2BlockNumberBeforeTx = sanitizeNumericString(body.l2BlockNumberBeforeTx)
    const l2ToL1MessageIndex = sanitizeNumericString(body.l2ToL1MessageIndex)
    const siblingPath = sanitizeSiblingPath(body.siblingPath)
    const recipientL1Address = sanitizeEthAddress(body.recipientL1Address)
    const currentStep = sanitizeInt(body.currentStep, 0, 10)
    // L2→L1 witness epoch
    const epoch = sanitizeInt(body.epoch, 0, 1_000_000_000)
    // L1→L2 receipt fields
    const claimAmount = sanitizeNumericString(body.claimAmount)
    const l1BlockNumber = sanitizeNumericString(body.l1BlockNumber)
    // L1→L2 fuel recovery fields
    const fuelMessageHash = sanitizeHexString(body.fuelMessageHash, 130)
    const fuelMessageLeafIndex = sanitizeNumericString(body.fuelMessageLeafIndex)
    const fuelAmount = sanitizeNumericString(body.fuelAmount)

    // ── Immutable field guard ───────────────────────────────────────────
    // These fields are set once during operation creation and must never be
    // overwritten by subsequent PATCH calls (e.g. from the resume flow).
    const IMMUTABLE_FIELDS = [
      'encryptedCiphertext',
      'encryptedIv',
      'encryptedTag',
      'amountL1',
      'amountL2',
      'direction',
      'l1BlockNumberBeforeTx',
      'l2BlockNumberBeforeTx',
      'keyDerivationMessage',
      'keyDerivationDomain',
      'rollupVersion',
      'chainIdL1',
      'chainIdL2',
      'portalAddressL1',
      'bridgeAddressL2',
      'tokenAddressL1',
      'tokenAddressL2',
      'claimSecretHash',
      'fuelSecretHash',
      'privateFuelSecretHash',
    ] as const

    const blockedFields: string[] = []
    for (const field of IMMUTABLE_FIELDS) {
      if (body[field] !== undefined) {
        blockedFields.push(field)
      }
    }
    if (blockedFields.length > 0) {
      console.warn(
        '[bridge/operations PATCH]',
        id,
        '⚠ Rejected overwrite of immutable fields:',
        blockedFields.join(', '),
      )
      return NextResponse.json(
        {
          error: `Cannot overwrite immutable fields: ${blockedFields.join(', ')}`,
        },
        { status: 400 },
      )
    }

    // Validate status is a known BridgeOperationStatus value
    const VALID_STATUSES = new Set([
      'pending',
      'deposited',
      'claimed',
      'submitted',
      'ready',
      'pending_finalize',
      'completed',
      'failed',
    ])
    if (status && !VALID_STATUSES.has(status)) {
      return NextResponse.json({ error: `Invalid status value: ${status}` }, { status: 400 })
    }

    // Validate status transition if status is being changed
    if (status && status !== operation.status) {
      const allowed = VALID_TRANSITIONS[operation.status]
      if (!allowed || !allowed.includes(status)) {
        return NextResponse.json(
          {
            error: `Invalid status transition: ${operation.status} → ${status}`,
          },
          { status: 400 },
        )
      }
    }

    // Validate completedAt is a valid date if provided
    let completedAtDate: Date | undefined
    if (completedAt) {
      completedAtDate = new Date(completedAt)
      if (isNaN(completedAtDate.getTime())) {
        return NextResponse.json({ error: 'Invalid completedAt date format' }, { status: 400 })
      }
    }

    // Build update data — only include fields that were provided and sanitized
    const updateData: Record<string, unknown> = {}
    if (status) updateData.status = status as BridgeOperationStatus
    if (l1TxHash) updateData.l1TxHash = l1TxHash
    if (l1TxUrl) updateData.l1TxUrl = l1TxUrl
    if (messageHash) updateData.messageHash = messageHash
    if (messageLeafIndex) updateData.messageLeafIndex = messageLeafIndex
    if (l2TxHash) updateData.l2TxHash = l2TxHash
    if (l2TxUrl) updateData.l2TxUrl = l2TxUrl
    if (lastErrorMessage !== undefined) updateData.lastErrorMessage = lastErrorMessage
    // Set completedAt server-side for terminal states — ignore client-supplied value
    if (status === 'completed' || status === 'failed') {
      updateData.completedAt = new Date()
    } else if (completedAtDate) {
      updateData.completedAt = completedAtDate
    }
    // L2→L1 withdrawal fields
    if (l2BlockNumber) updateData.l2BlockNumber = l2BlockNumber
    if (l2BlockNumberBeforeTx) updateData.l2BlockNumberBeforeTx = l2BlockNumberBeforeTx
    if (l2ToL1MessageIndex) updateData.l2ToL1MessageIndex = l2ToL1MessageIndex
    if (siblingPath) updateData.siblingPath = siblingPath
    if (recipientL1Address) updateData.recipientL1Address = recipientL1Address
    if (currentStep != null) {
      // Forward-only guard: currentStep must not regress
      if (operation.currentStep != null && currentStep <= operation.currentStep) {
        // Allow same step (idempotent retry) but not backward
        if (currentStep < operation.currentStep) {
          return NextResponse.json(
            { error: `Cannot regress currentStep from ${operation.currentStep} to ${currentStep}` },
            { status: 400 },
          )
        }
      } else {
        updateData.currentStep = currentStep
      }
    }
    // L1→L2 receipt + fuel fields
    if (claimAmount) updateData.claimAmount = claimAmount
    if (l1BlockNumber) updateData.l1BlockNumber = l1BlockNumber
    if (fuelMessageHash) updateData.fuelMessageHash = fuelMessageHash
    if (fuelMessageLeafIndex) updateData.fuelMessageLeafIndex = fuelMessageLeafIndex
    if (fuelAmount) updateData.fuelAmount = fuelAmount
    // L2→L1 witness epoch
    if (epoch != null) updateData.epoch = epoch

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
    }

    await prisma.bridgeActivity.update({
      where: { id },
      data: updateData,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[bridge/operations/[id] PATCH]', error)
    return NextResponse.json({ error: 'Failed to update operation' }, { status: 500 })
  }
}
