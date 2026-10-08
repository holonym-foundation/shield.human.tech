'use client'

import { Icon, loadIcons } from '@iconify/react'
import { useToast } from '@/hooks/useToast'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useL1TokenBalances } from '@/hooks/useL1Operations'
import Image from 'next/image'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { L1_CHAIN_ID, POCH_MINT_URL, publicAsset } from '@/config'
import { useAttestationCheck } from '@/hooks/useAttestationCheck'
import { useHumnPoints } from '@/hooks/useHumnPoints'
import AccountChip from '@/components/AccountChip'
import DeploymentSelector from '@/components/DeploymentSelector'
import { useExplainerStore } from '@/stores/useExplainerStore'
import { useOnboardingStore } from '@/stores/useOnboardingStore'
import {
  useBindingStatus,
  useSessionLinkedL2,
  describeConflict,
  conflictMessage,
  disclosedLinkedL2,
  shortAddr,
} from '@/hooks/useBindingStatus'

/** Delay before auto-starting Aztec wallet discovery after WaaP connects. */
const AZTEC_AUTO_CONNECT_DELAY_MS = 2000

// Preload the icons used inside the wallet dropdown and the mobile nav toggle
// so they're cached in iconify's store before those elements first render.
// Module-level + window-guard so it runs once per page in the browser only.
if (typeof window !== 'undefined') {
  loadIcons([
    'ph:copy',
    'majesticons:open',
    'ph:wallet',
    'ph:wallet-fill',
    'ph:sign-out',
    'ph:question',
    'ph:caret-down',
    'ph:list',
    'ph:x',
    'ph:book-open',
    'ph:gas-pump',
    'ph:globe-hemisphere-west',
    'ph:link-simple',
    'ph:check',
    'ph:warning-circle',
    'ph:info',
    'ph:hand-soap',
    'ph:identification-card',
    'ph:plus-circle',
    'ph:gauge',
    'ph:seal-check-fill',
    'ph:link',
  ])
}

/**
 * Floating "glass pill" material merged in from the design-system SiteTopBar
 * (human-tech-design-system/src/SiteTopBar: translucent white, blurred,
 * soft border, layered shadow, brightens on hover). Reproduced as Tailwind
 * classes rather than imported — this app is Tailwind-only and the design
 * system component ships CSS modules, so the look is ported, not the code.
 */
const GLASS_PILL =
  'backdrop-blur-md bg-white/[0.85] border border-[#E5E5E5]/80 shadow-[0_6px_18px_-6px_rgba(15,15,15,0.18),0_1px_2px_rgba(0,0,0,0.04)] transition-all duration-200'
const GLASS_PILL_HOVER = 'hover:bg-white hover:shadow-[0_10px_24px_-8px_rgba(15,15,15,0.24),0_1px_2px_rgba(0,0,0,0.04)]'
const GLASS_PILL_ACTIVE = 'bg-white shadow-[0_10px_24px_-8px_rgba(15,15,15,0.24),0_1px_2px_rgba(0,0,0,0.04)]'

/**
 * Dark-mode counterparts of the glass pill, used when Privacy Mode is on and
 * the page drops to the deep-maroon background (see ClientLayout's
 * `showPrivacyBackground` overlay, rgba(31,8,22,0.66)). Same frosted-glass
 * material — translucent + blurred + bordered — just re-tuned so it reads as
 * "dark glass" instead of a light pill floating on a dark field: a faint
 * white wash instead of near-opaque white, and shadows built from black
 * instead of the light pill's soft warm-grey.
 */
const GLASS_PILL_DARK =
  'backdrop-blur-md bg-white/[0.07] border border-white/[0.14] shadow-[0_6px_18px_-6px_rgba(0,0,0,0.55),0_1px_2px_rgba(0,0,0,0.35)] transition-all duration-200'
const GLASS_PILL_DARK_HOVER =
  'hover:bg-white/[0.12] hover:border-white/[0.22] hover:shadow-[0_10px_24px_-8px_rgba(0,0,0,0.6),0_1px_2px_rgba(0,0,0,0.35)]'
const GLASS_PILL_DARK_ACTIVE =
  'bg-white/[0.14] border-white/[0.22] shadow-[0_10px_24px_-8px_rgba(0,0,0,0.6),0_1px_2px_rgba(0,0,0,0.35)]'

/** Merges the base/hover/active glass-pill classes for the given theme in one call. */
function glassPill(isDark: boolean, active = false): string {
  if (isDark) return `${GLASS_PILL_DARK} ${GLASS_PILL_DARK_HOVER} ${active ? GLASS_PILL_DARK_ACTIVE : ''}`
  return `${GLASS_PILL} ${GLASS_PILL_HOVER} ${active ? GLASS_PILL_ACTIVE : ''}`
}

/**
 * One shared fixed height for every chip in the top nav row — the Shield brand
 * chip, the center pill (Privacy Mode + nav links), and the account chip.
 * Keeping it a single token is what makes the row read as a clean line of
 * uniform chips: inner contents scale to fit this height rather than each chip's
 * content dictating its own height. The version chip lives BELOW the Shield chip
 * (its own left-column chip), outside this row, so it is deliberately NOT bound
 * to this height. The skinny account chip owns this same height itself (h-14) as
 * a single collapsed row, so it lines up with the rest of the row without Header
 * having to wrap it in a height container.
 */
const CHIP_H = 'h-14'

/** Nav/body text — navy on light, near-white on the dark privacy background. */
function navText(isDark: boolean): string {
  return isDark ? 'text-white/[0.90]' : 'text-[#17235E]'
}
// NOTE: every white/black-alpha class in this file below uses the bracket
// form (e.g. `text-white/[0.60]`), never the bare `text-white/60` shorthand.
// tailwind.config.js overrides the `opacity` theme scale to a sparse set
// ({0,20,40,60,80,100}) for the standalone `opacity-*` utility, and that
// same scale gates the color-alpha shorthand — any `/<n>` not in that set
// silently compiles to *no rule at all*, so the element falls back to an
// inherited color (black text, opaque backgrounds) instead of erroring.
// Bracket values bypass the scale entirely and always compile.

/**
 * Muted icon/caret/label tone (was text-gray-400). Still legibly readable
 * against the dark-maroon surface — white/60, not a washed-out low-contrast
 * grey — reserved for secondary labels, not decorative/disabled affordances.
 */
function mutedIconText(isDark: boolean): string {
  return isDark ? 'text-white/[0.60]' : 'text-gray-400'
}
/** Row hover tint inside the flat (borderless) wallet-cluster rows. */
function hoverTint(isDark: boolean): string {
  return isDark ? 'hover:bg-white/[0.10]' : 'hover:bg-black/[0.04]'
}
/** Opaque-ish dropdown/panel surface — deliberately more solid than the nav pills so menu text stays legible over whatever's behind it. */
function panelSurface(isDark: boolean): string {
  return isDark
    ? 'bg-[#2A0E1C]/[0.95] backdrop-blur-md border border-white/[0.12]'
    : 'bg-white/[0.95] backdrop-blur-md border border-[#E5E5E5]/80'
}

// HUMN Points are sourced live from Human Passport (Season 1) via useHumnPoints
// (/api/points), keyed on the connected L1 address, and folded into the account
// chip. AccountChip hides the value when the wallet has none (or none loaded
// yet) — no placeholder is ever shown.

// Same copy the BridgeHeader guard uses — keep them identical so the warning
// reads the same whether it fires from the bridge header or the top nav.
const TRANSFER_LEAVE_CONFIRM =
  "Leave now? Your in-progress transfer's recovery data could be lost. Export a backup first."

interface HeaderProps {
  credentials?: React.ReactNode
}

/**
 * External ecosystem destinations shown in the "Ecosystem" nav dropdown. Kept
 * as a plain array so new entries are a one-line add (no JSX edits): drop in
 * another { label, href, icon } and it renders with the same row treatment. The
 * `icon` is a LOCAL asset path (the runtime CSP blocks remote images) holding
 * the destination's real brand logo; omit it and the row falls back to a neutral
 * glyph rather than a broken image.
 */
const ECOSYSTEM_LINKS: { label: string; href: string; icon?: string }[] = [
  { label: 'Azguard', href: 'https://azguardwallet.io', icon: publicAsset('/assets/svg/ecosystem/azguard.svg') },
  { label: 'Aztecscan', href: 'https://aztecscan.xyz', icon: publicAsset('/assets/svg/ecosystem/aztecscan.svg') },
  { label: 'Nyx', href: 'https://www.nyx.money', icon: publicAsset('/assets/svg/ecosystem/nyx.svg') },
]

/**
 * Dropdown surface for the Ecosystem menu — deliberately a byte-for-byte match
 * of the account dropdown's `panelSurface` (see AccountChip.tsx), so the two
 * menus read as ONE component we can later lift into a shared Storybook
 * dropdown. It is intentionally NOT the Header `panelSurface` above: that one is
 * shared with the mobile nav panel and sits at 0.95 opacity, whereas the account
 * dropdown (our reference chrome) sits at 0.97. Keeping this local keeps the two
 * consumers from drifting.
 */
function ecosystemPanelSurface(isDark: boolean): string {
  return isDark
    ? 'bg-[#2A0E1C]/[0.97] backdrop-blur-md border border-white/[0.12]'
    : 'bg-white/[0.97] backdrop-blur-md border border-[#E5E5E5]/80'
}

/**
 * "Ecosystem" nav item — a click-to-open dropdown of external ecosystem links.
 * Rendered inside the shared secondaryNav (desktop pill + mobile panel), so it
 * owns its own open/close state, click-outside, and Escape handling here rather
 * than in Header (secondaryNav is inline JSX and can't hold hooks). The TRIGGER
 * reuses the exact nav-link treatment of How it works / Docs / Fee Juice.
 *
 * The open PANEL is deliberately aligned to the account dropdown (AccountChip's
 * portaled menu) — the reference chrome for this app — rather than the mobile
 * nav panel: same surface (ecosystemPanelSurface == account panelSurface), the
 * same rounded-[16px] corner + shadow-lg, the same py-2 container with a top
 * SectionLabel, and menu-item rows (mx-2 px-2 py-1.5 rounded-lg, hoverTint,
 * text-xs font-medium) instead of full-round pills. Each row carries the
 * destination's real brand logo on a neutral tile at the left, its label, and
 * the external-link affordance at the right. The goal is a single coherent
 * dropdown look liftable into a shared Storybook component later.
 *
 * The panel is PORTALED to <body> (same reason as AccountChip #296): the desktop
 * nav that hosts this trigger is `overflow-hidden` (the §384 label-collapse
 * belt-and-suspenders), which clips any absolutely-positioned child — an
 * in-flow panel renders but is invisible. Portaled + fixed, it also escapes the
 * Header's z-30 stacking context. It is anchored just under the trigger's left
 * edge so it never overlaps the nav row.
 */
// The anchor math clamps against the panel's own width, so width and clamp must
// read from one source — a Tailwind w-[…] class would silently drift from it.
const ECOSYSTEM_PANEL_W = 240
const ECOSYSTEM_PANEL_GUTTER = 12

const EcosystemNav: React.FC<{ isDark: boolean; onNavigate?: () => void; showLabel?: boolean }> = ({
  isDark,
  onNavigate,
  showLabel = true,
}) => {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!open) return
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (containerRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const update = () => {
      const el = containerRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const maxLeft = window.innerWidth - ECOSYSTEM_PANEL_W - ECOSYSTEM_PANEL_GUTTER
      setMenuPos({
        top: r.bottom + 8,
        left: Math.max(ECOSYSTEM_PANEL_GUTTER, Math.min(r.left, maxLeft)),
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
    // showLabel: the §384 collapse changes the trigger's width mid-resize, so the
    // anchor must be re-measured after that render commits, not just on resize.
  }, [open, showLabel])

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Ecosystem"
        title="Ecosystem"
        className={`flex items-center gap-1.5 px-3 h-9 text-[13px] font-medium rounded-full ${navText(isDark)} ${hoverTint(isDark)} transition-colors duration-200 whitespace-nowrap`}
      >
        <Icon
          icon="ph:globe-hemisphere-west"
          width={16}
          height={16}
          className={isDark ? 'text-white/[0.50]' : 'text-[#737373]'}
        />
        <span className={showLabel ? '' : 'hidden'}>Ecosystem</span>
        <Icon
          icon="ph:caret-down"
          width={12}
          height={12}
          className={`${isDark ? 'text-white/[0.50]' : 'text-[#737373]'} transition-transform duration-150 motion-reduce:transition-none ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open && mounted && menuPos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Ecosystem"
          data-portal-menu
          style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            width: ECOSYSTEM_PANEL_W,
            maxWidth: `calc(100vw - ${ECOSYSTEM_PANEL_GUTTER * 2}px)`,
          }}
          className={`z-[60] ${ecosystemPanelSurface(isDark)} ${navText(isDark)} rounded-[16px] shadow-lg py-2 flex flex-col`}
        >
          {/* Section label — mirrors the account dropdown's Wallets / Identity
              group headers so the two menus share one structural vocabulary. */}
          <div className={`px-4 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wide ${mutedIconText(isDark)}`}>
            Ecosystem
          </div>
          {ECOSYSTEM_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onNavigate?.()
              }}
              className={`flex items-center gap-2.5 mx-2 px-2 py-1.5 rounded-lg text-left transition-colors duration-150 motion-reduce:transition-none ${hoverTint(isDark)} cursor-pointer`}
            >
              {/* Brand logo on a neutral tile so differently-shaped logos (square
                  Azguard, transparent Aztecscan, circular Nyx) all align at one
                  size — the same 24px avatar slot the account dropdown uses for
                  wallet rows. Falls back to a neutral globe glyph if a logo asset
                  is missing, never a broken image. */}
              <span
                className={`flex w-6 h-6 items-center justify-center rounded-[7px] flex-shrink-0 ${
                  isDark ? 'bg-white/[0.06]' : 'bg-black/[0.04]'
                }`}
              >
                {link.icon ? (
                  <Image src={link.icon} alt="" width={16} height={16} className="object-contain" />
                ) : (
                  <Icon icon="ph:globe-hemisphere-west" width={14} height={14} className={mutedIconText(isDark)} />
                )}
              </span>
              <span className={`flex-1 min-w-0 truncate text-xs font-medium ${navText(isDark)}`}>{link.label}</span>
              <Icon
                icon="majesticons:open"
                width={14}
                height={14}
                className={`flex-shrink-0 ${mutedIconText(isDark)}`}
              />
            </a>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

const Header: React.FC<HeaderProps> = ({ credentials }) => {
  const {
    waapAddress,
    isWaapConnected,
    connectWaapWallet,
    disconnectWaapWallet,
    aztecAddress,
    isAztecConnected,
    disconnectAztecWallet,
    connectAztecWallet,
    walletConnectionPhase,
    waapLoginMethod: loginMethod,
    waapWalletIcon: walletIcon,
    aztecAlias,
    availableAccounts,
    switchAztecAccount,
  } = useWalletStore()

  // Authoritative binding for the connected pair (needs both wallets + JWT).
  const { data: bindingStatus } = useBindingStatus()

  // ─── Pairing / binding conflict (issues #98, #97, #100, #120, #124) ──
  // SERVER TRUTH ONLY. On a server-side conflict, describeConflict names the
  // exact stored counterpart from the CURRENT pair's response (privacy-safe).
  // When the connected pair matches the stored binding the status is 'bound',
  // describeConflict returns null, and every notice/toast below clears — the
  // conflict UI is derived entirely from this live status, so it can't go stale.
  const conflict = describeConflict(bindingStatus?.binding, waapAddress, aztecAddress)

  // The Aztec account the SERVER says this EVM wallet is bound to (disclosed on
  // an evm-linked-elsewhere conflict). Live off the CURRENT response — used for
  // the inline conflict notice so it clears the instant the pair matches.
  const serverLinkedL2 = disclosedLinkedL2(conflict)

  // Persistent (session) view of the linked Aztec account for the connected EVM
  // wallet — remembered from any earlier server disclosure this session (bound
  // or conflict), so the "Linked" badge on the Switch Account list survives a
  // dropdown reopen even after the transient conflict response has cleared. In
  // memory only (never localStorage); null until something has been disclosed.
  const sessionLinkedL2 = useSessionLinkedL2(waapAddress)

  // Live Season-1 HUMN Points for the connected L1 wallet (Human Passport via
  // /api/points). Undefined until an address is connected and the lookup
  // resolves; AccountChip hides the value unless it's a positive number.
  const { data: humnPoints } = useHumnPoints(waapAddress || undefined)

  // Is that server-disclosed linked account one of the Azguard accounts the user
  // already has connected? Used only to tune the inline notice copy.
  const linkedAccountConnected =
    !!serverLinkedL2 && availableAccounts.some((a) => a.address.toLowerCase() === serverLinkedL2.toLowerCase())

  // #304: name the exact target account the user must move to, and never imply
  // they've already switched. When the linked account is already one of their
  // connected Azguard accounts we tell them to SWITCH to it; otherwise we tell
  // them to CONNECT it. Both cases short-address the bound account so the target
  // is unambiguous. No em-dash.
  const walletNotice = !conflict
    ? null
    : serverLinkedL2
      ? linkedAccountConnected
        ? `Your EVM wallet is linked to Aztec account ${shortAddr(serverLinkedL2)}. Switch to that account to continue.`
        : `Your EVM wallet is linked to Aztec account ${shortAddr(serverLinkedL2)}. Connect that account to continue.`
      : conflictMessage(conflict)

  const { isPrivacyModeEnabled, setPrivacyModeEnabled, getProgressSteps } = useBridgeStore()

  // In-progress transfer detection — same derivation BridgeHeader uses: at
  // least one active step, not all completed, and not errored. While true, the
  // wallet Disconnect + Switch Account are HARD-DISABLED (issue #136 — they'd
  // orphan the live transfer's recovery data), and the brand-link-to-home still
  // confirms before tearing down the /progress view. Idle, completed and errored
  // flows navigate/disconnect freely.
  const progressSteps = getProgressSteps()
  const isTransferInProgress =
    progressSteps.some((s) => s.status === 'active') &&
    !progressSteps.every((s) => s.status === 'completed') &&
    !progressSteps.some((s) => s.status === 'error')

  const { splashActive, requestShowSplash } = useOnboardingStore()

  // Privacy Mode swaps the page to the deep-maroon background (see
  // ClientLayout's `showPrivacyBackground`) — the nav's light glass-pill
  // material reads poorly there, so every pill/text/hover style below is
  // gated on this same flag to switch to its dark-mode counterpart.
  //
  // Exception: while the onboarding splash is up, the nav is lifted ABOVE that
  // overlay onto the splash's LIGHT paper field (the dark background is hidden
  // behind the splash). Rendering the dark nav there is white-on-light-pink and
  // unreadable, so stay light-styled until the splash dismisses (#94).
  const isDark = isPrivacyModeEnabled && !splashActive
  const { openModal: openHowItWorks } = useExplainerStore()
  const notify = useToast()

  // The docs pages are a standalone reading view — no wallet, privacy toggle, or
  // deployment badge.
  const pathname = usePathname()
  const router = useRouter()
  const isDocs = pathname?.startsWith('/docs') ?? false

  const { data: l1TokenBalances = [] } = useL1TokenBalances()

  const sepoliaNativeTokens = l1TokenBalances.find((t) => t.type === 'native' && t.network?.chainId === L1_CHAIN_ID)
  const l1NativeBalance = sepoliaNativeTokens?.balance_formatted?.toString()

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [walletButtonPressed, setWalletButtonPressed] = useState(false)
  const [mounted, setMounted] = useState(false)
  const mobileMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setMounted(true)
  }, [])

  // #399 — measure-based label collapse. Instead of a fixed 1280px (`xl:`)
  // breakpoint, the centered nav keeps full labels for exactly as long as they
  // fit and drops to icon-only only when they would overflow. `navRef` is the
  // available track (flex-1, so its clientWidth is the room the row has,
  // independent of whether labels are currently shown); `ghostRef` is an inert,
  // visually-hidden copy of the row rendered ALWAYS with labels, whose width is
  // the space the labels REQUIRE. Comparing required-vs-available makes the
  // decision monotonic (the ghost never collapses, so there is nothing to
  // thrash against), and a small hysteresis buffer keeps a borderline width from
  // flip-flopping. Default collapsed so the first paint is icon-only (the
  // narrowest, never-overflowing state); the effect expands to labels only after
  // it has measured that they fit — so it never flashes overflowing (SSR-safe:
  // the real tree only renders once `mounted`, and the effect re-runs then).
  const navRef = useRef<HTMLElement>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const [labelsCollapsed, setLabelsCollapsed] = useState(true)
  useEffect(() => {
    const nav = navRef.current
    const ghost = ghostRef.current
    if (!nav || !ghost) return

    // Dead zone (px) between "fits" and "expand" so a width parked right at the
    // fit boundary doesn't oscillate label<->icon on sub-pixel resizes.
    const NAV_FIT_BUFFER = 8
    let raf = 0
    const measure = () => {
      raf = 0
      const available = nav.clientWidth
      const required = Math.ceil(ghost.scrollWidth)
      // Below lg the nav is display:none (clientWidth 0) and the hamburger owns
      // navigation; guard so a 0 width doesn't force a spurious collapse read.
      if (available === 0 || required === 0) return
      setLabelsCollapsed((prev) => {
        if (required > available) return true
        if (required + NAV_FIT_BUFFER <= available) return false
        return prev
      })
    }
    const schedule = () => {
      if (raf) return
      raf = requestAnimationFrame(measure)
    }

    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(nav)
    ro.observe(ghost)
    // Web-font swap changes label widths after first paint — re-measure once
    // fonts settle so the collapse point tracks the final metrics.
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(schedule).catch(() => {})
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [mounted, isDocs])

  // No forced auto-switch (reverted #120): selecting a "wrong" Aztec account is
  // allowed and never silently overridden — the app must never change the user's
  // chosen account for them. Instead the linked account is MARKED in the switch
  // list (see linkedAccountAddress below) and the primary action button is
  // guarded up-front in page.tsx when the connected pair is a conflict, so a
  // guaranteed-to-fail bridge can't be started. The conflict is surfaced inline
  // under the wallet cluster (walletNotice) — no toast.

  // Auto-connect to Aztec when WaaP wallet is connected
  useEffect(() => {
    if (isWaapConnected && !isAztecConnected && walletButtonPressed && walletConnectionPhase === 'idle') {
      const timer = setTimeout(() => {
        connectAztecWallet()
        setWalletButtonPressed(false)
      }, AZTEC_AUTO_CONNECT_DELAY_MS)

      return () => clearTimeout(timer)
    }
  }, [isWaapConnected, isAztecConnected, walletButtonPressed, walletConnectionPhase, connectAztecWallet])

  // Close the secondary-nav (mobile) panel on click-outside / Escape
  useEffect(() => {
    if (!mobileMenuOpen) return
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node | null
      // Dropdowns opened from inside this panel (Ecosystem) are portaled to
      // <body>, so they are not DOM descendants of mobileMenuRef. Without this
      // exemption a mousedown on one of their rows closes the panel, unmounting
      // the row before mouseup — the click never lands and the link is dead.
      if (target instanceof Element && target.closest('[data-portal-menu]')) return
      if (mobileMenuRef.current && target && !mobileMenuRef.current.contains(target)) {
        setMobileMenuOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMobileMenuOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [mobileMenuOpen])

  const handleConnectWallet = async () => {
    // Set the button pressed flag
    setWalletButtonPressed(true)
    try {
      await connectWaapWallet()
      // Aztec connection will be handled by the useEffect above
    } catch (error) {
      console.error('Failed to connect wallet:', error)
      // Reset the button press tracker if connection fails
      setWalletButtonPressed(false)
    }
    setMobileMenuOpen(false)
  }

  const handleConnectAztecOnly = async () => {
    // Clicking the Aztec wallet from the top-right takes the user to the app-shell
    // home first, where the "Connect Aztec Wallet" step lives, so the connect flow
    // always runs in context on the bridge rather than over whatever route they were on.
    if (pathname !== '/') router.push('/?app=1')
    try {
      await connectAztecWallet()
    } catch (error) {
      console.error('Failed to connect Aztec wallet:', error)
    }
  }

  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen)
  }

  const isL1Connecting = !isWaapConnected && walletConnectionPhase !== 'idle'
  const isL2Connecting =
    isWaapConnected && !isAztecConnected && (walletButtonPressed || walletConnectionPhase !== 'idle')

  if (!mounted) {
    return (
      <header className="w-full px-4 pt-3 flex justify-between items-center">
        <div className="flex-shrink-0">
          <Link href="/" className="hover:opacity-80 transition-opacity duration-200">
            <Image src={publicAsset('/assets/svg/shield-lockup-maroon.svg')} alt="Shield" width={112} height={30} />
          </Link>
        </div>
      </header>
    )
  }

  if (isDocs) {
    return (
      <header className="w-full px-4 pt-3 flex justify-between items-center relative">
        <div className="flex-shrink-0">
          <Link href="/" className="hover:opacity-80 transition-opacity duration-200">
            <Image src={publicAsset('/assets/svg/shield-lockup-maroon.svg')} alt="Shield" width={112} height={30} />
          </Link>
        </div>
      </header>
    )
  }

  const privacyToggle = (
    // Flat segment, not a pill (#185). Carries no glass-pill fill/shadow/blur of
    // its own so it doesn't read as a pill stacked on the main nav pill. The
    // toggle switch itself supplies the interactive affordance, and a hairline on
    // the wrapper (see below) divides it from the centered nav links.
    <div
      className={`flex items-center gap-[6px] sm:gap-[8px] h-9 sm:h-10 privacy-mode-toggle relative flex-shrink-0`}
      data-tooltip-id="privacy-mode-tooltip"
      data-tooltip-content={isPrivacyModeEnabled ? 'Private transactions enabled' : 'Enable private transactions'}
    >
      <span
        className={`hidden sm:inline ${isDark ? 'text-white/[0.90]' : 'text-[#0A0A0A]'} text-[13px] font-[450] leading-[20px] font-sans whitespace-nowrap`}
      >
        Privacy Mode
      </span>
      <button
        className={`flex w-[36px] h-[22px] sm:w-[40px] sm:h-[24px] py-[3px] px-1 items-center rounded-full transition-all duration-200 border-0 focus:outline-none relative z-10 flex-shrink-0 ${
          isPrivacyModeEnabled
            ? 'bg-[#3B3B3B] justify-end pl-[17px] sm:pl-[19px]'
            : 'bg-[#D4D4D4] justify-start pr-[17px] sm:pr-[19px]'
        }`}
        onClick={() => {
          setPrivacyModeEnabled(!isPrivacyModeEnabled)
          if (!isPrivacyModeEnabled) {
            setTimeout(() => {
              notify('privacy-mode', {
                message: 'Your balance, counterparties, and history stay private on Aztec',
                heading: 'Private mode activated',
              })
            }, 1500)
          } else {
            notify.dismiss('privacy-mode-toastId')
          }
        }}
        aria-pressed={isPrivacyModeEnabled}
        tabIndex={0}
        style={{ border: 'none' }}
      >
        <span className="flex w-[16px] h-[16px] sm:w-[18px] sm:h-[18px] p-[1px] justify-center items-center flex-shrink-0 rounded-full bg-white shadow-[0px_1px_3px_0px_rgba(0,0,0,0.25)] transition-transform duration-200">
          <Image src={publicAsset('/assets/svg/shield.svg')} alt="Shield" width={12} height={12} />
        </span>
      </button>
    </div>
  )

  // Skinny variant-A account chip — a single uniform-height nav chip standing at
  // the right end of the nav (like the Shield brand chip). It encapsulates the
  // connect / connected states and the Wallets · Identity & proofs · Limits &
  // usage · Disconnect dropdown, reading wallet-store state itself. Header only
  // threads the props it can't self-source: the connect actions, the derived
  // connecting/lock/balance flags, the folded-in HUMN Points balance (#313), and
  // the authoritative binding data (conflict notice + server-disclosed linked L2
  // account).
  const accountChip = (
    <AccountChip
      isDark={isDark}
      onConnectWallet={handleConnectWallet}
      onConnectAztec={handleConnectAztecOnly}
      isL1Connecting={isL1Connecting}
      isL2Connecting={isL2Connecting}
      l1NativeBalance={l1NativeBalance}
      actionsLocked={isTransferInProgress}
      loginMethod={loginMethod}
      points={humnPoints?.totalPoints}
      conflictNotice={walletNotice || undefined}
      conflictSevere={!!conflict}
      linkedAccountAddress={sessionLinkedL2 || undefined}
    />
  )

  // #384 / #399 — graceful collapse so the nav NEVER overflows. `showLabels`
  // drives whether each control shows its word or just its `ph:` glyph. In the
  // desktop pill it is set from the live fit measurement (labelsCollapsed): full
  // labels while they fit, icon-only the moment they would overflow — no fixed
  // pixel breakpoint. The `ph:` glyph plus the native `title`/`aria-label` keep
  // every control reachable and named on hover in icon-only mode (SOP §7, no new
  // deps). Below lg the whole nav moves to the hamburger panel. In the mobile
  // panel and the hidden measurement ghost, labels are always shown — neither is
  // width-constrained.
  const renderSecondaryNav = (showLabels: boolean) => {
    const labelCls = showLabels ? '' : 'hidden'
    return (
      <>
        {credentials && (
          <div
            className={`text-sm font-medium cursor-pointer transition-colors duration-200 whitespace-nowrap ${navText(isDark)} ${
              isDark ? 'hover:text-white' : 'hover:text-latest-grey-800'
            }`}
          >
            {credentials}
          </div>
        )}
        <button
          onClick={() => {
            openHowItWorks()
            setMobileMenuOpen(false)
          }}
          aria-label="How it works"
          title="How it works"
          className={`flex items-center gap-1.5 px-3 h-9 text-[13px] font-medium rounded-full ${navText(isDark)} ${hoverTint(isDark)} transition-colors duration-200 whitespace-nowrap`}
        >
          <Icon icon="ph:question" width={16} height={16} className={isDark ? 'text-white/[0.50]' : 'text-[#737373]'} />
          <span className={labelCls}>How it works</span>
        </button>
        <Link
          href="/docs"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Docs"
          title="Docs"
          className={`flex items-center gap-1.5 px-3 h-9 text-[13px] font-medium rounded-full ${navText(isDark)} ${hoverTint(isDark)} transition-colors duration-200 whitespace-nowrap`}
        >
          <Icon
            icon="ph:book-open"
            width={16}
            height={16}
            className={isDark ? 'text-white/[0.50]' : 'text-[#737373]'}
          />
          <span className={labelCls}>Docs</span>
        </Link>
        {/* Direct, always-available entry to the Fee Juice screen — previously only
            reachable by failing a claim (#146). Same pattern/tone as the sibling
            links; shared by the desktop nav and the mobile panel. whitespace-nowrap
            keeps it from wrapping the nav row. */}
        <Link
          href="/fee-juice"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Fee Juice"
          title="Fee Juice"
          className={`flex items-center gap-1.5 px-3 h-9 text-[13px] font-medium rounded-full ${navText(isDark)} ${hoverTint(isDark)} transition-colors duration-200 whitespace-nowrap`}
        >
          <Icon icon="ph:gas-pump" width={16} height={16} className={isDark ? 'text-white/[0.50]' : 'text-[#737373]'} />
          <span className={labelCls}>Fee Juice</span>
        </Link>
        {/* Ecosystem — click-to-open dropdown of external ecosystem links. Shares
            the sibling links' pill/hover/typography treatment; opens below the
            trigger so it clears the nav row. Label collapses with the siblings. */}
        <EcosystemNav isDark={isDark} onNavigate={() => setMobileMenuOpen(false)} showLabel={showLabels} />
      </>
    )
  }

  return (
    <header
      className="w-full px-3 sm:px-4 pt-3 flex items-start gap-2 sm:gap-3 relative"
      style={{ containerType: 'inline-size' }}
    >
      {/* Left column — the Shield BRAND chip on top (brand only), and the
          version/network selector as its OWN separate chip directly beneath it
          (#113). No chip-in-chip: the version dropdown is no longer stacked
          inside the brand pill. The brand chip shares the uniform top-row height
          (CHIP_H); the version chip hangs below it, OUTSIDE that row — so the
          header uses items-start, letting this column be taller than the row
          without stretching the other chips. */}
      <div className="flex flex-col items-stretch gap-2 flex-shrink-0 relative z-40">
        {/* Shield brand chip — logo + wordmark only. */}
        <div className={`${CHIP_H} flex items-center justify-center px-3 sm:px-5 rounded-[26px] ${glassPill(isDark)}`}>
          <Link
            href="/"
            onClick={(e) => {
              // Preserve the state-loss guard: while a transfer is in progress,
              // returning to the splash tears down the live /progress view, so
              // confirm first and bail if the user cancels.
              if (isTransferInProgress && !window.confirm(TRANSFER_LEAVE_CONFIRM)) {
                e.preventDefault()
                return
              }
              // Not just route home — re-show the onboarding splash (#103).
              requestShowSplash()
            }}
            className="flex items-center justify-center hover:opacity-80 transition-opacity duration-200"
          >
            <Image
              src={isDark ? publicAsset('/assets/svg/shield-lockup-white.svg') : publicAsset('/assets/svg/shield-lockup-maroon.svg')}
              alt="Shield"
              width={100}
              height={27}
            />
          </Link>
        </div>
        {/* Version chip — its own rounded, visually distinct chip. The
            DeploymentSelector supplies its own tinted pill material, caret, and
            expandable network/version dropdown; here it simply sits centered
            directly under the brand chip.

            #413: the selector's own fill is nearly transparent (0.04 light /
            0.06 dark), so its text used to read straight off the PAGE background
            — the deep-maroon Privacy-Mode field in particular washed the muted
            tokens (v · Aztec Testnet, the ALPHA tag) below legibility. Back it
            with a SOLID theme-aware surface so those tokens always sit on a
            defined, high-contrast backing instead of the page: opaque white on
            light, opaque deep-maroon in Privacy Mode. The selector's translucent
            fill layers over this, so the chip still reads as one unit while the
            solid surface underneath carries the contrast. Same isDark the
            selector computes internally, so surface and text tones stay matched.
            No dropdown/behaviour change — this is purely a legibility backing. */}
        <div className="flex justify-center">
          <div
            className={`inline-flex rounded-full ${
              isDark
                ? 'bg-[#2A0E1C]/[0.95] shadow-[0_2px_10px_-3px_rgba(0,0,0,0.55)]'
                : 'bg-white shadow-[0_2px_10px_-3px_rgba(15,15,15,0.16)]'
            }`}
          >
            <DeploymentSelector />
          </div>
        </div>
      </div>

      {/* Center pill — Privacy Mode pinned left, secondary nav links centered
          (lg+), and the mobile-nav hamburger at the right (below lg). Uniform
          top-row height. No nested chips: the account chip (with HUMN Points now
          folded in, #313) lives in its own standalone chip to the right of this
          pill. */}
      <div
        className={`${CHIP_H} flex-1 min-w-0 flex items-center justify-between gap-2 pl-4 pr-2 sm:pl-5 sm:pr-3 rounded-full ${glassPill(isDark)}`}
      >
        {/* Privacy Mode — pinned far left (#159), a flat segment (#185) with a
            flush hairline on its right edge dividing it from the centered nav
            links at lg+. Below lg the border collapses so no hairline floats. */}
        <div
          className={`flex items-center flex-shrink-0 lg:border-r lg:pr-3 ${
            isDark ? 'border-white/[0.14]' : 'border-black/[0.10]'
          }`}
        >
          {privacyToggle}
        </div>

        {/* Centered nav links (#159). flex-1 + justify-center pins them to the
            middle. Hidden below lg, where they move into the mobile panel.
            overflow-hidden is a §384 belt-and-suspenders: labels are dropped by
            measurement BEFORE they overflow, so this only ever clips a transient
            frame between a resize and the next measure, never a resting state. */}
        <nav
          ref={navRef}
          className="hidden lg:flex items-center justify-center gap-1 flex-1 min-w-0 overflow-hidden"
          aria-label="Secondary"
        >
          {renderSecondaryNav(!labelsCollapsed)}
        </nav>

        {/* Hidden measurement ghost (#399). An inert, visually-hidden copy of the
            nav rendered ALWAYS with labels; its scrollWidth is the width the full
            labels REQUIRE, which the effect compares against the real nav's
            available width to decide the collapse. `inert` keeps its duplicated
            controls out of the tab order and the a11y tree; the w-0/h-0
            overflow-hidden wrapper means it contributes nothing to layout or page
            scroll while the inline-flex inner still sizes to its content. */}
        <div aria-hidden inert className="absolute top-0 left-0 w-0 h-0 overflow-hidden pointer-events-none">
          <div ref={ghostRef} className="inline-flex items-center gap-1 whitespace-nowrap">
            {renderSecondaryNav(true)}
          </div>
        </div>

        {/* Mobile-nav toggle — only below lg, where the nav links collapse into
            the panel. */}
        <button
          onClick={toggleMobileMenu}
          className={`lg:hidden flex-shrink-0 flex items-center justify-center w-9 h-9 rounded-full ${hoverTint(isDark)} transition-colors duration-200`}
          aria-label="Toggle menu"
          aria-expanded={mobileMenuOpen}
        >
          <Icon icon={mobileMenuOpen ? 'ph:x' : 'ph:list'} width={20} height={20} className={navText(isDark)} />
        </button>
      </div>

      {/* Account chip — the skinny variant-A chip, its own standalone glass pill
          at the uniform top-row height (CHIP_H / h-14 supplied by AccountChip
          itself), pulled OUT of the center pill so it sits on its own at the
          right end. A single collapsed row (avatars + Account + verified + HUMN
          Points + caret) that opens the account dropdown. The separate
          humanity/points chip has been removed (#313); its points value is now
          folded into this chip, and the humanity score lives only in the
          dropdown's Identity section. The binding-conflict notice renders as a
          static banner inside that dropdown (#282), not a floating overlay. */}
      <div className="relative z-40 flex-shrink-0">{accountChip}</div>

      {/* Mobile secondary-nav panel (credentials / How it works / Docs / Fee
          Juice) — the version chip lives under the Shield brand chip now (#113),
          not here. */}
      {mobileMenuOpen && (
        <div
          ref={mobileMenuRef}
          className={`lg:hidden absolute top-full left-3 right-3 sm:left-4 sm:right-4 mt-2 z-50 ${panelSurface(isDark)} rounded-2xl shadow-lg py-3 px-3 flex flex-col items-start gap-2`}
        >
          {renderSecondaryNav(true)}
        </div>
      )}

      <ReactTooltip
        id="privacy-mode-tooltip"
        place="bottom"
        className="z-[100]"
        style={{
          fontSize: '12px',
          padding: '4px 8px',
        }}
      />
    </header>
  )
}

export default Header
