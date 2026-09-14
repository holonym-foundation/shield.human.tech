'use client'

import { Icon, loadIcons } from '@iconify/react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { useWalletStore } from '@/stores/walletStore'
import { useAttestationCheck } from '@/hooks/useAttestationCheck'
import { useL1Humanity } from '@/hooks/useL1Humanity'
import { shortAddr, accountLabel } from '@/hooks/useBindingStatus'
import { POCH_MINT_URL, PASSPORT_BUILD_URL, IS_MAINNET } from '@/config'
import { BRIDGE_MAX_DEPOSIT_USD, TRAVEL_RULE_THRESHOLD_USD } from '@/config/env.config'
import { silkUrl } from '@/config/l1.config'
import { LOGIN_METHODS } from '@/types/wallet'
import { copyToClipboard } from '@/utils'

// Preload the Phosphor glyphs used inside the chip + dropdown so iconify has
// them cached before first paint (same pattern Header uses for its own set).
if (typeof window !== 'undefined') {
  loadIcons([
    'ph:seal-check-fill',
    'ph:seal-warning',
    'ph:caret-down',
    'ph:link',
    'ph:link-simple',
    'ph:wallet',
    'ph:arrows-left-right',
    'ph:sign-out',
    'ph:identification-card',
    'ph:hand-soap',
    'ph:plus-circle',
    'ph:gauge',
    'ph:check',
    'ph:copy',
    'ph:warning-circle',
    'ph:info',
    'ph:trash',
    'majesticons:open',
  ])
}

// ─── Brand assets reused from the app (never re-drawn) ──────────────────────
const EVM_NETWORK_ICON = '/assets/svg/network-logo.svg'
const AZTEC_ICON = '/assets/svg/aztec.svg'
const EVM_WALLET_FALLBACK = '/assets/wallets/wally-dark.svg'
// WaaP embedded wallet brand mark. The WaaP wallet IS human.tech's Silk wallet
// (the "Open Wallet" action opens the Silk UI at silkUrl), so its own product
// logo is the correct identity for the row — never the generic/injected icon
// (Rabby/MetaMask) that waapWalletIcon may carry for a browser-extension login.
const WAAP_WALLET_ICON = '/assets/svg/silk-logo.svg'

// HUMN Points display is OFF until it reads from a working source (#427/#429).
// The current /api/points proxy hits Passport's public Stamps API, whose
// points_data field is now hardcoded null (the campaign moved) — so it returns 0
// for everyone, even a wallet showing 1,200 on the Passport dApp. Showing that 0
// is worse than showing nothing (a false balance). Flip this back to true once
// fetchPassportPoints is repointed at the Covenant HUMN Points service (needs its
// base URL + auth). Until then both the nav chip and the dropdown row stay hidden.
const HUMN_POINTS_LIVE = false

// Compliance figures surfaced in the account dropdown. Both come from env
// (BRIDGE_MAX_DEPOSIT_USD, TRAVEL_RULE_THRESHOLD_USD) — never hardcoded — so
// they track config. Neither is NEXT_PUBLIC, so on the client `process.env`
// returns undefined and they resolve to their config defaults, so a server-only
// override moves enforcement without moving this label.
// Thousands abbreviate to "$25k"; under 1,000 must print in full, or a $10 cap
// renders as "$0.01k".
const DEPOSIT_CAP_USD = Number(BRIDGE_MAX_DEPOSIT_USD)
const DEPOSIT_CAP_LABEL =
  DEPOSIT_CAP_USD >= 1000 ? `$${DEPOSIT_CAP_USD / 1000}k` : `$${DEPOSIT_CAP_USD.toLocaleString('en-US')}`
const TRAVEL_RULE_LABEL = `$${Number(TRAVEL_RULE_THRESHOLD_USD).toLocaleString()}`

// ─── Theme helpers (ported from Header's glass-pill vocabulary; this app is
// Tailwind-only and the design system ships CSS modules, so the LOOK is
// reproduced, not imported). Every white/black-alpha uses the BRACKET form —
// the bare `/60` shorthand silently compiles to nothing under this repo's
// sparse opacity scale (see Header.tsx for the full note). ────────────────────
const GLASS_PILL =
  'backdrop-blur-md bg-white/[0.85] border border-[#E5E5E5]/80 shadow-[0_6px_18px_-6px_rgba(15,15,15,0.18),0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200'
const GLASS_PILL_HOVER =
  'hover:bg-white hover:shadow-[0_10px_24px_-8px_rgba(15,15,15,0.24),0_1px_2px_rgba(0,0,0,0.04)]'
const GLASS_PILL_ACTIVE =
  'bg-white shadow-[0_10px_24px_-8px_rgba(15,15,15,0.24),0_1px_2px_rgba(0,0,0,0.04)]'
const GLASS_PILL_DARK =
  'backdrop-blur-md bg-white/[0.07] border border-white/[0.14] shadow-[0_6px_18px_-6px_rgba(0,0,0,0.55),0_1px_2px_rgba(0,0,0,0.35)] transition-all duration-200'
const GLASS_PILL_DARK_HOVER =
  'hover:bg-white/[0.12] hover:border-white/[0.22] hover:shadow-[0_10px_24px_-8px_rgba(0,0,0,0.6),0_1px_2px_rgba(0,0,0,0.35)]'
const GLASS_PILL_DARK_ACTIVE =
  'bg-white/[0.14] border-white/[0.22] shadow-[0_10px_24px_-8px_rgba(0,0,0,0.6),0_1px_2px_rgba(0,0,0,0.35)]'

function glassPill(isDark: boolean, active = false): string {
  if (isDark) return `${GLASS_PILL_DARK} ${GLASS_PILL_DARK_HOVER} ${active ? GLASS_PILL_DARK_ACTIVE : ''}`
  return `${GLASS_PILL} ${GLASS_PILL_HOVER} ${active ? GLASS_PILL_ACTIVE : ''}`
}
function navText(isDark: boolean): string {
  return isDark ? 'text-white/[0.90]' : 'text-[#17235E]'
}
function mutedIconText(isDark: boolean): string {
  return isDark ? 'text-white/[0.60]' : 'text-gray-400'
}
function subtleText(isDark: boolean): string {
  return isDark ? 'text-white/[0.65]' : 'text-gray-500'
}
/** Shield accent — maroon on light, pink-40 on dark (maroon is too close to the
 *  dark-maroon Privacy background to read as an accent). */
function accentPink(isDark: boolean): string {
  return isDark ? 'text-[#FA8FC4]' : 'text-[#81133B]'
}
function hoverTint(isDark: boolean): string {
  return isDark ? 'hover:bg-white/[0.10]' : 'hover:bg-black/[0.04]'
}
function panelSurface(isDark: boolean): string {
  return isDark
    ? 'bg-[#2A0E1C]/[0.97] backdrop-blur-md border border-white/[0.12]'
    : 'bg-white/[0.97] backdrop-blur-md border border-[#E5E5E5]/80'
}
function panelDivider(isDark: boolean): string {
  return isDark ? 'border-white/[0.12]' : 'border-[#E5E5E5]'
}
function menuItemHover(isDark: boolean): string {
  return isDark ? 'hover:bg-white/[0.10]' : 'hover:bg-black/[0.04]'
}
/** Progress-track background under a fill bar. */
function trackBg(isDark: boolean): string {
  return isDark ? 'bg-white/[0.12]' : 'bg-black/[0.06]'
}

/**
 * Canonical Human Points glyph, ported from the design-system icon set
 * (human-tech-design-system/src/icons/humanpoints.svg). Inlined as raw SVG since
 * the design system isn't a dependency here. Used for the HUMN Points value now
 * folded into the account chip (#313).
 */
const HumanPointsIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 100 100" fill="none" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M50.5 10C54.0539 10 57.136 11.6347 59.5978 13.9768C62.0389 16.2999 64.0561 19.472 65.6595 23.0796C66.8788 25.8231 67.9004 28.9244 68.7057 32.2892C72.0727 33.0947 75.1753 34.1205 77.9204 35.3405C81.5277 36.9437 84.7001 38.9614 87.0232 41.4022C89.3651 43.8637 90.9997 46.9466 91 50.5C90.9997 54.0537 89.3654 57.1362 87.0232 59.5978C84.7003 62.0387 81.5276 64.0511 77.9204 65.6544C75.1754 66.8744 72.0725 67.8993 68.7057 68.7057C67.9002 72.0724 66.8794 75.1756 65.6595 77.9204C64.0561 81.528 62.0389 84.7001 59.5978 87.0232C57.136 89.3653 54.0539 91 50.5 91C46.946 90.9996 43.8639 89.3657 41.4022 87.0232C38.9612 84.7002 36.9489 81.5278 35.3456 77.9204C34.1254 75.1751 33.0957 72.0731 32.2892 68.7057C28.9242 67.8995 25.8232 66.8738 23.0796 65.6544C19.4724 64.0511 16.2997 62.0387 13.9768 59.5978C11.6346 57.1362 10.0003 54.0537 10 50.5C10.0003 46.9466 11.6349 43.8637 13.9768 41.4022C16.2999 38.9614 19.4723 36.9437 23.0796 35.3405C25.8233 34.1211 28.924 33.0945 32.2892 32.2892C33.0955 28.9237 34.126 25.8236 35.3456 23.0796C36.9489 19.4722 38.9612 16.2998 41.4022 13.9768C43.8639 11.6343 46.946 10.0003 50.5 10ZM59.8876 70.2313C56.8657 70.57 53.7207 70.75 50.5 70.75C47.2775 70.75 44.1307 70.5703 41.1073 70.2313C41.6021 71.8156 42.1484 73.2882 42.7448 74.6301C44.0732 77.619 45.5506 79.7887 46.986 81.1547C48.3999 82.5003 49.5812 82.9037 50.5 82.9041C51.4188 82.9041 52.6 82.4999 54.014 81.1547C55.4494 79.7887 56.9268 77.619 58.2552 74.6301C58.8514 73.2887 59.3925 71.815 59.8876 70.2313ZM50.5 38.3459C46.5082 38.3459 42.7086 38.6605 39.2003 39.2003C38.6615 42.7086 38.351 46.5085 38.351 50.5C38.351 54.4896 38.662 58.2877 39.2003 61.7946C42.7089 62.3335 46.5081 62.649 50.5 62.649C54.49 62.649 58.2874 62.333 61.7946 61.7946C62.334 58.2874 62.6541 54.4902 62.6541 50.5C62.6541 46.5079 62.3345 42.7089 61.7946 39.2003C58.2877 38.661 54.4899 38.3459 50.5 38.3459ZM30.7636 41.1073C29.1812 41.6021 27.7104 42.149 26.3699 42.7448C23.3813 44.073 21.2113 45.5508 19.8453 46.986C18.5006 48.3994 18.0963 49.5814 18.0959 50.5C18.0963 51.4187 18.5002 52.6003 19.8453 54.014C21.2112 55.4493 23.3812 56.9269 26.3699 58.2552C27.7104 58.8509 29.1812 59.3983 30.7636 59.8927C30.4246 56.8695 30.25 53.7222 30.25 50.5C30.25 47.2778 30.4246 44.1305 30.7636 41.1073ZM70.2313 41.1073C70.5697 44.1308 70.75 47.2776 70.75 50.5C70.75 53.7224 70.5697 56.8692 70.2313 59.8927C71.8155 59.3979 73.2883 58.8515 74.6301 58.2552C77.6188 56.9269 79.7888 55.4493 81.1547 54.014C82.4998 52.6003 82.9037 51.4187 82.9041 50.5C82.9037 49.5814 82.4994 48.3994 81.1547 46.986C79.7887 45.5508 77.6186 44.073 74.6301 42.7448C73.2883 42.1484 71.8155 41.6025 70.2313 41.1073ZM50.5 18.0959C49.5812 18.0963 48.3999 18.4997 46.986 19.8453C45.5506 21.2113 44.0732 23.381 42.7448 26.3699C42.149 27.7104 41.6018 29.1811 41.1073 30.7636C44.1306 30.4253 47.2778 30.25 50.5 30.25C53.7204 30.25 56.8659 30.4256 59.8876 30.7636C59.3929 29.1817 58.8508 27.71 58.2552 26.3699C56.9268 23.3809 55.4494 21.2113 54.014 19.8453C52.6 18.5001 51.4188 18.0959 50.5 18.0959Z"
      fill="currentColor"
    />
  </svg>
)

interface AccountChipProps {
  /** True when Privacy Mode is on and the page is on the dark maroon field. */
  isDark?: boolean
  /** Existing combined EVM→Aztec connect flow (Header owns the auto-connect). */
  onConnectWallet: () => void
  /** Existing Aztec-only connect action. */
  onConnectAztec: () => void
  /** L1 connection in flight (nothing connected yet). */
  isL1Connecting?: boolean
  /** L2 connection in flight (EVM up, Aztec connecting). */
  isL2Connecting?: boolean
  /** Native L1 balance string, already derived in Header from useL1TokenBalances. */
  l1NativeBalance?: string
  /** Hard-lock fund-losing actions (Disconnect) during an in-progress transfer. */
  actionsLocked?: boolean
  /** WAAP login method — gates the "Open Wallet" row (Header owns the store field). */
  loginMethod?: string | null
  /**
   * Actionable binding-conflict notice, rendered as a static BANNER at the top
   * of the dropdown (above the account list) rather than a floating overlay that
   * would cover the account-selection rows (issue #282).
   */
  conflictNotice?: string
  /** True when the notice is a hard server conflict (deeper accent) vs a softer pre-warn. */
  conflictSevere?: boolean
  /**
   * L2 account the SERVER has disclosed as the pair for the connected EVM wallet
   * (authoritative bound response — never localStorage). The matching row in the
   * Switch Account list gets a "Linked" badge so the user can pick it (issue #284).
   */
  linkedAccountAddress?: string
  /**
   * HUMN Points balance, folded into the account chip (#313 — the separate
   * humanity/points nav chip is gone). Optional and gated on the connection/data
   * state (#303): the value renders ONLY while the EVM wallet is connected and a
   * real number is present, so it can never persist as a stale readout after the
   * wallet disconnects.
   */
  points?: number
}

/**
 * Account Chip (Variant A) — a single skinny wallet-only chip in the top-right
 * nav that opens an account dropdown. Encapsulates the connect / connected
 * states and the Wallets · Identity & proofs · Limits & usage · Disconnect
 * dropdown. Sits standalone at the right end of the nav at the uniform top-row
 * height (h-14 / CHIP_H), like the Shield brand + humanity chips.
 *
 * The humanity/points chip is a SEPARATE element that stays beside this in the
 * Header — it is intentionally NOT folded in here.
 */
const AccountChip: React.FC<AccountChipProps> = ({
  isDark = false,
  onConnectWallet,
  onConnectAztec,
  isL1Connecting = false,
  isL2Connecting = false,
  l1NativeBalance,
  actionsLocked = false,
  loginMethod,
  conflictNotice,
  conflictSevere = false,
  linkedAccountAddress,
  points,
}) => {
  const {
    waapAddress,
    isWaapConnected,
    waapWalletIcon,
    disconnectWaapWallet,
    aztecAddress,
    aztecAlias,
    isAztecConnected,
    disconnectAztecWallet,
    availableAccounts,
    switchAztecAccount,
  } = useWalletStore()

  // Authenticated Shield attestation — carries the per-user deposit / Travel-Rule
  // caps, but needs an authed session + Shield attestation. Without auth it is
  // undefined, so it must NEVER be the source of the personhood face (that would
  // contradict the nav). It is used ONLY for the cap/limit figures and to decide
  // whether the SEPARATE "Complete verification" nudge is needed.
  const { data: attestation, isFetching: attFetching } = useAttestationCheck()
  const eligible = attestation?.eligible ?? false
  const remainingDepositUsd = attestation?.remainingDepositUsd
  const reservedDepositUsd = attestation?.reservedDepositUsd
  const travelRuleRemainingUsd = attestation?.travelRuleRemainingUsd
  const depositLimitReached = attestation?.depositLimitReached ?? false
  // The authed attestation's own verified state (session + Shield attestation).
  const attScorePasses =
    typeof attestation?.passportScore === 'number' &&
    typeof attestation?.passportThreshold === 'number' &&
    attestation.passportScore >= attestation.passportThreshold
  const attVerified = eligible || attScorePasses || attestation?.method === 'poch'

  // ── Personhood: SAME L1 humanity source the nav uses (issue #291) ──
  // Keyed purely on the L1 address (no JWT / no L2 binding), so the score shown
  // here is identical to the nav's humanity chip and can never disagree with it.
  const { data: l1Humanity, isFetching: l1Fetching } = useL1Humanity(waapAddress || undefined)
  const l1Method = l1Humanity?.method ?? null
  const l1Score = l1Humanity?.passportScore
  const l1Threshold = l1Humanity?.passportThreshold
  // Mirror the nav: a score > 0 counts as a real, showable score (never a bare 0).
  const l1HasScore = typeof l1Score === 'number' && l1Score > 0
  const l1IsPoch = l1Method === 'poch'
  const l1ScorePasses =
    l1HasScore && (typeof l1Threshold === 'number' ? l1Score! >= l1Threshold : true)
  // Verified indicator reflects the humanity result (same as the nav), NOT the
  // authed attestation — so the seal/state can never contradict the nav.
  const l1Verified = l1HasScore || l1IsPoch || (l1Humanity?.eligible ?? false)
  // #434: PERSONHOOD is only proven by a PASSING score or Clean Hands — a score
  // below the threshold (e.g. 11 when the bar is 20) is NOT verified. The seal must
  // use this, never `l1Verified` (which is true for any score > 0), or it contradicts
  // the Passport row's own passing state.
  const l1PersonhoodVerified = l1ScorePasses || l1IsPoch
  // Has a Passport score but BELOW the passing threshold — the next step is to RAISE
  // the score (add stamps), not "complete verification" or "upgrade to Clean Hands"
  // (both of which assume they already passed) (#434).
  const l1BelowThreshold = l1HasScore && !l1ScorePasses && !l1IsPoch
  // Has a Passport score but not yet Clean Hands.
  const l1OnPassportTier = !l1IsPoch && l1HasScore

  // #303: HUMN Points render strictly from the connection + data state — only
  // while the EVM wallet is connected AND a real numeric balance is present. When
  // the wallet disconnects the chip collapses to the connect state (below), so
  // there is no persisted/stale value left to clear.
  const showPoints = HUMN_POINTS_LIVE && isWaapConnected && typeof points === 'number' && points > 0
  // A positive, real balance — drives the accent treatment on the dropdown points
  // row (#427), which (unlike the nav chip) stays visible at 0 while connected.
  const hasPoints = typeof points === 'number' && points > 0

  // #306: current-tier deposit limits derived from the L1 proof tier
  // (useL1Humanity), NOT gated behind an authed attestation session. Clean Hands
  // unlocks the daily deposit cap; a passing Passport (no Clean Hands) is bound
  // by the lifetime Travel-Rule threshold; an unverified wallet sees a verify
  // prompt and nothing else. Real remaining usage is shown where the authed
  // attestation has supplied it.
  const depositCapUsd = Number(BRIDGE_MAX_DEPOSIT_USD)
  const travelRuleUsd = Number(TRAVEL_RULE_THRESHOLD_USD)

  const tierLimitLabel = l1IsPoch
    ? `Daily limit (${DEPOSIT_CAP_LABEL}/human)`
    : l1OnPassportTier
      ? `Lifetime bridged in (${TRAVEL_RULE_LABEL}/human)`
      : 'Deposit limits'

  // Explainer for the lifetime bridge-in cap, surfaced as an (i) tooltip beside
  // the label (SOP §7). Deposit-only: withdrawals never reduce it.
  const tierLimitInfo = l1OnPassportTier
    ? 'This is a per human lifetime cap on the value you bridge into Aztec. Only deposits count toward it. Withdrawals do not reduce it, and only funds bridged in through this app are counted.'
    : undefined

  const tierLimitValue = l1IsPoch
    ? depositLimitReached
      ? 'Reached'
      : typeof remainingDepositUsd === 'number'
        ? `$${remainingDepositUsd.toLocaleString()} left`
        : attFetching
          ? 'Checking…'
          : `${DEPOSIT_CAP_LABEL} daily`
    : l1OnPassportTier
      ? typeof travelRuleRemainingUsd === 'number'
        ? `$${travelRuleRemainingUsd.toLocaleString()} left`
        : attFetching
          ? 'Checking…'
          : `${TRAVEL_RULE_LABEL} lifetime`
      : l1Fetching
        ? 'Checking…'
        : 'Verify to see limits'

  // Usage percentage only when a real remaining figure is available against a
  // known cap; otherwise the bar stays a striped placeholder rather than
  // fabricating a fill level.
  let tierLimitPct: number | undefined
  if (l1IsPoch) {
    if (depositLimitReached) tierLimitPct = 100
    else if (typeof remainingDepositUsd === 'number' && depositCapUsd > 0)
      tierLimitPct = ((depositCapUsd - remainingDepositUsd) / depositCapUsd) * 100
  } else if (l1OnPassportTier) {
    if (typeof travelRuleRemainingUsd === 'number' && travelRuleUsd > 0)
      tierLimitPct = ((travelRuleUsd - travelRuleRemainingUsd) / travelRuleUsd) * 100
  }
  const tierLimitPlaceholder = tierLimitPct === undefined && (l1IsPoch || l1OnPassportTier)
  const tierLimitTint: 'maroon' | 'navy' = l1IsPoch ? 'maroon' : 'navy'

  // #304: the exact linked Aztec account (when it is one of the connected
  // Azguard accounts) so the conflict banner can offer a one-tap switch to the
  // named target without implying the user has already switched.
  const linkedAccount =
    linkedAccountAddress && availableAccounts.length > 0
      ? availableAccounts.find((a) => a.address.toLowerCase() === linkedAccountAddress.toLowerCase())
      : undefined

  // #438: the connected Aztec account IS the server-bound pair for the EVM wallet
  // — the same condition that drives the per-row "Linked" badge. Reused to gate
  // the avatar-column connector drawn between the two wallet rows.
  const aztecConnectorLinked =
    !!linkedAccountAddress &&
    !!aztecAddress &&
    aztecAddress.toLowerCase() === linkedAccountAddress.toLowerCase()

  // #349: dropdown actions that start a flow (Aztec connect, in-app verification)
  // must transition the user to where the flow lives — the connect UI renders at
  // z-20 while this menu is portaled at z-[60], so a control that only fires the
  // handler leaves the menu frozen over the flow it just started.
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [aztecSwitchOpen, setAztecSwitchOpen] = useState(false)
  // #275: which wallet row was just copied (keyed by address) so the check +
  // "Copied" flip is scoped to the row the user acted on, not both rows.
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // #296: the dropdown is PORTALED to <body> so it escapes the Header's own
  // stacking context (Header sits at z-30 in ClientLayout, the binder tabs at
  // z-40 — a descendant of z-30 can never paint above z-40 no matter its local
  // z-index). Portaled + fixed + z-[60], it clears the tabs. mounted gates the
  // portal so document.body is only touched on the client.
  const [mounted, setMounted] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    // Click-outside must account for the portaled menu no longer living inside
    // rootRef — a click inside the menu is NOT "outside".
    function onClickOutside(e: MouseEvent) {
      const t = e.target as Node
      if (rootRef.current?.contains(t)) return
      if (menuRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  // Anchor the portaled dropdown just under the chip, pinned to its right edge,
  // and keep it there through scroll/resize. Viewport-aware: never let the right
  // gutter fall under 12px so it can't clip off-screen.
  useEffect(() => {
    if (!open) return
    const update = () => {
      const el = rootRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      setMenuPos({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right) })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  // #275: copies the FULL address (not the truncated label), flips to a check +
  // "Copied" for ~1.5s, keeping the dropdown open so the user can copy again.
  const handleCopy = async (addr?: string) => {
    if (!addr) return
    await copyToClipboard(addr)
    setCopiedKey(addr)
    setTimeout(() => setCopiedKey((k) => (k === addr ? null : k)), 1500)
  }

  // #335: single disconnect path reused by the header affordance and the bottom
  // menu item, so the fund-loss hard-lock (actionsLocked) is enforced once and
  // the handler logic is never duplicated.
  const handleDisconnect = () => {
    if (actionsLocked) return
    if (isAztecConnected) void disconnectAztecWallet()
    if (isWaapConnected) void disconnectWaapWallet()
    setOpen(false)
  }

  // #393: testnet-only "Clear app data" reset. Wipes this origin's local state
  // (storage + cookies), disconnects via the SAME handlers as the normal
  // Disconnect, then reloads so every in-memory store rebuilds from a clean
  // slate. Guarded by the SAME fund-loss hard-lock (actionsLocked) so a user
  // can never nuke local data mid-transfer. Never rendered on mainnet.
  const handleClearAppData = () => {
    if (actionsLocked) return
    if (typeof window === 'undefined') return
    const ok = window.confirm(
      'Clear all Shield app data on this device? This resets your local state (onboarding, cached balances, saved recovery data) and disconnects. Testnet only.',
    )
    if (!ok) return

    try {
      window.localStorage.clear()
      window.sessionStorage.clear()
    } catch {
      // storage may be unavailable (private mode / blocked) — best effort.
    }

    // Best-effort cookie clear for this origin: expire each cookie name.
    if (typeof document !== 'undefined') {
      try {
        for (const pair of document.cookie.split(';')) {
          const name = pair.split('=')[0]?.trim()
          if (name) {
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
          }
        }
      } catch {
        // ignore — cookie access can throw under some policies.
      }
    }

    if (isAztecConnected) void disconnectAztecWallet()
    if (isWaapConnected) void disconnectWaapWallet()
    setOpen(false)
    window.location.reload()
  }

  // ── State 1: nothing connected → a compact "Connect wallet" chip. ──
  if (!isWaapConnected && !isAztecConnected) {
    return (
      <button
        type="button"
        onClick={onConnectWallet}
        disabled={isL1Connecting}
        title={isL1Connecting ? 'Connecting…' : 'Connect wallet'}
        aria-label={isL1Connecting ? 'Connecting wallet' : 'Connect wallet'}
        className={`flex items-center justify-center gap-2 h-14 w-14 sm:w-auto px-0 sm:px-5 rounded-[20px] flex-shrink-0 ${
          isDark ? GLASS_PILL_DARK : GLASS_PILL
        } ${isL1Connecting ? 'opacity-60 cursor-not-allowed' : `${isDark ? GLASS_PILL_DARK_HOVER : GLASS_PILL_HOVER} cursor-pointer`}`}
      >
        <Icon icon="ph:wallet" width={16} height={16} className={`${accentPink(isDark)} flex-shrink-0`} />
        <span className={`hidden sm:inline text-xs sm:text-sm font-medium ${navText(isDark)} whitespace-nowrap`}>
          {isL1Connecting ? 'Connecting…' : 'Connect wallet'}
        </span>
      </button>
    )
  }

  const evmIcon = waapWalletIcon || EVM_WALLET_FALLBACK
  // The primary EVM wallet is an embedded WaaP/Silk wallet only for the WAAP
  // login method; an injected login (Rabby/MetaMask) keeps its real icon.
  const isWaapEmbedded = loginMethod === LOGIN_METHODS.WAAP
  const bothConnected = isWaapConnected && isAztecConnected

  const label = bothConnected ? 'Account' : waapAddress ? shortAddr(waapAddress) : 'Wallet'

  const EvmAvatar = (
    <span className="flex w-6 h-6 p-[2px] justify-center items-center rounded-full bg-[#FDE7F3] flex-shrink-0">
      <Image src={evmIcon} alt="" width={18} height={18} />
    </span>
  )
  // #333: the WALLETS-section row for the primary wallet shows the WaaP/Silk
  // brand mark when the login is the embedded WaaP wallet, so the row reads
  // clearly as a WaaP wallet instead of the generic/injected (Rabby) icon.
  const WaapRowAvatar = isWaapEmbedded ? (
    <span className="flex w-6 h-6 p-[2px] justify-center items-center rounded-full bg-[#FDE7F3] flex-shrink-0">
      <Image src={WAAP_WALLET_ICON} alt="" width={18} height={18} />
    </span>
  ) : (
    EvmAvatar
  )
  // The Aztec mark is a light-green diamond, invisible on the light-pink avatar
  // chip. Seat it on a small dark circular chip so it reads on the white/light
  // dropdown + nav surfaces. The mark fills the chip at 18px (matching the EVM
  // glyph beside it) with a small even inset, instead of a tiny dot in a big
  // empty circle. The aztec.svg carries its own viewBox padding, so 18px lands
  // the visible diamond with a balanced gutter inside the w-6 chip.
  const AztecAvatar = (
    <span className="inline-flex w-6 h-6 items-center justify-center rounded-full bg-[#0A0A0A] flex-shrink-0">
      <Image src={AZTEC_ICON} alt="" width={18} height={18} />
    </span>
  )

  return (
    <div className="relative flex-shrink-0" ref={rootRef}>
      {/* Skinny collapsed chip — a SINGLE row (stacked avatars + Account + verified
          + caret) at the uniform top-row height (h-14 / CHIP_H), never two stacked
          wallet rows. */}
      {/* One SOLID glass pill holding the primary account segment, the folded-in
          HUMN Points readout (#313) and the Connect-Aztec affordance. The
          secondary segments are TRANSPARENT and adjoined to the solid primary via
          a hairline divider (#302) — not separate floating pills. overflow-hidden
          keeps each segment's hover tint inside the pill's rounded corners. */}
      <div
        className={`flex items-center h-14 pl-2 pr-1 rounded-[20px] overflow-hidden max-w-[240px] sm:max-w-[360px] ${glassPill(isDark, open)}`}
      >
        {/* HUMN Points — folded into the account chip (#313) and pinned to the
            LEFT of the account, so the chip reads [points] then [account]. A
            TRANSPARENT segment adjoined to the primary via a hairline divider on
            its RIGHT edge. Gated on the connection/data state (#303): only
            rendered while the EVM wallet is connected and a real balance is
            present. Hidden below sm, where the row gets tight (matches the old
            standalone chip's breakpoint). The glyph slowly rotates via the
            ported `humn-points-spin` class (motion-reduce guarded in globals). */}
        {showPoints && (
          <span
            className={`hidden sm:flex items-center gap-1.5 flex-shrink-0 h-9 pl-1 pr-2.5 border-r ${
              isDark ? 'border-white/[0.14]' : 'border-black/[0.10]'
            }`}
            data-tooltip-id="humn-points-tooltip"
            data-tooltip-content="HUMN Points reward real, verified humans across human.tech."
            aria-label={`${points!.toLocaleString()} HUMN Points`}
          >
            <HumanPointsIcon className={`humn-points-spin w-4 h-4 ${navText(isDark)}`} />
            <span className={`text-xs font-semibold leading-none ${navText(isDark)}`}>{points!.toLocaleString()}</span>
          </span>
        )}

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="true"
          aria-expanded={open}
          className="flex items-center gap-1.5 min-w-0 pl-0.5 pr-1.5 py-1 cursor-pointer"
        >
          {/* Avatars: stacked (EVM + Aztec) when both are connected. */}
          <span className="flex items-center flex-shrink-0">
            {isWaapConnected && EvmAvatar}
            {bothConnected && <span className="-ml-2">{AztecAvatar}</span>}
            {!isWaapConnected && isAztecConnected && AztecAvatar}
          </span>
          <span className={`text-xs font-medium truncate ${navText(isDark)}`} title={waapAddress || ''}>
            {label}
          </span>
          {/* #441: the pill ALWAYS communicates verification status. A pink seal
              when personhood is verified, a muted outline seal when connected but
              not yet verified — each with a hover explainer. Same 15px glyph slot
              either way so the pill layout never shifts. */}
          {isWaapConnected &&
            (l1PersonhoodVerified ? (
              <span
                data-tooltip-id="seal-status-tooltip"
                data-tooltip-content={
                  l1IsPoch ? 'Personhood verified via Proof of Clean Hands' : 'Personhood verified via Human Passport'
                }
                className="inline-flex flex-shrink-0"
              >
                <Icon
                  icon="ph:seal-check-fill"
                  width={15}
                  height={15}
                  className={accentPink(isDark)}
                  aria-label="Personhood verified"
                />
              </span>
            ) : (
              <span
                data-tooltip-id="seal-status-tooltip"
                data-tooltip-content="Not verified. Complete verification to bridge above the limit."
                className="inline-flex flex-shrink-0"
              >
                <Icon
                  icon="ph:seal-warning"
                  width={15}
                  height={15}
                  className={mutedIconText(isDark)}
                  aria-label="Not verified"
                />
              </span>
            ))}
          <Icon
            icon="ph:caret-down"
            width={12}
            height={12}
            className={`flex-shrink-0 ${mutedIconText(isDark)} transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {/* EVM connected, Aztec NOT → inline Connect Aztec affordance (#302):
            a TRANSPARENT secondary segment adjoined to the solid primary via the
            same hairline divider, NOT a filled floating pill. Accent-coloured
            label + hover tint keep it reading as active; only faded +
            cursor-not-allowed while actually connecting. */}
        {isWaapConnected && !isAztecConnected && (
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onConnectAztec()
            }}
            disabled={isL2Connecting}
            title="Connect Aztec wallet"
            className={`flex items-center gap-1 flex-shrink-0 h-9 pl-2.5 pr-2 border-l text-[11px] font-medium ${
              isDark ? 'border-white/[0.14]' : 'border-black/[0.10]'
            } ${
              isL2Connecting ? 'opacity-40 cursor-not-allowed' : `cursor-pointer ${hoverTint(isDark)}`
            } ${accentPink(isDark)}`}
          >
            <Image src={AZTEC_ICON} alt="" width={13} height={13} className="flex-shrink-0" />
            <span className="hidden sm:inline whitespace-nowrap">{isL2Connecting ? '…' : 'Connect Aztec'}</span>
          </button>
        )}
      </div>

      {open && mounted && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
          className={`z-[60] w-[290px] max-w-[calc(100vw-1.5rem)] max-h-[min(72vh,560px)] overflow-y-auto rounded-[16px] shadow-lg py-2 flex flex-col ${panelSurface(isDark)} ${navText(isDark)}`}
        >
          {/* #282: the binding-conflict notice is a STATIC banner at the top of the
              dropdown, above the account list — so it can never float over and
              block the Switch / account-selection rows. */}
          {conflictNotice && (
            <div
              role="alert"
              className={`mx-2 mb-1 rounded-xl p-2.5 flex items-start gap-2 border-l-2 ${
                conflictSevere ? 'border-l-[#E3357E]' : 'border-l-[#FA8FC4]'
              } ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.03]'}`}
            >
              <Icon icon="ph:warning-circle" width={15} height={15} className={`mt-[1px] flex-shrink-0 ${accentPink(isDark)}`} />
              <div className="flex flex-col gap-1.5 min-w-0">
                <p className={`text-[12px] leading-snug ${navText(isDark)}`}>{conflictNotice}</p>
                {/* #304: when the bound target is one of the connected Azguard
                    accounts, name it and offer a one-tap switch — never a generic
                    prompt that implies the user has already moved. */}
                {linkedAccount && aztecAddress && linkedAccount.address.toLowerCase() !== aztecAddress.toLowerCase() && (
                  <button
                    type="button"
                    onClick={() => {
                      switchAztecAccount(linkedAccount)
                      setAztecSwitchOpen(false)
                    }}
                    title="Switch to your linked Aztec account"
                    className={`self-start flex items-center gap-1 px-2 py-1 rounded-full text-[12px] font-medium border ${
                      isDark
                        ? 'border-[#FA8FC4]/[0.30] hover:bg-[#FA8FC4]/[0.14]'
                        : 'border-[#81133B]/[0.25] hover:bg-[#FA8FC4]/[0.16]'
                    } ${accentPink(isDark)}`}
                  >
                    <Icon icon="ph:arrows-left-right" width={13} height={13} className="flex-shrink-0" />
                    Switch to {shortAddr(linkedAccount.address)}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* ── Wallets ── */}
          {/* #335: Disconnect was buried at the very bottom of the dropdown. A
              small, secondary Disconnect affordance is surfaced here on the
              Wallets header too (a fresh user's first eye-line), reusing the same
              handler + the same fund-loss hard-lock as the bottom item. */}
          <div className="flex items-center justify-between pr-2">
            <SectionLabel isDark={isDark}>Wallets</SectionLabel>
            <button
              type="button"
              disabled={actionsLocked}
              title={actionsLocked ? 'Locked during transfer to protect your funds.' : 'Disconnect'}
              onClick={handleDisconnect}
              className={`flex items-center gap-1 flex-shrink-0 px-2 py-1 rounded-full text-[12px] font-medium ${
                actionsLocked ? 'opacity-40 cursor-not-allowed' : `cursor-pointer ${hoverTint(isDark)}`
              } ${isDark ? 'text-[#FF6B6B]' : 'text-red'}`}
            >
              <Icon icon="ph:sign-out" width={13} height={13} />
              Disconnect
            </button>
          </div>

          {/* #438: wrap the two stacked wallet rows (EVM top, linked Aztec bottom)
              so an ABSOLUTE overlay can position over them. `relative` adds no
              layout box; the connector below takes no space, so the dropdown's
              width/height is unchanged. This wrapper must hold ONLY the two rows:
              the connector's vertical geometry is expressed as PERCENTAGES of it,
              which is what keeps it aligned without hardcoded row metrics (the
              Azguard account list therefore renders after the wrapper, not in it). */}
          <div className="relative">
            {/* #438: connector tying the EVM wallet to its linked Aztec account.
                Absolutely positioned → NO added height/width. Shown only when BOTH
                wallets are connected AND the connected Aztec account is the
                server-bound pair.

                Vertical: the two rows are equal height, so the avatar centers sit
                at 25% / 75% of this wrapper and their midpoint at 50%. Percentages
                rather than px because row height is type-driven — this Tailwind
                config declares no paired line-heights, so two 12px lines make a
                ~41px row, not the 36px the spacing scale implies.
                Horizontal: avatars are w-6 (24px) after px-4 (16px) pad, so the
                avatar center is 16 + 12 = 28px from the row's left edge.
                Maroon on light, pink accent on dark. */}
            {isWaapConnected && isAztecConnected && aztecConnectorLinked && (
              // The connector IS the indicator — no node, no glyph. The hover target is
              // this wrapper, sized to the EXPOSED span of track: the line runs avatar
              // center to avatar center, but each w-6 avatar paints over 12px of it, so
              // only the gap between them can be hovered. Insetting the wrapper by that
              // 12px keeps it clear of both wallet rows, which own their own hover (the
              // group-hover copy control) and must not lose it to an overlay.
              <span
                data-tooltip-id="wallet-link-tooltip"
                data-tooltip-content="This Aztec account is linked to your EVM wallet."
                tabIndex={0}
                role="img"
                aria-label="Linked to your EVM wallet"
                className={`absolute left-[20px] top-[calc(25%_+_12px)] bottom-[calc(25%_+_12px)] w-4 rounded-full outline-none focus-visible:ring-2 ${
                  isDark ? 'focus-visible:ring-[#FA8FC4]' : 'focus-visible:ring-[#81133B]'
                }`}
              >
                {/* Vertical line, avatar center to avatar center: the wrapper's own 12px
                    insets, given back. Glows in place rather than travelling — a moving
                    charge would spend most of its run hidden behind the avatars. */}
                <span
                  aria-hidden="true"
                  style={{ '--wallet-link-color': isDark ? '#FA8FC4' : '#81133B' } as React.CSSProperties}
                  className="wallet-link-glow pointer-events-none absolute bottom-[-12px] left-1/2 top-[-12px] w-0.5 -translate-x-1/2 rounded-full"
                />
              </span>
            )}

          {isWaapConnected && (
            // #333: this is the embedded WaaP (email) wallet. It PRIMARILY shows
            // the address for now; hover reveals the copy control (WalletRow's
            // group-hover pattern). The friendlier WaaP email/username is NOT in
            // walletStore state — the only source is the async provider method
            // window.waap.requestEmail() (SilkEthereumProviderInterface), which
            // isn't surfaced into the store, so it can't be read here without new
            // store plumbing (out of scope for this component-only change).
            // TODO(#333): show WaaP email/username as primary (hover -> address +
            // copy) once the store exposes it, e.g. a `waapEmail` field populated
            // from `window.waap.requestEmail()` at connect time.
            <WalletRow
              isDark={isDark}
              avatar={WaapRowAvatar}
              networkIcon={EVM_NETWORK_ICON}
              primary={waapAddress ? shortAddr(waapAddress) : 'EVM wallet'}
              secondary={l1NativeBalance ? `${l1NativeBalance} ETH` : 'Ethereum'}
              fullAddress={waapAddress || undefined}
              copied={!!waapAddress && copiedKey === waapAddress}
              onCopy={() => handleCopy(waapAddress || undefined)}
              // #335: re-calling window.waap.login() only re-selects an account
              // for an INJECTED login (it re-requests wallet permissions). For the
              // embedded WaaP wallet the SDK exposes NO account-switcher (only
              // login/logout/getLoginMethod), and login() is a no-op once a
              // session exists — that made "Switch" a dead button. So Switch is
              // shown only for injected logins; embedded-wallet account switching
              // lives inside the WaaP wallet UI, reached via "Open Wallet" below.
              // TODO(#335): wire a real embedded account switch if the WaaP SDK
              // ever exposes one from current state.
              onSwitch={isWaapEmbedded ? undefined : onConnectWallet}
              switchTitle="Re-open the wallet login to switch EVM account"
              // #333: for the embedded WaaP login, "Open Wallet" is a small
              // secondary action tucked onto this row (beside Switch/Copy) —
              // not a full-width button that reads as a primary action.
              onOpenWallet={isWaapEmbedded ? () => window.open(silkUrl, '_blank', 'noopener,noreferrer') : undefined}
              openWalletTitle="Open your WaaP wallet"
            />
          )}

          {isAztecConnected && (
            <WalletRow
              isDark={isDark}
              avatar={AztecAvatar}
              primary={aztecAlias || (aztecAddress ? shortAddr(aztecAddress) : 'Aztec account')}
              secondary={aztecAddress ? shortAddr(aztecAddress) : 'Aztec'}
              fullAddress={aztecAddress || undefined}
              copied={!!aztecAddress && copiedKey === aztecAddress}
              onCopy={() => handleCopy(aztecAddress || undefined)}
              onSwitch={availableAccounts.length > 1 ? () => setAztecSwitchOpen((v) => !v) : undefined}
              switchTitle="Switch Azguard account"
              switchActive={aztecSwitchOpen}
              // #454: the per-row "Linked" badge is dropped here. The single
              // "Linked" indicator is now the avatar-column connector node drawn
              // above (between the EVM and Aztec rows) so the two can't collide.
            />
          )}
          </div>

          {/* Sits OUTSIDE the connector wrapper above: that wrapper's height must
              stay exactly the two wallet rows for the connector's percentage
              geometry to hold. Visually unchanged — it still renders directly
              under the Aztec row. */}
          {isAztecConnected && aztecSwitchOpen && availableAccounts.length > 1 && (
            <div className="px-2 pb-1">
              {availableAccounts.map((acc, i) => {
                const isCurrent = acc.address === aztecAddress
                // #284: mark the account the server disclosed as bound to the
                // connected EVM wallet, so the user can spot and pick it.
                const isLinked =
                  !!linkedAccountAddress && acc.address.toLowerCase() === linkedAccountAddress.toLowerCase()
                return (
                  <button
                    key={acc.address}
                    type="button"
                    onClick={() => {
                      if (!isCurrent) switchAztecAccount(acc)
                      setAztecSwitchOpen(false)
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors duration-150 ${
                      isCurrent ? 'cursor-default' : `${menuItemHover(isDark)} cursor-pointer`
                    }`}
                  >
                    <Icon
                      icon={isCurrent ? 'ph:check' : 'ph:wallet'}
                      width={15}
                      height={15}
                      className={isCurrent ? accentPink(isDark) : subtleText(isDark)}
                    />
                    <span className="flex flex-col min-w-0 flex-1">
                      <span className="text-xs truncate">{accountLabel(acc, i)}</span>
                      <span className={`text-[12px] ${mutedIconText(isDark)}`}>
                        {shortAddr(acc.address)}
                        {isCurrent ? ' · Current' : ''}
                      </span>
                    </span>
                    {isLinked && (
                      <span
                        className={`ml-auto flex items-center gap-1 text-[12px] font-medium whitespace-nowrap ${accentPink(isDark)}`}
                        title="Linked to your EVM wallet"
                      >
                        <Icon icon="ph:link-simple" width={13} height={13} className="flex-shrink-0" />
                        Linked
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {/* #290: EVM up, Aztec NOT connected → show the Aztec row grayed/muted
              (opacity-40 on the avatar + labels) rather than omitting it, with an
              ACTIVE "Connect" button (full opacity) wired to the Aztec-connect
              action so the next step is obvious. */}
          {isWaapConnected && !isAztecConnected && (
            <div className="flex items-center gap-2 px-4 py-1.5">
              <span className="flex items-center gap-2 min-w-0 flex-1 opacity-40 select-none">
                <span className="flex-shrink-0">{AztecAvatar}</span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className={`text-xs font-medium truncate ${navText(isDark)}`}>Aztec account</span>
                  <span className={`text-[12px] ${subtleText(isDark)} truncate`}>Not connected</span>
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onConnectAztec()
                }}
                disabled={isL2Connecting}
                title="Connect Aztec wallet"
                className={`flex items-center gap-1 flex-shrink-0 pl-1.5 pr-2 py-1 rounded-full text-[12px] font-medium border ${
                  isL2Connecting
                    ? 'opacity-40 cursor-not-allowed border-transparent'
                    : `cursor-pointer ${
                        isDark
                          ? 'bg-[#FA8FC4]/[0.14] border-[#FA8FC4]/[0.30] hover:bg-[#FA8FC4]/[0.22]'
                          : 'bg-[#FA8FC4]/[0.16] border-[#81133B]/[0.25] hover:bg-[#FA8FC4]/[0.26]'
                      }`
                } ${accentPink(isDark)}`}
              >
                <Image src={AZTEC_ICON} alt="" width={13} height={13} className="flex-shrink-0" />
                {isL2Connecting ? '…' : 'Connect'}
              </button>
            </div>
          )}

          {/* Link a New Wallet — DISABLED variant. Non-interactive (no onClick)
              until the WAAP wallet-linking flow ships; opacity-40 (opacity-40 is a
              no-op on this repo's sparse opacity scale) + muted + cursor-not-allowed
              + select-none make the "Coming soon" state read as intentionally inert. */}
          <div
            aria-disabled="true"
            className="flex items-center gap-2 mx-2 px-2 py-1.5 rounded-lg opacity-40 cursor-not-allowed select-none"
          >
            <Icon icon="ph:link" width={16} height={16} className={mutedIconText(isDark)} />
            <span className={`text-xs font-medium ${mutedIconText(isDark)}`}>Link a New Wallet</span>
            <span className={`ml-auto text-[12px] px-1.5 py-0.5 rounded-full ${trackBg(isDark)} ${subtleText(isDark)}`}>
              Coming soon
            </span>
          </div>

          <Divider isDark={isDark} />

          {/* ── Identity & proofs ── */}
          <SectionLabel isDark={isDark}>Identity &amp; proofs</SectionLabel>

          {/* #291: the SCORE comes from useL1Humanity (same as the nav), so it
              can never contradict the nav's humanity chip. A real score is shown
              as a bare number — never a bald "Not verified" alongside one. */}
          <ProofRow
            isDark={isDark}
            icon="ph:identification-card"
            title="Passport"
            caption={`Required · ${TRAVEL_RULE_LABEL} per human`}
            status={
              l1Fetching
                ? 'Checking…'
                : l1HasScore
                  ? `${l1Score}`
                  : l1IsPoch
                    ? 'Covered by Clean Hands'
                    : 'Not verified'
            }
            good={l1ScorePasses || l1IsPoch}
            infoId="passport-info-tooltip"
            infoContent={`Your Human Passport score. It measures unique humanity from the stamps you have collected. Bridge unlocks at ${
              typeof l1Threshold === 'number' ? `a score of ${l1Threshold}+` : 'the threshold'
            }.`}
          />
          <ProofRow
            isDark={isDark}
            icon="ph:hand-soap"
            title="Clean Hands SBT"
            caption={`Transfer $${Number(BRIDGE_MAX_DEPOSIT_USD).toLocaleString('en-US')}/day`}
            status={l1Fetching ? 'Checking…' : l1IsPoch ? 'Verified' : 'Not held'}
            good={l1IsPoch}
          />
          {/* HUMN Points readout (#427). The number beside Passport above is the
              humanity SCORE, not points — users conflate the two, and the nav
              points chip hides at 0, so a user with none has nowhere to look. This
              row is the authoritative points answer: labelled, always shown while
              the wallet is connected, and it shows a real 0 rather than vanishing.
              Uses the HUMN Points glyph (not a ph: icon) so it can't be mistaken
              for a credential row. */}
          {HUMN_POINTS_LIVE && isWaapConnected && (
            <div className="flex items-center gap-2 px-4 py-1.5">
              <HumanPointsIcon
                className={`w-4 h-4 ${hasPoints ? accentPink(isDark) : mutedIconText(isDark)}`}
              />
              <span className="flex flex-col min-w-0 flex-1">
                <span className={`text-xs font-medium ${navText(isDark)}`}>HUMN Points</span>
                <span className={`text-[12px] ${subtleText(isDark)}`}>Rewards for verified humans</span>
              </span>
              <span
                className={`flex-shrink-0 text-[12px] font-semibold ${
                  hasPoints ? accentPink(isDark) : subtleText(isDark)
                }`}
              >
                {typeof points === 'number' ? points.toLocaleString() : '—'}
              </span>
            </div>
          )}
          {/* Contextual next step (driven by the SAME L1 humanity result as the
              face, so it stays consistent):
                - real humanity but the authed Shield attestation is incomplete
                  (no session / not attested) → a subtle "Complete verification"
                  nudge (never a bald "Not verified" beside a real score);
                - Passport tier, no Clean Hands → Upgrade to Clean Hands;
                - no proof yet → Get verified;
                - already Clean Hands → hidden. */}
          {!l1IsPoch &&
            (l1BelowThreshold ? (
              // #434: has a score but BELOW the passing threshold — the honest next
              // step is to RAISE it (add stamps on Passport), not "complete
              // verification" (implies done) or "upgrade to Clean Hands" (implies
              // they passed the lower tier). External, closes the dropdown on click.
              <a
                href={PASSPORT_BUILD_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2 mx-2 px-2 py-1.5 rounded-lg ${menuItemHover(isDark)} cursor-pointer transition-colors duration-150`}
              >
                <Icon icon="ph:plus-circle" width={16} height={16} className={accentPink(isDark)} />
                <span className={`text-xs font-medium ${navText(isDark)}`}>Raise your Passport score</span>
              </a>
            ) : l1ScorePasses && !attVerified ? (
              // #349: the wallet holds a PASSING L1 proof but the authed Shield
              // attestation is incomplete — the missing step is the IN-APP humanity
              // re-check (VerificationStep, surfaced on the bridge page), NOT an
              // external passport rebuild. Route into the app's verify flow and
              // close the dropdown so it can never sit frozen over the page.
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  router.push('/?verify=1')
                }}
                className={`flex items-center gap-2 mx-2 px-2 py-1.5 rounded-lg ${menuItemHover(isDark)} cursor-pointer transition-colors duration-150`}
              >
                <Icon icon="ph:plus-circle" width={16} height={16} className={accentPink(isDark)} />
                <span className={`text-xs font-medium ${navText(isDark)}`}>Complete verification</span>
              </button>
            ) : (
              // A passing (attested) Passport → upgrade to Clean Hands; no proof yet
              // → get verified. Both are external steps; close the dropdown on click.
              <a
                href={l1ScorePasses ? POCH_MINT_URL : PASSPORT_BUILD_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2 mx-2 px-2 py-1.5 rounded-lg ${menuItemHover(isDark)} cursor-pointer transition-colors duration-150`}
              >
                <Icon icon="ph:plus-circle" width={16} height={16} className={accentPink(isDark)} />
                <span className={`text-xs font-medium ${navText(isDark)}`}>
                  {l1ScorePasses ? 'Upgrade to Clean Hands' : 'Get verified'}
                </span>
              </a>
            ))}

          <Divider isDark={isDark} />

          {/* ── Limits & usage ── */}
          <SectionLabel isDark={isDark}>
            <span className="inline-flex items-center gap-1.5">
              <Icon icon="ph:gauge" width={13} height={13} className={mutedIconText(isDark)} />
              Limits &amp; usage
            </span>
          </SectionLabel>

          <div className="px-4 py-1 flex flex-col gap-2.5">
            {/* #306: ONE bar reflecting the user's CURRENT proof tier — Clean
                Hands shows the daily deposit cap, a passing Passport shows the
                lifetime Travel-Rule limit, and only a genuinely unverified wallet
                is prompted to verify. Real remaining usage (and its fill %) is
                shown when the authed attestation supplies it; otherwise the tier
                ceiling is shown as a striped estimate — never a bare "Verify to
                see limits" for a wallet that clearly holds a proof. */}
            <LimitBar
              isDark={isDark}
              label={tierLimitLabel}
              info={tierLimitInfo}
              valueText={tierLimitValue}
              pct={tierLimitPct}
              placeholder={tierLimitPlaceholder}
              tint={tierLimitTint}
            />
            {typeof reservedDepositUsd === 'number' && reservedDepositUsd > 0 && (
              <LimitBar
                isDark={isDark}
                label="On hold (pending)"
                valueText={`$${reservedDepositUsd.toLocaleString()}`}
                pct={undefined}
                placeholder
                tint="amber"
              />
            )}
          </div>

          {/* ── Clear app data (#393) — TESTNET ONLY. The normal Disconnect
              lives on the Wallets-section header above; this bottom slot is a
              destructive testing reset that wipes local state and reloads. It
              never renders on mainnet, and it honours the SAME fund-loss
              hard-lock (actionsLocked) as Disconnect. */}
          {!IS_MAINNET && (
            <>
              <Divider isDark={isDark} />
              <button
                type="button"
                disabled={actionsLocked}
                title={
                  actionsLocked
                    ? 'Locked during transfer to protect your funds.'
                    : 'Wipe local app data on this device and reload (testnet only).'
                }
                onClick={handleClearAppData}
                className={`flex items-center gap-2 mx-2 px-2 py-2 rounded-lg transition-colors duration-150 ${
                  actionsLocked
                    ? 'opacity-40 cursor-not-allowed'
                    : `${menuItemHover(isDark)} cursor-pointer`
                } ${isDark ? 'text-[#FF6B6B]' : 'text-red'}`}
              >
                <Icon icon="ph:trash" width={18} height={18} />
                <span className="text-sm">Clear app data</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {/* #456: every dropdown tooltip must paint ABOVE the portaled z-[60] menu.
          zIndex: 9999 alone was NOT enough: react-tooltip v5 renders its floating
          element inline where <ReactTooltip> sits in the tree, so these instances
          were trapped inside the Header's low (z-30) stacking context and lost to
          the menu that portals to <body> at z-[60] — a descendant's z-index can't
          beat an ancestor stacking context. Fix: portal the tooltips to <body>
          ourselves so they become siblings of the menu portal; at body level the
          raw z-index wins (9999 > 60). react-tooltip still finds its anchors by
          data-tooltip-id globally, so its DOM location doesn't matter. */}
      {mounted &&
        createPortal(
          <>
            {/* Tooltip explaining the HUMN Points readout. */}
            <ReactTooltip
              id="humn-points-tooltip"
              place="bottom"
              className="max-w-[220px]"
              style={{ fontSize: '12px', padding: '4px 8px', zIndex: 9999 }}
            />

            {/* Explainer for the lifetime bridge-in cap in LIMITS & USAGE (#372). */}
            <ReactTooltip
              id="limit-info-tooltip"
              place="top"
              className="max-w-[240px]"
              style={{ fontSize: '12px', padding: '6px 8px', lineHeight: '1.35', zIndex: 9999 }}
            />

            {/* #441: personhood seal state (verified vs not), anchored in the pill. */}
            <ReactTooltip
              id="seal-status-tooltip"
              place="bottom"
              className="max-w-[220px]"
              style={{ fontSize: '12px', padding: '6px 8px', lineHeight: '1.35', zIndex: 9999 }}
            />

            {/* The link node between the EVM and Aztec wallet rows: it carries no
                text, so the tooltip is the only place the word "Linked" appears
                on that connector. */}
            <ReactTooltip
              id="wallet-link-tooltip"
              // The node sits at the menu's left edge, so `left` opens into the
              // space outside the menu instead of covering the wallet rows;
              // floating-ui flips it when a narrow viewport leaves no room.
              place="left"
              className="max-w-[200px]"
              style={{ fontSize: '12px', padding: '6px 8px', lineHeight: '1.35', zIndex: 9999 }}
            />

            {/* #440: explainer for the Human Passport SCORE on the Passport row. */}
            <ReactTooltip
              id="passport-info-tooltip"
              place="top"
              className="max-w-[240px]"
              style={{ fontSize: '12px', padding: '6px 8px', lineHeight: '1.35', zIndex: 9999 }}
            />
          </>,
          document.body,
        )}
    </div>
  )
}

// ─── Small presentational building blocks (mirror the DS AccountDrawer
// section / row structure, in Shield's Tailwind + Phosphor stack) ────

const SectionLabel: React.FC<{ isDark: boolean; children: React.ReactNode }> = ({ isDark, children }) => (
  <div className={`px-4 pt-1 pb-1 text-[12px] font-semibold uppercase tracking-wide ${mutedIconText(isDark)}`}>
    {children}
  </div>
)

const Divider: React.FC<{ isDark: boolean }> = ({ isDark }) => (
  <div className={`border-t ${panelDivider(isDark)} my-1.5`} />
)

const WalletRow: React.FC<{
  isDark: boolean
  avatar: React.ReactNode
  networkIcon?: string
  primary: string
  secondary: string
  /** Full address to copy on hover (#275). */
  fullAddress?: string
  copied?: boolean
  onCopy?: () => void
  onSwitch?: () => void
  switchTitle?: string
  switchActive?: boolean
  /** #333: small secondary "Open Wallet" action tucked beside Switch/Copy. */
  onOpenWallet?: () => void
  openWalletTitle?: string
  /** #297a: show a "Linked" badge — set ONLY for the server-bound account. */
  linked?: boolean
}> = ({ isDark, avatar, networkIcon, primary, secondary, fullAddress, copied, onCopy, onSwitch, switchTitle, switchActive, onOpenWallet, openWalletTitle, linked }) => (
  // #275: `group` lets hover/focus reveal the copy control. This is a div (not a
  // button) so the copy/switch buttons aren't nested inside a button.
  <div className="group flex items-center gap-2 px-4 py-1.5">
    <span className="relative flex-shrink-0">
      {avatar}
      {networkIcon && (
        <Image
          src={networkIcon}
          alt=""
          width={12}
          height={12}
          className="absolute -bottom-0.5 -right-0.5 rounded-full"
        />
      )}
    </span>
    <span className="flex flex-col min-w-0 flex-1">
      <span className={`text-xs font-medium truncate ${navText(isDark)}`}>{primary}</span>
      <span className={`text-[12px] ${subtleText(isDark)} truncate`}>{secondary}</span>
    </span>
    {linked && (
      <span
        className={`flex items-center gap-1 flex-shrink-0 text-[12px] font-medium whitespace-nowrap ${accentPink(isDark)}`}
        title="Linked to your EVM wallet"
      >
        <Icon icon="ph:link-simple" width={13} height={13} className="flex-shrink-0" />
        Linked
      </span>
    )}
    {fullAddress && onCopy && (
      <button
        type="button"
        onClick={onCopy}
        title="Copy address"
        aria-label="Copy full address"
        className={`flex items-center gap-1 flex-shrink-0 px-1.5 py-1 rounded-full text-[12px] font-medium opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity duration-150 ${hoverTint(isDark)} ${
          copied ? accentPink(isDark) : subtleText(isDark)
        }`}
      >
        <Icon icon={copied ? 'ph:check' : 'ph:copy'} width={14} height={14} />
        {copied && <span>Copied</span>}
      </button>
    )}
    {onSwitch && (
      <button
        type="button"
        onClick={onSwitch}
        title={switchTitle}
        className={`flex items-center gap-1 flex-shrink-0 px-2 py-1 rounded-full text-[12px] font-medium ${hoverTint(isDark)} ${
          switchActive ? accentPink(isDark) : subtleText(isDark)
        }`}
      >
        <Icon icon="ph:arrows-left-right" width={13} height={13} />
        Switch
      </button>
    )}
    {onOpenWallet && (
      // #333: Open Wallet as a small secondary text/icon action on the row —
      // same secondary weight as Switch, never a full-width primary button.
      <button
        type="button"
        onClick={onOpenWallet}
        title={openWalletTitle}
        className={`flex items-center gap-1 flex-shrink-0 px-2 py-1 rounded-full text-[12px] font-medium ${hoverTint(isDark)} ${subtleText(isDark)}`}
      >
        <Icon icon="majesticons:open" width={13} height={13} />
        Open
      </button>
    )}
  </div>
)

const ProofRow: React.FC<{
  isDark: boolean
  icon: string
  title: string
  caption: string
  status: string
  good: boolean
  /** #440: optional (i) hover explainer for the status/value (SOP §7). */
  infoId?: string
  infoContent?: string
}> = ({ isDark, icon, title, caption, status, good, infoId, infoContent }) => (
  <div className="flex items-center gap-2 px-4 py-1.5">
    <Icon icon={icon} width={16} height={16} className={`flex-shrink-0 ${good ? accentPink(isDark) : mutedIconText(isDark)}`} />
    <span className="flex flex-col min-w-0 flex-1">
      <span className={`text-xs font-medium truncate ${navText(isDark)}`}>{title}</span>
      <span className={`text-[12px] truncate ${subtleText(isDark)}`}>{caption}</span>
    </span>
    {infoId && infoContent && (
      <span
        data-tooltip-id={infoId}
        data-tooltip-content={infoContent}
        tabIndex={0}
        role="img"
        aria-label={infoContent}
        className={`inline-flex flex-shrink-0 cursor-help ${mutedIconText(isDark)}`}
      >
        <Icon icon="ph:info" width={13} height={13} />
      </span>
    )}
    <span
      className={`flex items-center gap-1 flex-shrink-0 whitespace-nowrap text-[12px] font-medium ${
        good ? accentPink(isDark) : subtleText(isDark)
      }`}
    >
      {good && <Icon icon="ph:seal-check-fill" width={13} height={13} className="flex-shrink-0" />}
      {status}
    </span>
  </div>
)

const LimitBar: React.FC<{
  isDark: boolean
  label: string
  valueText: string
  pct?: number
  /** True when the bar is an unknown-ratio placeholder (no total exposed). */
  placeholder?: boolean
  tint: 'maroon' | 'amber' | 'navy'
  /** Optional (i) hover explainer surfaced beside the label (SOP §7). */
  info?: string
}> = ({ isDark, label, valueText, pct, placeholder, tint, info }) => {
  const fillColor =
    tint === 'maroon'
      ? isDark
        ? 'bg-[#FA8FC4]'
        : 'bg-[#81133B]'
      : tint === 'amber'
        ? 'bg-[#F79009]'
        : isDark
          ? 'bg-white/[0.40]'
          : 'bg-[#17235E]'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 min-w-0">
          <span className={`text-[12px] ${subtleText(isDark)} truncate`}>{label}</span>
          {info && (
            <span
              data-tooltip-id="limit-info-tooltip"
              data-tooltip-content={info}
              tabIndex={0}
              role="img"
              aria-label={info}
              className={`inline-flex flex-shrink-0 cursor-help ${mutedIconText(isDark)}`}
            >
              <Icon icon="ph:info" width={13} height={13} />
            </span>
          )}
        </span>
        <span className={`text-[12px] font-medium ${navText(isDark)} flex-shrink-0`}>{valueText}</span>
      </div>
      <div className={`w-full h-1.5 rounded-full overflow-hidden ${trackBg(isDark)}`}>
        {typeof pct === 'number' ? (
          <div className={`h-full rounded-full ${fillColor}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
        ) : placeholder ? (
          // Unknown ratio (no cap total client-side): a striped placeholder
          // track so the value above reads as real while the bar is clearly
          // an estimate, not a fabricated fill level.
          <div
            className="h-full w-full opacity-60"
            style={{
              backgroundImage:
                'repeating-linear-gradient(45deg, rgba(129,19,59,0.35) 0, rgba(129,19,59,0.35) 4px, transparent 4px, transparent 8px)',
            }}
          />
        ) : null}
      </div>
    </div>
  )
}

export default AccountChip
