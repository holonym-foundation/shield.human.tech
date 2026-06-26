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

export function captureBridgeInitiated(props: {
  token: string
  amount: string
  fuel_enabled: boolean
}) {
  if (typeof window === 'undefined') return
  posthog.capture('bridge.initiated', props)
}

export function captureBridgeCompleted(props: {
  token: string
  l1_tx_hash?: string | null
  l2_tx_hash?: string | null
}) {
  if (typeof window === 'undefined') return
  posthog.capture('bridge.completed', props)
}
