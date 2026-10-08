'use client'

import React, { useEffect, useId, useState } from 'react'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import type { BridgeOperation } from '@human.tech/clean.sdk'
import { STORAGE_KEYS } from '@human.tech/clean.sdk'
import { formatUnits } from 'viem'
import { L1_TOKEN_METADATA, L1_NETWORKS, AZTEC_VERSION, publicAsset } from '@/config'
import StyledImage from '@/components/StyledImage'
import { canResumeOp, hasPossibleLockedFunds, isLikelyCompleted } from '@/utils/resumability'
import { useIsOperationLive } from '@/hooks/useResumableCount'
import { formatFjAmount } from '@/utils/fuelPricing'
import { copyToClipboard } from '@/utils'
import { useToast } from '@/hooks/useToast'

export type StatusBadgeStyle = { label: string; className: string }

// Single source of truth for bridge-operation status badges, shared with
// ActivityDrawer so the card and the drawer can never drift apart (#394). Each
// entry is a soft Shield tint paired with the dark-of-that-hue text token, so
// every pairing clears 4.5:1 and none is dark text on a saturated red/pink fill
// (SOP §1 brand tokens only, §2 contrast). `className` carries colour only; each
// component keeps its own size/shape classes. Semantics: completed = success
// green; deposited/claimed = navy (milestone reached); pending/submitted/ready/
// finalizing = warn amber (in flight); failed = error red (soft tint, dark text).
const STATUS_NAVY = 'bg-latest-blue-200 text-latest-blue-100'
const STATUS_WARN = 'bg-warn-200 text-warn-main'

export const STATUS_BADGE: Record<string, StatusBadgeStyle> = {
  pending: { label: 'Pending', className: STATUS_WARN },
  submitted: { label: 'Submitted', className: STATUS_WARN },
  ready: { label: 'Ready', className: STATUS_WARN },
  pending_finalize: { label: 'Finalizing', className: STATUS_WARN },
  deposited: { label: 'Deposited', className: STATUS_NAVY },
  claimed: { label: 'Claimed', className: STATUS_NAVY },
  completed: { label: 'Completed', className: 'bg-success-200 text-success-main' },
  failed: { label: 'Failed', className: 'bg-error-200 text-error-main' },
}

export function getStatusBadge(status: string): StatusBadgeStyle {
  return STATUS_BADGE[status] ?? { label: status, className: 'bg-neutral-200 text-neutral-800' }
}

// Network/deployment this app instance runs against. The operation record does
// not persist a per-op network or Aztec version, so we surface the current active
// deployment. Same source (config-derived, never hardcoded) and same "vX Alpha"
// language the DeploymentSelector uses in the nav.
const DEPLOYMENT_LABEL = [L1_NETWORKS[0]?.title, AZTEC_VERSION ? `v${AZTEC_VERSION} Alpha` : null]
  .filter(Boolean)
  .join(' · ')

// Deposit = Ethereum (L1) to Aztec (L2); withdraw = Aztec (L2) to Ethereum (L1).
// Reuses the same logo assets + arrow glyph the ProgressCard from/to block uses,
// so the direction reads consistently across the app. The visible text label is
// gone, so the group carries an aria-label/title announcing the direction.
function DirectionLogos({ direction }: { direction: BridgeOperation['direction'] }) {
  const isDeposit = direction === 'L1_TO_L2'
  const label = isDeposit ? 'L1 to L2' : 'L2 to L1'
  // The Ethereum glyph is a self-contained dark circle, but the Aztec mark is a
  // bare light-green diamond that washes out on a light surface. It gets a dark
  // circular chip so it stays legible; both glyphs stay h-4 w-4 so the row aligns.
  const ethGlyph = <StyledImage src={publicAsset('/assets/svg/ethLogo.svg')} alt="" className="h-4 w-4 shrink-0" />
  const aztecGlyph = (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#0A0A0A]">
      <StyledImage src={publicAsset('/assets/svg/aztec.svg')} alt="" className="h-3 w-3" />
    </span>
  )
  const first = isDeposit ? ethGlyph : aztecGlyph
  const second = isDeposit ? aztecGlyph : ethGlyph
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex items-center gap-1">
      {first}
      <Icon icon="ph:arrow-right" width={12} height={12} className="text-gray-400" aria-hidden="true" />
      {second}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const style = getStatusBadge(status)
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${style.className}`}>
      {style.label}
    </span>
  )
}

// Whether the bridge ran privately. Globe/navy = public, lock/maroon = private —
// the same icon + colour language used for fuel privacy elsewhere (FuelToggle,
// Messages tints), so the mode reads consistently across the app (#230a).
function PrivacyBadge({ isPrivate }: { isPrivate: boolean }) {
  return isPrivate ? (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#FDE7F3] text-[#81133B] whitespace-nowrap">
      <Icon icon="ph:lock-key-fill" width={11} height={11} />
      Private
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-[#E5EFFF] text-[#17235E] whitespace-nowrap">
      <Icon icon="ph:globe-hemisphere-west-fill" width={11} height={11} />
      Public
    </span>
  )
}

// Collapsed to a SINGLE line by default (line-clamp-1) so the card stays
// compact and a page of them fits the fixed shell with no scroll. Anything
// past roughly one line's worth of characters is likely being truncated, so
// that's when we surface the "Show more" toggle to reveal the full copyable text.
const ERROR_EXPAND_THRESHOLD = 48

/** Failed-operation error message: clamped to one line by default, expandable + copyable in full. */
function OperationError({ message }: { message: string }) {
  const notify = useToast()
  const [expanded, setExpanded] = useState(false)
  const canExpand = message.length > ERROR_EXPAND_THRESHOLD

  const handleCopy = async () => {
    const ok = await copyToClipboard(message)
    notify(ok ? 'success' : 'error', ok ? 'Error copied to clipboard' : 'Failed to copy error')
  }

  return (
    <div className="mt-1 flex items-start gap-1.5">
      <p
        className={`text-xs text-red-500 flex-1 min-w-0 ${
          expanded
            ? 'whitespace-pre-wrap break-words max-h-20 overflow-y-auto pr-1'
            : 'line-clamp-1 break-words'
        }`}
      >
        {message}
      </p>
      <div className="flex items-center gap-1 flex-shrink-0">
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Show less of error message' : 'Show full error message'}
            className="text-[10px] font-semibold text-[#81133B] hover:underline px-1"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy error message"
          className="text-gray-400 hover:text-[#81133B] p-0.5 rounded"
        >
          <Icon icon="ph:copy" width={13} height={13} />
        </button>
      </div>
    </div>
  )
}

/**
 * True when the operation has the fuel-leg fields populated. Whether the fuel was sent to a
 * third party (as opposed to the bridger's own L2) is in the encrypted blob, so we can't tell
 * here — we just expose the share button whenever fuel data exists, and let the click handler
 * decrypt and decide.
 */
function hasFuelClaimData(op: BridgeOperation): boolean {
  if (op.direction !== 'L1_TO_L2') return false
  return !!op.fuelMessageHash && !!op.fuelMessageLeafIndex && !!op.fuelAmount && !!op.l1TxHash
}

// TODO(#331): "Fee Juice used" (L2 gas consumption) cannot be surfaced from this
// data source. useBridgeOperations() -> bridge.getOperations() -> GET
// /api/bridge/operations returns only BridgeOperation rows (L1->L2 deposits and
// L2->L1 withdrawals). Fuel appears ONLY as the top-up leg of a deposit
// (op.fuelAmount / fuelMessageHash), surfaced below. Nothing in this source, or
// any client store, records FeeJuice spent paying for L2 transactions, so usage
// needs backend/indexer support emitting fuel-consumption events before it can
// render here.
//
// Human-readable Fee Juice top-up for a deposit that carved part of the bridged
// token into FeeJuice. op.fuelAmount is the FeeJuice received (18-dec) — the same
// value the claim flow and FuelClaimLinkPanel treat as the claim amount.
// Withdrawals never carry a fuel leg, so this is L1->L2 only.
function fuelTopUpFj(op: BridgeOperation): string | null {
  if (op.direction !== 'L1_TO_L2' || !op.fuelAmount) return null
  try {
    return formatFjAmount(BigInt(op.fuelAmount))
  } catch {
    return null
  }
}

/**
 * Whether the fuel from this bridge is genuinely shareable (went to someone ELSE, who needs a
 * claim link) versus the bridger's own L2 account (theirs already, nothing to share).
 *
 * The recipient split lives in the encrypted blob and is never sent to the backend, so the raw
 * operation can't tell us. The bridge flow does mirror `fuelClaimByOther` into the local deposits
 * store on the originating device (see l1ToL2 receipt persistence), so we read that:
 *   - 'shareable': local record says the fuel went to a third party.
 *   - 'self': local record says the fuel went to the bridger, so hide the affordance (#308).
 *   - 'unknown': no local record (e.g. a different device or cleared storage). We keep the
 *     affordance but let the share handler decrypt and decide, and the copy stays explicit
 *     about what it's for.
 */
function readLocalFuelShareState(op: BridgeOperation): 'shareable' | 'self' | 'unknown' {
  if (typeof window === 'undefined') return 'unknown'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.deposits)
    if (!raw) return 'unknown'
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>
    // SDK stores `id` as number|string, so normalize both sides for the comparison.
    const entry = entries.find((c) => c && String(c.id) === String(op.id))
    if (!entry || entry.fuelRecipient == null) return 'unknown'
    return entry.fuelClaimByOther ? 'shareable' : 'self'
  } catch {
    return 'unknown'
  }
}

interface ActivityCardProps {
  operation: BridgeOperation
  onResume: (operation: BridgeOperation) => void
  resuming: boolean
  onShareFuelClaim?: (operation: BridgeOperation) => void
  sharingFuelClaim?: boolean
}

export default function ActivityCard({
  operation,
  onResume,
  resuming,
  onShareFuelClaim,
  sharingFuelClaim,
}: ActivityCardProps) {
  const decimals = operation.tokenDecimalsL1 ?? L1_TOKEN_METADATA.decimals
  const tokenSymbol = operation.tokenSymbol ?? operation.tokenSymbolL1 ?? L1_TOKEN_METADATA.symbol
  const amount =
    operation.amountDisplayL1 ?? (operation.amountL1 ? formatUnits(BigInt(operation.amountL1), decimals) : '?')
  const date = new Date(operation.createdAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  // Resume button shown for both standard resumable states AND the edge case
  // where status='pending' but a tx hash exists (session died after tx send
  // but before the status-update PATCH landed — funds may be locked on-chain).
  // Both branches use the same decrypt + resume pipeline; the badge below
  // tells the user which case they're in.
  // A consumed / "no non-nullified" message means the deposit's L1→L2 message was already
  // claimed on a prior attempt — resuming just re-fails. Surface it as a calm "likely completed"
  // state and never offer Resume for it (isResumable already excludes it).
  const likelyCompleted = isLikelyCompleted(operation)
  const lockedFunds = hasPossibleLockedFunds(operation)
  // Resume covers every still-in-flight operation, not only the SDK-classified
  // resumable/locked states. A bare 'pending' (the session dropped before any tx
  // landed, so no hash exists yet) still needs a route back into the flow.
  // Terminal (completed/failed) and likely-completed rows never resume.
  // ...and an operation a client mutation is driving RIGHT NOW is running, not
  // interrupted: it holds a resumable-looking status for its whole run, so Resume
  // would offer a second run of a live transfer (SOP §8).
  const live = useIsOperationLive()(operation.id)
  const showResume = !live && canResumeOp(operation)
  const fuelTopUp = fuelTopUpFj(operation)

  // Unique per card so multiple cards' tooltips don't collide.
  const fuelTipId = `share-fuel-${useId()}`

  // localStorage isn't readable during SSR/first paint, so start 'unknown' and resolve in an
  // effect. 'self' means the fuel is the bridger's own, so no claim link exists to share (#308).
  const [fuelShareState, setFuelShareState] = useState<'shareable' | 'self' | 'unknown'>('unknown')
  useEffect(() => {
    if (hasFuelClaimData(operation)) setFuelShareState(readLocalFuelShareState(operation))
  }, [operation])

  const showShareFuelClaim = !!onShareFuelClaim && hasFuelClaimData(operation) && fuelShareState !== 'self'

  const hasActionRow = operation.l1TxUrl || operation.l2TxUrl || showShareFuelClaim || showResume || live

  return (
    <div className="bg-[#F5F5F5] rounded-xl p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <DirectionLogos direction={operation.direction} />
          <StatusBadge status={operation.status} />
          <PrivacyBadge isPrivate={!!operation.isPrivacyModeEnabled} />
          {likelyCompleted && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 whitespace-nowrap">
              Likely completed
            </span>
          )}
          {lockedFunds && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-800 whitespace-nowrap">
              Funds may be locked
            </span>
          )}
        </div>
        <span className="text-[11px] text-gray-400 whitespace-nowrap flex-shrink-0">{date}</span>
      </div>

      <p className="text-base font-semibold leading-none mt-1.5">
        {amount} {tokenSymbol}
      </p>
      {DEPLOYMENT_LABEL && <p className="mt-1 text-[11px] text-gray-400">{DEPLOYMENT_LABEL}</p>}
      {fuelTopUp && (
        <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-amber-700">
          <Icon icon="ph:gas-pump" width={12} height={12} className="flex-shrink-0" />
          Fee Juice top up · {fuelTopUp} FJ
        </p>
      )}

      {likelyCompleted ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-emerald-700">
          <Icon icon="ph:check-circle-fill" width={14} height={14} className="flex-shrink-0" />
          This deposit likely already completed. Check your L2 balance.
        </p>
      ) : (
        operation.lastErrorMessage && <OperationError message={operation.lastErrorMessage} />
      )}

      {hasActionRow && (
        <>
        <hr className="mt-2.5 border-0 border-t border-black/[0.06]" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2">
          {operation.l1TxUrl && (
            <a
              href={operation.l1TxUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap"
            >
              L1 Tx
              <Icon icon="ph:arrow-square-out" width={13} height={13} />
            </a>
          )}
          {operation.l2TxUrl && (
            <a
              href={operation.l2TxUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-purple-600 hover:text-purple-800 whitespace-nowrap"
            >
              L2 Tx
              <Icon icon="ph:arrow-square-out" width={13} height={13} />
            </a>
          )}

          <div className="ml-auto flex items-center gap-2">
            {showShareFuelClaim && (
              <div className="flex items-center gap-1.5">
                {/* Info (i) sits inside the pill, immediately after the label, so it
                    reads as explaining the share action (#190). */}
                <div className="inline-flex items-center gap-1 rounded-lg bg-amber-100/70 pl-3 pr-2 py-1">
                  <button
                    onClick={() => onShareFuelClaim!(operation)}
                    disabled={!!sharingFuelClaim}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-900 transition-opacity hover:opacity-80 disabled:opacity-60 whitespace-nowrap"
                  >
                    <Icon icon="ph:share-network" width={13} height={13} />
                    {sharingFuelClaim ? 'Decrypting…' : 'Share fuel claim link'}
                  </button>
                  <button
                    type="button"
                    data-tooltip-id={fuelTipId}
                    data-tooltip-content="Only for when you funded gas for someone else's Aztec account. This makes a link they use to claim the Fee Juice on L2. If the gas is for your own account, it is already yours and nothing needs sharing."
                    aria-label="What is the fuel claim link for?"
                    className="text-amber-700/70 hover:text-[#81133B]"
                  >
                    <Icon icon="ph:info" width={13} height={13} />
                  </button>
                </div>
                <ReactTooltip id={fuelTipId} place="top" className="z-[100]" style={{ fontSize: '11px', maxWidth: '220px' }} />
              </div>
            )}
            {live && (
              <span className="flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-[#81133B]">
                <Icon icon="ph:spinner-gap-bold" width={12} height={12} className="shrink-0 animate-spin" />
                In progress
              </span>
            )}
            {showResume && (
              <button
                onClick={() => onResume(operation)}
                disabled={resuming}
                className="text-xs font-semibold text-white bg-black hover:opacity-80 disabled:opacity-60 px-3 py-1 rounded-lg whitespace-nowrap"
              >
                {resuming ? 'Decrypting...' : 'Resume'}
              </button>
            )}
          </div>
        </div>
        </>
      )}
    </div>
  )
}
