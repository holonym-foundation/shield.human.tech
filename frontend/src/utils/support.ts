import { useNotificationsStore } from '@/stores/useNotificationsStore'

// The Iris support widget (src/app/layout.tsx, data-iris-key="shield") renders its
// launcher and panel inside a CLOSED shadow root (host id "iris-widget-host"), and it
// exposes no global API today. So there is no guaranteed programmatic open. We try, in
// order: a global control object (future-proof / in case a build adds one), an OPEN
// shadow root we can reach into, then any launcher the widget left in the light DOM.
// Every branch is guarded so a missing widget is a silent no-op rather than a throw.
export function openSupport(): boolean {
  if (typeof window === 'undefined') return false

  // 1. A control object on the global, if a future widget build exposes one.
  const globals = [(window as any).Iris, (window as any).IrisWidget, (window as any).iris]
  for (const g of globals) {
    const fn = g?.open ?? g?.show ?? g?.toggle
    if (typeof fn === 'function') {
      try {
        fn.call(g)
        return true
      } catch {
        /* fall through to the DOM paths */
      }
    }
  }

  // 2. Reach the launcher through the widget host. The widget itself requests a CLOSED
  //    root; src/app/layout.tsx intercepts that call and forces it open, which is what
  //    makes this path reachable. Still guarded in case that interception ever misses.
  try {
    const host = document.getElementById('iris-widget-host') as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null
    const root = host?.shadowRoot
    if (root) {
      const bubble = root.querySelector<HTMLElement>('.iris-bubble, [aria-label="Open chat"]')
      if (bubble) {
        bubble.click()
        return true
      }
    }
  } catch {
    /* fall through */
  }

  // 3. Any launcher the widget injected into the light DOM.
  try {
    const el = document.querySelector<HTMLElement>('.iris-bubble, [data-iris-launcher], [aria-label="Open chat"]')
    if (el) {
      el.click()
      return true
    }
  } catch {
    /* no-op */
  }

  return false
}

// Whether the support widget can be opened programmatically RIGHT NOW, decided
// WITHOUT opening it. Mirrors the reachable paths openSupport() would take: a
// callable global control method, a launcher the widget left in the light DOM, or
// an OPEN shadow root on the host. Used to decide whether it's safe to hide the
// native floating launcher — we only hide it when support stays reachable through
// the Support tab (shield.human.tech#86). SSR-guarded.
export function isSupportOpenable(): boolean {
  if (typeof window === 'undefined') return false

  // 1. A callable control method on the global (future widget build).
  const globals = [(window as any).Iris, (window as any).IrisWidget, (window as any).iris]
  for (const g of globals) {
    const fn = g?.open ?? g?.show ?? g?.toggle
    if (typeof fn === 'function') return true
  }

  try {
    // 2. A launcher the widget injected into the light DOM is clickable now.
    if (document.querySelector('.iris-bubble, [data-iris-launcher], [aria-label="Open chat"]')) return true

    // 3. An OPEN shadow root on the host exposes a reachable launcher.
    const host = document.getElementById('iris-widget-host') as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null
    if (host?.shadowRoot) return true
  } catch {
    return false
  }

  return false
}

/** Stable feed key for the "transfer stuck" escalation, one per operation. */
export function stuckNotificationKey(opId: string): string {
  return `stuck-${opId}`
}

// Keep the raw revert readable in a feed row: collapse whitespace and cap length so a
// multi-line SDK error doesn't blow out the message.
function trimErrorForFeed(error: string, max = 140): string {
  const clean = error.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

// Escalate a repeatedly-stuck transfer into the Messages feed (SOP: notices live in the
// feed / peek, never the app-shell ProgressCard). Keyed by op so it updates in place
// instead of spamming a new row on every failed resume. type:'warning' auto-surfaces in
// the round-6 mini-bar status chip, so this one push carries both the detail and the chip.
export function pushStuckEscalation(opId: string, errorText: string): void {
  const trimmed = trimErrorForFeed(errorText)
  useNotificationsStore.getState().pushNotification({
    type: 'warning',
    key: stuckNotificationKey(opId),
    title: 'Transfer stuck',
    message: `This transfer hasn't completed after several attempts. Your funds are safe. Reach us via the chat bubble in the bottom-right corner.${
      trimmed ? ` Error: ${trimmed}` : ''
    }`,
    action: { label: 'Contact support', onClick: openSupport },
  })
}

/** Clear the stuck escalation for an op once it eventually succeeds. */
export function dismissStuckEscalation(opId: string): void {
  const store = useNotificationsStore.getState()
  const key = stuckNotificationKey(opId)
  const existing = store.notifications.find((n) => n.key === key)
  if (existing) store.dismiss(existing.id)
}
