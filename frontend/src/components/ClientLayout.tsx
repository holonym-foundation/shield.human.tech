'use client'

import BannerAztecNodeError from '@/components/BannerAztecNodeError'
import BannerAztecTestnet from '@/components/BannerAztecTestnet'
import Footer from '@/components/Footer'
import Header from '@/components/Header'
import ShieldOnboarding from '@/components/ShieldOnboarding'
import BridgeStepsRail from '@/components/BridgeStepsRail'
import ActivityDrawer from '@/components/ActivityDrawer'
import NotificationsDrawer from '@/components/NotificationsDrawer'
import SupportTab from '@/components/SupportTab'
import HowItWorksModal from '@/components/model/HowItWorksModal'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useNotificationsStore } from '@/stores/useNotificationsStore'
import { useWalletStore } from '@/stores/walletStore'
import { isSupportOpenable } from '@/utils/support'
import { motion } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const { isPrivacyModeEnabled } = useBridgeStore()
  const pathname = usePathname()
  // Docs is a public, neutral reading surface: reachable without the onboarding gate and
  // rendered on a clean near-white background rather than the pink paper-shader field.
  const isDocs = pathname?.startsWith('/docs') ?? false
  // Docs is a neutral reading view — keep the light background even when privacy mode is on.
  const showPrivacyBackground = isPrivacyModeEnabled && !isDocs

  // See shield.human.tech#86 — never hide the native Iris launcher while it's the
  // only way to reach support. The Iris widget mounts client-side after hydration,
  // so poll briefly and only flip this on once the widget reports it's openable
  // (i.e. the Support tab can actually reach it). If it never becomes openable, the
  // native bubble stays visible as the working fallback.
  // #96: the Iris support service is intermittently unavailable (#379), so hide our
  // Support binder tab until it's reliable. Flip back to true once Iris is stable. While
  // off, we also stop suppressing the native Iris launcher so support isn't fully hidden.
  const SUPPORT_TAB_ENABLED = false
  // Kill switch for the native floating bubble: a support entry point that opens
  // nothing is worse than none, so flip this to false if Iris starts failing again
  // (pairs with SUPPORT_TAB_ENABLED / shield.human.tech#96).
  const IRIS_ENABLED = true
  const [hideNativeBubble, setHideNativeBubble] = useState(false)
  useEffect(() => {
    if (isSupportOpenable()) {
      setHideNativeBubble(true)
      return
    }
    const id = window.setInterval(() => {
      if (isSupportOpenable()) {
        setHideNativeBubble(true)
        window.clearInterval(id)
      }
    }, 500)
    // Stop probing after a while; a widget that never reports openable keeps its bubble.
    const stop = window.setTimeout(() => window.clearInterval(id), 15000)
    return () => {
      window.clearInterval(id)
      window.clearTimeout(stop)
    }
  }, [])

  // The notifications feed persists to localStorage but rehydrates with
  // skipHydration, so restore it once on the client — server and first client
  // render stay empty (no hydration mismatch), then prior messages reappear.
  useEffect(() => {
    void useNotificationsStore.persist.rehydrate()
  }, [])

  // Tab-title flip while a wallet signature is pending (#417): a user who tabbed
  // away is pulled back by the title. This is not a banner and never touches the
  // layout — the "signature needed" notice itself lives in the mini-bar ticker +
  // the Messages feed. Restored to the original title the moment it clears.
  const isSignaturePending = useWalletStore((s) => !!s.pendingSignature)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!isSignaturePending) return
    const original = document.title
    document.title = 'Signature needed · Shield'
    return () => {
      document.title = original
    }
  }, [isSignaturePending])

  return (
    <div
      // Static-viewport app shell (#363): pinned to exactly one viewport (h-[100dvh])
      // with overflow HIDDEN, so the page never scrolls and nothing ever spills below
      // the footer into a bare dark strip (the #347 regression — that earlier fixed-height
      // attempt lacked this clip). It is a flex column: header (top) + card region
      // (flex-grow, scrolls INTERNALLY only if the card genuinely can't fit) + footer
      // (bottom). On comfortable heights everything fits with no scroll at all — the
      // "looking through a window, see everything" experience. The clip guarantees the
      // footer is always visible and never pushed off-screen.
      className="relative flex flex-col w-full min-w-0 overflow-hidden h-[100dvh]"
      style={{ minWidth: 0 }}
    >
      {/* Onboarding is skipped on docs so the guides render without connecting a wallet. */}
      {!isDocs && <ShieldOnboarding />}
      {/* Background: a very soft white paper-shader field on docs (same MeshGradient
          treatment as the app for continuity, just near-white), pink field elsewhere.
          The white wash fades in so navigating INTO docs animates rather than cuts. */}
      {isDocs ? (
        <div className="absolute inset-0 z-0" aria-hidden="true">
          <MeshGradient
            colors={['#ffffff', '#fdfbfc', '#f8f2f7', '#f1e8f0']}
            speed={0.12}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
          <motion.div
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.78))' }}
          />
        </div>
      ) : (
        <div className="absolute inset-0 z-0" aria-hidden="true">
          <MeshGradient
            colors={['#fff6fa', '#fde7f3', '#fcd4ea', '#fa8fc4']}
            speed={0.16}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
          <motion.div
            className="absolute inset-0"
            // initial={false} renders the background at its target on mount (no
            // enter animation) so when Privacy Mode is the default the dark field
            // is applied synchronously on first paint instead of animating up
            // from light — the toggle transition on later changes is unaffected (#94).
            initial={false}
            animate={{
              background: showPrivacyBackground
                ? 'rgba(31,8,22,0.66)'
                : 'linear-gradient(180deg, rgba(255,246,250,0.30), rgba(255,246,250,0.62))',
            }}
            transition={{ duration: 0.6, ease: 'easeInOut' }}
            style={{ willChange: 'background' }}
          />
        </div>
      )}
      {/* Grain overlay */}
      {/* <motion.div
        className="absolute inset-0 z-10 pointer-events-none"
        animate={{
          opacity: isPrivacyModeEnabled ? 1 : 0,
        }}
        transition={{ duration: 0.7, ease: 'easeInOut' }}
        style={{
          backgroundImage: 'url(assets/images/bgGrain.png)',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
          willChange: 'opacity',
        }}
      /> */}
      {/* Header — kept in its own stacking wrapper so it can be lifted above the
          onboarding splash overlay (z-100) for connected users. See data-ob-splash.
          z-50 keeps the nav (banners + Header) ABOVE the binder dock (z-40) and its
          drawer panels, so an open drawer can never occlude the top nav (#318). The
          connected-splash elevation to z-130 still wins via `!important`. */}
      <div className="ob-header-elevate relative z-50 flex flex-col">
        <BannerAztecTestnet />
        <BannerAztecNodeError />
        <Header />
      </div>
      {/* Main content — a flex-grow column between header and footer. It is
          overflow-VISIBLE, not a clipped scroller: the fixed-height card is sized to
          fit this space (RootStyle: h-[min(85vh,100dvh-11rem)]), and each page scrolls
          INSIDE its own card (the card is overflow-hidden with an internal scroll
          region). A clip here (overflow-y-auto) cut the card's drop shadow off exactly
          at the footer's top edge, drawing a hard horizontal line where the card met the
          pink background (#432). With overflow-visible the shadow fades softly behind the
          transparent footer; the page still never scrolls because the root shell
          (h-[100dvh], overflow-hidden) clips any spill below the footer. */}
      <div className="relative z-20 flex flex-grow flex-col min-h-0 overflow-visible">
        <div className="flex-grow">{children}</div>
      </div>
      {/* Footer pinned to the bottom of the fixed shell (shrink-0 so it keeps its
          height). It rests at the bottom edge on every route and can never be clipped:
          when a short viewport can't fit the card, the column above scrolls under this
          footer rather than pushing it off-screen or forcing a document scroll. */}
      <div className="relative z-20 shrink-0">
        <Footer />
      </div>
      {/* Persistent binder dock: app-shell chrome mounted once, so the Tutorial /
          Activity / Messages tabs are present on EVERY route and navigation never
          drops them (their badges stay live across routes because they read global
          stores, not page state). The dock is fixed + pointer-events-none so it
          never adds page width/scroll and clicks pass through the gaps; each drawer
          re-enables its own pointer events. Tutorial sits above Activity above
          Messages; each opens its panel leftward as an absolutely-positioned
          overlay, so hovering one never reflows (splits apart) the others (#114).
          Desktop/tablet only (md+): the centered 360px card leaves no gutter on
          phones, so the tab would sit over the card edge — the mobile dock below
          takes over there. */}
      <div className="pointer-events-none fixed right-0 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-end gap-2 md:flex">
        <BridgeStepsRail />
        <ActivityDrawer />
        <NotificationsDrawer />
        {/* Only surface the Support tab once the Iris widget is actually
            openable; until then the native bubble is the working entry point and
            a tab that can't open anything would be dead. See shield.human.tech#86. */}
        {SUPPORT_TAB_ENABLED && hideNativeBubble && <SupportTab />}
      </div>
      {/* Below md the centered card leaves no right gutter, so the right-edge
          binder tabs would sit off-screen (#243). Relocate them to a compact,
          tappable dock in the bottom-LEFT corner, clear of the bottom-right
          support chat bubble. Each tab keeps its icon + badge and opens its
          panel as a bottom-anchored sheet. */}
      <div className="pointer-events-none fixed bottom-4 left-4 z-40 flex items-end gap-2 md:hidden">
        <BridgeStepsRail variant="dock" />
        <ActivityDrawer variant="dock" />
        <NotificationsDrawer variant="dock" />
        {SUPPORT_TAB_ENABLED && hideNativeBubble && <SupportTab variant="dock" />}
      </div>
      {/* See shield.human.tech#86 — hide the native Iris floating bubble ONLY once
          it's programmatically openable, so the Support tab replaces it without ever
          leaving support unreachable. Until then the native launcher stays visible. */}
      {SUPPORT_TAB_ENABLED && hideNativeBubble && (
        <style dangerouslySetInnerHTML={{ __html: '#iris-widget-host { display: none !important }' }} />
      )}
      {/* Iris disabled: pull the native bubble entirely until it's fixed. Kept as its
          own unconditional rule so it hides regardless of the Support-tab state above. */}
      {!IRIS_ENABLED && (
        <style
          dangerouslySetInnerHTML={{
            __html:
              '#iris-widget-host, .iris-bubble, [data-iris-launcher], [aria-label="Open chat"] { display: none !important }',
          }}
        />
      )}
      <HowItWorksModal />
    </div>
  )
}
