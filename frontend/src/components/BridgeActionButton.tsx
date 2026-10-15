import React, { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import TextButton from './TextButton'
import { BridgeDirection } from '@/types/bridge'
import { useToast } from '@/hooks/useToast'
import { extractErrorMessage, humanizeError } from '@/utils'
import { logError } from '@/utils/datadog'
import { parseUnits } from 'viem'
import CongestionWarningModal from './model/CongestionWarningModal'
import { useL2PendingTxCount, useNetworkHealth } from '@/hooks/useL2Operations'
import { POCH_MINT_URL } from '@/config'
import { PASSPORT_MAX_AMOUNT } from '@/config/env.config'
import { pushNotification, dismissNotificationByKey } from '@/stores/useNotificationsStore'

// Single-loader policy (#298): progress lives in the top mini progress bar
// (BridgeHeader's LoadingBar), so the button no longer renders its own spinner.
// It just shows a clean text state ("Bridging Tokens…", "Verifying…") that
// tracks the same phase without a second, competing spinner.
function LoadingContent({ label }: { label: string }) {
  return <span>{label}</span>
}

interface BridgeActionButtonProps {
  isDisabled?: boolean
  // Specific reason the button is disabled by an EXTERNAL gate (fuel sufficiency / recipient /
  // amount / auth), so we never show a silent greyed button — the reason renders under it.
  // The internal disable cases already surface themselves in the button label.
  disabledReason?: string

  // Binding guard: the connected (L1, L2) pair is a CONFLICT (the EVM wallet is
  // bound to a different Aztec account, or vice-versa). Bridging would deposit
  // into a guaranteed-failing pair, so block up-front (issues #98/#130). The
  // button just disables with a concise reason; the full switch-your-wallet
  // notice is pushed into the Messages feed by the parent (#297b).
  bindingBlocked?: boolean
  // Retained for compatibility; the detailed switch-wallet copy now lives in the
  // Messages feed rather than the button label, so the button no longer reads it.
  bindingBlockedLabel?: string

  // Connection states
  isWaapConnected: boolean
  connectWaapWallet: () => void
  getWalletProvider: () => string | null
  loginMethod: string | null
  walletProvider: string | null
  isAztecConnected: boolean
  connectAztec: () => void
  inputRef: React.RefObject<HTMLInputElement | null>

  // Balance and amount states
  inputAmount: string
  l1Balance: string
  l2Balance: string
  l1BalanceLoading?: boolean
  l2BalanceLoading?: boolean
  feeJuiceLoading?: boolean

  // Bridge direction
  direction: BridgeDirection

  // Core operations
  bridgeTokensToL2: (amount: string) => void
  withdrawTokensToL1: (amount: string) => void
  requestFaucet: () => void
  useExternalFaucet?: boolean
  handleExternalFaucet?: () => void

  // Loading states
  isStateInitialized?: boolean
  requestFaucetPending?: boolean
  bridgeTokensToL2Pending?: boolean
  withdrawTokensToL1Pending?: boolean

  // Faucet related
  isEligibleForFaucet: boolean
  needsGas?: boolean
  needsTokens?: boolean
  needsTokensOnly?: boolean

  // SBT related
  hasL1SBT: boolean | unknown
  hasL2SBT: boolean | undefined
  setShowSBTModal: (show: boolean) => void
  setCurrentSBTChain: (chain: 'Ethereum' | 'Aztec') => void

  // Claim-gas guard: the L2 claim would be paid from standing FeeJuice the user
  // doesn't have. When true, the button becomes an "enable gas top-up" CTA.
  needsClaimGas?: boolean
  onAddClaimGas?: () => void
  // Compliance attestation
  pochEligible?: boolean
  pochLoading?: boolean
  pochReason?: string
  // Opens the verification step/screen when attestation is required (replaces a toast).
  onRequestVerification?: () => void
  attestationMethod?: 'poch' | 'passport' | null
  passportMaxAmount?: bigint
  // Alpha per-day (rolling 24h) deposit cap: USD left for this user (undefined = cap disabled)
  remainingDepositUsd?: number
  // Travel Rule: passport tier blocked because lifetime volume reached the threshold.
  travelRuleBlocked?: boolean
  // Travel Rule: USD budget left before the threshold (undefined = disabled).
  travelRuleRemainingUsd?: number
  // USD held by an outstanding attestation reservation (already netted out of the remaining
  // budgets above). A block charged to this is a temporary hold, not a permanent cap: it frees
  // once the pending deposit settles (or the reservation is released), so we disable with a hold
  // label rather than routing the user to Clean Hands verification. The hold can persist for
  // other reasons too (e.g. a deposit stuck for lack of Fee Juice), so we never promise a fixed
  // time for it to clear.
  reservedDepositUsd?: number

  // Operation completion state
  bridgeCompleted?: boolean
  l2NodeError?: boolean
  l2NodeIsReadyLoading?: boolean
  feeJuiceBalanceLoading?: boolean
}

function BridgeActionButton({
  isDisabled = false,
  disabledReason,
  bindingBlocked = false,
  isWaapConnected,
  connectWaapWallet,
  getWalletProvider,
  loginMethod,
  walletProvider,
  isAztecConnected,
  connectAztec,
  inputRef,
  inputAmount,
  l1Balance,
  l2Balance,
  l1BalanceLoading = false,
  l2BalanceLoading = false,
  feeJuiceLoading = false,
  direction,
  bridgeTokensToL2,
  withdrawTokensToL1,
  requestFaucet,
  useExternalFaucet = false,
  handleExternalFaucet,
  isStateInitialized = true,
  requestFaucetPending = false,
  bridgeTokensToL2Pending = false,
  withdrawTokensToL1Pending = false,
  isEligibleForFaucet,
  needsGas = false,
  needsTokens = false,
  needsTokensOnly = false,
  hasL1SBT,
  hasL2SBT,
  setShowSBTModal,
  setCurrentSBTChain,
  needsClaimGas = false,
  onAddClaimGas,
  pochEligible,
  pochLoading = false,
  pochReason,
  onRequestVerification,
  attestationMethod,
  passportMaxAmount,
  remainingDepositUsd,
  travelRuleBlocked = false,
  travelRuleRemainingUsd,
  reservedDepositUsd,
  bridgeCompleted = false,
  l2NodeError = false,
  l2NodeIsReadyLoading = false,
  feeJuiceBalanceLoading = false,
}: BridgeActionButtonProps) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isOperationPending, setIsOperationPending] = useState(false)
  // Transient amount-validation error, rendered inline under the button only. It is
  // NEVER pushed into the persistent Messages feed (that made it feel un-dismissable,
  // #332/#333) and it auto-clears the moment the amount becomes valid or is cleared.
  const [amountError, setAmountError] = useState<string | null>(null)
  const notify = useToast()

  useEffect(() => {
    if (!inputAmount || parseFloat(inputAmount) > 0) setAmountError(null)
  }, [inputAmount])

  // Flag an empty/zero amount: inline field error (primary) plus a momentary, non-persisted
  // toast. Focus returns to the amount input so the fix is one keystroke away.
  const flagInvalidAmount = () => {
    setAmountError('Please enter a valid amount')
    notify.transient('error', 'Please enter a valid amount')
    inputRef.current?.focus()
  }
  const [showCongestionWarning, setShowCongestionWarning] = useState(false)
  const { data: pendingTxCount } = useL2PendingTxCount()
  const isCongested = pendingTxCount && pendingTxCount > 40
  const { data: networkHealth } = useNetworkHealth()
  const isNetworkDown = networkHealth?.isNetworkDown ?? false

  const bothWalletsConnected = isWaapConnected && isAztecConnected
  const balancesLoading =
    bothWalletsConnected && (!isStateInitialized || l1BalanceLoading || l2BalanceLoading || feeJuiceLoading)

  // Helper functions
  const getOperationType = (dir: BridgeDirection) => (dir === BridgeDirection.L2_TO_L1 ? 'withdrawal' : 'bridge')

  const getOperationLabel = (dir: BridgeDirection) =>
    dir === BridgeDirection.L2_TO_L1 ? 'Withdraw Tokens' : 'Bridge Tokens'

  const getSBTChainForDirection = (dir: BridgeDirection) => (dir === BridgeDirection.L2_TO_L1 ? 'Aztec' : 'Ethereum')

  // Process operations for bridging or withdrawing
  const processBridgeOperation = async () => {
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      flagInvalidAmount()
      return
    }

    setIsOperationPending(true)
    try {
      const amount = inputAmount
      if (direction === BridgeDirection.L2_TO_L1) {
        await withdrawTokensToL1(amount)
      } else {
        await bridgeTokensToL2(amount)
      }
    } catch (error) {
      const operationType = getOperationType(direction)
      const errorMsg = extractErrorMessage(error)

      console.error(`[BridgeActionButton] ${operationType} operation failed:`, error)
      logError('Bridge operation failed', {
        errorType: 'bridge_operation_failed',
        operationType,
        direction,
        error: errorMsg,
      })

      if (errorMsg.toLowerCase().includes('deposit limit')) {
        notify('error', 'You have reached your deposit limit for now. It frees up as your recent deposits settle.')
      } else if (errorMsg.includes('insufficient')) {
        notify('error', `Insufficient funds for ${operationType} operation`)
      } else if (errorMsg.includes('rejected') || errorMsg.includes('denied')) {
        notify('error', `Transaction rejected by user`)
      } else {
        notify('error', `${operationType.charAt(0).toUpperCase() + operationType.slice(1)} failed. ${humanizeError(error)}`)
      }
    } finally {
      setIsOperationPending(false)
    }
  }

  const checkSBTRequirements = () => {
    const requiredChain = getSBTChainForDirection(direction)
    if (direction === BridgeDirection.L2_TO_L1) {
      if (!hasL2SBT) {
        setCurrentSBTChain(requiredChain)
        setShowSBTModal(true)
        return false
      }
    } else {
      if (hasL1SBT !== true) {
        setCurrentSBTChain(requiredChain)
        setShowSBTModal(true)
        return false
      }
    }
    return true
  }

  // Main action handler
  const handleButtonClick = async () => {
    // Step 1: Connect WaaP wallet
    if (!isWaapConnected) {
      setIsConnecting(true)
      setIsOperationPending(true)
      try {
        await connectWaapWallet()
      } catch (error) {
        // Error handling is done in useWalletStore
      } finally {
        setIsConnecting(false)
        setIsOperationPending(false)
      }
      return
    }

    // Step 2: Connect Aztec wallet
    if (!isAztecConnected) {
      setIsConnecting(true)
      setIsOperationPending(true)
      try {
        await connectAztec()
      } catch (error) {
        // Error handling is done in useWalletStore
      } finally {
        setIsConnecting(false)
        setIsOperationPending(false)
      }
      return
    }

    // Travel Rule: over the cumulative deposit cap — route to the Clean Hands / Passport
    // upgrade screen instead of dead-ending on a disabled button. A temporary hold is NOT
    // an upgrade prompt (the user just needs to wait), so it stays a disabled button below.
    if (travelRuleBlockedDeposit && !pendingHoldBlocked) {
      onRequestVerification?.()
      return
    }

    // Step 3: Faucet if needed
    if (isStateInitialized && isEligibleForFaucet) {
      if (useExternalFaucet && handleExternalFaucet && needsGas && !needsTokensOnly) {
        handleExternalFaucet()
        return
      } else {
        setIsOperationPending(true)
        try {
          await requestFaucet()
        } catch (error) {
          // handled elsewhere
        } finally {
          setIsOperationPending(false)
        }
        return
      }
    }

    // Step 4: SBT check
    if (!checkSBTRequirements()) {
      return
    }

    // Step 5: Attestation check — required for BOTH public and private flows.
    // The L1 TokenPortal and L2 TokenBridge gate every deposit/exit on POCH or
    // Passport regardless of privacy mode.
    if (pochLoading) {
      notify('info', 'Checking eligibility...')
      return
    }
    if (!pochEligible) {
      onRequestVerification?.()
      return
    }

    // Step 5b: Claim-gas guard — the L2 claim would have no FeeJuice to pay for
    // itself. Steer the user into enabling gas top-up rather than letting them
    // start a bridge that strands the funds at the claim step.
    if (needsClaimGas) {
      onAddClaimGas?.()
      return
    }

    // Step 6: Validate amount
    // Step 6a: Passport amount limit check (applies to both public and private)
    if (attestationMethod === 'passport' && passportMaxAmount != null) {
      try {
        const decimals = 6 // USDC decimals
        const inputBigInt = BigInt(Math.floor(parseFloat(inputAmount || '0') * 10 ** decimals))
        if (inputBigInt > passportMaxAmount) {
          // Two different blocks share this gate: the fixed per-transaction ceiling
          // ($1,000) and a smaller leftover slice of the rolling daily limit. Name
          // whichever one actually binds so the figure the user reads is truthful —
          // showing the tiny daily remainder as a "per transaction" max is nonsense.
          const perTxMaxUsd = Number(PASSPORT_MAX_AMOUNT) / 10 ** decimals
          const dailyBinds = remainingDepositUsd != null && remainingDepositUsd < perTxMaxUsd
          const verifyLink = React.createElement(
            'a',
            {
              href: POCH_MINT_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: '#BF1254', textDecoration: 'underline' },
            },
            'Proof of Clean Hands',
          )
          notify(
            'error',
            dailyBinds
              ? {
                  heading: 'Amount Exceeds Your Daily Limit',
                  message: React.createElement(
                    'span',
                    null,
                    `You have $${remainingDepositUsd!.toFixed(2)} left of your daily limit. Verify `,
                    verifyLink,
                    ' to raise it.',
                  ) as unknown as string,
                }
              : {
                  heading: 'Amount Exceeds Human Passport Limit',
                  message: React.createElement(
                    'span',
                    null,
                    `Human Passport allows up to $${perTxMaxUsd.toLocaleString('en-US')} per transaction. Verify `,
                    verifyLink,
                    ' to raise your limit.',
                  ) as unknown as string,
                },
          )
          return
        }
      } catch {
        // parseFloat failed — will be caught by the next validation step
      }
    }
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      flagInvalidAmount()
      return
    }

    // Step 7: Congestion check
    if (isCongested) {
      setShowCongestionWarning(true)
      return
    }

    // Step 8: Execute
    processBridgeOperation()
  }

  const handleConfirmBridge = () => {
    setShowCongestionWarning(false)
    processBridgeOperation()
  }

  // --- Derived UI state ---

  // Alpha per-day deposit cap (deposits only). Block up-front so the user
  // can't start a bridge the attestation layer will reject. remainingDepositUsd
  // is undefined when the cap is disabled.
  const depositLimitBlocked =
    direction === BridgeDirection.L1_TO_L2 &&
    remainingDepositUsd != null &&
    (remainingDepositUsd <= 0 || parseFloat(inputAmount || '0') > remainingDepositUsd)

  // Travel Rule: passport-tier user whose lifetime volume reached the threshold — or
  // whose entered amount would cross it — must upgrade to POCH before bridging more.
  // `>=` because the threshold triggers at "$1,000 or more"; USDC is $1-pegged on Alpha.
  const travelRuleBlockedDeposit =
    direction === BridgeDirection.L1_TO_L2 &&
    (travelRuleBlocked ||
      (travelRuleRemainingUsd != null &&
        (travelRuleRemainingUsd <= 0 || parseFloat(inputAmount || '0') >= travelRuleRemainingUsd - 1e-6)))

  // A block is a *temporary hold* (a signed-but-unconfirmed deposit reserving budget), not a
  // permanent cap, when a reservation exists and it — not settled volume — is what zeroed the
  // remaining budget. `travelRuleBlocked` is settled-only, so it distinguishes a genuine
  // Travel Rule exhaustion (route to Clean Hands) from a hold (wait / disable with a hint).
  const holdUsd =
    direction === BridgeDirection.L1_TO_L2 && reservedDepositUsd != null ? reservedDepositUsd : 0
  const depositHeldOut = holdUsd > 0 && remainingDepositUsd != null && remainingDepositUsd <= 0
  const travelRuleHeldOut =
    holdUsd > 0 && !travelRuleBlocked && travelRuleRemainingUsd != null && travelRuleRemainingUsd <= 0
  const pendingHoldBlocked = depositHeldOut || travelRuleHeldOut

  // Full explanation for the temporary hold, delivered as a Messages entry (below) and carried
  // on the disabled CTA's aria-label/title (SOP §6). Stays GENERAL: a hold can clear on its own
  // when the pending deposit settles, but it can also linger for other reasons (a deposit stuck
  // for lack of Fee Juice), so we never promise a fixed time. Names the reserved amount when the
  // reservation figure is known.
  const pendingHoldReason = pendingHoldBlocked
    ? holdUsd > 0
      ? `$${holdUsd.toFixed(2)} of your limit is held by a pending deposit. It frees up once that deposit settles.`
      : 'Part of your limit is held by a pending deposit. It frees up once that deposit settles.'
    : undefined

  // Full explanation for a plain limit block (the entered amount exceeds what's left of the cap,
  // or the cap is spent). Also delivered as a Messages entry and carried on the aria-label/title,
  // so the button itself stays a short critical label instead of a wrapped paragraph (#415b).
  const depositLimitReason =
    depositLimitBlocked && !pendingHoldBlocked
      ? remainingDepositUsd != null && remainingDepositUsd > 0
        ? `That amount is over your remaining limit. You can bridge up to $${remainingDepositUsd.toFixed(2)} more right now.`
        : 'You have reached your deposit limit for now. It frees up as your recent deposits settle.'
      : undefined

  // One reason string for the disabled CTA (pending hold wins, matching the label priority below).
  const limitBlockReason = pendingHoldReason ?? depositLimitReason

  // #415b: keep the full sentence OUT of the button. The button is a clean grayed control with a
  // short critical label ("Limit held" / "Over your limit"); the full explanation lands here as a
  // persistent, keyed Messages entry so paragraphs never wrap inside the button. Keyed upsert =
  // one row, no spam; dismissed by key the moment the block clears.
  useEffect(() => {
    const key = 'bridge-deposit-limit'
    if (pendingHoldReason) {
      pushNotification({ type: 'warning', key, title: 'Deposit limit on hold', message: pendingHoldReason })
    } else if (depositLimitReason) {
      pushNotification({ type: 'warning', key, title: 'Over your deposit limit', message: depositLimitReason })
    } else {
      dismissNotificationByKey(key)
    }
  }, [pendingHoldReason, depositLimitReason])

  // Binding conflict is only meaningful once BOTH wallets are connected (it's
  // derived from the connected pair). Before that the button is a Connect CTA,
  // so never let the guard suppress those.
  const bindingConflictBlocked = bindingBlocked && bothWalletsConnected

  const isButtonDisabled =
    l2NodeIsReadyLoading ||
    l2NodeError ||
    isNetworkDown ||
    balancesLoading ||
    isConnecting ||
    requestFaucetPending ||
    withdrawTokensToL1Pending ||
    bridgeTokensToL2Pending ||
    isOperationPending ||
    depositLimitBlocked ||
    pendingHoldBlocked ||
    bindingConflictBlocked ||
    bridgeCompleted

  const isOperationInFlight =
    isConnecting || requestFaucetPending || withdrawTokensToL1Pending || bridgeTokensToL2Pending || isOperationPending

  const showLoadingSpinner =
    l2NodeIsReadyLoading ||
    balancesLoading ||
    isOperationInFlight ||
    // Attestation eligibility check is required for both modes.
    (pochLoading && bothWalletsConnected)

  const getLoadingText = () => {
    if (l2NodeIsReadyLoading) return 'Checking Aztec Network Status...'
    if (balancesLoading) return 'Loading balances...'
    if (isConnecting) return 'Connecting...'
    if (requestFaucetPending) return 'Getting Testnet USDC...'
    if (pochLoading) return 'Checking eligibility...'
    if (withdrawTokensToL1Pending) return 'Withdrawing Tokens...'
    if (bridgeTokensToL2Pending) return 'Bridging Tokens...'
    return 'Loading...'
  }

  const getButtonLabel = () => {
    if (l2NodeIsReadyLoading) return 'Checking Aztec Network Status...'
    if (l2NodeError) return 'Aztec Network Unavailable'
    if (isNetworkDown) return 'Aztec Network is Down'
    if (bridgeCompleted) return 'Bridge Complete!'
    if (balancesLoading) return 'Loading balances...'

    // Connection states
    if (!isWaapConnected) return 'Connect Ethereum Wallet'
    if (!isAztecConnected) return 'Connect Aztec Wallet'

    // Binding conflict deliberately does NOT rewrite the label (#297b): the button
    // stays a plain, disabled operation label and the concise reason renders under
    // it, while the full switch-your-wallet notice lives in the Messages feed.

    // Temporary reservation hold: a signed-but-unconfirmed deposit is holding the user's budget.
    // Short critical label only — the full sentence lives in Messages and on the aria-label (#415b).
    if (pendingHoldBlocked) {
      return 'Limit held'
    }

    // Travel Rule: passport tier exhausted, POCH required (deposits only)
    if (travelRuleBlockedDeposit) {
      return 'Verify with Clean Hands to bridge more'
    }

    // Alpha deposit cap (deposits only). Short critical label only — the figure and the full
    // explanation live in Messages and on the aria-label, not wrapped inside the button (#415b).
    if (depositLimitBlocked) {
      return 'Over your limit'
    }

    // Faucet — name what is actually missing (the faucet supplies both ETH gas and
    // test USDC): tokens only when the user already has gas, gas only when they have
    // tokens, or both.
    if (needsGas || needsTokensOnly) {
      if (needsGas && needsTokens) return 'Click to Get Testnet ETH + USDC'
      if (needsTokensOnly) return 'Click to Get Testnet USDC'
      return 'Click to Get Testnet ETH'
    }

    // SBT requirements
    const requiredChain = getSBTChainForDirection(direction)
    if (direction === BridgeDirection.L2_TO_L1) {
      if (!hasL2SBT) return `Get SBT on ${requiredChain}`
    } else {
      if (hasL1SBT !== true) return `Get SBT on ${requiredChain}`
    }

    // Attestation requirement applies to both public and private modes.
    if (pochLoading) return 'Checking eligibility...'
    if (!pochEligible) return 'Verify to continue'

    // The L2 claim has no FeeJuice to pay for itself — turn on gas top-up first.
    if (needsClaimGas) return 'Add gas to claim on Aztec'

    return getOperationLabel(direction)
  }

  // Binding conflict (#297b): the button is a plain disabled control; this concise
  // reason renders under it. The full "switch to your linked pair (0x…)" notice is
  // pushed into the Messages feed by the parent, not crammed into the button label.
  const bindingShortReason = bindingConflictBlocked ? "Wallets don't match your linked pair" : undefined

  // Graceful states: when the button is disabled by an external gate whose reason isn't already
  // carried in the label (fuel / recipient / amount / auth), surface it right under the button
  // instead of leaving a silent greyed control. Suppressed while loading or on completion.
  const effectiveDisabledReason = bindingShortReason ?? disabledReason
  const showDisabledReason =
    !!effectiveDisabledReason && (isDisabled || isButtonDisabled) && !showLoadingSpinner && !bridgeCompleted

  return (
    <>
      <div className="w-full">
        <TextButton
          onClick={handleButtonClick}
          disabled={isButtonDisabled || isDisabled}
          className=""
          title={limitBlockReason}
          aria-label={limitBlockReason}
        >
          {showLoadingSpinner ? (
            <LoadingContent label={getLoadingText()} />
          ) : bridgeCompleted ? (
            <div className="flex items-center gap-2">
              <Icon icon="ph:check-circle-fill" width={20} height={20} className="flex-shrink-0" aria-hidden="true" />
              <span>Bridge Complete!</span>
            </div>
          ) : (
            getButtonLabel()
          )}
        </TextButton>
        {showDisabledReason && (
          <p className="mt-1 text-center text-[11px] leading-[15px] font-medium text-[#B54708]">
            {effectiveDisabledReason}
          </p>
        )}
        {amountError && !showLoadingSpinner && !bridgeCompleted && (
          <p className="mt-1 text-center text-[11px] leading-[15px] font-medium text-[#D92D20]">
            {amountError}
          </p>
        )}
      </div>

      <CongestionWarningModal
        isOpen={showCongestionWarning}
        onClose={() => setShowCongestionWarning(false)}
        onConfirm={handleConfirmBridge}
      />
    </>
  )
}

export default BridgeActionButton
