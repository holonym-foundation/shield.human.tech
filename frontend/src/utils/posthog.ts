import posthog from 'posthog-js'
import { POSTHOG_KEY, POSTHOG_HOST } from '@/config/env.config'

export function init() {
  if (typeof window === 'undefined' || !POSTHOG_KEY) return

  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: 'history_change',
    capture_pageleave: true,
    persistence: 'localStorage+cookie',
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
