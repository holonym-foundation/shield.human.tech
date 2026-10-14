import posthog from 'posthog-js'
import { POSTHOG_KEY, POSTHOG_HOST } from '@/config/env.config'

export function init() {
  if (typeof window === 'undefined' || !POSTHOG_KEY) return

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    autocapture: true,
    // Keep 'history_change' (a superset of `true`) so SPA route changes are
    // also captured as pageviews — important for the bridge funnel.
    capture_pageview: 'history_change',
    capture_pageleave: true, // scroll depth
    enable_heatmaps: true, // heatmaps + click/scroll maps
    disable_session_recording: true, // NO replay — this is a funds/bridge flow
    persistence: 'localStorage+cookie',
  })

  // Behavioral analytics standard — APP surface super-properties.
  posthog.register({
    site: 'bridge',
    product: 'bridge',
    surface_type: 'app',
  })
}

// `token_symbol`, not `token`: PostHog reserves `token` for the project API key
// in the event payload and overwrites any property of that name. Every
// bridge.initiated event ever sent recorded the project key instead of the
// symbol, so the analytics had no usable token breakdown at all.
export function captureBridgeInitiated(props: { token_symbol: string; amount: string; fuel_enabled: boolean }) {
  if (typeof window === 'undefined') return
  posthog.capture('bridge.initiated', props)
}

// No L2 transaction hash. An L2 hash ties an analytics identity to the Aztec
// side of a deposit, which for a privacy-mode bridge is precisely the link the
// feature exists to prevent — and it was sent identically whether or not
// privacy mode was on. Session recording is disabled on this flow for the same
// reason; this closes the gap that was left open beside it.
//
// The L1 hash stays: it is the join key behind source attribution on the
// dashboard, and an L1 deposit is a public transaction either way. It still
// links a PostHog session to an L1 address, so it is a deliberate trade rather
// than a safe default — drop it here if that trade stops being worth it.
export function captureBridgeCompleted(props: { token_symbol: string; l1_tx_hash?: string | null }) {
  if (typeof window === 'undefined') return
  posthog.capture('bridge.completed', props)
}
