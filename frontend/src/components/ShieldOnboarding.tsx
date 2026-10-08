'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'
import { useWalletStore } from '@/stores/walletStore'
import { AZTEC_VERSION_ID, IS_MAINNET, POCH_MINT_URL, publicAsset } from '@/config'
import { useOnboardingStore } from '@/stores/useOnboardingStore'
import { PASSPORT_BUILD_URL } from '@/config'

const ONBOARDED_KEY = 'shield_onboarded'

// Module-scoped, so it survives client-side navigations (React remounts) but resets on a
// true document reload/refresh. Once the user has entered the app this page-load, NO
// route change may re-show the splash — the only ways back to it are a refresh (module
// re-initialises → false) or the top-left Shield brand (requestShowSplash). This is the
// root fix for dangling routes that bounced users to the splash (#419/#437), independent
// of whether any given navigation remembered the ?app=1 marker.
let hasEnteredAppThisLoad = false
const BRAND = '#81133B'
const CLEAN_SDK = 'https://human.tech/clean-sdk'
const DOCS_CLEAN_HANDS = '/docs/users'

type Screen = {
  eyebrow: string
  title: string
  body: ReactNode
  cta: string
  visual: 'cryptex' | 'shield' | 'identity' | 'zk'
}

const SCREENS: Screen[] = [
  {
    eyebrow: 'Private bridge\nEthereum ⇄ Aztec',
    title: 'Private Transactions for Ethereum Have Arrived',
    body: (
      <p>Move your funds between Ethereum and Aztec with privacy.</p>
    ),
    cta: 'Get started',
    visual: 'cryptex',
  },
  {
    eyebrow: 'Opt in to privacy',
    title: 'Shield your funds',
    body: (
      <>
        <p>
          On Ethereum every balance and transfer is public. Bridge into Aztec to make yours private,
          screened on the way in so the pool stays clean.
        </p>
        <BridgePreview />
      </>
    ),
    cta: 'Next',
    visual: 'shield',
  },
  {
    eyebrow: 'Onchain identity',
    title: 'Prove your identity',
    body: (
      <>
        <p>Reputation is everything in a post privacy web3.</p>
        <div className="ob-tiers" role="table" aria-label="Verification tiers">
          <div className="ob-tier-row" role="row">
            <div className="ob-tier-icon" role="cell">
              <span className="ob-brandlogo ob-logo-passport" aria-hidden="true" />
            </div>
            <div className="ob-tier-copy" role="cell">
              <strong>Up to $1,000</strong>
              <span>Prove you&apos;re a unique human. No ID.</span>
            </div>
          </div>
          <div className="ob-tier-row" role="row">
            <div className="ob-tier-icon" role="cell">
              <span className="ob-brandlogo ob-logo-clean" aria-hidden="true" />
            </div>
            <div className="ob-tier-copy" role="cell">
              <strong>Above $1,000</strong>
              <span>
                Prove your hands are clean.{' '}
                <InfoTooltip label="Learn more about Proof of Clean Hands" align="right">
                  Above $1,000 you verify a government ID in zero knowledge.{' '}
                  <a href="https://human.tech/shield" target="_blank" rel="noopener noreferrer">Learn more</a>.
                </InfoTooltip>
              </span>
            </div>
          </div>
        </div>
        <div className="ob-tier-ctas">
          <a
            href={PASSPORT_BUILD_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ob-pill ob-pill-primary"
          >
            <span className="ob-brandlogo ob-pill-ico ob-logo-passport" aria-hidden="true" />
            Human Passport
          </a>
          <a
            href={POCH_MINT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="ob-pill ob-pill-outline"
          >
            <span className="ob-brandlogo ob-pill-ico ob-logo-clean" aria-hidden="true" />
            Proof of Clean Hands
          </a>
        </div>
      </>
    ),
    cta: 'Next',
    visual: 'identity',
  },
  {
    eyebrow: 'Zero knowledge by design',
    title: 'Private by default, transparent accountability',
    body: (
      <>
        <p>
          <strong>2M+ users</strong> and <strong>44M+ credentials</strong> created on
          human.tech&apos;s ZK stack.
        </p>
        <ZkPulse />
      </>
    ),
    cta: 'Connect wallet',
    visual: 'zk',
  },
]

// The shader colors are a JS prop, so the CSS dark-mode block can't reach them. Without
// this the light-pink field renders in both schemes and dark mode only drops a partial
// veil over it, landing everything in a muddy mid-tone that light text can't beat.
function usePrefersDark() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setDark(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

/* Network-stage caution badge — sits above the hero eyebrow. Amber (not brand pink) so it
   reads as a warning, with a hover/focus tooltip so users know which network they are on
   before they bridge: Alphanet (real value, early network) on mainnet, Testnet otherwise. */
function NetworkStageBadge() {
  const stage = IS_MAINNET ? 'Alphanet' : 'Testnet'
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 240)
  }
  return (
    <span
      className="ob-alpha"
      onMouseEnter={() => {
        cancelClose()
        setOpen(true)
      }}
      onMouseLeave={scheduleClose}
    >
      <span
        className="ob-alpha-pill"
        tabIndex={0}
        role="note"
        aria-label={`${stage} release warning`}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
        </svg>
        {stage}
      </span>
      <AnimatePresence>
        {open && (
          <motion.span
            className="ob-tooltip-bubble ob-alpha-bubble"
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {IS_MAINNET ? (
              <>
                Shield runs on Aztec Alphanet, an early-stage network. Treat every transaction as final and bridge only what you can afford to lose.{' '}
                <a href="https://aztec.network/blog/introducing-alpha-v5" target="_blank" rel="noopener noreferrer">Learn about Alpha v5</a>.
              </>
            ) : (
              <>
                Shield is running on Aztec Testnet ({AZTEC_VERSION_ID}). Testnet tokens have no value, and balances can be reset when Aztec ships a new version.
              </>
            )}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

/* Paper-shader field: real @paper-design MeshGradient in Shield tones, softened by a
   translucent veil so copy stays legible, plus a fine grain for paper texture. */
function PaperField({ still }: { still: boolean }) {
  const dark = usePrefersDark()
  return (
    <div className="ob-field" aria-hidden="true">
      <MeshGradient
        colors={dark ? ['#1c0710', '#3d0e21', '#5a1327', '#81133b'] : ['#fff6fa', '#fde7f3', '#fcd4ea', '#fa8fc4']}
        speed={still ? 0 : 0.16}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <div className="ob-veil" />
      <svg className="ob-grain" width="100%" height="100%">
        <filter id="ob-noise"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" /></filter>
        <rect width="100%" height="100%" filter="url(#ob-noise)" />
      </svg>
    </div>
  )
}

/* Cryptex hero mark — concentric dial rings framing the headline. A point spirals from
   the outer ring (public, light) to the private core (dark, occluded) and back out,
   endlessly shielding and unshielding. No text, no logos — state is read through light
   and shadow alone. */
const CX_SIZE = 320
const CX_CENTER = CX_SIZE / 2
const CX_OUTER = 148
const CX_CORE = 30
const CX_STEPS = 48
const CX_SPIRAL_TURNS = 3 // integer turns so the point ends exactly where it began (seamless loop)

// `dashMini` is a coarser dash pattern for the minimized mark: literally scaling the hero's
// 1.4/320-viewBox stroke down to a ~60px mark would put the ring under a physical pixel wide
// (invisible). Small marks need their linework re-weighted, not just shrunk, to stay legible.
const CX_RINGS = [
  { r: 148, dash: '1.5 15', dashMini: '7 22', duration: 46, dir: 1 },
  { r: 114, dash: '1.5 12', dashMini: '6 18', duration: 34, dir: -1 },
  { r: 80, dash: '1.5 10', dashMini: '5 15', duration: 26, dir: 1 },
  { r: 48, dash: '1.5 8', dashMini: '4 12', duration: 19, dir: -1 },
]

function cxPoint(radius: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: CX_CENTER + radius * Math.cos(rad), y: CX_CENTER + radius * Math.sin(rad) }
}

// t: 0 -> 1 is one full shield (inward) + unshield (outward) cycle.
function cxRadiusAt(t: number) {
  const half = t <= 0.5 ? t / 0.5 : (1 - t) / 0.5
  return CX_CORE + (CX_OUTER - CX_CORE) * half
}

function cxToneAt(t: number) {
  const half = t <= 0.5 ? t / 0.5 : (1 - t) / 0.5 // 1 = at outer edge (public), 0 = at core (private)
  const fill = half > 0.66 ? '#f462a6' : half > 0.33 ? '#b23a72' : '#3d0e21'
  const opacity = 0.35 + half * 0.65
  const glow = Math.max(0, half - 0.4) * 0.9
  return { fill, opacity, glow }
}

const CX_SPIRAL = Array.from({ length: CX_STEPS + 1 }, (_, i) => {
  const t = i / CX_STEPS
  const radius = cxRadiusAt(t)
  const angle = t * CX_SPIRAL_TURNS * 360
  const { x, y } = cxPoint(radius, angle)
  const { fill, opacity, glow } = cxToneAt(t)
  return { x, y, fill, opacity, glow }
})
const CX_X = CX_SPIRAL.map((p) => p.x)
const CX_Y = CX_SPIRAL.map((p) => p.y)
const CX_FILL = CX_SPIRAL.map((p) => p.fill)
const CX_OPACITY = CX_SPIRAL.map((p) => p.opacity)
const CX_OPACITY_MINI = CX_OPACITY.map((o) => o * 0.72)
const CX_GLOW = CX_SPIRAL.map((p) => p.glow)

// `mini` dials back stroke/point opacity and drops the blurred outer glow point (its blur
// radius is a fixed px value that dominates at small sizes) so the mark reads as a subtle,
// quiet echo once it's minimized into the eyebrow rather than competing with the copy.
function CryptexVisual({ still, mini = false }: { still: boolean; mini?: boolean }) {
  return (
    <svg className="ob-cryptex-svg" viewBox={`0 0 ${CX_SIZE} ${CX_SIZE}`} aria-hidden="true">
      <defs>
        <radialGradient id="cx-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#3d0e21" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#3d0e21" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle cx={CX_CENTER} cy={CX_CENTER} r={CX_CORE + 8} fill="url(#cx-core)" />

      {CX_RINGS.map((ring, i) =>
        still ? (
          <circle
            key={ring.r}
            cx={CX_CENTER}
            cy={CX_CENTER}
            r={ring.r}
            fill="none"
            stroke={i === 0 ? '#e79cbe' : i === CX_RINGS.length - 1 ? '#5a1f36' : '#c96f97'}
            strokeWidth={mini ? 6 : 1.4}
            strokeDasharray={mini ? ring.dashMini : ring.dash}
            opacity={mini ? 0.5 : 0.5}
          />
        ) : (
          <motion.g
            key={ring.r}
            style={{ transformOrigin: `${CX_CENTER}px ${CX_CENTER}px` }}
            animate={{ rotate: ring.dir * 360 }}
            transition={{ duration: ring.duration, repeat: Infinity, ease: 'linear' }}
          >
            <motion.circle
              cx={CX_CENTER}
              cy={CX_CENTER}
              r={ring.r}
              fill="none"
              strokeWidth={mini ? 6 : 1.4}
              strokeDasharray={mini ? ring.dashMini : ring.dash}
              animate={{
                stroke: ['#f2b7d3', '#5a1f36', '#f2b7d3'],
                opacity: mini ? [0.2, 0.5, 0.2] : [0.28, 0.72, 0.28],
              }}
              transition={{
                duration: 9,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: i * 0.55,
              }}
            />
          </motion.g>
        )
      )}

      {!still && (
        <>
          {!mini && (
            <motion.circle
              r={11}
              animate={{ cx: CX_X, cy: CX_Y, fill: CX_FILL, opacity: CX_GLOW }}
              transition={{ duration: 10, repeat: Infinity, ease: 'linear' }}
              style={{ filter: 'blur(5px)' }}
            />
          )}
          <motion.circle
            r={mini ? 9 : 4}
            animate={{ cx: CX_X, cy: CX_Y, fill: CX_FILL, opacity: mini ? CX_OPACITY_MINI : CX_OPACITY }}
            transition={{ duration: 10, repeat: Infinity, ease: 'linear' }}
          />
        </>
      )}

      {still && (
        <>
          <circle cx={cxPoint(CX_OUTER, 40).x} cy={cxPoint(CX_OUTER, 40).y} r={mini ? 9 : 4.5} fill="#f462a6" />
          <circle cx={cxPoint(CX_CORE + 4, 220).x} cy={cxPoint(CX_CORE + 4, 220).y} r={mini ? 7 : 3.5} fill="#3d0e21" opacity={0.7} />
        </>
      )}
    </svg>
  )
}

// Shared layoutId used only within the multi-screen flow, so Framer Motion morphs the same
// element between its hero size (screen 0) and its mini size (screens 1-3) instead of
// cross-fading two different nodes — this is what produces the "minimize into the eyebrow"
// motion. The splash (`shared` unset) always shows the plain hero, no shared transition needed.
const CRYPTEX_LAYOUT_ID = 'ob-cryptex-shell'

function CryptexMark({ reduce, mini = false, shared = false }: { reduce: boolean; mini?: boolean; shared?: boolean }) {
  const shellClass = `ob-cryptex-shell${mini ? ' ob-cryptex-shell-mini' : ''}`

  if (reduce) {
    return (
      <div className={shellClass}>
        <CryptexVisual still mini={mini} />
      </div>
    )
  }

  return (
    <motion.div
      layout
      layoutId={shared ? CRYPTEX_LAYOUT_ID : undefined}
      className={shellClass}
      transition={{ layout: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } }}
    >
      <CryptexVisual still={false} mini={mini} />
      {!mini && (
        <div className="ob-epicenter" aria-hidden="true">
          <MeshGradient
            colors={['#f462a6', '#b23a72', '#4d051f', '#81133b']}
            speed={0.32}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
        </div>
      )}
    </motion.div>
  )
}

/* Minimal accessible tooltip: a small inline info glyph that reveals a short blurb on
   hover or keyboard focus. No external positioning library, no portal, just a relatively
   positioned bubble anchored to the trigger. The trigger sits inline with the sentence
   and never forces a line break. */
function InfoTooltip({ label, children, align = 'center' }: { label: string; children: ReactNode; align?: 'center' | 'right' }) {
  const [open, setOpen] = useState(false)
  const tooltipId = useId()
  // Small close delay so the pointer can travel from the icon into the bubble
  // (to click the link inside) without the bubble vanishing mid-move.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 240)
  }
  const icon = (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8" cy="4.7" r="0.95" fill="currentColor" />
      <path d="M8 7.1v4.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
  return (
    <span className="ob-tooltip" onMouseEnter={() => { cancelClose(); setOpen(true) }} onMouseLeave={scheduleClose}>
      <button
        type="button"
        className="ob-tooltip-trigger"
        aria-label={label}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={scheduleClose}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
      </button>
      <AnimatePresence>
        {open && (
          <motion.span
            id={tooltipId}
            role="tooltip"
            className={`ob-tooltip-bubble${align === 'right' ? ' ob-tooltip-bubble-right' : ''}`}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
          >
            {children}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

/* Screen-2 bridge preview: a small mock of the bridge itself — a public balance on
   Ethereum, a shield, and the resulting private balance on Aztec. Line art holds still at
   rest; a soft dot travels the path on a loop to suggest funds moving through the shield. */
function BridgePreview() {
  const reduce = useReducedMotion() ?? false
  return (
    <div className="ob-bp" aria-hidden="true">
      <div className="ob-bp-col">
        <span className="ob-bp-chain">Ethereum</span>
        <span className="ob-bp-amount ob-bp-amount-public">1,000 USDC</span>
      </div>
      <div className="ob-bp-track">
        <span className="ob-bp-line" />
        {!reduce && (
          <motion.span
            className="ob-bp-dot"
            animate={{ left: ['4%', '96%'], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        <span className="ob-bp-lock">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="5.5" y="11" width="13" height="9.5" rx="2.4" stroke={BRAND} strokeWidth="1.5" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke={BRAND} strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="12" cy="15.4" r="1.3" fill={BRAND} />
          </svg>
          {!reduce && (
            <motion.span
              className="ob-bp-lock-glow"
              animate={{ opacity: [0.15, 0.5, 0.15] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </span>
      </div>
      <div className="ob-bp-col">
        <span className="ob-bp-chain">Aztec · private</span>
        <span className="ob-bp-amount ob-bp-amount-private">•••• USDC</span>
      </div>
    </div>
  )
}

/* Screen-4 proof animation: three source nodes settle into a single verified check, on a
   slow loop. Purely decorative and low-key — a quiet pulse, not a focal point. */
const ZK_NODES: [number, number][] = [
  [14, 26],
  [64, 10],
  [64, 42],
]

function ZkPulse() {
  const items = [
    'Your identity and your activity stay yours. No one can see them or link them back to you.',
    'Rule-bound disclosure, only minimal facts about you are disclosed.',
  ]
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: '20px auto 0',
        padding: 0,
        maxWidth: 400,
        textAlign: 'left',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {items.map((t) => (
        <li key={t} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14.5, lineHeight: 1.4, color: '#5a4650' }}>
          <svg viewBox="0 0 20 20" width={20} height={20} style={{ flex: 'none', marginTop: 1 }} aria-hidden="true">
            <circle cx="10" cy="10" r="9" fill={BRAND} opacity="0.12" />
            <path d="M6 10.5l2.5 2.5L14.5 7" fill="none" stroke={BRAND} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  )
}

export default function ShieldOnboarding() {
  const reduce = useReducedMotion() ?? false
  const router = useRouter()
  const pathname = usePathname()
  const connectWaapWallet = useWalletStore((s) => s.connectWaapWallet)
  const isWaapConnected = useWalletStore((s) => s.isWaapConnected)
  const walletConnectionPhase = useWalletStore((s) => s.walletConnectionPhase)
  const showWalletInstallPrompt = useWalletStore((s) => s.showWalletInstallPrompt)
  const setSplashActive = useOnboardingStore((s) => s.setSplashActive)
  const showSplashNonce = useOnboardingStore((s) => s.showSplashNonce)
  // Start in 'loading': the shader shell renders immediately (covering the bridge from
  // the first paint) while we read localStorage / wallet state, then we resolve to the
  // real mode and the inner content fades in over the same, never-remounted shader.
  const [mode, setMode] = useState<'loading' | 'hidden' | 'flow' | 'splash'>('loading')
  const [index, setIndex] = useState(0)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    // "Back to main screen" from the progress/activity flow appends ?app=1 so a
    // returning user lands on the bridge shell directly instead of the splash gate,
    // even when that navigation re-mounts this component (a fresh page load). The
    // marker is honored once and immediately stripped from the URL, so a later reload
    // of the bare route still shows the splash for onboarded users — the Shield brand
    // click (issue #103) stays the only other way back to it.
    let returnToApp = false
    try {
      const params = new URLSearchParams(window.location.search)
      returnToApp = params.get('app') === '1'
      if (returnToApp) {
        params.delete('app')
        const qs = params.toString()
        window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
      }
    } catch {
      returnToApp = false
    }

    // First visit runs the full flow (once). Every subsequent page load — including a
    // refresh by a connected user — lands on the branded splash; the user explicitly
    // re-enters the bridge from there. Decided once on mount so a wallet reconnecting
    // mid-session doesn't tear the splash down underneath the user.
    let onboarded = false
    try {
      onboarded = !!localStorage.getItem(ONBOARDED_KEY)
    } catch {
      onboarded = false
    }
    // A fresh load that lands on a NON-'/' app route (a refresh on the progress /
    // fee-juice / activity page, or a deep link) shows that PAGE, not the splash — the
    // splash belongs to the '/' home. Otherwise a connected user who refreshes mid-flow
    // gets the splash stacked over their page, and because they navigate via the lifted
    // nav (never clicking "Enter app") the entered-flag never sets, so every nav click
    // keeps re-triggering the splash (#443). Refreshing the '/' home still shows the
    // splash for onboarded users; the Shield brand is still the in-app way back to it.
    let onAppRoute = false
    try {
      onAppRoute = window.location.pathname !== '/'
    } catch {}
    setMode(
      returnToApp || hasEnteredAppThisLoad || (onboarded && onAppRoute)
        ? 'hidden'
        : onboarded
          ? 'splash'
          : 'flow',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Signal the splash state to the app chrome via a root attribute. When the splash is
  // up for a *connected* user, ClientLayout lifts the real nav bar above the overlay so
  // they keep their account/nav; otherwise the splash covers everything.
  useEffect(() => {
    const root = document.documentElement
    if (mode === 'splash') {
      root.setAttribute('data-ob-splash', isWaapConnected ? 'connected' : 'active')
    } else {
      root.removeAttribute('data-ob-splash')
    }
    return () => root.removeAttribute('data-ob-splash')
  }, [mode, isWaapConnected])

  // Publish "splash is up" so the elevated nav (which sits ABOVE this overlay
  // on the light paper field) can drop its dark Privacy-Mode styling while the
  // splash covers the dark background it would otherwise read against (#94).
  useEffect(() => {
    setSplashActive(mode === 'splash')
    return () => setSplashActive(false)
  }, [mode, setSplashActive])

  // A Shield-brand click that returns the user to the splash is DELIBERATE and must
  // win over the auto-dismiss below, even when a connect flow was already active at
  // click-time (a wallet modal open, or the install prompt up). This flag marks the
  // current splash as brand-initiated; the connect-dismiss effect then only tears it
  // down for a genuinely NEW connect the user starts from it, never for the stale
  // phase that was already running when they hit the brand (#414).
  const brandSplashRef = useRef(false)
  // Tracks whether a connect flow was active on the previous render so the effect can
  // detect a rising edge (idle -> connecting) — a fresh connect — versus a phase that
  // was already active before the splash appeared.
  const prevConnectActiveRef = useRef(false)

  // Connect from the splash nav (e.g. "Connect Aztec"): the connect modal renders
  // BENEATH the splash overlay, so hitting connect on the splash would fire but stay
  // hidden. Drop the splash the moment an ACTIVE connect flow starts (discovering /
  // selecting, or the install prompt) so the modal is visible (#370). Gate on the
  // actively-connecting phases ONLY — NOT `!== 'idle'` — because a fully 'connected'
  // user who deliberately returns to the splash via the Shield brand link must NOT be
  // bounced straight back to the app (#409).
  useEffect(() => {
    const connecting = walletConnectionPhase === 'discovering' || walletConnectionPhase === 'selecting'
    const active = connecting || showWalletInstallPrompt
    // Rising edge = a connect flow that just STARTED this render. Compute before the
    // ref is refreshed, and refresh it unconditionally so the edge stays accurate even
    // while the splash is hidden (the flow may start, resolve, and restart in the app).
    const rising = active && !prevConnectActiveRef.current
    prevConnectActiveRef.current = active

    if (mode !== 'splash' || !active) return

    // A brand-requested splash only yields to a connect the user starts FROM it — a
    // rising edge after the splash appeared. A connect that was already active when the
    // brand was clicked (a stale modal / install prompt) is NOT a fresh start, so the
    // splash holds until the user acts (#414). Non-brand splashes keep the original
    // level-triggered dismiss so a fresh connect from the splash nav still shows the
    // modal (#370).
    if (brandSplashRef.current && !rising) return

    brandSplashRef.current = false
    setMode('hidden')
  }, [mode, walletConnectionPhase, showWalletInstallPrompt])

  // Clicking the Shield brand returns the user to the splash (#103). The brand
  // link's own in-progress-transfer guard runs first (see Header), so by the
  // time the nonce bumps here it's already confirmed. Skip the initial mount
  // value so this only fires on an actual request.
  const didMountSplashRequest = useRef(false)
  useEffect(() => {
    if (!didMountSplashRequest.current) {
      didMountSplashRequest.current = true
      return
    }
    brandSplashRef.current = true
    setLeaving(false)
    setIndex(0)
    setMode('splash')
  }, [showSplashNonce])

  const markOnboarded = () => {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1')
    } catch {}
  }

  // Entering the bridge from the splash/flow must always land on the bridge form (/),
  // never wherever the splash happened to be overlaying. The splash shows for every
  // onboarded user on top of the current route, so a returning user sitting on
  // /activity (the recovery view, reached after a completed/interrupted bridge) would
  // otherwise be dropped straight back onto it with no visible step to connect Aztec or
  // start a bridge. The bridge form is the one place the action button surfaces the
  // "Connect Aztec Wallet" next step, so route there before dismissing.
  const enterApp = () => {
    brandSplashRef.current = false
    // Mark the app as entered for this page-load so no later navigation re-shows the
    // splash, and ALWAYS land on the app-shell home (#437 + "enter app → home"): the
    // splash overlays whatever route was underneath, so a user who opened it from
    // /activity must be taken to the bridge, never dropped back onto that route.
    hasEnteredAppThisLoad = true
    if (pathname !== '/') router.push('/')
    setMode('hidden')
  }

  const finishFlow = () => {
    markOnboarded()
    enterApp()
  }

  const skip = () => finishFlow()

  const connectWallet = () => {
    connectWaapWallet().catch(() => {})
  }

  const advance = () => {
    if (index < SCREENS.length - 1) {
      setIndex((i) => i + 1)
    } else {
      // Final CTA: open the WaaP login, then fade into the app.
      markOnboarded()
      connectWallet()
      setLeaving(true)
    }
  }

  const connectFromSplash = () => {
    // Already connected in the background: skip straight into the bridge. Not
    // connected yet: start the same WaaP connect flow the app uses and only enter
    // once it resolves, so the splash stays put if the user cancels the login.
    if (isWaapConnected) {
      enterApp()
      return
    }
    connectWaapWallet()
      .then(() => enterApp())
      .catch(() => {})
  }

  const back = () => setIndex((i) => Math.max(0, i - 1))

  const screen = SCREENS[index]
  const progress = ((index + 1) / SCREENS.length) * 100

  const flowContent = (
    <motion.div
      key="flow"
      className="ob-inner"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: 'easeInOut' }}
    >
      {/* Full-width progress bar */}
      <div className="ob-progress" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={SCREENS.length}>
        <motion.div className="ob-progress-fill" animate={{ width: `${progress}%` }} transition={{ duration: 0.5, ease: 'easeOut' }} />
      </div>

      <div className="ob-top">
        <img src={publicAsset('/assets/svg/shield-symbol-maroon.svg')} alt="Shield" width={22} height={27} />
        <button className="ob-skip" onClick={skip}>Skip</button>
      </div>

      <div className="ob-stage">
        <div className="ob-stage-inner">
          <div className="ob-card-region">
            {/* Minimized cryptex lives OUTSIDE the fading card so it stays pinned (never
                re-fades) as you move between screens 1-3; the layoutId still morphs it in
                from the screen-0 hero. */}
            {index > 0 && (
              <div className="ob-mini-pin">
                <CryptexMark reduce={reduce} mini shared />
              </div>
            )}
            <AnimatePresence mode="wait">
              <motion.div
                key={index}
                className={`ob-card${index === 0 ? '' : ' ob-card-top'}`}
                initial={{ opacity: 0, y: 22 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -22 }}
                transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
              >
                {screen.visual === 'cryptex' ? (
                  <div className="ob-cryptex-hero">
                    <CryptexMark reduce={reduce} shared />
                    <div className="ob-headline">
                      <NetworkStageBadge />
                      <p className="ob-eyebrow">{screen.eyebrow}</p>
                      <h1 className="ob-title">{screen.title}</h1>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="ob-eyebrow">{screen.eyebrow}</p>
                    <h1 className={`ob-title ob-title-${screen.visual}`}>{screen.title}</h1>
                  </>
                )}
                <div className="ob-body">{screen.body}</div>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="ob-controls">
            <div className="ob-btns">
              {index > 0 && <button className="ob-back" onClick={back}>Back</button>}
              <button className="ob-next" onClick={advance}>{screen.cta}</button>
            </div>
            <p className="ob-secured">
              Secured by <strong className="ob-htmark" role="img" aria-label="human.tech" />
              <span className="ob-dot">·</span>
              Built on <a href={CLEAN_SDK} target="_blank" rel="noopener noreferrer" className="ob-link">Clean SDK</a>
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  )

  const splashContent = (
    <motion.div
      key="splash"
      className="ob-inner"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: 'easeInOut' }}
    >
      {/* The version/network selector is NOT re-rendered here: the real app nav bar is
          now lifted above this overlay in every splash state (see data-ob-splash), so its
          own DeploymentSelector is live and a second one here would just duplicate it. */}
      <div className="ob-stage">
        <div className="ob-stage-inner">
          <div className="ob-card-region">
            <div className="ob-card">
              <div className="ob-cryptex-hero">
                <CryptexMark reduce={reduce} />
                <div className="ob-headline">
                  <NetworkStageBadge />
                  <p className="ob-eyebrow">{SCREENS[0].eyebrow}</p>
                  <h1 className="ob-title">{SCREENS[0].title}</h1>
                </div>
              </div>
              <div className="ob-body">
                <p>Move your funds between Ethereum and Aztec with privacy.</p>
              </div>
            </div>
          </div>
          <div className="ob-controls">
            <div className="ob-btns">
              <button className="ob-next" onClick={connectFromSplash}>{isWaapConnected ? 'Enter app' : 'Connect wallet'}</button>
            </div>
            <a href={CLEAN_SDK} target="_blank" rel="noopener noreferrer" className="ob-dev-cta">
              Build your own App with Programmable Privacy
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14" />
                <path d="m13 6 6 6-6 6" />
              </svg>
            </a>
          </div>
        </div>
      </div>
      {/* #157: the "Secured by human.tech · Built on Clean SDK" trust line sits
          in the splash's bottom footer now, not tucked under the developer CTA. */}
      <footer className="ob-splash-footer">
        <p className="ob-secured">
          Secured by <strong className="ob-htmark" role="img" aria-label="human.tech" />
          <span className="ob-dot">·</span>
          Built on <a href={CLEAN_SDK} target="_blank" rel="noopener noreferrer" className="ob-link">Clean SDK</a>
        </p>
      </footer>
    </motion.div>
  )

  return (
    <AnimatePresence>
      {/* The shader shell is painted on the very first client frame so the bridge never
          flashes underneath. The shell itself never fades IN (initial={false}); it stays
          mounted while the inner content (progress bar, headline, controls) fades in over
          it, and it only fades OUT — cleanly revealing the bridge — when we dismiss. */}
      {mode !== 'hidden' && !leaving && (
        <motion.div
          key="ob-root"
          className={`ob-root${mode === 'splash' ? ' ob-splash' : ''}`}
          initial={false}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5, ease: 'easeInOut' }}
        >
          <PaperField still={reduce} />
          <AnimatePresence mode="wait">
            {mode === 'flow' ? flowContent : mode === 'splash' ? splashContent : null}
          </AnimatePresence>
        </motion.div>
      )}

      {leaving && (
        <motion.div
          key="handoff"
          className="ob-handoff"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 1.5, times: [0, 0.25, 0.7, 1], ease: 'easeInOut' }}
          onAnimationComplete={() => {
            markOnboarded()
            setLeaving(false)
            enterApp()
          }}
        >
          <motion.div
            className="ob-handoff-mark"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: [0.8, 1, 1.06], opacity: [0, 1, 1] }}
            transition={{ duration: 1.5, ease: 'easeOut' }}
          >
            <img src={publicAsset('/assets/svg/human.tech.logo.svg')} alt="human.tech" width={140} onError={(e) => ((e.currentTarget.src = publicAsset('/assets/svg/shield-symbol-maroon.svg')))} />
          </motion.div>
        </motion.div>
      )}

      <style key="ob-style">{`
        .ob-root { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column;
          overflow: hidden; font-family: 'Suisse Intl', system-ui, sans-serif;
          background: #fff6fa; color: #1c1116; }
        /* On the splash (connected OR not) the whole real app nav bar is lifted above
           this overlay so every control stays live — the account chip + its dropdown,
           the Privacy toggle, Ecosystem / Docs, and the version selector. Toggled by
           data-ob-splash on <html>; the attribute is removed the instant the splash
           dismisses, dropping the nav back to its normal in-app stacking. */
        html[data-ob-splash] .ob-header-elevate { z-index: 130 !important; }
        /* The account dropdown is PORTALED to <body> (a direct child, at z-[60]) so it
           escapes the Header's stacking context. On the splash the z-100 overlay would
           otherwise paint over it and swallow its clicks, so lift the portaled menu above
           both the overlay and the elevated header while the splash is up. Scoped to a
           direct body child so it only targets the portaled menu, never the Header's own
           in-flow Ecosystem menu. */
        html[data-ob-splash] body > [role="menu"] { z-index: 140 !important; }
        /* Inner content overlay: fades in over the persistent shader shell. */
        .ob-inner { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; }
        .ob-field { position: absolute; inset: 0; z-index: 0; overflow: hidden; }
        .ob-field canvas { position: absolute; inset: 0; width: 100% !important; height: 100% !important; }
        .ob-veil { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255,246,250,0.38), rgba(255,246,250,0.78)); }
        .ob-grain { position: absolute; inset: 0; opacity: 0.05; mix-blend-mode: multiply; pointer-events: none; }
        .ob-progress { position: relative; z-index: 3; height: 4px; width: 100%; background: rgba(129,19,59,0.12); }
        .ob-progress-fill { height: 100%; background: linear-gradient(90deg, ${BRAND}, #f462a6); }
        .ob-top { position: relative; z-index: 3; display: flex; align-items: center; justify-content: space-between;
          padding: 18px 22px 0; }
        .ob-skip { background: none; border: 0; color: #987f8a; font-size: 14px; cursor: pointer; padding: 6px; }
        .ob-skip:hover { color: #5a4650; }
        .ob-stage { position: relative; z-index: 2; flex: 1; min-height: 0; display: flex; align-items: center;
          justify-content: center; padding: 16px 24px; overflow-y: auto; }
        .ob-stage-inner { width: 100%; max-width: 720px; margin: auto; display: flex; flex-direction: column;
          align-items: center; gap: 28px; }
        /* Fixed content region: height is sized to the tallest screen (the cryptex hero).
           Every screen's content is vertically centered inside it, so the controls row
           below always sits at the same y and the button never shifts between screens. */
        .ob-card-region { position: relative; width: 100%; height: clamp(430px, 60vh, 540px); }
        .ob-card { position: absolute; inset: 0; width: 100%; text-align: center; display: flex;
          flex-direction: column; align-items: center; justify-content: center; }
        /* Non-hero screens top-align and reserve space for the pinned cryptex above, so the
           mark sits at the same Y on every screen and the copy never overlaps it. */
        .ob-card-top { justify-content: flex-start; padding-top: 108px; }
        .ob-mini-pin { position: absolute; top: 24px; left: 0; right: 0; height: 72px; z-index: 2;
          display: flex; align-items: center; justify-content: center; }
        .ob-visual { height: 72px; display: flex; align-items: center; justify-content: center; margin-bottom: 18px; width: 100%; }
        .ob-alpha { position: relative; display: inline-flex; margin: 0 auto 10px; }
        .ob-alpha-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
          background: rgba(255,255,255,0.55); color: #9a6512; border: 1px solid rgba(176,120,31,0.45);
          -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
          font-size: 9.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; cursor: default; outline: none; }
        .ob-alpha-pill:focus-visible { outline: 2px solid #b06f16; outline-offset: 2px; }
        /* #156: pin the Alphanet tooltip ABOVE its badge (never below, where the
           top nav could clip it) and lift its z above the elevated nav. */
        .ob-alpha-bubble { width: 250px; bottom: calc(100% + 10px); top: auto; z-index: 140; }
        .ob-eyebrow { font-size: 12.5px; letter-spacing: 0.14em; text-transform: uppercase; color: ${BRAND};
          font-weight: 600; margin: 0 0 14px; white-space: pre-line; line-height: 1.7; }
        .ob-title { font-size: clamp(26px, 5vw, 40px); line-height: 1.08; letter-spacing: -0.02em; font-weight: 640;
          margin: 0 0 16px; text-wrap: balance; max-width: 15ch; }
        .ob-title-zk { max-width: 24ch; }
        .ob-body { font-size: 16.5px; line-height: 1.55; color: #5a4650; max-width: 56ch; }
        .ob-body p { margin: 0 0 10px; } .ob-body p:last-child { margin-bottom: 0; }
        .ob-body strong { color: #1c1116; font-weight: 640; }
        .ob-link { color: ${BRAND}; text-decoration: underline; text-underline-offset: 2px; font-weight: 550; }
        /* verification tiers grid (page 3) */
        /* overflow:visible (not hidden) so a right-anchored tooltip bubble on the "Above
           $1,000" tier row is never clipped by the card edge (#444). The rounded corners
           still read from the container's own border + background; the rows carry no
           corner-reaching background to spill out. */
        .ob-tiers { width: 100%; max-width: 460px; margin: 18px auto 0; border: 1px solid #f0d3e0;
          border-radius: 16px; overflow: visible; background: rgba(255,255,255,0.55); text-align: left; }
        .ob-tier-row { display: flex; align-items: center; gap: 16px; padding: 16px 20px; }
        .ob-tier-row + .ob-tier-row { border-top: 1px solid #f0d3e0; }
        .ob-tier-icon { flex: none; width: 40px; height: 40px; border-radius: 12px; background: rgba(129,19,59,0.08);
          display: flex; align-items: center; justify-content: center; }
        .ob-tier-icon svg { width: 20px; height: 20px; }
        /* Real shipped brand marks (passport.svg / clean-hands.svg), tinted via CSS mask
           the same way the human.tech wordmark is (.ob-htmark) so they inherit the local
           text colour instead of a baked-in fill. background-color: currentColor means the
           mark takes the maroon accent on the light tier chip and the pill's own text
           colour inside the toggle pills below (white on the solid pill, maroon on the
           outline pill), staying legible on each. */
        .ob-brandlogo { display: inline-block; flex: none; background-color: currentColor;
          -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
          -webkit-mask-position: center; mask-position: center;
          -webkit-mask-size: contain; mask-size: contain; }
        .ob-logo-passport { -webkit-mask-image: url(${publicAsset('/assets/svg/passport.svg')}); mask-image: url(${publicAsset('/assets/svg/passport.svg')}); }
        .ob-logo-clean { -webkit-mask-image: url(${publicAsset('/assets/svg/clean-hands.svg')}); mask-image: url(${publicAsset('/assets/svg/clean-hands.svg')}); }
        .ob-tier-icon .ob-brandlogo { width: 22px; height: 22px; color: ${BRAND}; }
        .ob-pill-ico { width: 16px; height: 16px; }
        .ob-tier-copy { display: flex; flex-direction: column; gap: 2px; }
        .ob-tier-copy strong { font-size: 15.5px; color: #1c1116; font-weight: 640; }
        .ob-tier-copy span { font-size: 14px; line-height: 1.4; color: #5a4650; }
        /* learn more info-icon tooltip (page 4) */
        .ob-tooltip { position: relative; display: inline-flex; vertical-align: middle; margin-left: 4px; }
        .ob-tooltip-trigger { display: inline-flex; align-items: center; justify-content: center; background: none;
          border: 0; padding: 0; margin: 0; width: 17px; height: 17px; color: ${BRAND}; opacity: 0.75;
          cursor: pointer; border-radius: 50%; transition: opacity .15s ease, transform .15s ease;
          transform: translateY(-1px); }
        .ob-tooltip-trigger svg { width: 17px; height: 17px; display: block; }
        .ob-tooltip-trigger:hover, .ob-tooltip-trigger:focus-visible { opacity: 1; }
        .ob-tooltip-trigger:focus-visible { outline: 2px solid ${BRAND}; outline-offset: 2px; }
        .ob-tooltip-bubble { position: absolute; left: 50%; bottom: calc(100% + 10px); transform: translateX(-50%);
          width: 240px; max-width: 76vw; padding: 12px 14px; border-radius: 12px; background: #1c1116; color: #fdf0f6;
          font-size: 13px; line-height: 1.45; text-align: left; box-shadow: 0 12px 30px rgba(0,0,0,0.22); z-index: 40; }
        .ob-tooltip-bubble a { color: #f9b9d6; text-decoration: underline; text-underline-offset: 2px; font-weight: 600; }
        .ob-tooltip-bubble a:hover { color: #fff; }
        .ob-tooltip-bubble::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
          border: 6px solid transparent; border-top-color: #1c1116; }
        /* Edge-anchored variant: for triggers near the right edge (e.g. page-3 tiers),
           pin the bubble's right edge to the trigger so it can't overflow the viewport. */
        .ob-tooltip-bubble-right { left: calc(100% + 12px); right: auto; bottom: auto; top: 50%; transform: translateY(-50%); z-index: 60; }
        .ob-tooltip-bubble-right::after { top: 50%; left: -6px; right: auto; transform: translateY(-50%);
          border-width: 6px 6px 6px 0; border-color: transparent #1c1116 transparent transparent; }
        /* tier CTAs (page 3): map straight onto the two rows above */
        .ob-tier-ctas { display: flex; gap: 12px; width: 100%; max-width: 460px; margin: 16px auto 0; }
        /* flex-basis auto (not 0) so each pill is at least as wide as its icon + label +
           padding — the longer "Proof of Clean Hands" can never be crushed below its
           content and overflow (#445). grow:1 still lets both expand to fill the row so
           they stay visually balanced. */
        .ob-pill { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; gap: 8px;
          height: 44px; padding: 0 22px; border-radius: 999px; font-size: 14px; font-weight: 610;
          text-decoration: none; white-space: nowrap;
          transition: transform .15s ease, filter .15s ease, background-color .15s ease; }
        .ob-pill-primary { background: ${BRAND}; color: #fff; }
        .ob-pill-primary:hover { transform: translateY(-1px); filter: brightness(1.08); }
        .ob-pill-outline { background: transparent; border: 1px solid #eccfdc; color: ${BRAND}; }
        .ob-pill-outline:hover { background: rgba(129,19,59,0.06); }
        /* bridge preview card (page 2) */
        .ob-bp { display: flex; align-items: center; width: 100%; max-width: 420px; margin: 22px auto 0;
          padding: 16px 18px; border: 1px solid #f0d3e0; border-radius: 16px; background: rgba(255,255,255,0.55); }
        .ob-bp-col { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; }
        .ob-bp-chain { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: #987f8a;
          font-weight: 620; white-space: nowrap; }
        .ob-bp-amount { font-size: 13.5px; font-weight: 640; padding: 5px 10px; border-radius: 999px;
          border: 1px solid #f0d3e0; background: #fff; white-space: nowrap; }
        .ob-bp-amount-public { color: ${BRAND}; border-color: rgba(129,19,59,0.25); }
        .ob-bp-amount-private { color: #5a4650; border-style: dashed; letter-spacing: 0.1em; }
        .ob-bp-track { flex: none; width: 72px; height: 32px; position: relative; display: flex;
          align-items: center; justify-content: center; }
        .ob-bp-line { position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: rgba(129,19,59,0.22); }
        .ob-bp-dot { position: absolute; top: 50%; width: 6px; height: 6px; border-radius: 50%; background: ${BRAND};
          transform: translate(-50%, -50%); box-shadow: 0 0 8px rgba(129,19,59,0.45); }
        .ob-bp-lock { position: relative; z-index: 1; width: 32px; height: 32px; border-radius: 10px;
          background: rgba(129,19,59,0.08); display: flex; align-items: center; justify-content: center; }
        .ob-bp-lock svg { width: 18px; height: 18px; }
        .ob-bp-lock-glow { position: absolute; inset: -6px; border-radius: 14px; z-index: -1;
          background: radial-gradient(circle, rgba(129,19,59,0.35), transparent 70%); filter: blur(6px); }
        /* zk proof pulse (page 4) */
        .ob-zk { margin: 20px auto 0; display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .ob-zk-svg { display: block; }
        .ob-zk-caption { font-size: 12px; color: #987f8a; letter-spacing: 0.01em; }
        .ob-controls { position: relative; z-index: 3; width: 100%; display: flex; flex-direction: column;
          align-items: center; gap: 16px; }
        .ob-btns { width: 100%; max-width: 420px; display: flex; gap: 12px; }
        .ob-next { flex: 1; height: 54px; border: 0; border-radius: 14px; background: ${BRAND}; color: #fff;
          font-size: 16px; font-weight: 620; cursor: pointer; transition: transform .15s ease, filter .15s ease; }
        .ob-next:hover { transform: translateY(-1px); filter: brightness(1.08); }
        .ob-back { height: 54px; padding: 0 22px; border: 1px solid #eccfdc; border-radius: 14px; background: transparent;
          color: #5a4650; font-size: 16px; font-weight: 560; cursor: pointer; }
        .ob-back:hover { background: rgba(129,19,59,0.05); }
        .ob-secured { font-size: 12.5px; color: #987f8a; margin: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; justify-content: center; }
        .ob-secured strong { color: #5a4650; font-family: 'PP Hatton', 'Suisse Intl', sans-serif; font-weight: 600; }
        /* human.tech icon + wordmark, painted from the shared SVG via mask so it inherits the
           .ob-secured strong colour rules (light / dark / splash) instead of a fixed black.
           align-self centres the mark on the line under the container's baseline alignment. */
        .ob-htmark { display: inline-block; width: 61px; height: 15px; align-self: center; background-color: currentColor;
          -webkit-mask: url(${publicAsset('/assets/svg/human.tech.logo.svg')}) no-repeat center / contain;
          mask: url(${publicAsset('/assets/svg/human.tech.logo.svg')}) no-repeat center / contain; }
        .ob-dot { opacity: 0.5; }
        /* #157: splash trust-line footer, pinned to the bottom of the splash. */
        .ob-splash-footer { position: relative; z-index: 3; padding: 0 24px 20px; display: flex; justify-content: center; }
        /* Secondary, subordinate developer CTA on the splash — a quiet text link beneath the
           primary "Enter app" button, deliberately far lighter than the solid maroon CTA. */
        .ob-dev-cta { display: inline-flex; align-items: center; gap: 6px; margin: -2px auto 0; color: ${BRAND};
          font-size: 13.5px; font-weight: 550; text-decoration: none; opacity: 0.85;
          transition: opacity .15s ease, gap .15s ease; }
        .ob-dev-cta:hover { opacity: 1; gap: 8px; text-decoration: underline; text-underline-offset: 3px; }
        .ob-dev-cta svg { flex: none; }
        /* cryptex hero — concentric dial rings framing the headline. max-height keeps the
           full-size mark from overflowing the fixed region on short viewports (it scales
           down with the region rather than being clipped or shrunk at its base size). */
        .ob-cryptex-hero { position: relative; width: 100%; max-width: 500px; max-height: calc(100% - 40px);
          aspect-ratio: 1 / 1; margin: 4px auto 4px; display: flex; align-items: center; justify-content: center; }
        /* The shared shell: fills the hero frame on screen 0, shrinks to a small fixed square
           for the minimized mark on screens 1-3. Framer Motion's shared layoutId animates the
           box between these two states as the user advances/goes back. */
        .ob-cryptex-shell { position: absolute; inset: 0; }
        .ob-cryptex-shell-mini { position: relative; inset: auto; width: 68px; height: 68px; }
        .ob-cryptex-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
        /* Amorphous epicenter glow: a real MeshGradient (shader) blob, blurred and radially
           masked so it reads as an organic ripple of light breathing behind the headline. */
        .ob-epicenter { position: absolute; top: 47%; left: 50%; width: 360px; height: 360px;
          transform: translate(-50%, -50%); z-index: 0; border-radius: 50%; overflow: hidden;
          opacity: 0.44; filter: blur(28px); pointer-events: none;
          -webkit-mask: radial-gradient(circle, #000 22%, transparent 66%);
          mask: radial-gradient(circle, #000 22%, transparent 66%); }
        .ob-headline { position: relative; z-index: 1; padding: 0 28px; text-align: center; }
        .ob-headline .ob-title { max-width: 17ch; }
        /* handoff splash */
        .ob-handoff { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center;
          background: radial-gradient(#FDE7F3, #ffffff); }
        .ob-handoff-mark { display: grid; place-items: center; }
        @media (max-width: 640px) {
          .ob-stage { padding: 14px 20px; }
          .ob-stage-inner { gap: 22px; }
          /* On mobile the cryptex is narrower, so a text-heavy screen (page 4) is tallest;
             size the region to fit it, page 1 then centers with room to spare. */
          .ob-card-region { height: clamp(420px, 66vh, 470px); }
          .ob-visual { height: 62px; margin-bottom: 14px; }
          .ob-mini-pin { height: 60px; top: 18px; }
          .ob-card-top { padding-top: 90px; }
          .ob-cryptex-hero { max-width: 300px; }
          .ob-cryptex-shell-mini { width: 58px; height: 58px; }
          .ob-headline { padding: 0 20px; }
          .ob-title { font-size: 27px; }
          .ob-title-zk { max-width: none; }
          .ob-body { font-size: 15.5px; }
          .ob-tiers { max-width: 100%; }
          .ob-tier-row { padding: 14px 16px; gap: 12px; }
          .ob-tooltip-bubble { width: 210px; }
          .ob-tier-ctas { max-width: 100%; margin-top: 12px; }
          .ob-pill { height: 40px; padding: 0 16px; font-size: 13px; }
          .ob-bp { max-width: 100%; margin-top: 16px; padding: 13px 12px; }
          .ob-bp-chain { font-size: 10px; }
          .ob-bp-amount { font-size: 12.5px; padding: 4px 8px; }
          .ob-bp-track { width: 52px; }
          .ob-zk { margin-top: 14px; }
          .ob-zk-svg { width: 120px; height: 44px; }
          .ob-splash-footer { padding: 0 20px 16px; }
        }
        @media (prefers-color-scheme: dark) {
          .ob-root { background: #150a0f; color: #f6ecf1; }
          .ob-grain { mix-blend-mode: screen; opacity: 0.06; }
          .ob-veil { background:
            radial-gradient(120% 90% at 50% 46%, rgba(21,10,15,0.52), rgba(21,10,15,0) 70%),
            linear-gradient(180deg, rgba(21,10,15,0.30), rgba(21,10,15,0.70)); }
          .ob-body { color: #e6d0dc; } .ob-body strong { color: #f6ecf1; }
          .ob-back { color: #cba7b6; border-color: #3a2530; }
          .ob-skip { color: #c9adb9; } .ob-skip:hover { color: #f0dbe6; }
          .ob-secured { color: #b89aa6; } .ob-secured strong { color: #e6d0dc; }
          /* #81133B is too close to the dark maroon field to read; use the palette's pink accent. */
          .ob-dev-cta, .ob-eyebrow { color: #f2b7d3; }
          .ob-tiers { border-color: #3a2530; background: rgba(255,255,255,0.03); }
          .ob-tier-row + .ob-tier-row { border-top-color: #3a2530; }
          .ob-tier-icon { background: rgba(246,236,241,0.08); }
          .ob-tier-icon .ob-brandlogo { color: #f2b7d3; }
          .ob-tier-copy strong { color: #f6ecf1; }
          .ob-tier-copy span { color: #cba7b6; }
          .ob-tooltip-bubble { background: #f6ecf1; color: #1c1116; }
          .ob-tooltip-bubble::after { border-top-color: #f6ecf1; }
          .ob-tooltip-bubble-right::after { border-color: transparent #f6ecf1 transparent transparent; }
          .ob-tooltip-bubble a { color: ${BRAND}; }
          .ob-tooltip-bubble a:hover { color: #4d051f; }
          .ob-handoff { background: radial-gradient(#2a141f, #150a0f); }
          .ob-pill-outline { border-color: #3a2530; color: #f2b7d3; }
          .ob-pill-outline:hover { background: rgba(246,236,241,0.06); }
          .ob-bp { border-color: #3a2530; background: rgba(255,255,255,0.03); }
          .ob-bp-chain { color: #cba7b6; }
          .ob-bp-amount { border-color: #3a2530; background: rgba(246,236,241,0.04); color: #f6ecf1; }
          .ob-bp-amount-public { color: #f2b7d3; border-color: rgba(242,183,211,0.3); }
          .ob-bp-amount-private { color: #cba7b6; }
          .ob-bp-line { background: rgba(242,183,211,0.22); }
          .ob-bp-lock { background: rgba(246,236,241,0.08); }
          .ob-zk-caption { color: #cba7b6; }
        }
        /* The splash is the pre-app marketing screen: it must always read as the light
           pink branded field — same look whether Privacy Mode is default-on or off, and
           regardless of the OS colour scheme. The privacy dark background lives at z-0,
           far below this z-100 opaque overlay, so it can't bleed through; the darkening
           came from the splash's OWN dark-scheme styling above. Pin every splash surface
           to its light values (these beat the dark-scheme rules on specificity, in both
           schemes) so the splash and its light-styled nav (#94) stay consistent and
           readable. The first-visit flow keeps its dark-scheme support (it's fully
           covered by this overlay, never shown against the lifted nav). */
        .ob-root.ob-splash { background: #fff6fa; color: #1c1116; }
        .ob-root.ob-splash .ob-veil { background: linear-gradient(180deg, rgba(255,246,250,0.38), rgba(255,246,250,0.78)); }
        .ob-root.ob-splash .ob-grain { mix-blend-mode: multiply; opacity: 0.05; }
        .ob-root.ob-splash .ob-body { color: #5a4650; }
        .ob-root.ob-splash .ob-body strong { color: #1c1116; }
        .ob-root.ob-splash .ob-secured strong { color: #5a4650; }
        .ob-root.ob-splash .ob-dev-cta { color: ${BRAND}; }
      `}</style>
    </AnimatePresence>
  )
}
