'use client'

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { formatUnits } from 'viem'
import type { BridgeOperation, RecoveryClaimData, RecoveryWithdrawalData } from '@human.tech/clean.sdk'
import { useBridgeOperations, decryptOperationPayload } from '@/hooks/useBridgeOperations'
import { useIsOperationLive, useResumableCount } from '@/hooks/useResumableCount'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useToast } from '@/hooks/useToast'
import { canResumeOp } from '@/utils/resumability'
import { humanizeError } from '@/utils'
import { logError } from '@/utils/datadog'
import { formatFjAmount } from '@/utils/fuelPricing'
import { L1_TOKEN_METADATA, L1_NETWORKS, AZTEC_VERSION, publicAsset } from '@/config'
import { BridgeDirection } from '@/types/bridge'
import { LocalRecoveryPanel } from '@/components/LocalRecoveryPanel'
import StyledImage from '@/components/StyledImage'
import { getStatusBadge } from '@/components/ActivityCard'

// Motion values mirrored from the human-tech design system (docs/tokens.css):
// --dur-enter / --ease-slide for the panel that slides out from the tab.
const DS_DUR_ENTER = 0.32
const DS_EASE_SLIDE: [number, number, number, number] = [0.32, 0.72, 0, 1]

// Shared right-edge peek coordination (#160): each binder tab announces its open
// state; a tab that sees another open closes itself, so only one peeks at a time.
const PEEK_EVENT = 'shield:peek'
type PeekSignal = { id: string; open: boolean }

// Enough rows to fill the taller mid-length panel (below) and scroll the rest
// inside it, so the peek shows several recent ops at once rather than a couple.
const MAX_VISIBLE_OPS = 12

// The top nav row (banners + Header) sits at the viewport top. The upward-growing
// panel must stop BELOW it, so reserve this much space from the viewport top; the
// panel's top edge lands here and never crosses into the nav (#318). Mirrors the
// same NAV_SAFE_TOP reservation BridgeStepsRail uses for its rail panel (#316).
const NAV_SAFE_TOP = 72

// The panel is given a DEFINITE height so the list region fills a substantial
// mid-length panel (the founder's "as long as Messages") instead of collapsing
// to the height of the few short rows it happens to have. This target mirrors the
// intrinsic height NotificationsDrawer's Messages panel settles at (its taller,
// padded rows). It is always clamped by the measured available space
// (maxPanelHeight, which reserves NAV_SAFE_TOP and caps to the viewport), so it
// never overflows the viewport or grows into the nav — it only makes the panel
// taller when there is room. The flex-1 list then scrolls internally (#406).
const PANEL_TARGET_HEIGHT = 560

// SOP §5: an open rail panel must keep a >=12px breathing gap from the centered
// 360px app-shell card and never clip its edge (#378). The card is
// viewport-centered so its right edge sits at 50vw+180px; the panel is right-
// anchored ~ (tab 42px + 12px gap) from the viewport edge and grows leftward. Cap
// the panel width to 50vw-246px [42 tab + 12 gap-to-tab + 180 card-half + 12 gap-
// to-card] so its left edge stays >=12px clear of the card. On roomy viewports the
// natural width is smaller than the cap (no effect); on tighter md+ widths the
// panel shrinks from the left and sits in the right gutter rather than colliding.
const CARD_SAFE_MAX_WIDTH = 'calc(50vw - 246px)'

// Network/deployment this app instance runs against. The operation record does
// not persist a per-op network or Aztec version, so we surface the current active
// deployment. Same config-derived source and "vX Alpha" language the nav's
// DeploymentSelector uses.
const DEPLOYMENT_LABEL = [L1_NETWORKS[0]?.title, AZTEC_VERSION ? `v${AZTEC_VERSION} Alpha` : null]
  .filter(Boolean)
  .join(' · ')

// Deposit = Ethereum (L1) to Aztec (L2); withdraw = Aztec (L2) to Ethereum (L1).
// Same logo assets + arrow the ProgressCard from/to block uses. Visible text is
// gone, so the group carries an aria-label/title announcing the direction.
function DirectionLogos({ direction }: { direction: BridgeOperation['direction'] }) {
  const isDeposit = direction === 'L1_TO_L2'
  const eth = publicAsset('/assets/svg/ethLogo.svg')
  const aztec = publicAsset('/assets/svg/aztec.svg')
  const first = isDeposit ? eth : aztec
  const second = isDeposit ? aztec : eth
  const label = isDeposit ? 'L1 to L2' : 'L2 to L1'
  // The Aztec mark is a bare light-green diamond that washes out on the light card
  // surface, so sit it inside a dark circular chip (the Ethereum glyph is already a
  // self-contained dark circle and needs none). Matches ActivityCard's DirectionLogos.
  const renderMark = (src: string) =>
    src === aztec ? (
      <span className="inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full bg-[#0A0A0A]">
        <StyledImage src={src} alt="" className="h-[11px] w-[11px]" />
      </span>
    ) : (
      <StyledImage src={src} alt="" className="h-[15px] w-[15px] shrink-0" />
    )
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex items-center gap-1">
      {renderMark(first)}
      <Icon icon="ph:arrow-right" width={11} height={11} className="text-[#989898]" aria-hidden="true" />
      {renderMark(second)}
    </span>
  )
}

// TODO(#331): "Fee Juice used" (L2 gas consumption) cannot be surfaced from this
// data source. useBridgeOperations() -> bridge.getOperations() -> GET
// /api/bridge/operations returns only BridgeOperation rows (L1->L2 deposits and
// L2->L1 withdrawals). Fuel appears ONLY as the top-up leg of a deposit
// (op.fuelAmount / fuelMessageHash), surfaced on the row below. Nothing in this
// source, or any client store, records FeeJuice spent paying for L2 transactions,
// so usage needs backend/indexer support emitting fuel-consumption events first.
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

// Recent-bridge-operations peek, mirroring BridgeStepsRail's drawer pattern but
// on the card's right edge. Reuses useBridgeOperations for data and duplicates
// only the resume/decrypt flow from /activity — everything else (share fuel
// claim links, full history) stays on the full Activity page we link out to.
type ActivityDrawerProps = { variant?: 'rail' | 'dock' }

const ActivityDrawer: React.FC<ActivityDrawerProps> = ({ variant = 'rail' }) => {
  const isDock = variant === 'dock'
  const router = useRouter()
  const notify = useToast()
  const panelId = useId()
  const peekId = useId()
  const prefersReducedMotion = useReducedMotion()

  const { waapAddress: l1Address, signWaapMessage, isWaapConnected, connectWaapWallet } = useWalletStore()
  const { setRecovery, setWithdrawalRecovery, setDirection } = useBridgeStore()
  const { data: operations, isLoading } = useBridgeOperations()

  // Hover previews the panel; a click pins it open. On touch (no hover) the tap
  // toggles `pinned`, so the same handle works on every size.
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [recoverOpen, setRecoverOpen] = useState(false)
  // The panel is anchored to the tab's bottom and grows UPWARD (#229), so it
  // never spills below the tab into the floating chat widget. Cap its height to
  // the room between the nav bar (NAV_SAFE_TOP) and the tab's bottom edge so the
  // header and the "View full activity" footer always stay on-screen and the top
  // edge never rises over the nav no matter where the dock sits (#318).
  const [maxPanelHeight, setMaxPanelHeight] = useState<number | undefined>(undefined)
  const open = hovered || pinned
  const drawerRef = useRef<HTMLDivElement>(null)
  const handleRef = useRef<HTMLButtonElement>(null)

  const closeDesktop = () => {
    setPinned(false)
    setHovered(false)
    handleRef.current?.focus()
  }

  // ── Peek coordination (#160): announce our open state; close on a sibling's.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent<PeekSignal>(PEEK_EVENT, { detail: { id: peekId, open } }))
  }, [open, peekId])

  useEffect(() => {
    const onPeek = (e: Event) => {
      const detail = (e as CustomEvent<PeekSignal>).detail
      if (!detail || detail.id === peekId || !detail.open) return
      setHovered(false)
      setPinned(false)
    }
    window.addEventListener(PEEK_EVENT, onPeek)
    return () => window.removeEventListener(PEEK_EVENT, onPeek)
  }, [peekId])

  // Esc + outside click close a pinned desktop drawer. Only wired up while
  // pinned so hover-only previews don't pay for a global listener.
  useEffect(() => {
    if (!pinned) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setPinned(false)
      setHovered(false)
      handleRef.current?.focus()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setPinned(false)
        setHovered(false)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [pinned])

  // Measure the space above the tab's bottom edge and cap the panel to it, so the
  // upward-growing panel is never clipped by the viewport top and never crosses
  // into the top nav bar (#318). The top boundary is the LIVE bottom of the nav
  // (banners + Header), which grows when a banner shows — a static reservation
  // lands the panel's top edge behind a taller nav (z-50), hiding the header row
  // and top op. Measure the same `.ob-header-elevate` wrapper BridgeStepsRail and
  // NotificationsDrawer read; fall back to NAV_SAFE_TOP. Re-measures on resize.
  useEffect(() => {
    if (!open) return
    const measure = () => {
      const rect = handleRef.current?.getBoundingClientRect()
      if (!rect) return
      const header = typeof document !== 'undefined' ? document.querySelector('.ob-header-elevate') : null
      const navBottom = header ? header.getBoundingClientRect().bottom : NAV_SAFE_TOP
      setMaxPanelHeight(Math.max(160, Math.round(rect.bottom - navBottom)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  // Esc closes the recovery overlay.
  useEffect(() => {
    if (!recoverOpen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRecoverOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [recoverOpen])

  const recentOps = useMemo(() => {
    if (!operations) return []
    return [...operations]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_VISIBLE_OPS)
  }, [operations])

  // Count across ALL operations (not just the visible 5), so the tab flags
  // resumable work even when it has scrolled out of the recent peek.
  const resumableCount = useResumableCount()
  const isLive = useIsOperationLive()

  const handleResume = async (operation: BridgeOperation) => {
    if (!l1Address) {
      notify('error', 'Please connect your Ethereum wallet first')
      return
    }

    setResumingId(operation.id)
    try {
      const decrypted = await decryptOperationPayload(operation, l1Address, signWaapMessage)

      if (!decrypted) {
        throw new Error(
          'Could not decrypt operation data. Make sure you are using the same wallet that created this bridge.',
        )
      }

      if (operation.direction === 'L2_TO_L1') {
        const recoveryData: RecoveryWithdrawalData = {
          operationId: operation.id,
          amount: decrypted.amount ?? operation.amountL2 ?? operation.amountL1 ?? '0',
          l1Address: decrypted.l1Address ?? l1Address,
          l2Address: decrypted.l2Address ?? '',
          l2TxHash: operation.l2TxHash,
          l2TxUrl: operation.l2TxUrl,
          l2BlockNumber: operation.l2BlockNumber,
          l2BlockNumberBeforeTx: operation.l2BlockNumberBeforeTx,
          l2ToL1MessageIndex: operation.l2ToL1MessageIndex,
          siblingPath: operation.siblingPath,
          epoch: operation.epoch,
          numCheckpointsInEpoch: operation.numCheckpointsInEpoch,
          recipientL1Address: operation.recipientL1Address ?? l1Address,
          rollupVersion: operation.rollupVersion,
          chainIdL1: operation.chainIdL1,
          portalAddressL1: operation.portalAddressL1,
          bridgeAddressL2: operation.bridgeAddressL2,
          l1RollupAddress: operation.l1RollupAddress,
          l1OutboxAddress: operation.l1OutboxAddress,
          isPrivacyModeEnabled: operation.isPrivacyModeEnabled ?? false,
          nodeInfo: operation.nodeInfo,
          status: operation.status,
          currentStep: operation.currentStep,
        }

        setDirection(BridgeDirection.L2_TO_L1)
        setWithdrawalRecovery(operation.id, recoveryData)
        router.push('/progress/resume')
      } else {
        if (!decrypted.claimSecret || !decrypted.claimSecretHash) {
          throw new Error(
            'Could not decrypt claim secret. Make sure you are using the same wallet that created this bridge.',
          )
        }

        const recoveryData: RecoveryClaimData = {
          operationId: operation.id,
          claimSecret: decrypted.claimSecret,
          claimSecretHash: decrypted.claimSecretHash,
          messageHash: operation.messageHash,
          messageLeafIndex: operation.messageLeafIndex,
          amount: decrypted.amount ?? operation.amountL1 ?? '0',
          claimAmount: operation.claimAmount ?? null,
          l1Address: decrypted.l1Address ?? l1Address,
          l2Address: decrypted.l2Address ?? '',
          l1TxHash: operation.l1TxHash,
          l1TxUrl: operation.l1TxUrl,
          l1BlockNumberBeforeTx: operation.l1BlockNumberBeforeTx,
          isPrivacyModeEnabled: operation.isPrivacyModeEnabled ?? false,
          nodeInfo: operation.nodeInfo,
          status: operation.status,
          currentStep: operation.currentStep,
          portalAddressL1: operation.portalAddressL1,
          bridgeAddressL2: operation.bridgeAddressL2,
          tokenAddressL1: operation.tokenAddressL1,
          tokenAddressL2: operation.tokenAddressL2,
          fuelSecret: decrypted.fuelSecret ?? null,
          privateFuelSalt: decrypted.privateFuelSalt ?? null,
          privateFuelSecret: decrypted.privateFuelSecret ?? null,
          fuelMessageHash: operation.fuelMessageHash ?? null,
          fuelMessageLeafIndex: operation.fuelMessageLeafIndex ?? null,
          fuelAmount: operation.fuelAmount ?? null,
        }

        setDirection(BridgeDirection.L1_TO_L2)
        setRecovery(operation.id, recoveryData)
        router.push('/progress/resume')
      }

      setPinned(false)
      setHovered(false)
    } catch (err) {
      console.error('[ActivityDrawer] resume/decrypt failed:', err)
      logError('Resume decrypt failed', {
        errorType: 'resume_decrypt_failed',
        error: err instanceof Error ? err.message : String(err),
      })
      notify('error', humanizeError(err))
    } finally {
      setResumingId(null)
    }
  }

  const renderOp = (op: BridgeOperation) => {
    const decimals = op.tokenDecimalsL1 ?? L1_TOKEN_METADATA.decimals
    const tokenSymbol = op.tokenSymbol ?? op.tokenSymbolL1 ?? L1_TOKEN_METADATA.symbol
    const amount = op.amountDisplayL1 ?? (op.amountL1 ? formatUnits(BigInt(op.amountL1), decimals) : '?')
    const opDate = new Date(op.createdAt)
    const date = `${opDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${opDate.toLocaleTimeString(
      undefined,
      { hour: 'numeric', minute: '2-digit' },
    )}`
    const meta = getStatusBadge(op.status)
    // A transfer this tab is still driving is NOT resumable — it is running. Showing
    // Resume beside a screen that says "Buying Fee Juice…" made the row contradict the
    // app (SOP §8), and starting a second run of the same operation is exactly what the
    // Resume button would have done.
    const live = isLive(op.id)
    const showResume = !live && canResumeOp(op)
    const fuelTopUp = fuelTopUpFj(op)

    return (
      <li key={op.id} className="border-b border-[#F0F0F0] py-2.5 last:border-b-0 last:pb-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <DirectionLogos direction={op.direction} />
            {/* Public (globe/navy) vs private (lock/maroon) — same language as ActivityCard (#230a). */}
            {op.isPrivacyModeEnabled ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-[#FDE7F3] px-1.5 py-0.5 text-[9px] font-semibold text-[#81133B]">
                <Icon icon="ph:lock-key-fill" width={9} height={9} />
                Private
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-[#E5EFFF] px-1.5 py-0.5 text-[9px] font-semibold text-[#17235E]">
                <Icon icon="ph:globe-hemisphere-west-fill" width={9} height={9} />
                Public
              </span>
            )}
          </div>
          <span className={`flex-shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${meta.className}`}>
            {meta.label}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#0A0A0A]">
            {amount} {tokenSymbol}
          </span>
          <span className="flex-shrink-0 text-[11px] text-[#989898]">{date}</span>
        </div>
        {DEPLOYMENT_LABEL && (
          <p className="mt-0.5 truncate text-[10px] text-[#989898]">{DEPLOYMENT_LABEL}</p>
        )}
        {fuelTopUp && (
          <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] font-medium text-amber-700">
            <Icon icon="ph:gas-pump" width={10} height={10} className="flex-shrink-0" />
            Fee Juice top up · {fuelTopUp} FJ
          </p>
        )}
        {live && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-[#81133B]">
            <Icon icon="ph:spinner-gap-bold" width={11} height={11} className="shrink-0 animate-spin" />
            In progress
          </p>
        )}
        {showResume && (
          <button
            onClick={() => handleResume(op)}
            disabled={resumingId === op.id}
            className="mt-1.5 rounded-md bg-black px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-80 disabled:opacity-60"
          >
            {resumingId === op.id ? 'Decrypting…' : 'Resume'}
          </button>
        )}
      </li>
    )
  }

  const panelBody = (onClose?: () => void) => (
    <>
      <div className="mb-3 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.5px] text-[#989898]">Bridge activity</p>
          {resumableCount > 0 && (
            <span className="flex-shrink-0 rounded-full bg-[#FDE7F3] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.3px] text-[#81133B]">
              {resumableCount} to finish
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {/* Recover from local backup, reduced to a key icon (#179) so it no longer
              eats a full row. Opens as an overlay over the current view (#195) rather
              than navigating away. Tooltip explains the action on hover/focus. */}
          <button
            type="button"
            onClick={() => {
              setPinned(false)
              setHovered(false)
              setRecoverOpen(true)
            }}
            data-tooltip-id="activity-recover-tip"
            data-tooltip-content="Restore a bridge from a local backup key if it is missing here."
            aria-label="Recover from local backup"
            className="flex h-6 w-6 items-center justify-center rounded-full text-[#81133B] transition-colors hover:bg-[#FDE7F3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#81133B]/40"
          >
            <Icon icon="ph:key" width={14} height={14} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1 flex h-6 w-6 items-center justify-center rounded-full text-[#989898] transition-colors hover:bg-[#F0F0F0] hover:text-[#0A0A0A] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#17235E]/40"
            >
              <Icon icon="ph:x-bold" width={13} height={13} />
            </button>
          )}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {isLoading && <p className="text-[12px] text-[#989898]">Loading…</p>}
        {!isLoading &&
          recentOps.length === 0 &&
          (isWaapConnected ? (
            // Connected but no operations yet — genuine empty state.
            <p className="text-[12px] text-[#989898]">No bridge operations yet.</p>
          ) : (
            // Not connected — don't imply the history is empty (#163). Prompt to connect.
            <div className="flex flex-col items-center gap-2 py-5 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#E5EFFF] text-[#17235E]">
                <Icon icon="ph:plugs" width={18} height={18} />
              </span>
              <p className="text-[12px] font-medium text-[#737373]">Connect your wallet to see your activity</p>
              <button
                type="button"
                onClick={() => connectWaapWallet().catch(() => {})}
                className="mt-0.5 inline-flex items-center gap-1.5 rounded-lg bg-[#17235E] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#17235E]/90"
              >
                <Icon icon="ph:wallet" width={14} height={14} />
                Connect wallet
              </button>
            </div>
          ))}
        {recentOps.length > 0 && <ul className="flex flex-col">{recentOps.map(renderOp)}</ul>}
      </div>
      <div className="mt-3 shrink-0 border-t border-[#F0F0F0] pt-3">
        {/* #416: the "see more" affordance was a small, left-aligned, muted-grey
            row that was easy to miss. Make it the clear centered call-to-action
            it should be: full-width and centered, a step larger, semibold, in
            brand maroon (text-shield, #81133B) with the activity glyph — high
            contrast on the white panel and unmistakable as the way to the full
            history. Soft maroon hover wash + focus ring mirror the recover
            button above so the two footer affordances read as one family. */}
        <button
          onClick={() => router.push('/activity')}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] font-semibold text-[#81133B] transition-colors hover:bg-[#FDE7F3] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#81133B]/40"
        >
          <Icon icon="ph:clock-counter-clockwise" width={16} height={16} />
          View full activity
        </button>
      </div>
      <ReactTooltip id="activity-recover-tip" place="left" className="z-[100]" style={{ fontSize: '11px', maxWidth: '200px' }} />
    </>
  )

  // A slim binder tab pinned to the viewport's right edge, stacked below the
  // Tutorial tab by the dock in ClientLayout. Hover or click peeks the recent
  // activity panel out to the LEFT of the tab — same direction as Tutorial, so
  // the two read as one binder. The panel is absolutely positioned so opening it
  // never reflows (splits apart) the sibling tabs (#114). The dock is fixed, so
  // it never adds page scroll and persists across every app screen.
  return (
    <>
    {isDock ? (
      // Narrow-viewport dock (#243): a compact round icon button in the
      // bottom-left mobile dock. Keeps the clock-counter-clockwise identity + the
      // "transfers to finish" count badge and opens the same activity panel as a
      // bottom-anchored sheet that stays on-screen on phones.
      <div
        ref={drawerRef}
        className="pointer-events-auto relative"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="panel"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: prefersReducedMotion ? 0 : DS_DUR_ENTER, ease: DS_EASE_SLIDE }}
              className="fixed bottom-[76px] left-4 z-40 w-[300px] max-w-[calc(100vw-2rem)]"
            >
              <div
                id={panelId}
                className="flex max-h-[70dvh] flex-col rounded-[16px] border border-[#D4D4D4] bg-white p-4 shadow-[0px_15px_34px_0px_rgba(0,0,0,0.10)]"
              >
                {panelBody(closeDesktop)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          ref={handleRef}
          type="button"
          aria-expanded={open}
          aria-label={
            resumableCount > 0
              ? `Bridge activity, ${resumableCount} ${resumableCount === 1 ? 'transfer' : 'transfers'} to finish`
              : 'Bridge activity'
          }
          aria-controls={panelId}
          onClick={() => setPinned((p) => !p)}
          className={`relative flex h-11 w-11 items-center justify-center rounded-full border bg-white shadow-[0px_6px_16px_0px_rgba(0,0,0,0.12)] transition-colors ${
            open ? 'border-[#17235E]/40' : 'border-[#D4D4D4]'
          }`}
        >
          <Icon icon="ph:clock-counter-clockwise" width={18} height={18} className="text-[#737373]" aria-hidden="true" />
          {resumableCount > 0 ? (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#81133B] px-1 text-[9px] font-bold leading-none text-white ring-2 ring-white"
            >
              {resumableCount > 9 ? '9+' : resumableCount}
            </span>
          ) : (
            <span aria-hidden="true" className="absolute right-1 top-1 h-2 w-2 rounded-full bg-[#17235E] ring-2 ring-white" />
          )}
        </button>
      </div>
    ) : (
    <div
      ref={drawerRef}
      className="pointer-events-auto relative flex items-center justify-end"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 280, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : DS_DUR_ENTER, ease: DS_EASE_SLIDE }}
            style={{ maxWidth: CARD_SAFE_MAX_WIDTH }}
            className="absolute bottom-0 right-[calc(100%_+_12px)] overflow-hidden"
          >
            <div
              id={panelId}
              style={{
                height: maxPanelHeight != null ? Math.min(maxPanelHeight, PANEL_TARGET_HEIGHT) : undefined,
                maxHeight: maxPanelHeight,
                maxWidth: CARD_SAFE_MAX_WIDTH,
              }}
              className="flex max-h-[calc(100dvh-1.5rem)] w-[280px] flex-col rounded-[16px] border border-[#D4D4D4] bg-white p-4 shadow-[0px_15px_34px_0px_rgba(0,0,0,0.10)]"
            >
              {panelBody(closeDesktop)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        ref={handleRef}
        type="button"
        aria-expanded={open}
        aria-label={
          resumableCount > 0
            ? `Bridge activity, ${resumableCount} ${resumableCount === 1 ? 'transfer' : 'transfers'} to finish`
            : 'Bridge activity'
        }
        aria-controls={panelId}
        onClick={() => setPinned((p) => !p)}
        className={`flex h-[144px] px-1.5 py-3.5 flex-shrink-0 flex-col items-center justify-center gap-2 rounded-l-[12px] border border-r-0 bg-white transition-[width,border-color] duration-200 ease-out ${
          open ? 'border-[#17235E]/40' : 'border-[#D4D4D4] hover:border-[#17235E]/30'
        } ${open && !prefersReducedMotion ? 'w-[42px]' : 'w-9'}`}
      >
        {resumableCount > 0 ? (
          // Attention badge: a shield-pink count sits where the neutral status
          // dot would, so the user sees "you have N transfers to finish"
          // without opening the drawer. Ring keeps it legible against the tab
          // on either theme. Static (no pulse) so it is reduced-motion safe.
          <span
            aria-hidden="true"
            className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#81133B] px-1 text-[9px] font-bold leading-none text-white ring-2 ring-white/90"
          >
            {resumableCount > 9 ? '9+' : resumableCount}
          </span>
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-[#17235E]" aria-hidden="true" />
        )}
        <Icon icon="ph:clock-counter-clockwise" width={15} height={15} className="text-[#737373]" aria-hidden="true" />
        <span
          className="px-0.5 py-1 text-[10px] font-semibold uppercase tracking-[1.5px] text-[#737373]"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Activity
        </span>
      </button>
    </div>
    )}

    {/* Recover-from-local-backup overlay (#195): opens OVER the current view
        instead of navigating to a full page. */}
    <AnimatePresence>
      {recoverOpen && (
        <motion.div
          key="recover-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
          onClick={() => setRecoverOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Recover from local backup"
        >
          <div
            className="w-[360px] max-w-full max-h-[calc(90vh-2rem)] min-h-[520px] overflow-hidden rounded-xl bg-white shadow-[0px_15px_34px_0px_rgba(0,0,0,0.20)]"
            onClick={(e) => e.stopPropagation()}
          >
            <LocalRecoveryPanel variant="modal" onClose={() => setRecoverOpen(false)} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}

export default ActivityDrawer
