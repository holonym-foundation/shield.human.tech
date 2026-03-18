import { NextRequest, NextResponse } from 'next/server'
import { BridgeOperationStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { authenticateRequest, createAuthErrorResponse } from '@/lib/auth'
import {
  PatchOperationSchema,
  IMMUTABLE_FIELDS,
  WRITE_ONCE_FIELDS,
  VALID_TRANSITIONS,
} from '@/lib/validation'

/**
 * GET /api/bridge/operations/:id
 *
 * Fetch a single bridge operation by ID.
 * Auth required; user must own the operation.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = parseInt(idStr, 10)
    if (isNaN(id)) {
      return NextResponse.json({ error: 'Invalid operation ID' }, { status: 400 })
    }

    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const operation = await prisma.bridgeActivity.findFirst({
      where: { id, fkUserId: authResult.user.id },
    })

    if (!operation) {
      return NextResponse.json(
        { error: 'Operation not found or access denied' },
        { status: 404 },
      )
    }

    return NextResponse.json({ operation })
  } catch (error) {
    console.error('[bridge/operations/[id] GET]', error)
    return NextResponse.json(
      { error: 'Failed to fetch operation' },
      { status: 500 },
    )
  }
}

/**
 * PATCH /api/bridge/operations/:id
 *
 * Update a bridge operation at each stage of the bridge flow.
 * Auth required; user must own the operation.
 * Status transitions must be forward-only (except any → failed).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: idStr } = await params
    const id = parseInt(idStr, 10)
    if (isNaN(id)) {
      return NextResponse.json({ error: 'Invalid operation ID' }, { status: 400 })
    }

    const authResult = await authenticateRequest(request)
    if (!authResult.success || !authResult.user) {
      return createAuthErrorResponse(authResult.error ?? 'Unauthorized', 401)
    }

    const operation = await prisma.bridgeActivity.findFirst({
      where: { id, fkUserId: authResult.user.id },
    })

    if (!operation) {
      return NextResponse.json(
        { error: 'Operation not found or access denied' },
        { status: 404 },
      )
    }

    const body = await request.json()

    // ── Validate + sanitize all inputs via Zod ────────────────────────────
    const parsed = PatchOperationSchema.safeParse(body)
    if (!parsed.success) {
      const firstError = parsed.error.issues[0]
      return NextResponse.json(
        { error: `Validation error: ${firstError.path.join('.')} — ${firstError.message}` },
        { status: 400 },
      )
    }

    const data = parsed.data

    // ── Immutable field guard ───────────────────────────────────────────
    // Block any PATCH that tries to set an immutable field, regardless of
    // whether the DB value is currently null. Only initial creation can set these fields.
    const blockedFields: string[] = []
    for (const field of IMMUTABLE_FIELDS) {
      if (data[field] !== undefined) {
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

    // ── Write-once field guard ──────────────────────────────────────────
    // These recovery-critical fields may only be set when their DB value is null.
    const alreadySetFields = new Set<string>()
    for (const field of WRITE_ONCE_FIELDS) {
      if ((operation as any)[field] != null) {
        alreadySetFields.add(field)
      }
    }
    if (alreadySetFields.size > 0) {
      const attempted = [...alreadySetFields].filter(f => (data as any)[f] !== undefined)
      if (attempted.length > 0) {
        console.log(
          '[bridge/operations PATCH]',
          id,
          'Skipping write-once fields (already set):',
          attempted.join(', '),
        )
      }
    }

    // ── Validate status transition ────────────────────────────────────────
    if (data.status && data.status !== operation.status) {
      const allowed = VALID_TRANSITIONS[operation.status]
      if (!allowed || !allowed.includes(data.status)) {
        return NextResponse.json(
          {
            error: `Invalid status transition: ${operation.status} → ${data.status}`,
          },
          { status: 400 },
        )
      }
    }

    // ── Validate completedAt date ─────────────────────────────────────────
    let completedAtDate: Date | undefined
    if (data.completedAt) {
      completedAtDate = new Date(data.completedAt)
      if (isNaN(completedAtDate.getTime())) {
        return NextResponse.json(
          { error: 'Invalid completedAt date format' },
          { status: 400 },
        )
      }
    }

    // ── Build update data ─────────────────────────────────────────────────
    // Only include fields that were provided and sanitized.
    // Write-once fields are skipped if the DB already has a non-null value.
    const wo = alreadySetFields
    const updateData: Record<string, unknown> = {}
    if (data.status) updateData.status = data.status as BridgeOperationStatus
    if (data.l1TxHash && !wo.has('l1TxHash')) updateData.l1TxHash = data.l1TxHash
    if (data.l1TxUrl && !wo.has('l1TxUrl')) updateData.l1TxUrl = data.l1TxUrl
    if (data.messageHash && !wo.has('messageHash')) updateData.messageHash = data.messageHash
    if (data.messageLeafIndex) updateData.messageLeafIndex = data.messageLeafIndex
    if (data.l2TxHash && !wo.has('l2TxHash')) updateData.l2TxHash = data.l2TxHash
    if (data.l2TxUrl && !wo.has('l2TxUrl')) updateData.l2TxUrl = data.l2TxUrl
    if (data.lastErrorMessage !== undefined)
      updateData.lastErrorMessage = data.lastErrorMessage
    if (completedAtDate) updateData.completedAt = completedAtDate
    // L2→L1 withdrawal fields
    if (data.l2BlockNumber && !wo.has('l2BlockNumber')) updateData.l2BlockNumber = data.l2BlockNumber
    if (data.l2BlockNumberBeforeTx) updateData.l2BlockNumberBeforeTx = data.l2BlockNumberBeforeTx
    if (data.l2ToL1MessageIndex) updateData.l2ToL1MessageIndex = data.l2ToL1MessageIndex
    if (data.siblingPath) updateData.siblingPath = data.siblingPath
    if (data.recipientL1Address) updateData.recipientL1Address = data.recipientL1Address
    if (data.currentStep != null) updateData.currentStep = data.currentStep
    // Confirmed L1 block number
    if (data.l1BlockNumber && !wo.has('l1BlockNumber')) updateData.l1BlockNumber = data.l1BlockNumber
    // L1→L2 post-fee amount
    if (data.amountAfterFee && !wo.has('amountAfterFee')) updateData.amountAfterFee = data.amountAfterFee
    // Fuel fields
    if (data.fuelMessageHash && !wo.has('fuelMessageHash')) updateData.fuelMessageHash = data.fuelMessageHash
    if (data.fuelMessageLeafIndex && !wo.has('fuelMessageLeafIndex')) updateData.fuelMessageLeafIndex = data.fuelMessageLeafIndex
    if (data.fuelAmount && !wo.has('fuelAmount')) updateData.fuelAmount = data.fuelAmount
    // L2→L1 witness epoch
    if (data.epoch != null) updateData.epoch = data.epoch

    console.log(`[bridge/operations PATCH ${id}] updateData →`, updateData, '| write-once blocked:', [...alreadySetFields])

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 },
      )
    }

    // Optimistic locking: include current status in WHERE clause to prevent
    // concurrent PATCH requests from racing past status transition validation.
    // Include fkUserId in WHERE clause for defense-in-depth ownership check
    const currentStatus = operation.status
    const result = await prisma.bridgeActivity.updateMany({
      where: { id, status: currentStatus as BridgeOperationStatus, fkUserId: authResult.user.id },
      data: updateData,
    })

    if (result.count === 0) {
      // Status changed between our read and write — retry-safe for the client
      return NextResponse.json(
        { error: 'Operation was modified concurrently. Please retry.' },
        { status: 409 },
      )
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[bridge/operations/[id] PATCH]', error)
    return NextResponse.json(
      { error: 'Failed to update operation' },
      { status: 500 },
    )
  }
}
