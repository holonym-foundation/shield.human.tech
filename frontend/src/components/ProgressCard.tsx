'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { useCountdown } from 'usehooks-ts'
import LoadingStepsBars from '@/components/LoadingStepsBars'
import CryptexAnimation from '@/components/CryptexAnimation'
import StyledImage from '@/components/StyledImage'
import TextButton from '@/components/TextButton'
import type { LoadingStep } from '@/stores/bridgeStore'
import { STORAGE_KEYS, classifyL2Execution } from '@human.tech/clean.sdk'
import type { BridgeOperation, RecoveryClaimData, RecoveryWithdrawalData } from '@human.tech/clean.sdk'
import { exportClaimData, exportWithdrawalData, humanizeError } from '@/utils'
import { logError } from '@/utils/datadog'
import { useBridgeOperations, decryptOperationPayload } from '@/hooks/useBridgeOperations'
import { useWalletStore } from '@/stores/walletStore'
import { aztecNode } from '@/aztec'
import { TxHash } from '@aztec/stdlib/tx'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useToast } from '@/hooks/useToast'
import { isResumable, hasPossibleLockedFunds } from '@/utils/resumability'
import { useResumeAttemptsStore } from '@/stores/useResumeAttemptsStore'
import { pushNotification, dismissNotificationByKey } from '@/stores/useNotificationsStore'
import { openSupport } from '@/utils/support'
import { BridgeDirection } from '@/types/bridge'

export interface ProgressCardProps {
  steps: LoadingStep[]
  progressStep: number
  hasError: boolean
  l1TxUrl: string | null
  l2TxUrl: string | null
  estimatedTimeSeconds: number
  /** Display amount string, e.g. "10.5 USDC" */
  amountDisplay: string
  /** Optional fuel breakdown for fresh L1→L2 with fuel */
  fuelBreakdown?: { bridgeAmount: string; fuelAmount: string }
  /** From/To network titles */
  fromNetwork: string
  toNetwork: string
  /** Bridge direction — used for export button */
  direction?: 'L1_TO_L2' | 'L2_TO_L1'
  /** Raw failure text (mutation error message), when the page can surface it. Used to
      classify a Fee-Juice/gas shortfall so recovery routes to the top-up flow. */
  errorMessage?: string | null
  /** Privacy mode of THIS operation (derived from the operation/recovery data, NOT the live
      toggle). Drives the PUBLIC/PRIVATE badge so the user always knows which mode is running. */
  isPrivate?: boolean
  /** The live Privacy Mode toggle. Compared against `isPrivate` to warn when the operation the
      user is watching/resuming was created in the opposite mode from the one now selected. */
  currentPrivacyMode?: boolean
  /** Id of the operation this screen is running or resuming, when the page knows it. */
  operationId?: string | null
}

// A stuck L2 claim that can't pay its gas out of the bridged Fee Juice surfaces as a
// contract assertion / gas-cost revert. These substrings cover the shapes we've seen
// (Aztec `Assertion failed`, `max_gas_cost`, `claim_and_end_setup`) plus generic
// fee/gas/insufficient wording. Matching is intentionally broad — the recovery it
// offers (top up FJ, then resume) is safe and non-destructive even on a false positive.
const FUEL_ERROR_NEEDLES = [
  'assertion failed',
  'max_gas_cost',
  'claim_and_end_setup',
  'fee',
  'insufficient',
  'gas',
  'feejuice',
  'fuel',
]

function isFuelError(message?: string | null): boolean {
  if (!message) return false
  const m = message.toLowerCase()
  return FUEL_ERROR_NEEDLES.some((needle) => m.includes(needle))
}

// The wallet (WaaP / signer) never came back — a signature prompt was left hanging or the
// request timed out. No funds moved beyond what already confirmed, so resume is safe.
const WALLET_ERROR_NEEDLES = ['wallet did not respond', 'did not respond', 'timed out', 'timeout', 'user rejected', 'user denied']
// The L1→L2 message was already spent — the claim actually went through on a prior attempt.
// This is a "you're already done" signal, not a loss; point the user at their L2 balance.
// "No non-nullified L1 to L2 message found" (SDK #47) is the most common shape: the message
// was already consumed by a prior successful claim, so a re-run has nothing left to claim.
const CONSUMED_ERROR_NEEDLES = [
  'already consumed',
  'already claimed',
  'nullifier already',
  'existing nullifier',
  'already been consumed',
  'has already been',
  'no non-nullified',
  'non-nullified l1 to l2',
  // The fuel-claim shape (SDK FUEL_CLAIM_MESSAGE_GONE_ERROR). It deliberately avoids the
  // "already consumed" phrasing, because that would make the SDK's isAlreadyConsumedError
  // mark an undelivered deposit 'completed'. Match it here so the UI still suppresses
  // Resume and runs the receipt check rather than looping (#2146).
  'was consumed',
]

type FailureKind = 'fuel' | 'wallet' | 'consumed' | 'deposit-landed' | 'pre-deposit' | 'unknown'

interface FailureInfo {
  kind: FailureKind
  heading: string
  message: string
}

function hasNeedle(m: string, needles: string[]): boolean {
  return needles.some((n) => m.includes(n))
}

// Turn the raw mutation error into a specific, funds-safe explanation. Never "unknown error":
// the genuinely-unclassifiable branch still states funds are safe and points to Resume/support
// with the copyable error. Specific causes (wallet timeout, already-consumed) are checked before
// the broad fuel needles so a precise match always wins over the catch-all gas keywords.
function classifyFailure(args: { errorMessage?: string | null; isL1ToL2: boolean; l1TxUrl: string | null }): FailureInfo {
  const { errorMessage, isL1ToL2, l1TxUrl } = args
  const m = (errorMessage ?? '').toLowerCase()

  if (m && hasNeedle(m, CONSUMED_ERROR_NEEDLES)) {
    return {
      kind: 'consumed',
      // Deliberately states only what a consumed message proves. The screen replaces this
      // with a receipt-backed verdict (see consumedView); this is the pre-check fallback.
      heading: 'This deposit cannot be retried',
      message: 'The L1 message was already consumed. Checking whether the tokens arrived.',
    }
  }
  if (m && hasNeedle(m, WALLET_ERROR_NEEDLES)) {
    return {
      kind: 'wallet',
      heading: "Wallet didn't respond",
      message: 'Your wallet did not respond in time. Your funds are safe. Resume to finish.',
    }
  }
  if (isL1ToL2 && isFuelError(errorMessage)) {
    return {
      kind: 'fuel',
      heading: 'Claim ran short on gas',
      message: 'Your claim ran short on L2 gas (Fee Juice). Your funds are safe. Top up and resume.',
    }
  }
  if (l1TxUrl) {
    return {
      kind: 'deposit-landed',
      heading: "Transfer didn't finish",
      message: 'Your L1 deposit confirmed but a later step did not. Your funds are safe. Resume to finish.',
    }
  }
  if (!m) {
    return {
      kind: 'pre-deposit',
      heading: "Transfer didn't start",
      message: 'The transfer stopped before any funds moved. You can safely try again.',
    }
  }
  return {
    kind: 'unknown',
    heading: "Transfer didn't finish",
    message: 'Something interrupted the transfer. Your funds are safe. Resume, or copy the error for support.',
  }
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

// Once the estimate reaches 0 the countdown must stop showing a frozen "00:00"
// (reads as broken). It switches to a reassuring label instead: "Any moment now"
// at/just past 0, then "Taking a little longer" once it runs this many seconds
// past the estimate. Reassuring, never alarming.
const OVERRUN_GRACE_SECONDS = 45

// Stable feed key for the calm "keep this page open" in-progress notice, so it
// upserts to a single Messages row and can be cleared by key on completion.
const STAY_ON_PAGE_KEY = 'progress-stay-on-page'

export default function ProgressCard({
  steps,
  progressStep,
  hasError,
  l1TxUrl,
  l2TxUrl,
  estimatedTimeSeconds,
  amountDisplay,
  fuelBreakdown,
  fromNetwork,
  toNetwork,
  direction,
  errorMessage,
  isPrivate,
  currentPrivacyMode,
  operationId,
}: ProgressCardProps) {
  const router = useRouter()
  const notify = useToast()

  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const { setRecovery, setWithdrawalRecovery, setDirection, isPrivacyModeEnabled, setPrivacyModeEnabled } =
    useBridgeStore()
  const { data: operations } = useBridgeOperations()
  const [resuming, setResuming] = useState(false)

  const isAllComplete = steps.every((step) => step.status === 'completed')
  // The pending/working state — neither finished nor failed. Drives the redesigned layout
  // (ticker + top From/To panel + in-clock countdown) while success/failure keep their own.
  const isInProgress = !isAllComplete && !hasError

  // The L2 claim ("Claiming tokens on Aztec Network") is the step that spends bridged
  // Fee Juice — the one that stalls when gas runs short. Detect it by label so both the
  // in-progress escape hatch and the failure classifier can key off it.
  const isL1ToL2 = direction === 'L1_TO_L2'
  const claimStepActive = isL1ToL2 && steps.some((s) => s.status === 'active' && /claim/i.test(s.label))
  const claimStepErrored = isL1ToL2 && steps.some((s) => s.status === 'error' && /claim/i.test(s.label))

  // Specific, funds-safe diagnosis of the failure — drives both the copy and which recovery
  // action leads. Only evaluated when hasError, but cheap so computed unconditionally.
  const failure = useMemo(
    () => classifyFailure({ errorMessage, isL1ToL2, l1TxUrl }),
    [errorMessage, isL1ToL2, l1TxUrl],
  )
  const fuelErrorDetected = failure.kind === 'fuel'
  // "No non-nullified message" and friends mean the deposit's L1→L2 message was already consumed
  // by a prior successful claim. Re-running just re-fails, so this renders as a calm "you're
  // likely done" state (no red alert, no Resume) that points at Activity / the L2 balance.
  const isAlreadyCompleted = hasError && failure.kind === 'consumed'

  // #2146: a consumed L1→L2 message proves only that SOMETHING spent it, never that the
  // tokens were delivered — that mainnet case had the message consumed, ~2.94 FJ burned and
  // 0 cUSDC delivered, while this screen showed green and asserted it likely completed.
  //
  // The verdict comes from the claim tx receipt, the only evidence tied to THIS deposit (a
  // balance moves with transfers and later spends). `executionResult === 'success'` means the
  // claim executed; anything else means the setup phase consumed the message and the mint
  // reverted. No recorded tx hash is undecidable here, and the screen says so.
  //
  // Must be THIS operation: a deposit completed earlier today would lend its successful
  // receipt to an older stuck one. Without an id, fall back to the newest unfinished op.
  const consumedOp = useMemo<BridgeOperation | null>(() => {
    if (!isAlreadyCompleted || !direction || !operations) return null
    if (operationId) return operations.find((op) => op.id === operationId) ?? null
    return (
      [...operations]
        .filter((op) => op.direction === direction && op.status !== 'completed')
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
    )
  }, [isAlreadyCompleted, operations, direction, operationId])

  const [delivery, setDelivery] = useState<'checking' | 'delivered' | 'reverted' | 'unknown'>('checking')

  useEffect(() => {
    if (!isAlreadyCompleted) return
    // l2TxHash is only set once a claim landed, so it wins over a reverted earlier attempt
    // (failedL2TxHash) that a later resume superseded.
    const claimTxHash = consumedOp?.l2TxHash ?? consumedOp?.failedL2TxHash
    if (!consumedOp || !claimTxHash) {
      setDelivery('unknown')
      return
    }
    let cancelled = false
    setDelivery('checking')
    void (async () => {
      try {
        const receipt = await aztecNode.getTxReceipt(TxHash.fromString(claimTxHash))
        if (cancelled) return
        const verdict = classifyL2Execution(receipt)
        setDelivery(verdict === 'executed' ? 'delivered' : verdict === 'reverted' ? 'reverted' : 'unknown')
      } catch (err) {
        if (cancelled) return
        logError(
          'bridge.consumed_receipt_check_failed',
          { operationId: consumedOp.id, l2TxHash: claimTxHash },
          err instanceof Error ? err : undefined,
        )
        setDelivery('unknown')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isAlreadyCompleted, consumedOp])

  // The PUBLIC/PRIVATE badge reflects the OPERATION's mode (isPrivate), not the live toggle — a
  // resumed public claim must still read PUBLIC even while Privacy Mode is toggled on. When the
  // two disagree we surface a warning so the user doesn't resume in the wrong mode.
  const modeKnown = isPrivate !== undefined
  const privacyMismatch = modeKnown && currentPrivacyMode !== undefined && isPrivate !== currentPrivacyMode

  // The operation on screen is private, so match the user's intent by enabling Privacy Mode
  // automatically instead of warning about a mismatch. Guarded to fire only while the op is
  // private and the toggle is still off, so it settles after a single set and never loops.
  useEffect(() => {
    if (isPrivate === true && !isPrivacyModeEnabled) {
      setPrivacyModeEnabled(true)
    }
  }, [isPrivate, isPrivacyModeEnabled, setPrivacyModeEnabled])
  // Fall back to offering top-up only when the deposit already landed on L1 (l1TxUrl set)
  // — i.e. we're at/after the claim boundary where Fee Juice matters. A pre-deposit
  // failure moved no funds and needs no gas top-up.
  const fuelTopUpSecondary =
    isL1ToL2 && !fuelErrorDetected && (claimStepErrored || (!errorMessage && !!l1TxUrl))

  // Latest interrupted operation for THIS direction that can be resumed — the same
  // backend operations the Activity page/drawer resume from, so this button routes
  // into the identical /progress/resume flow rather than making the user hunt for it.
  const resumableOp = useMemo<BridgeOperation | null>(() => {
    if (!direction || !operations) return null
    return (
      [...operations]
        .filter((op) => op.direction === direction && (isResumable(op) || hasPossibleLockedFunds(op)))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null
    )
  }, [operations, direction])

  // This op has failed resume enough times that re-offering the naive full-width Resume
  // just loops. The detail + support live in the Messages feed and the status chip now, so
  // the card only softens to a calm "Get help" line (see the escalation in progress/resume).
  const stuckCount = useResumeAttemptsStore((s) => (resumableOp ? (s.attempts[resumableOp.id]?.count ?? 0) : 0))
  const escalated = stuckCount >= 3

  // The primary failure CTA is one of three: escalated support ("Get help"), a Fee-Juice top-up,
  // or resume. Resume is only a REAL action when there's a resumable backend op to hand off to
  // /progress/resume. When there isn't, the button renders inactive (opacity-40, not-allowed)
  // rather than a live-looking dead button — the "View in Activity" link below is the escape.
  const primaryMode: 'help' | 'fuel' | 'resume' =
    escalated && !fuelErrorDetected ? 'help' : fuelErrorDetected ? 'fuel' : 'resume'
  const resumeInactive = primaryMode === 'resume' && !resumableOp
  // #458: a "pre-deposit" failure moved no funds and created no resumable op, so
  // "Resume claim" is meaningless — it renders as a dead greyed button. The whole
  // transfer was cancelled before anything moved, so the right action is a LIVE
  // "Try again" that returns to the bridge to start fresh.
  const startOver = failure.kind === 'pre-deposit'

  // Mirrors the Activity page/drawer resume handler (activity/page.tsx isn't importable):
  // decrypt to prove wallet ownership, stash recovery data, then hand off to /progress/resume.
  const handleResume = async (operation: BridgeOperation) => {
    if (!l1Address) {
      notify('error', 'Please connect your Ethereum wallet first')
      return
    }

    setResuming(true)
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
    } catch (err) {
      console.error('[ProgressCard] resume/decrypt failed:', err)
      logError('Resume decrypt failed', {
        errorType: 'resume_decrypt_failed',
        error: err instanceof Error ? err.message : String(err),
      })
      notify('error', humanizeError(err))
    } finally {
      setResuming(false)
    }
  }

  const resumeLabel =
    direction === 'L2_TO_L1' ? 'Resume withdrawal' : direction === 'L1_TO_L2' ? 'Resume claim' : 'Resume transfer'

  const handleResumeClick = () => {
    if (resumableOp) {
      handleResume(resumableOp)
    } else {
      // Backend op not loaded yet or not found — fall back to the full Activity list
      // so the user still has a path forward instead of a dead button.
      router.push('/activity')
    }
  }

  // Track whether backup data is available in localStorage
  const [hasBackup, setHasBackup] = useState(false)
  useEffect(() => {
    if (!direction) return
    const key = direction === 'L1_TO_L2' ? STORAGE_KEYS.deposits : STORAGE_KEYS.withdrawals
    const check = () => {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return
        const entries = JSON.parse(raw)
        if (entries.some((e: any) => !e.success)) setHasBackup(true)
      } catch {
        /* ignore */
      }
    }
    check()
    // Re-check when localStorage changes (SDK writes during operation)
    const handleStorage = (e: StorageEvent) => {
      if (e.key === key) check()
    }
    window.addEventListener('storage', handleStorage)
    // Also poll briefly since storage events don't fire for same-tab writes
    const interval = setInterval(check, 3000)
    return () => {
      window.removeEventListener('storage', handleStorage)
      clearInterval(interval)
    }
  }, [direction])

  const [count, { startCountdown, stopCountdown }] = useCountdown({
    countStart: estimatedTimeSeconds,
    intervalMs: 1000,
  })

  // Start countdown on mount, stop on unmount
  useEffect(() => {
    startCountdown()
    return () => {
      stopCountdown()
    }
  }, [startCountdown, stopCountdown])

  // Stop countdown on completion or error
  useEffect(() => {
    if (isAllComplete || hasError) {
      stopCountdown()
    }
  }, [isAllComplete, hasError, stopCountdown])

  const formattedCountdown = formatSeconds(count)
  const initialEstimateFormatted = formatSeconds(estimatedTimeSeconds)

  // `useCountdown` clamps at 0, so `count` never goes negative — it just sits at
  // "00:00" while the transfer keeps running. That frozen zero is what reads as
  // broken (#407). We measure how long we've been parked at 0 separately, and once
  // the countdown hits 0 the display stops showing a number entirely.
  const [overrunSeconds, setOverrunSeconds] = useState(0)
  useEffect(() => {
    if (count > 0 || !isInProgress) {
      setOverrunSeconds(0)
      return
    }
    const id = setInterval(() => setOverrunSeconds((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [count, isInProgress])

  // At/past 0 the number is replaced by a reassuring label; while counting, the
  // label is null and the numeric "MM:SS" carries the estimate. Exactly one of the
  // two is ever non-null in progress, so the mini-bar never renders a stuck 00:00.
  const countdownRemaining = count > 0 ? formattedCountdown : null
  const countdownLabel =
    count > 0 ? null : overrunSeconds < OVERRUN_GRACE_SECONDS ? 'Any moment now' : 'Taking a little longer'

  // Stream the live countdown to the mini-bar (BridgeHeader), which renders it on the left in
  // place of the decorative glyph. BridgeHeader is a sibling and the shared store is off-limits,
  // so the value crosses via a window event. `remaining` carries the number while counting;
  // `label` carries the graceful zero/overrun copy once it reaches 0. Both null while not in
  // progress, and cleared on unmount so the glyph returns when the user leaves the screen.
  useEffect(() => {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('shield:progress-timer', {
        detail: {
          remaining: isInProgress ? countdownRemaining : null,
          label: isInProgress ? countdownLabel : null,
        },
      }),
    )
  }, [isInProgress, countdownRemaining, countdownLabel])
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      window.dispatchEvent(new CustomEvent('shield:progress-timer', { detail: { remaining: null } }))
    }
  }, [])

  // Time taken = total estimate - remaining
  const timeTakenSeconds = estimatedTimeSeconds - count
  const formattedTimeTaken = formatSeconds(timeTakenSeconds)

  const handleExportBackup = () => {
    if (!direction) return
    try {
      const key = direction === 'L1_TO_L2' ? STORAGE_KEYS.deposits : STORAGE_KEYS.withdrawals
      const raw = localStorage.getItem(key)
      if (!raw) return
      const entries = JSON.parse(raw)
      const latest = entries.filter((e: any) => !e.success).pop()
      if (!latest) return
      if (direction === 'L1_TO_L2') {
        exportClaimData(latest)
      } else {
        exportWithdrawalData(latest)
      }
    } catch (e) {
      console.error('[ProgressCard] Export failed:', e)
    }
  }

  // Calm, informational "keep this page open" notice, surfaced in the Messages feed
  // while the transfer is actively in progress. Type `info` so it never hijacks the
  // header ticker (which only surfaces warning/error) — it stays a quiet record that
  // also carries the recovery-file download as an inline action. Keyed so it upserts
  // to one row and clears cleanly the moment the transfer is no longer in progress
  // (completed or failed), so it never lingers on the idle bridge later.
  useEffect(() => {
    if (!isInProgress) {
      dismissNotificationByKey(STAY_ON_PAGE_KEY)
      return
    }
    pushNotification({
      type: 'info',
      key: STAY_ON_PAGE_KEY,
      title: 'Keep this page open',
      message:
        'Keep this page open while your transfer completes. If it is interrupted you can resume from Activity, or download a recovery file to restore it later.',
      action:
        direction && hasBackup ? { label: 'Download recovery file', onClick: handleExportBackup } : undefined,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInProgress, direction, hasBackup])

  // Leaving the progress screen (unmount) also retires the notice, so a mid-transfer
  // navigation away can't leave it sitting in the persisted feed.
  useEffect(() => {
    return () => dismissNotificationByKey(STAY_ON_PAGE_KEY)
  }, [])

  const copyError = () => {
    if (!errorMessage) return
    navigator.clipboard
      ?.writeText(errorMessage)
      .then(() => notify('success', 'Error details copied'))
      .catch(() => notify('error', 'Could not copy'))
  }

  // Hand over both hashes: the L1 deposit proves the funds left, and the L2 claim is what
  // support needs to see the revert.
  const copyReferences = () => {
    const lines = [
      consumedOp?.l1TxHash ? `L1 deposit: ${consumedOp.l1TxHash}` : l1TxUrl ? `L1 deposit: ${l1TxUrl}` : null,
      consumedOp?.l2TxHash ? `L2 claim: ${consumedOp.l2TxHash}` : null,
      consumedOp?.failedL2TxHash ? `L2 claim (reverted): ${consumedOp.failedL2TxHash}` : null,
      consumedOp?.id ? `Operation: ${consumedOp.id}` : null,
    ].filter(Boolean)
    if (lines.length === 0) return
    navigator.clipboard
      ?.writeText(lines.join('\n'))
      .then(() => notify('success', 'Transaction references copied'))
      .catch(() => notify('error', 'Could not copy'))
  }

  // The consumed screen speaks from the receipt check, not from an assumption.
  const consumedView = useMemo(() => {
    switch (delivery) {
      case 'checking':
        return {
          heading: 'Checking this deposit',
          message: 'This deposit cannot be retried. Looking up whether the claim went through.',
          tone: 'neutral' as const,
          icon: 'ph:hourglass-medium-fill',
        }
      case 'delivered':
        return {
          heading: 'Deposit completed',
          message: 'The claim went through, so this deposit is done and cannot be retried.',
          tone: 'ok' as const,
          icon: 'ph:check-circle-fill',
        }
      case 'reverted':
        return {
          heading: 'Tokens did not arrive',
          message:
            'The claim was mined but reverted, so the deposit did not complete and cannot be retried. ' +
            'Copy the references below and contact support.',
          tone: 'alert' as const,
          icon: 'ph:warning-circle-fill',
        }
      default:
        return {
          heading: "We can't confirm this deposit",
          message:
            'This deposit cannot be retried, and we could not determine whether the tokens arrived. ' +
            'Copy the references below and contact support.',
          tone: 'neutral' as const,
          icon: 'ph:info-fill',
        }
    }
  }, [delivery])

  const consumedTone =
    consumedView.tone === 'ok'
      ? 'text-[#047857]'
      : consumedView.tone === 'alert'
        ? 'text-[#B45309]'
        : 'text-latest-grey-500'

  const heading = isAlreadyCompleted
    ? consumedView.heading
    : hasError
      ? failure.heading
      : isAllComplete
        ? 'Transaction complete'
        : 'Transaction in progress'

  const showBackButton = isAllComplete || hasError

  // The From/To marks follow the direction, so each mark always matches the network named beside
  // it: a deposit (L1→L2) runs Eth→Aztec, a withdrawal (L2→L1) runs Aztec→Eth. The Aztec mark
  // keeps its dark-chip treatment. Direction unknown falls back to the deposit orientation.
  const isWithdrawal = direction === 'L2_TO_L1'
  const renderEthMark = (small = false) => (
    <StyledImage src="/assets/svg/ethLogo.svg" alt="" className={small ? 'h-5 w-5' : 'h-6 w-6'} />
  )
  const renderAztecMark = (small = false) => (
    <span
      className={`inline-flex ${small ? 'h-5 w-5' : 'h-6 w-6'} shrink-0 items-center justify-center rounded-full bg-[#0A0A0A]`}
    >
      <StyledImage src="/assets/svg/aztec.svg" alt="" className={small ? 'h-[15px] w-[15px]' : 'h-[18px] w-[18px]'} />
    </span>
  )
  const renderFromMark = (small = false) => (isWithdrawal ? renderAztecMark(small) : renderEthMark(small))
  const renderToMark = (small = false) => (isWithdrawal ? renderEthMark(small) : renderAztecMark(small))

  // One compact, icon-led explorer-link row used across every state (in-progress, success,
  // failure). Kept near the status so it never sinks to the bottom of the card where the big
  // pills used to clip (#200) — and it stays inside the no-scroll budget.
  const explorerLinks =
    l1TxUrl || l2TxUrl ? (
      <div className="mt-2 flex items-center justify-center gap-4">
        {l1TxUrl && (
          <a
            href={l1TxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-200 hover:text-blue-100"
          >
            View L1 Tx
            <Icon icon="ph:arrow-square-out" width={13} height={13} />
          </a>
        )}
        {l2TxUrl && (
          <a
            href={l2TxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#BF1254] hover:text-[#81133B]"
          >
            View L2 Tx
            <Icon icon="ph:arrow-square-out" width={13} height={13} />
          </a>
        )}
      </div>
    ) : null

  return (
    <div className="flex h-full flex-col">
      {/* In-progress layout: the title leads, the From/To + amount panel sits centered in the
          space freed by moving the countdown to the mini-bar, and the step-dots + status line
          close it out. The single do-not-reload indicator is the mini-bar pill (no in-card banner). */}
      {isInProgress && (
        <div className="flex min-h-full flex-col justify-center py-4">
          <p className="text-center font-semibold text-md">Transaction in progress</p>

          {/* Cryptex — concentric cipher rings settling around an Aztec diamond, filling the
              slack the fixed-height card leaves above the From/To panel. Decorative and
              reassuring ("privately processing"), never competing with the progress bar or
              status line. In-progress only; success/failure keep their own content. */}
          <CryptexAnimation height={132} className="mt-1" />

          {/* Privacy-mode mismatch — a public operation is on screen while the live toggle is on.
              The private case auto-enables Privacy Mode (no warning), so only the public case
              surfaces here. Concise, icon-led, only on that edge case. */}
          {privacyMismatch && !isPrivate && (
            <div className="mx-auto mt-2 flex max-w-sm items-start gap-1.5 rounded-md bg-light-yellow px-2.5 py-1.5">
              <Icon icon="ph:warning-fill" width={13} height={13} className="mt-[1px] flex-shrink-0 text-dark-yellow" />
              <p className="text-[11px] font-medium leading-snug text-dark-yellow">
                This transfer is Public, but Privacy Mode is on.
              </p>
            </div>
          )}

          {/* From/To + amount panel, absorbing the recovery-backup control (top-left), the
              PUBLIC/PRIVATE mode pill (top-right), and the explorer link (View L1 Tx). */}
          <div className="bg-[#F5F5F5] rounded-md mt-3 p-4">
            <div className="flex items-center justify-between">
              {direction && hasBackup ? (
                <button
                  onClick={handleExportBackup}
                  data-tooltip-id="progress-recovery-tip"
                  data-tooltip-content="Export a recovery backup. Save this so you can recover your funds if the page closes."
                  aria-label="Export a recovery backup"
                  className="relative flex h-7 w-7 items-center justify-center rounded-full bg-[#047857]/[0.10] text-[#047857] transition-colors hover:bg-[#047857]/[0.18] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#047857]/40"
                >
                  <Icon icon="ph:key" width={15} height={15} />
                  <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#047857]" />
                </button>
              ) : (
                <span className="h-7 w-7" aria-hidden="true" />
              )}
              {modeKnown && (
                <div
                  className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[10px] font-semibold uppercase tracking-wide ${
                    isPrivate ? 'bg-[#FDE7F3] text-[#81133B]' : 'bg-[#EEF1FB] text-[#17235E]'
                  }`}
                  title={isPrivate ? 'This transfer runs in Private mode' : 'This transfer runs in Public mode'}
                >
                  <Icon icon={isPrivate ? 'ph:shield-check-fill' : 'ph:eye-bold'} width={12} height={12} />
                  {isPrivate ? 'Private' : 'Public'}
                </div>
              )}
            </div>
            <div className="flex justify-between mt-3">
              <div>
                <p className="text-14 font-semibold text-latest-grey-100">From</p>
                <div className="flex gap-2 mt-2">
                  {renderFromMark()}
                  <p className="text-16 font-medium text-latest-black-100 w-[106px]">{fromNetwork}</p>
                </div>
              </div>
              <div>
                <p className="text-14 font-semibold text-latest-grey-100">To</p>
                <div className="flex gap-2 mt-2">
                  {renderToMark()}
                  <p className="text-16 font-medium text-latest-black-100 w-[106px]">{toNetwork}</p>
                </div>
              </div>
            </div>
            <hr className="text-latest-grey-300 my-3" />
            <p className="text-32 text-black font-medium text-center">{amountDisplay}</p>
            {fuelBreakdown && (
              <p className="text-center text-[11px] leading-tight font-medium text-latest-grey-500 mt-0.5">
                {fuelBreakdown.bridgeAmount} to bridge + {fuelBreakdown.fuelAmount}
              </p>
            )}
            {explorerLinks}
            <ReactTooltip id="progress-recovery-tip" place="top" className="z-[100]" style={{ fontSize: '11px', maxWidth: '220px' }} />
          </div>

          {/* Step-dots + live status line ("Exiting from Aztec…"). */}
          <div className="mt-4">
            <LoadingStepsBars steps={steps} currentStep={progressStep - 1} />
          </div>

          {/* Calm, reassuring "stay on this page" notice — informational, never a red alert.
              Reframes the old "do not reload" banner as helpful guidance and points to the two
              recovery paths (resume from Activity, or download a recovery file). Only shown while
              in progress, so a completed/failed transfer never carries it. */}
          <div className="mx-auto mt-3 flex max-w-sm items-start gap-2 rounded-md bg-[#F5F5F5] px-3 py-2">
            <Icon icon="ph:info" width={14} height={14} className="mt-[1px] flex-shrink-0 text-latest-grey-500" />
            <div className="text-[11px] font-medium leading-snug text-latest-grey-500">
              <p>
                Keep this page open while your transfer completes. If it is interrupted you can resume from
                Activity, or download a recovery file to restore it later.
              </p>
              {direction && hasBackup && (
                <button
                  onClick={handleExportBackup}
                  className="mt-1 inline-flex items-center gap-1 font-semibold text-[#047857] underline-offset-2 hover:underline focus:outline-none focus-visible:underline"
                >
                  <Icon icon="ph:download-simple" width={13} height={13} />
                  Download recovery file
                </button>
              )}
            </div>
          </div>

          {/* Escape hatch during the L2 claim: the claim pays gas from bridged Fee Juice and can
              loop/retry when it runs short. Offer a top-up route so the user isn't forced to wait
              out the retry loop. Subtle — the claim usually succeeds on its own. */}
          {claimStepActive && (
            <div className="mt-3 flex justify-center">
              <button
                onClick={() => router.push('/fee-juice?resume=1')}
                className="inline-flex items-center gap-1 text-12 font-medium text-latest-grey-500 underline-offset-2 hover:text-[#81133B] hover:underline"
              >
                <Icon icon="ph:gas-pump" width={13} height={13} className="shrink-0" />
                Not enough gas? Top up Fee Juice
              </button>
            </div>
          )}
        </div>
      )}

      {/* Progress Card — success and failure states keep the icon-led card. */}
      {!isInProgress && (
      <div className="bg-white rounded-md mt-2 p-4 relative">
        {/* Encrypted-backup export — a small icon affordance in the top-right rather than a
            full-width button. Recovery-critical, so it stays in the transaction frame, but
            it must not dominate the layout. The green dot marks it as an available action. */}
        {direction && hasBackup && hasError && (
          <button
            onClick={handleExportBackup}
            title="Export an encrypted local backup. Your data is already backed up. This saves a copy for manual recovery."
            aria-label="Export an encrypted local backup"
            className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-[#047857]/[0.10] text-[#047857] transition-colors hover:bg-[#047857]/[0.18]"
          >
            <Icon icon="ph:key" width={16} height={16} />
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[#047857]" />
          </button>
        )}
        {/* PUBLIC/PRIVATE badge — pinned top-left, mirroring the export button top-right. Derived
            from the operation's own mode, so a resumed public claim always reads PUBLIC even when
            Privacy Mode is toggled on. Icon-led, so it costs no vertical space in the flow. */}
        {modeKnown && !isInProgress && (
          <div
            className={`absolute left-3 top-3 inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-semibold uppercase tracking-wide ${
              isPrivate ? 'bg-[#FDE7F3] text-[#81133B]' : 'bg-[#EEF1FB] text-[#17235E]'
            }`}
            title={isPrivate ? 'This transfer runs in Private mode' : 'This transfer runs in Public mode'}
          >
            <Icon icon={isPrivate ? 'ph:shield-check-fill' : 'ph:eye-bold'} width={12} height={12} />
            {isPrivate ? 'Private' : 'Public'}
          </div>
        )}
        <div className="flex flex-col items-center justify-center">
          {isAlreadyCompleted ? (
            <Icon icon={consumedView.icon} width={48} height={48} className={consumedTone} />
          ) : hasError ? (
            <svg width="48" height="48" viewBox="0 0 25 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path
                d="M12.5004 8.99998V13M12.5004 17H12.5104M22.2304 18L14.2304 3.99998C14.056 3.69218 13.803 3.43617 13.4973 3.25805C13.1917 3.07993 12.8442 2.98608 12.4904 2.98608C12.1366 2.98608 11.7892 3.07993 11.4835 3.25805C11.1778 3.43617 10.9249 3.69218 10.7504 3.99998L2.75042 18C2.5741 18.3053 2.48165 18.6519 2.48243 19.0045C2.48321 19.3571 2.5772 19.7032 2.75486 20.0078C2.93253 20.3124 3.18757 20.5646 3.49411 20.7388C3.80066 20.9131 4.14783 21.0032 4.50042 21H20.5004C20.8513 20.9996 21.1959 20.9069 21.4997 20.7313C21.8035 20.5556 22.0556 20.3031 22.2309 19.9991C22.4062 19.6951 22.4985 19.3504 22.4984 18.9995C22.4983 18.6486 22.4059 18.3039 22.2304 18Z"
                stroke="#B91C1C"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <StyledImage
              src={isAllComplete ? '/assets/svg/transactionComplete.svg' : '/assets/svg/progress.svg'}
              alt=""
              className={isAllComplete ? 'h-12 w-12' : 'h-[56px] w-[56px]'}
            />
          )}
        </div>

        <p
          className={`text-center font-semibold text-md ${hasError ? 'mt-3' : isAllComplete ? 'mt-2' : 'mt-4'} ${
            isAlreadyCompleted ? consumedTone : hasError ? 'text-[#B91C1C]' : isAllComplete ? 'text-green-600' : ''
          }`}
        >
          {heading}
        </p>

        {hasError && (
          <p className="text-center text-12 text-latest-grey-500 mt-1 px-2">
            {isAlreadyCompleted ? consumedView.message : failure.message}
          </p>
        )}

        {/* Privacy-mode mismatch warning — a public operation is on screen while Privacy Mode is on
            (e.g. resuming a public claim). The private case auto-enables Privacy Mode instead of
            warning, so only the public case renders here, keeping it inside the no-scroll budget. */}
        {privacyMismatch && !isPrivate && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md bg-light-yellow px-2.5 py-1.5">
            <Icon icon="ph:warning-fill" width={13} height={13} className="mt-[1px] flex-shrink-0 text-dark-yellow" />
            <p className="text-[11px] font-medium leading-snug text-dark-yellow">
              This transfer is Public, but Privacy Mode is on.
            </p>
          </div>
        )}

        {/* Explorer links sit right under the status as small icon-links (never full-width pills
            lower down, which clipped at the bottom of the card on some in-progress states). The L1
            deposit tx is the reassuring "your funds are here" anchor, so keep it close to the top. */}
        {explorerLinks}

        <div className={isAllComplete ? 'mt-2' : hasError ? 'mt-3' : 'mt-4'}>
          <LoadingStepsBars steps={steps} currentStep={progressStep - 1} />
        </div>

        {/* Completed state summary — final estimate + total time taken. */}
        {isAllComplete && (
          <>
            <hr className="text-latest-grey-300 my-2" />
            <div className="flex justify-between mt-[2px]">
              <p className="text-14 font-medium text-latest-grey-100">Estimated time </p>
              <p className="font-semibold text-14">~{initialEstimateFormatted}</p>
            </div>
            <div className="flex justify-between mt-[2px]">
              <p className="text-14 font-medium text-latest-grey-100">Total time taken </p>
              <p className="font-semibold text-14">{formattedTimeTaken}</p>
            </div>
          </>
        )}

      </div>
      )}

      {/* Transaction Details — on a failure this collapses to a single compact line
          (from → to · amount) to stay inside the no-scroll budget while still anchoring
          the user to "these are the funds, and they're accounted for". The full block is
          reserved for the in-progress / success states where there is room. */}
      {hasError ? (
        <div className="bg-[#F5F5F5] rounded-md mt-3 px-4 py-3 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            {renderFromMark(true)}
            <span className="text-14 font-medium text-latest-black-100">{fromNetwork}</span>
          </span>
          <Icon icon="ph:arrow-right-bold" width={13} height={13} className="text-latest-grey-100" />
          <span className="inline-flex items-center gap-1.5">
            {renderToMark(true)}
            <span className="text-14 font-medium text-latest-black-100">{toNetwork}</span>
          </span>
          <span className="text-latest-grey-300">·</span>
          <span className="text-16 font-semibold text-latest-black-100">{amountDisplay}</span>
        </div>
      ) : isAllComplete ? (
        <div className="bg-[#F5F5F5] rounded-md mt-2 px-4 py-3">
          <div className="flex justify-between">
            <div>
              <p className="text-14 font-semibold text-latest-grey-100">From</p>
              <div className="flex gap-2 mt-1.5">
                {renderFromMark()}
                <p className="text-16 font-medium text-latest-black-100 w-[106px]">{fromNetwork}</p>
              </div>
            </div>
            <div>
              <p className="text-14 font-semibold text-latest-grey-100">To</p>
              <div className="flex gap-2 mt-1.5">
                {renderToMark()}
                <p className="text-16 font-medium text-latest-black-100 w-[106px]">{toNetwork}</p>
              </div>
            </div>
          </div>
          <hr className="text-latest-grey-300 my-2" />
          <p className="text-26 text-black font-medium text-center">{amountDisplay}</p>
          {fuelBreakdown && (
            <p className="text-center text-[11px] leading-tight font-medium text-latest-grey-500 mt-0.5">
              {/* bridgeAmount/fuelAmount strings already include their own
                  token symbol and "to top up …" suffix from the producer at
                  app/progress/page.tsx — do NOT double-suffix here. */}
              {fuelBreakdown.bridgeAmount} to bridge + {fuelBreakdown.fuelAmount}
            </p>
          )}
        </div>
      ) : null}

      {/* Already-completed recovery — the deposit's L1→L2 message was already consumed, so a
          Resume would just re-fail. Lead the user to Activity / their L2 balance instead, with a
          real back button in the same ~80/20 split. No red, no Resume. */}
      {isAlreadyCompleted && (
        <div className="mt-3 mb-6 flex flex-col items-center gap-2">
          <div className="flex w-full items-stretch gap-2">
            <button
              onClick={() => router.push('/?app=1')}
              title="Back to main screen"
              aria-label="Back to main screen"
              className="flex flex-[2_1_0%] items-center justify-center rounded-lg border border-latest-grey-300 text-latest-grey-100 transition-colors hover:border-latest-black-100 hover:text-latest-black-100"
            >
              <Icon icon="ph:arrow-left-bold" width={18} height={18} />
            </button>
            <button
              onClick={() => router.push('/activity')}
              className={`flex-[8_1_0%] rounded-lg py-[10px] font-semibold text-white transition-opacity hover:opacity-80 ${
                consumedView.tone === 'ok' ? 'bg-[#047857]' : 'bg-latest-black-100'
              }`}
            >
              View in Activity
            </button>
          </div>
          {consumedView.tone !== 'ok' && (
            <div className="mt-1 flex w-full flex-col items-center gap-1">
              {(consumedOp?.l1TxHash || l1TxUrl || consumedOp?.l2TxHash || consumedOp?.failedL2TxHash) && (
                <button
                  onClick={() => copyReferences()}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-latest-grey-500 transition-colors hover:text-latest-black-100"
                >
                  <Icon icon="ph:copy" width={12} height={12} />
                  Copy transaction references
                </button>
              )}
              <TextButton onClick={() => openSupport()}>Contact support</TextButton>
            </div>
          )}
        </div>
      )}

      {/* Error recovery actions — the primary CTA (resume, or top-up for a diagnosed fuel
          shortfall) shares one row with a real back button in an ~80/20 split. The alternate
          recovery path and the Activity link sit directly beneath the CTA as light text links,
          grouped tightly with it rather than floated to the card footer. */}
      {hasError && !isAlreadyCompleted && direction && (
        <div className="mt-4 mb-6 flex flex-col items-center gap-2">
          <div className="flex w-full items-stretch gap-2">
            <button
              onClick={() => router.push('/?app=1')}
              title="Back to main screen"
              aria-label="Back to main screen"
              className="flex flex-[2_1_0%] items-center justify-center rounded-lg border border-latest-grey-300 text-latest-grey-100 transition-colors hover:border-latest-black-100 hover:text-latest-black-100"
            >
              <Icon icon="ph:arrow-left-bold" width={18} height={18} />
            </button>
            <button
              onClick={
                startOver
                  ? () => router.push('/?app=1')
                  : resumeInactive
                    ? undefined
                    : primaryMode === 'help'
                      ? openSupport
                      : primaryMode === 'fuel'
                        ? () => router.push('/fee-juice?resume=1')
                        : handleResumeClick
              }
              disabled={!startOver && (resumeInactive || (primaryMode === 'resume' && resuming))}
              aria-disabled={!startOver && resumeInactive}
              className={`flex-[8_1_0%] rounded-lg py-[10px] font-semibold text-white transition-opacity ${
                primaryMode === 'fuel' && !startOver ? 'bg-[#81133B]' : 'bg-black'
              } ${
                !startOver && resumeInactive
                  ? 'cursor-not-allowed opacity-40'
                  : 'hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60'
              }`}
            >
              {startOver
                ? 'Try again'
                : primaryMode === 'help'
                  ? 'Get help'
                  : primaryMode === 'fuel'
                    ? 'Top up Fee Juice'
                    : resuming
                      ? 'Resuming…'
                      : resumeLabel}
            </button>
          </div>

          {/* Alternate recovery path as a light text link, sized to the diagnosis. */}
          {fuelErrorDetected ? (
            <button
              onClick={handleResumeClick}
              disabled={resuming}
              className="text-12 font-medium text-latest-grey-500 underline-offset-2 hover:text-[#17235E] hover:underline disabled:opacity-60"
            >
              {resuming ? 'Resuming…' : `Already topped up? ${resumeLabel}`}
            </button>
          ) : fuelTopUpSecondary && !escalated ? (
            <button
              onClick={() => router.push('/fee-juice?resume=1')}
              className="inline-flex items-center gap-1 text-12 font-medium text-latest-grey-500 underline-offset-2 hover:text-[#81133B] hover:underline"
            >
              <Icon icon="ph:gas-pump" width={13} height={13} className="shrink-0" />
              Not enough gas? Top up Fee Juice
            </button>
          ) : failure.kind === 'unknown' && errorMessage ? (
            <button
              onClick={copyError}
              className="inline-flex items-center gap-1 text-12 font-medium text-latest-grey-500 underline-offset-2 hover:text-latest-black-100 hover:underline"
            >
              <Icon icon="ph:copy" width={13} height={13} />
              Copy error for support
            </button>
          ) : null}

          <button
            onClick={() => router.push('/activity')}
            className="inline-flex items-center gap-1 text-12 font-medium text-latest-grey-500 underline-offset-2 hover:text-latest-black-100 hover:underline"
          >
            <Icon icon="ph:clock-counter-clockwise" width={13} height={13} />
            View in Activity
          </button>
        </div>
      )}

      {/* Back to Main Screen — completion state, and the error fallback when no
          direction is available to build the resume action above. The already-completed
          state carries its own back button, so it's excluded here. */}
      {/* Completion CTAs (#459): now that funds are private on Aztec, feature one
          thing to DO next, plus a back-to-main button carrying the arrow. The featured
          app/use case is intentionally swappable — Nyx (private payments) is a real
          ecosystem app; drop in a different one when a launch partner is chosen. */}
      {showBackButton && !isAlreadyCompleted && !(hasError && direction) && isAllComplete && (
        <div className="mt-3 mb-4 flex flex-col gap-2.5">
          <a
            href="https://www.nyx.money"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 rounded-xl border border-latest-grey-300 px-3 py-2.5 text-left transition-colors hover:border-latest-black-100"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#F5F5F5]">
              <img src="/assets/svg/ecosystem/nyx.svg" alt="" className="h-5 w-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-13 font-semibold text-latest-black-100">Spend privately with Nyx</span>
              <span className="text-11 text-latest-grey-500">Put your now-private Aztec balance to work.</span>
            </span>
            <Icon icon="ph:arrow-up-right" width={15} height={15} className="shrink-0 text-latest-grey-500" />
          </a>
          <button
            onClick={() => router.push('/?app=1')}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-black py-[11px] font-semibold text-white transition-opacity hover:opacity-80"
          >
            <Icon icon="ph:arrow-left-bold" width={16} height={16} />
            Back to Main Screen
          </button>
        </div>
      )}
      {/* Error fallback (no direction to build a resume action): plain back to main. */}
      {showBackButton && !isAlreadyCompleted && !(hasError && direction) && !isAllComplete && (
        <div className="flex flex-row items-center justify-center mt-2 mb-4">
          <TextButton className="" onClick={() => router.push('/?app=1')}>
            Back to Main Screen
          </TextButton>
        </div>
      )}
    </div>
  )
}
