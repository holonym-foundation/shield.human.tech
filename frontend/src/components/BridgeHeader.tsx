import React from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Icon } from '@iconify/react'
import LoadingBar from './LoadingBar'
import { useBridgeStore } from '@/stores/bridgeStore'
import { SIGNATURE_NEEDED_KEY, useWalletStore } from '@/stores/walletStore'
import { useNotificationsStore } from '@/stores/useNotificationsStore'
import { useL1TokenBalance } from '@/hooks/useL1Operations'
import { useL2TokenBalance } from '@/hooks/useL2Operations'

interface BridgeHeaderProps {
  /** Title shown in the header pill. State-dependent so the shared chrome is
   *  expressive per screen ("BRIDGE" on the bridge, "TOP UP" on /fee-juice, etc.). */
  title?: string
}

// High-priority alert presentation, keyed off the notification type. Tints match
// the Messages feed (NotificationsDrawer's ICON_TINT) so the ticker and the row it
// links to read as the same alert. The header pill is white in both light and
// Privacy Mode, so these on-white tints hold in either theme.
const ALERT_META: Record<'warning' | 'error', { icon: string; className: string }> = {
  warning: { icon: 'ph:warning-circle-fill', className: 'text-[#7A4A00] bg-[#FFF1D6]' },
  error: { icon: 'ph:x-circle-fill', className: 'text-[#831816] bg-[#FFEBEB]' },
}

// Transient "keep this page open so your funds stay recoverable" safety banners,
// keyed by their stable feed key. These are only meaningful while a transfer is
// genuinely mid-flight — a state that only ever exists on the progress screens
// (the flow navigates to /progress before the SDK emits DO_NOT_RELOAD). The feed
// is persisted, so a banner from a prior transfer can survive a reload; gating it
// to the progress routes keeps a stale one from surfacing anywhere else (the idle
// bridge, Activity, Fee Juice, Docs…) while still letting it show in-context.
const SAFETY_BANNER_KEYS = new Set(['l1-to-l2-do-not-reload', 'l2-to-l1-do-not-reload'])

// The only routes where a transfer can genuinely be in progress. The do-not-reload
// / funds-recoverable safety banners are relevant ONLY here; everywhere else they
// are out of context and must not surface in the ticker. Allowlist, not denylist —
// a new idle screen is safe by default.
const PROGRESS_PATHS = new Set(['/progress', '/progress/resume'])

// Surface "Refreshing…" for at most this long, then force it off even if the
// balance query is still in flight. The balance hooks poll on a 30s/60s
// refetchInterval, so `isFetching` re-asserts on every routine background poll;
// on a slow node that read as a permanent, stuck "Refreshing…". Capping the
// visible window keeps it a brief, honest heads-up that never sits indefinitely.
const REFRESH_VISIBLE_CAP_MS = 5000

// Open the Messages feed by clicking the same tab the peek bubble / binder tab
// toggle. Both the rail and dock NotificationsDrawer mount their tab, but only
// one is visible per breakpoint (the other sits inside a `display:none` wrapper,
// so its offsetParent is null). Click just the visible one.
const openMessages = () => {
  document.querySelectorAll<HTMLElement>('[data-messages-tab]').forEach((el) => {
    if (el.offsetParent !== null) el.click()
  })
}

const BridgeHeader: React.FC<BridgeHeaderProps> = ({ title = 'BRIDGE' }) => {
  const router = useRouter()
  const pathname = usePathname()
  const {
    getHeaderSteps,
    getProgressSteps,
    headerStep,
    setHeaderStep
  } = useBridgeStore()

  const {
    isWaapConnected,
    isAztecConnected,
    pendingSignature
  } = useWalletStore()

  // Inline "refreshing balances" status, sourced from the SAME balance-query
  // fetching flags BalanceCard derives its own spinner from. react-query dedupes
  // these subscriptions, so reading the hooks here adds no extra network calls.
  const { isFetching: l1TokenIsFetching } = useL1TokenBalance()
  const { isFetching: l2IsFetching } = useL2TokenBalance()
  const isRefreshing = l1TokenIsFetching || l2IsFetching

  // Bounded mirror of `isRefreshing`. Shows when a fetch starts, but a hard cap
  // forces it off so a long-running or perpetually-repolling query can never look
  // stuck. Hides immediately if the fetch finishes before the cap.
  const [showRefreshing, setShowRefreshing] = React.useState(false)
  const refreshCapRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    if (isRefreshing) {
      setShowRefreshing(true)
      if (!refreshCapRef.current) {
        refreshCapRef.current = setTimeout(() => {
          setShowRefreshing(false)
          refreshCapRef.current = null
        }, REFRESH_VISIBLE_CAP_MS)
      }
    } else {
      setShowRefreshing(false)
      if (refreshCapRef.current) {
        clearTimeout(refreshCapRef.current)
        refreshCapRef.current = null
      }
    }
    return () => {
      if (refreshCapRef.current) {
        clearTimeout(refreshCapRef.current)
        refreshCapRef.current = null
      }
    }
  }, [isRefreshing])

  // Most-recent active (undismissed) high-priority alert. The feed is newest-first
  // (the store prepends), and `dismiss` removes rows, so the first warning/error
  // still in the list is the current alert. The found object reference is stable
  // across renders until it changes, so this selector doesn't churn.
  //
  // Two context gates decide what the ticker is allowed to surface:
  //  1. The in-progress-only "Do not reload" safety banners show ONLY on the
  //     progress routes (an allowlist). Everywhere else — the idle bridge,
  //     Activity, Fee Juice, Docs… — they are out of context and skipped, so the
  //     ticker falls through to the next genuine alert, or to nothing.
  //  2. Rows restored from localStorage (`rehydrated`) are a prior session's
  //     alerts; the ticker ignores them so a fresh bridge never force-surfaces
  //     yesterday's error. They remain in the Messages feed, and a new in-session
  //     event clears the flag (store keyed upsert), so live alerts still show.
  const isProgressRoute = PROGRESS_PATHS.has(pathname)

  // A finished, successful transfer must not have a stale in-session error hovering
  // over it. ProgressCard marks every progress step 'completed' on success (its own
  // isAllComplete); reading the same store slice lets the ticker fall silent once the
  // /progress screen shows its completed/success state. This is a separate case from
  // the rehydrated and route gates: the offending error fired in-session, and the
  // completed state lives on /progress (so neither of those gates catches it).
  const progressSteps = getProgressSteps()
  const isTransferComplete =
    progressSteps.length > 0 && progressSteps.every((st) => st.status === 'completed')
  const suppressCompletedAlerts = isProgressRoute && isTransferComplete

  const rawAlert = useNotificationsStore((s) =>
    s.notifications.find(
      (n) =>
        (n.type === 'warning' || n.type === 'error') &&
        !n.rehydrated &&
        !(!isProgressRoute && n.key !== undefined && SAFETY_BANNER_KEYS.has(n.key)),
    ),
  )

  // While a wallet signature is pending it is the STICKY, top-priority ticker
  // alert — a missed wallet popup is the top abandonment driver (#408/#417). It's
  // the keyed `warning` row the wallet store pushes; selecting it by key keeps it
  // winning even if a newer warning/error arrives. It never lingers on an idle
  // bridge: the store retires the row by key the instant the signature resolves
  // (so pendingSignature and this row clear together), consistent with the
  // ticker-state gates (#346/#350/#351/#366).
  const signatureAlert = useNotificationsStore((s) =>
    s.notifications.find((n) => n.key === SIGNATURE_NEEDED_KEY),
  )
  const currentAlert =
    pendingSignature && signatureAlert
      ? signatureAlert
      : suppressCompletedAlerts
        ? undefined
        : rawAlert
  const alertMeta = currentAlert ? ALERT_META[currentAlert.type as 'warning' | 'error'] : null
  const isAlertActive = !!(currentAlert && alertMeta)

  // Dismiss the message currently shown in the ticker. A keyed row (e.g. a
  // repeating progress ping) is retired by key so all of its copies clear at once;
  // an un-keyed one-off is removed by id. Either way it leaves the feed, so the
  // ticker falls through to the next genuine alert and the dismissed one does not
  // pop back into the bar.
  const dismiss = useNotificationsStore((s) => s.dismiss)
  const dismissByKey = useNotificationsStore((s) => s.dismissByKey)
  const dismissCurrentAlert = React.useCallback(() => {
    if (!currentAlert) return
    if (currentAlert.key !== undefined) dismissByKey(currentAlert.key)
    else dismiss(currentAlert.id)
  }, [currentAlert, dismiss, dismissByKey])

  // Single-line ticker text. Message adds context after the title when present;
  // middot keeps it one glanceable line (no em-dashes per house style).
  const tickerText = currentAlert
    ? currentAlert.message
      ? `${currentAlert.title} · ${currentAlert.message}`
      : currentAlert.title
    : ''

  // Live remaining-time for an in-progress transfer, streamed from ProgressCard via a window
  // event. ProgressCard is a sibling (not a parent) and the shared store is off-limits, so the
  // countdown crosses over here. When a countdown is live it takes the left slot in place of the
  // decorative glyph; otherwise the glyph returns. The progress screen clears it on unmount.
  // `remaining` is the numeric "MM:SS" while the estimate is counting down; once it
  // reaches 0 the number is dropped and `label` carries a reassuring copy instead
  // ("Any moment now" / "Taking a little longer") so the timer never freezes at
  // ~00:00 (#407). Exactly one of the two is set while a transfer is in progress.
  const [remainingTime, setRemainingTime] = React.useState<string | null>(null)
  const [timerLabel, setTimerLabel] = React.useState<string | null>(null)
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ remaining: string | null; label?: string | null }>).detail
      setRemainingTime(detail?.remaining ?? null)
      setTimerLabel(detail?.label ?? null)
    }
    window.addEventListener('shield:progress-timer', handler as EventListener)
    return () => window.removeEventListener('shield:progress-timer', handler as EventListener)
  }, [])
  // The timer occupies its slot whenever either form is present. All the "is a
  // transfer live?" chrome gates (glyph, Activity shortcut) key off this, not the
  // numeric value, so they stay correct through the zero/overrun handoff.
  const timerActive = remainingTime !== null || timerLabel !== null

  // Update step statuses based on wallet connections
  React.useEffect(() => {
    if (isWaapConnected) {
      setHeaderStep(1, 'completed')
    } else {
      setHeaderStep(1, 'pending')
    }

    if (isAztecConnected) {
      setHeaderStep(2, 'completed')
    } else {
      setHeaderStep(2, 'pending')
    }
  }, [isWaapConnected, isAztecConnected, setHeaderStep])

  const steps = getHeaderSteps()

  // No `whitespace-nowrap`: the alert wraps to as many lines as it needs (#2148).
  // The marquee this replaced masked 12px at both ends and looped across a seam, so
  // users read fragments like "rivate fee juice to keep your clai" and never the
  // whole sentence — on the two screens where the message is the only guidance.
  const tickerTextClass =
    "break-words text-[12px] font-[600] leading-[17px] tracking-[0.2px] font-['Suisse_Intl']"

  // The live countdown owns its own shrink-0 slot at the head of the bar, rendered
  // independently of the alert ticker. During a transfer an active warning/error would
  // otherwise take over the whole bar and hide the timer; keeping the timer in a dedicated
  // slot lets the countdown and the ticker coexist so the estimate is always visible.
  const timerSlot = timerActive ? (
    <div
      className='flex shrink-0 items-center gap-[4px]'
      role='timer'
      aria-label={remainingTime ? `Estimated time remaining ${remainingTime}` : (timerLabel ?? 'Finishing your transfer')}
      title={remainingTime ? 'Estimated time remaining' : 'Finishing your transfer'}
    >
      <Icon
        icon='ph:clock-countdown'
        width={18}
        height={18}
        className='shrink-0 animate-pulse text-[#0A0A0A] motion-reduce:animate-none'
      />
      {remainingTime ? (
        <span className="text-[13px] font-[600] leading-[16px] tracking-[0.2px] tabular-nums text-[#0A0A0A] font-['Suisse_Intl']">
          ~{remainingTime}
        </span>
      ) : (
        <span className="whitespace-nowrap text-[13px] font-[600] leading-[16px] tracking-[0.2px] text-[#0A0A0A] font-['Suisse_Intl']">
          {timerLabel}
        </span>
      )}
    </div>
  ) : null

  return (
    // While an alert is active the bar holds a wrapped, multi-line message, so the
    // 136px pill radius would render it as a lozenge. It softens to a rounded rect
    // and top-aligns its controls for the duration; the idle bar is unchanged.
    <div
      className={`flex w-full min-w-0 gap-[12px] border border-[#D4D4D4] bg-white px-[16px] pl-[8px] ${
        isAlertActive
          ? 'items-start rounded-[16px] py-[6px]'
          : 'items-center rounded-[136px] py-[4px]'
      }`}
    >
      {timerSlot}
      {isAlertActive && alertMeta ? (
        // ACTIVE: a live warning/error message takes over the bar as a compact
        // single-line ticker. The brain glyph and the "BRIDGE" label are hidden to
        // make room. The message area is one tap target that opens Messages; a
        // trailing close control lets the user dismiss the alert (kept as a sibling
        // button, not nested, so it stays a valid, separately-focusable target).
        <div
          className={`group flex min-w-0 flex-1 items-start gap-[6px] rounded-[12px] py-[8px] pl-[12px] pr-[8px] ${alertMeta.className}`}
        >
          <button
            type='button'
            onClick={openMessages}
            aria-label={`${currentAlert!.type === 'error' ? 'Error' : 'Warning'}: ${tickerText}. Open messages`}
            className='flex min-w-0 flex-1 items-start gap-[8px] rounded-[8px] text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A0A0A]/[0.2]'
          >
            <Icon
              icon={alertMeta.icon}
              width={14}
              height={14}
              // Aligned to the first line's optical centre rather than the block, so a
              // three-line message doesn't centre the glyph against line two.
              className='mt-[2px] shrink-0 animate-pulse motion-reduce:animate-none'
            />
            <span aria-hidden='true' className={`min-w-0 flex-1 ${tickerTextClass}`}>
              {tickerText}
            </span>
          </button>
          <button
            type='button'
            onClick={dismissCurrentAlert}
            aria-label='Dismiss message'
            className='mt-[1px] flex shrink-0 items-center justify-center rounded-full p-[3px] transition-colors hover:bg-[#0A0A0A]/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0A0A0A]/[0.2]'
          >
            <Icon icon='ph:x-bold' width={12} height={12} className='shrink-0' />
          </button>
        </div>
      ) : (
        // IDLE: the glyph (only when the countdown slot is empty) + progress bar + "BRIDGE" label.
        <>
          {!timerActive && (
            <img
              src='/assets/svg/human.aztec.svg'
              alt=''
              className='h-[24px] w-[24px] shrink-0'
            />
          )}

          <LoadingBar steps={steps} currentStep={headerStep} />

          <div className='flex min-w-0 items-center'>
            <p className="shrink-0 cursor-default text-center text-[#0A0A0A] font-[700] text-[16px] leading-[24px] tracking-[0.32px] uppercase font-['Suisse_Intl']">
              {title}
            </p>
            {/* Balance-refresh status. Collapses to zero width when idle (no layout
                shift), fades + expands into the empty space beside the title while a
                balance query is fetching. Bounded by REFRESH_VISIBLE_CAP_MS so it
                can never sit visibly "Refreshing…" indefinitely. Spinner holds still
                under reduced motion. */}
            <span
              role='status'
              aria-live='polite'
              aria-hidden={!showRefreshing}
              className={`flex items-center overflow-hidden whitespace-nowrap transition-all duration-300 ease-out ${
                showRefreshing ? 'ml-[8px] max-w-[140px] opacity-100' : 'ml-0 max-w-0 opacity-0'
              }`}>
              <Icon
                icon='ph:spinner-gap-bold'
                width={12}
                height={12}
                className='shrink-0 animate-spin motion-reduce:animate-none text-[#737373]'
              />
              <span className="ml-[4px] text-[11px] font-[500] leading-[16px] tracking-[0.2px] text-[#737373] font-['Suisse_Intl']">
                Refreshing…
              </span>
            </span>
          </div>
        </>
      )}
      {/* History / Activity shortcut. While a transfer is actively in progress the
          countdown is live (`remainingTime`), and this would be a click-away trap
          that abandons the in-flight transfer — so it is removed for the duration.
          On idle screens it stays as a useful shortcut. */}
      {!timerActive && (
        <button
          onClick={() => router.push('/activity')}
          className='ml-auto flex items-center justify-center p-1 rounded-full hover:bg-gray-100 transition-colors'
          aria-label='Bridge activity'
        >
          <Icon icon='ph:clock-counter-clockwise' width={20} height={20} className='text-[#0A0A0A]' />
        </button>
      )}
    </div>
  )
}

export default BridgeHeader
