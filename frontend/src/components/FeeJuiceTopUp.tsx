'use client'

import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { formatUnits, parseUnits } from 'viem'
import {
  formatFjAmount,
  usdToTokenAmount,
  buildSwapCandidates,
  getBestRoute,
  getFeeJuicePriceUsd,
  getTokenPriceUsd,
} from '@/utils/fuelPricing'
import { checkFuelSufficiency } from '@/utils/fuelGasEstimate'
import { BRIDGED_FPC_ADDRESS, L1_RPC_URL, L1_TOKENS, SWAP_BRIDGE_ROUTER_ADDRESS } from '@/config'
import { useTokenPrices } from '@/utils/coinGeckoPrice'
import { useClaimFeeEstimate } from '@/hooks/useL2Operations'
import { useL1TopUpFeeJuice, useL1TokenBalance } from '@/hooks/useL1Operations'
import { useWalletStore } from '@/stores/walletStore'
import { useAttestationCheck } from '@/hooks/useAttestationCheck'

const USD_PRESETS = [1, 5, 10]

/**
 * Real V4 on-chain quote for `tokenAmount` of the L1 funding token → FeeJuice,
 * debounced by 500ms. Mirrors FuelToggle's useV4FuelQuote so the top-up sizes
 * against the same pool rate the deposit-fuel carve uses.
 */
function useTopUpQuote(
  tokenAmount: string,
  tokenAddress: string,
  tokenDecimals: number,
): { fjOutput: bigint | null; loading: boolean; error: string | null } {
  const [fjOutput, setFjOutput] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const amount = Number(tokenAmount)
    if (!tokenAmount || amount <= 0 || !tokenAddress) {
      setFjOutput(null)
      setError(null)
      return
    }

    let inputRaw: bigint
    try {
      inputRaw = parseUnits(tokenAmount, tokenDecimals)
    } catch {
      setFjOutput(null)
      return
    }
    if (inputRaw <= 0n) {
      setFjOutput(null)
      return
    }

    setLoading(true)
    setError(null)

    const timeout = setTimeout(async () => {
      try {
        const candidates = buildSwapCandidates(tokenAddress as `0x${string}`)
        const best = await getBestRoute({ candidates, inputAmount: inputRaw, l1RpcUrl: L1_RPC_URL })
        setFjOutput(best.expectedOutput)
        setError(null)
      } catch (err) {
        setFjOutput(null)
        const errMsg = err instanceof Error ? err.message : String(err)
        const isRevert = errMsg.includes('reverted') || errMsg.includes('execution reverted')
        setError(isRevert ? 'Swap amount exceeds pool liquidity, try a smaller amount' : 'Quote failed')
      } finally {
        setLoading(false)
      }
    }, 500)

    return () => clearTimeout(timeout)
  }, [tokenAmount, tokenAddress, tokenDecimals])

  return { fjOutput, loading, error }
}

/** Whether the quoted FJ output covers the claim fee for `fuelType`. Debounced on fjOutput. */
function useTopUpSufficiency(
  fjOutput: bigint | null,
  fuelType: 'public' | 'private',
): { sufficient: boolean | null; feeLimitFj: string | null; loading: boolean } {
  const [sufficient, setSufficient] = useState<boolean | null>(null)
  const [feeLimitFj, setFeeLimitFj] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (fjOutput === null || fjOutput === 0n) {
      setSufficient(null)
      setFeeLimitFj(null)
      return
    }
    let cancelled = false
    setLoading(true)
    ;(async () => {
      try {
        const result = await checkFuelSufficiency(fjOutput, fuelType)
        if (!cancelled) {
          setSufficient(result.sufficient)
          setFeeLimitFj(result.feeLimitFj)
        }
      } catch {
        if (!cancelled) {
          setSufficient(null)
          setFeeLimitFj(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fjOutput, fuelType])

  return { sufficient, feeLimitFj, loading }
}

/**
 * Recommended top-up spend for the "auto" convenience.
 *
 * Sizes the spend to cover the SHORTFALL between the L2 claim fee and the FJ the
 * user already holds, not the full claim fee. Public fuel claims into the
 * account's public FJ balance, so an existing balance offsets what must be
 * bridged. Private fuel (BridgedFPC) self-funds its own landing claim
 * (mint_and_pay_fee asserts the fresh amount >= gas), so a private top-up must
 * still cover the whole claim; but if the user already holds enough, no top-up
 * is recommended at all. We probe the real V4 pool for its FeeJuice-per-token
 * rate (off mainnet the FJ price feed and the pool diverge, so price-based
 * sizing is wrong), then size the spend with headroom.
 */
function useRecommendedTopUp(
  enabled: boolean,
  fuelType: 'public' | 'private',
  claimFeeLimit: bigint | undefined,
  existingFj: number,
  tokenAddress: string,
  tokenDecimals: number,
  tokenSymbol: string,
  prices: Record<string, number> | null | undefined,
): string | null {
  const [recommended, setRecommended] = useState<string | null>(null)

  useEffect(() => {
    setRecommended(null)
    if (!enabled || claimFeeLimit == null || !tokenAddress) return
    let cancelled = false
    const timeout = setTimeout(async () => {
      try {
        const needFj = Number(claimFeeLimit) / 1e18
        // Existing FJ already covers the claim, nothing to bridge.
        if (existingFj >= needFj) return
        // Public fuel: only bridge the shortfall (existing + claimed pay together).
        // Private fuel: the fresh bridge self-funds its own landing claim, so size
        // to the whole claim.
        const requiredFj = fuelType === 'public' ? needFj - existingFj : needFj
        const fjUsd = getFeeJuicePriceUsd(prices)
        const tokenUsd = getTokenPriceUsd(tokenSymbol, prices)
        // Order-of-magnitude probe size (not the rate; the rate is measured on-chain).
        const guess = tokenUsd > 0 && fjUsd > 0 ? (requiredFj * fjUsd) / tokenUsd : 1
        const probeToken = Math.max(guess, 1e-6)
        const probeRaw = BigInt(Math.floor(probeToken * 10 ** tokenDecimals))
        if (probeRaw <= 0n) return
        const candidates = buildSwapCandidates(tokenAddress as `0x${string}`)
        const best = await getBestRoute({ candidates, inputAmount: probeRaw, l1RpcUrl: L1_RPC_URL })
        if (cancelled || best.expectedOutput <= 0n) return
        const fjPerToken = Number(best.expectedOutput) / 1e18 / probeToken
        if (fjPerToken <= 0) return
        // Headroom for price impact between probe and final size + swap slippage. Slightly
        // larger than the deposit-fuel buffer so the one-tap amount comfortably clears the
        // downstream sufficiency check without a second attempt.
        const BUFFER = 1.4
        const recToken = (requiredFj * BUFFER) / fjPerToken
        const centsDecimals = tokenUsd > 0 ? Math.ceil(Math.log10(tokenUsd) + 2) : 2
        const displayDecimals = Math.min(Math.max(centsDecimals, 2), tokenDecimals)
        const factor = 10 ** displayDecimals
        const rounded = Math.ceil(recToken * factor) / factor
        if (rounded > 0 && !cancelled) setRecommended(String(rounded))
      } catch {
        if (!cancelled) setRecommended(null)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [enabled, fuelType, claimFeeLimit, existingFj, tokenAddress, tokenDecimals, tokenSymbol, prices])

  return recommended
}

/** Carve almost the whole spend into fuel: the SDK requires fuel < amount strictly. */
function deriveFuelAmount(spend: string, decimals: number): string {
  if (!spend || Number(spend) <= 0) return ''
  try {
    const raw = parseUnits(spend, decimals)
    if (raw <= 1n) return ''
    return formatUnits(raw - 1n, decimals)
  } catch {
    return ''
  }
}

function QuoteSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-3 bg-neutral-300 rounded w-3/4" />
      <div className="h-3 bg-neutral-300 rounded w-full" />
    </div>
  )
}

/** One labeled balance figure (public/globe or private/lock), highlighted when it is the active mode. */
function BalanceFigure({
  label,
  value,
  loading,
  icon,
  color,
  active,
  first,
}: {
  label: string
  value: string
  loading?: boolean
  icon: string
  color: string
  active: boolean
  first: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between gap-2 px-4 py-3 ${first ? '' : 'border-t border-latest-grey-300'}`}
      style={active ? { backgroundColor: `${color}0F` } : undefined}
    >
      <span className="flex items-center gap-2 text-[13px] text-latest-grey-100">
        <Icon icon={icon} width={15} height={15} style={{ color }} />
        <span className={active ? 'font-semibold' : 'font-medium'} style={active ? { color } : undefined}>
          {label}
        </span>
        {active && (
          <span
            className="rounded-full px-2 py-0.5 text-10 font-semibold"
            style={{ color, backgroundColor: `${color}1A` }}
          >
            Active
          </span>
        )}
      </span>
      {loading ? (
        <span className="inline-block h-3 w-14 rounded bg-neutral-300 animate-pulse" />
      ) : (
        <span className="text-14 font-semibold tabular-nums text-latest-black-100">
          {value} <span className="text-[11px] font-medium text-latest-grey-500">FJ</span>
        </span>
      )}
    </div>
  )
}

interface FeeJuiceTopUpProps {
  isPrivacyModeEnabled?: boolean
  /** Public L2 Fee Juice balance (pays public claims; string like "10.15"). */
  feeJuiceBalance?: string
  /** BridgedFPC balance, the applicable balance in privacy mode. */
  privateFeeJuiceBalance?: string
  /** Loading flags so the balance figures can show a skeleton instead of a stale dash. */
  feeJuiceBalanceLoading?: boolean
  privateFeeJuiceBalanceLoading?: boolean
  /**
   * True when the user arrived here from an interrupted L1 to L2 claim that ran short on L2 gas.
   * Drives mode-specific status copy: in PUBLIC mode the existing balance can pay the landing
   * claim, but in PRIVATE mode that landing claim self-funds, so the existing private balance
   * does NOT apply and fresh private Fee Juice must be added.
   */
  landingClaimShort?: boolean
  /**
   * True when the interrupted claim's L1 to L2 message was already consumed by a prior successful
   * claim (the "no non-nullified message" case). The deposit very likely already completed, so a
   * top-up cannot fix it and "you have enough, resume" must never show; the panel points the user
   * at their L2 balance instead.
   */
  depositLikelyCompleted?: boolean
  /** Reports whether the existing balance already covers the interrupted claim (public mode). */
  onLandingCoveredChange?: (covered: boolean) => void
  /** Called with the L2 tx hash once the top-up completes and FJ lands on L2. */
  onSuccess?: (l2TxHash?: string) => void
  /**
   * Home action. Rendered as the ~20% secondary in the pinned action row beside the
   * primary CTA (SOP §4/#194), so the screen carries ONE return affordance, on the
   * same row as the action, instead of a separate top-left arrow.
   */
  onHome?: () => void
  /**
   * Page-owned action that belongs with the CTA (the fee-juice page's "Resume claim").
   * Rendered inside the pinned footer above the action row so it can never scroll out
   * of reach or drift up the card as the body shrinks.
   */
  footerExtra?: React.ReactNode
}

/**
 * Standalone "buy + bridge Fee Juice" form.
 *
 * Reuses the exact deposit-fuel primitive via `useL1TopUpFeeJuice` (buy FJ on L1,
 * bridge to L2) and the same V4 quote + sufficiency hooks the withdraw panel uses.
 * Adds a one-tap "auto" recommendation that sizes the spend to cover the L2 claim
 * fee. Privacy mode forces private (BridgedFPC) fuel so the topped-up FJ stays
 * anonymous, the same enforcement as every other fuel path.
 */
const FeeJuiceTopUp: React.FC<FeeJuiceTopUpProps> = ({
  isPrivacyModeEnabled = false,
  feeJuiceBalance,
  privateFeeJuiceBalance,
  feeJuiceBalanceLoading = false,
  privateFeeJuiceBalanceLoading = false,
  landingClaimShort = false,
  depositLikelyCompleted = false,
  onLandingCoveredChange,
  onSuccess,
  onHome,
  footerExtra,
}) => {
  const router = useRouter()
  const hasBridgedFpc = !!BRIDGED_FPC_ADDRESS
  const { isWaapConnected, isAztecConnected, connectWaapWallet, connectAztecWallet } = useWalletStore()

  // Graceful connect: never a dead disabled button. When a wallet is missing the top-up
  // controls become ACTIVE prompts that start the connect flow for the missing chain.
  const missingEth = !isWaapConnected
  const missingAztec = !isAztecConnected
  const [connecting, setConnecting] = useState(false)
  const connectLabel = missingEth && missingAztec ? 'Connect wallets' : missingEth ? 'Connect Ethereum wallet' : 'Connect Aztec wallet'
  const handleConnect = async () => {
    if ((isWaapConnected && isAztecConnected) || connecting) return
    setConnecting(true)
    try {
      if (missingEth) await connectWaapWallet()
      else if (missingAztec) await connectAztecWallet()
    } catch {
      // Store surfaces its own error toast.
    } finally {
      setConnecting(false)
    }
  }

  const fuelType: 'public' | 'private' = isPrivacyModeEnabled && hasBridgedFpc ? 'private' : 'public'

  const fundingToken = L1_TOKENS[0]
  const fundingSymbol = fundingToken?.symbol ?? 'USDC'
  const fundingDecimals = fundingToken?.decimals ?? 6
  const fundingAddress = fundingToken?.l1TokenContract ?? ''
  const canTopUp = !!SWAP_BRIDGE_ROUTER_ADDRESS && (!isPrivacyModeEnabled || hasBridgedFpc) && !!fundingAddress

  const { prices, error: pricesError } = useTokenPrices()
  const { data: claimFeeLimit, isLoading: claimFeeLoading } = useClaimFeeEstimate(fuelType)
  const claimFeeFj = claimFeeLimit != null ? formatFjAmount(claimFeeLimit, 2) : null

  const [spendAmount, setSpendAmount] = useState('')
  // When the user is already covered we hide the top-up form, but keep a subtle opt-in
  // so they can still add more Fee Juice on purpose.
  const [optionalTopUpOpen, setOptionalTopUpOpen] = useState(false)
  const fuelAmount = deriveFuelAmount(spendAmount, fundingDecimals)

  // Available L1 balance of the funding token (same balanceOf read the bridge form uses).
  // The user cannot spend more of it than they hold, so it gates the buy CTA below.
  const { data: fundingBalance } = useL1TokenBalance()
  const fundingBalanceNum =
    fundingBalance != null && fundingBalance !== '' && !isNaN(Number(fundingBalance)) ? Number(fundingBalance) : null
  // Floor to 4 dp so the "you have" figure never reads higher than the real balance.
  const fundingBalanceDisplay = fundingBalanceNum != null ? String(Math.floor(fundingBalanceNum * 1e4) / 1e4) : ''
  const spendNum = spendAmount && !isNaN(Number(spendAmount)) ? Number(spendAmount) : 0
  const exceedsBalance = fundingBalanceNum != null && spendNum > fundingBalanceNum

  const { fjOutput, loading: quoteLoading, error: quoteError } = useTopUpQuote(fuelAmount, fundingAddress, fundingDecimals)
  const { sufficient, feeLimitFj, loading: sufficiencyLoading } = useTopUpSufficiency(fjOutput, fuelType)

  // The FJ that pays an L2 claim comes from the user's ACCOUNT balance: public
  // FJ for public fuel, BridgedFPC balance for private fuel, so the existing
  // balance counts toward "do I have enough". For public fuel the freshly
  // claimed FJ lands in that same public balance, so existing + swap pay
  // together. For private fuel the fresh bridge self-funds its own landing
  // claim, so the swap alone must clear the claim (existing private balance
  // still means no top-up is needed if it already covers the claim).
  const applicableBalanceStr = fuelType === 'private' ? privateFeeJuiceBalance : feeJuiceBalance
  const existingFj = applicableBalanceStr != null && applicableBalanceStr !== '--' ? Number(applicableBalanceStr) : 0
  const needFj = claimFeeLimit != null ? Number(claimFeeLimit) / 1e18 : null
  const swapFj = fjOutput != null ? Number(fjOutput) / 1e18 : null
  // A specific interrupted claim in PRIVATE mode self-funds its landing claim, so the user's
  // EXISTING private balance can't be applied to it, fresh private Fee Juice is required.
  // That's why "already enough" must be false here even if the private balance looks sufficient
  // (this is what prevents the contradictory "you have enough" next to "claim ran short").
  const selfFundLandingShort = landingClaimShort && fuelType === 'private'
  // "You have enough" must never sit next to a failure a top-up can't fix. A consumed-message
  // recovery (deposit likely already completed) is exactly that case, so it can't be "enough".
  const alreadyEnough =
    needFj != null && existingFj >= needFj && !selfFundLandingShort && !depositLikelyCompleted
  // Whether the CHOSEN top-up amount will actually land: a fresh fuel bridge self-funds its own
  // L2 claim, so the swap output alone must clear the claim fee, regardless of any existing
  // balance. `sufficient` (fjOutput >= feeLimit) is the exact gate the SDK asserts before it
  // throws "Insufficient fuel". An existing balance covers other txs but never this fresh claim,
  // so it must not be added in here or the UI would promise coverage the top-up can't deliver.
  const topUpCovers = sufficient

  // Tell the page whether the interrupted claim is already fundable from the existing balance
  // (only possible in public mode) so it can offer Resume without a redundant top-up.
  const landingCovered = landingClaimShort && alreadyEnough
  useEffect(() => {
    onLandingCoveredChange?.(landingCovered)
  }, [landingCovered, onLandingCoveredChange])

  const topUp = useL1TopUpFeeJuice((l2TxHash) => {
    setSpendAmount('')
    onSuccess?.(l2TxHash)
  })

  const recommended = useRecommendedTopUp(
    canTopUp,
    fuelType,
    claimFeeLimit,
    existingFj,
    fundingAddress,
    fundingDecimals,
    fundingSymbol,
    prices,
  )

  const walletsReady = isWaapConnected && isAztecConnected
  const amountValid = !!fuelAmount && Number(fuelAmount) > 0

  // Keep the frontend in sync with the backend on the deposit limit. The buy+bridge below runs
  // through `useL1TopUpFeeJuice` -> `bridge.bridgeL1ToL2`, whose attestation cascade STILL counts
  // the spend against the compliance deposit cap. So we gate the top-up on the same remaining
  // figure the bridge form uses, and never let the user confirm a top-up the backend will reject.
  // Tier-appropriate remaining: a Passport user is bound by the Travel Rule (travelRuleRemainingUsd),
  // a PoCH user by the daily deposit cap (remainingDepositUsd); undefined = cap disabled, no gate.
  // This can be relaxed ONLY once the backend ships a fuel-only-deposit exemption (a `fuelOnly` flag
  // on the attestation request that skips fuel spend from the cap), at which point both layers drop
  // the gate together.
  const { data: attestation } = useAttestationCheck()
  const tierRemainingUsd =
    attestation?.method === 'passport' ? attestation?.travelRuleRemainingUsd : attestation?.remainingDepositUsd
  const spendUsd = spendNum > 0 ? spendNum * getTokenPriceUsd(fundingSymbol, prices) : 0
  const overDepositLimit = tierRemainingUsd != null && spendUsd > tierRemainingUsd
  const depositLimitMessage =
    tierRemainingUsd != null && tierRemainingUsd > 0
      ? `That amount is over your remaining limit. You can bridge up to $${tierRemainingUsd.toFixed(2)} more right now.`
      : 'You have reached your deposit limit for now. It frees up as your recent deposits settle.'

  const confirmDisabled =
    !canTopUp ||
    !walletsReady ||
    !amountValid ||
    exceedsBalance ||
    overDepositLimit ||
    quoteLoading ||
    fjOutput === null ||
    !!quoteError ||
    sufficiencyLoading ||
    topUpCovers === false ||
    topUp.isPending

  // Reason surfaced on the disabled primary (SOP §6): every disabled state names why.
  const confirmReason = !amountValid
    ? 'Enter an amount to add'
    : exceedsBalance
      ? `Not enough ${fundingSymbol}. You have ${fundingBalanceDisplay} ${fundingSymbol}.`
      : overDepositLimit
        ? depositLimitMessage
        : quoteLoading || sufficiencyLoading
        ? 'Checking the quote'
        : quoteError || fjOutput === null
          ? 'Quote unavailable, try again'
          : topUpCovers === false
            ? 'Add more to cover a transaction'
            : topUp.isPending
              ? 'Buying Fee Juice'
              : undefined

  const spend = (amount: string) => {
    const fuel = deriveFuelAmount(amount, fundingDecimals)
    if (!fuel || Number(fuel) <= 0) return
    topUp.mutate({ tokenSymbol: fundingSymbol, spendAmount: amount, fuelAmount: fuel, fuelType })
  }

  const handleConfirm = () => {
    if (confirmDisabled) return
    spend(spendAmount)
  }

  // Covered = the applicable-mode balance already meets the claim, so no top-up is required.
  // Likely-completed and covered both mean no top-up is needed, so the buy form collapses behind
  // the subtle opt-in in either case.
  const covered = alreadyEnough
  const noTopUpNeeded = covered || depositLikelyCompleted
  // The in-flight status stands in for the form: a disabled amount field beside a
  // spinning button reads as a frozen screen with nothing to do.
  const showForm = (!noTopUpNeeded || optionalTopUpOpen) && !topUp.isPending

  const modeIsPrivate = fuelType === 'private'
  const modeColor = modeIsPrivate ? '#81133B' : '#17235E'
  const modeLabel = modeIsPrivate ? 'Private' : 'Public'

  const showPrivate = hasBridgedFpc
  const publicDisplay = feeJuiceBalance != null && feeJuiceBalance !== '--' ? feeJuiceBalance : '--'
  const privateDisplay = privateFeeJuiceBalance != null && privateFeeJuiceBalance !== '--' ? privateFeeJuiceBalance : '--'
  const needLabel = claimFeeLoading || claimFeeFj == null ? '…' : `~${claimFeeFj} FJ`

  // How much this top-up adds relative to the mode balance the user already holds.
  const pctOfBalance = swapFj != null && existingFj > 0 ? (swapFj / existingFj) * 100 : null

  // The single primary action for the CURRENT state, rendered in the pinned row at the
  // bottom of the card (never inline in the body). One primary per state: a connect
  // prompt when a wallet is missing, the opt-in when nothing is required, otherwise the
  // buy. When the deployment cannot top up at all there is no action, and Home takes the
  // whole row rather than sitting beside a dead button (SOP §6).
  const primaryCta = !canTopUp ? null : !walletsReady ? (
    <button
      type="button"
      onClick={handleConnect}
      disabled={connecting}
      className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-[#81133B] px-4 py-3 text-14 font-semibold text-white transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Icon icon="ph:plugs-connected-fill" width={16} height={16} className="shrink-0" />
      <span className="truncate">{connecting ? 'Connecting…' : `${connectLabel} to buy Fee Juice`}</span>
    </button>
  ) : noTopUpNeeded && !optionalTopUpOpen && !topUp.isPending ? (
    <button
      type="button"
      onClick={() => setOptionalTopUpOpen(true)}
      className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-[#81133B] px-4 py-3 text-14 font-semibold text-white transition-opacity hover:opacity-80"
    >
      <Icon icon="ph:gas-pump-fill" width={16} height={16} className="shrink-0" />
      Add Fee Juice
    </button>
  ) : (
    <button
      type="button"
      onClick={handleConfirm}
      disabled={confirmDisabled}
      title={confirmDisabled ? confirmReason : undefined}
      aria-label={confirmDisabled ? confirmReason : undefined}
      className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-[#81133B] px-4 py-3 text-14 font-semibold text-white transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {topUp.isPending ? (
        <>
          <Icon icon="ph:spinner-gap-bold" width={16} height={16} className="shrink-0 animate-spin" />
          Buying Fee Juice…
        </>
      ) : (
        <>
          <Icon icon="ph:lightning-fill" width={16} height={16} className="shrink-0" />
          Buy and bridge Fee Juice
        </>
      )}
    </button>
  )

  // Fills the fixed-height card (SOP §4): the body takes the slack and the action row is
  // pinned to the bottom edge, so the CTA sits in the SAME place in every state instead of
  // riding up the card whenever the body has less to say.
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {!canTopUp ? (
          <p className="rounded-lg bg-latest-grey-200 px-4 py-3 text-[13px] leading-5 text-latest-grey-100">
            Fee Juice top up is not available on this deployment.
          </p>
        ) : (
          <>
            {/* Balances: two clearly labeled figures with the globe (public) / lock (private)
                treatment used elsewhere. The active mode is highlighted. */}
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-latest-grey-500">Your balance</p>
                {/* Mode indicator: mode follows Privacy Mode in the top nav. */}
                <div
                  data-tooltip-id="fj-mode-info"
                  data-tooltip-content="Public Fee Juice pays L2 gas openly. Private (BridgedFPC) fuel keeps your transaction anonymous. Mode follows Privacy Mode in the top nav."
                  className={`flex shrink-0 cursor-help items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                    modeIsPrivate ? 'border-[#81133B]/40 bg-[#81133B]/[0.06]' : 'border-[#17235E]/40 bg-[#17235E]/[0.06]'
                  }`}
                  style={{ color: modeColor }}
                >
                  <Icon icon={modeIsPrivate ? 'ph:lock-simple' : 'ph:globe'} width={13} height={13} />
                  {modeLabel}
                </div>
              </div>
              <div className="overflow-hidden rounded-lg border border-latest-grey-300 bg-white">
                <BalanceFigure
                  label="Public"
                  value={publicDisplay}
                  loading={feeJuiceBalanceLoading}
                  icon="ph:globe-hemisphere-west-fill"
                  color="#17235E"
                  active={!modeIsPrivate}
                  first
                />
                {showPrivate && (
                  <BalanceFigure
                    label="Private"
                    value={privateDisplay}
                    loading={privateFeeJuiceBalanceLoading}
                    icon="ph:lock-key-fill"
                    color="#81133B"
                    active={modeIsPrivate}
                    first={false}
                  />
                )}
              </div>
            </div>

            {/* Requirement indicator: how much FJ a transaction needs, and whether they are covered. */}
            <div
              className={`flex items-center justify-between gap-2 rounded-lg px-4 py-3 ${
                covered ? 'bg-[#17235E]/[0.06]' : 'bg-latest-grey-200'
              }`}
            >
              <span className="flex items-center gap-2 text-12 text-latest-grey-100">
                <Icon icon="ph:gas-pump-fill" width={14} height={14} className="text-[#17235E]" />
                A transaction needs <span className="font-semibold text-latest-black-100">{needLabel}</span>
              </span>
              {covered ? (
                <span className="flex shrink-0 items-center gap-1 text-12 font-semibold text-[#17235E]">
                  <Icon icon="ph:check-circle-fill" width={14} height={14} />
                  Covered
                </span>
              ) : (
                <span className="shrink-0 text-12 font-semibold text-latest-grey-500">
                  {topUp.isPending ? 'Adding' : 'Add below'}
                </span>
              )}
            </div>

            {pricesError && (
              <p className="text-[11px] text-amber-600">Live prices unavailable, using fallback prices</p>
            )}

            {/* The buy is an L1→L2 bridge, so it runs for minutes with nothing to do. The
                operation is created before the L1 send (OPERATION_CREATED precedes
                DEPOSIT_SENT), so a dropped session resumes from Activity rather than
                stranding the spend — which is what makes leaving this screen safe. */}
            {topUp.isPending && (
              <div className="space-y-2 rounded-lg bg-[#81133B]/[0.06] px-4 py-3">
                <p className="flex items-center gap-2 text-[13px] font-semibold text-[#81133B]">
                  <Icon icon="ph:spinner-gap-bold" width={15} height={15} className="animate-spin" />
                  Buying Fee Juice
                </p>
                <p className="text-12 leading-[17px] text-latest-grey-100">
                  Your {fundingSymbol} is swapping on Ethereum, then bridging to Aztec. This usually takes 5 to 15
                  minutes and finishes on its own.
                </p>
                <p className="text-12 leading-[17px] text-latest-grey-100">
                  Keep this tab open. You can move around the app while it runs. If the tab closes, pick it back up
                  under Activity. Your funds stay safe either way.
                </p>
              </div>
            )}

            {/* One coherent status line, mode-specific, never two opposing statements. The
                in-flight block above owns the screen while a buy is running, so none of these
                can tell the user to "add below" next to a form that is no longer there. */}
            {topUp.isPending ? null : depositLikelyCompleted ? (
              <div className="flex items-start gap-2 rounded-lg bg-[#17235E]/[0.08] px-4 py-3">
                <Icon icon="ph:check-circle-fill" width={16} height={16} className="mt-0.5 flex-shrink-0 text-[#17235E]" />
                <p className="text-12 leading-[17px] text-latest-grey-100">
                  <span className="font-semibold text-[#17235E]">This deposit likely already completed.</span> Check your
                  L2 balance. No top up or resume needed.
                </p>
              </div>
            ) : covered ? (
              // Covered is stated once, by the compact requirement indicator above. No extra
              // panel telling the user they have nothing to do.
              null
            ) : selfFundLandingShort ? (
              <div className="flex items-start gap-2 rounded-lg bg-[#D92D20]/[0.08] px-4 py-3">
                <Icon icon="ph:warning-circle-fill" width={16} height={16} className="mt-0.5 flex-shrink-0 text-[#D92D20]" />
                <p className="text-12 leading-[17px] text-latest-grey-100">
                  <span className="font-semibold text-[#D92D20]">This claim needs fresh private Fee Juice.</span> Your
                  existing private balance will not apply. Add some below, or switch to public in Privacy Mode.
                </p>
              </div>
            ) : landingClaimShort ? (
              <div className="flex items-start gap-2 rounded-lg bg-[#D92D20]/[0.08] px-4 py-3">
                <Icon icon="ph:warning-circle-fill" width={16} height={16} className="mt-0.5 flex-shrink-0 text-[#D92D20]" />
                <p className="text-12 leading-[17px] text-latest-grey-100">
                  <span className="font-semibold text-[#D92D20]">Claim ran short on L2 gas.</span> Add Fee Juice below,
                  then resume. Your funds stay safe.
                </p>
              </div>
            ) : null}

            {showForm && (
              <div className="space-y-3">
                <div className="flex items-baseline justify-between gap-2">
                  <label htmlFor="fee-juice-amount" className="text-[13px] font-semibold text-latest-black-100">
                    Amount to add
                  </label>
                  {fundingBalanceNum != null ? (
                    <span className="flex items-baseline gap-1.5 text-[11px] text-latest-grey-500">
                      Balance {fundingBalanceDisplay} {fundingSymbol}
                      <button
                        type="button"
                        disabled={topUp.isPending}
                        onClick={() => setSpendAmount(fundingBalance ?? '')}
                        title={`Use full ${fundingSymbol} balance`}
                        className="font-semibold text-[#81133B] transition-opacity hover:opacity-80 disabled:opacity-40"
                      >
                        Max
                      </button>
                    </span>
                  ) : (
                    <span className="text-[11px] text-latest-grey-500">Paid in {fundingSymbol} on Ethereum</span>
                  )}
                </div>

                {/* Focal amount entry: a large field with the token unit inline, plus quick presets. */}
                <div className="relative">
                  <input
                    id="fee-juice-amount"
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={spendAmount}
                    disabled={topUp.isPending}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '' || !isNaN(Number(v))) setSpendAmount(v)
                    }}
                    className="w-full rounded-lg border border-latest-grey-300 px-4 py-3 pr-16 text-18 font-semibold text-latest-black-100 transition-colors focus:border-[#81133B] focus:outline-none focus:ring-1 focus:ring-[#81133B] disabled:opacity-60"
                  />
                  <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-medium text-latest-grey-500">
                    {fundingSymbol}
                  </span>
                </div>

                <div className="flex gap-2">
                  {USD_PRESETS.map((usd) => {
                    const tokenEquiv = usdToTokenAmount(usd, fundingSymbol, prices)
                    const selected = spendAmount === tokenEquiv
                    return (
                      <button
                        key={usd}
                        type="button"
                        disabled={topUp.isPending}
                        onClick={() => setSpendAmount(tokenEquiv)}
                        title={`${tokenEquiv} ${fundingSymbol}`}
                        className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors disabled:opacity-60 ${
                          selected
                            ? 'border-[#81133B] bg-[#81133B]/[0.06] text-[#81133B]'
                            : 'border-latest-grey-300 text-latest-grey-100 hover:border-latest-grey-400'
                        }`}
                      >
                        ${usd}
                      </button>
                    )
                  })}
                  {recommended && (
                    <button
                      type="button"
                      disabled={topUp.isPending}
                      onClick={() => setSpendAmount(recommended)}
                      title={`${recommended} ${fundingSymbol}, sized to cover a transaction`}
                      className={`flex-1 rounded-lg border px-3 py-2 text-[13px] font-medium transition-colors disabled:opacity-60 ${
                        spendAmount === recommended
                          ? 'border-[#81133B] bg-[#81133B]/[0.06] text-[#81133B]'
                          : 'border-latest-grey-300 text-latest-grey-100 hover:border-latest-grey-400'
                      }`}
                    >
                      Auto
                    </button>
                  )}
                </div>

                {/* Balance guard: one compact line, and it stands in for the quote readout (never
                    stacked on top of it) so an over-balance amount can't grow the card past its
                    fixed height. */}
                {exceedsBalance && (
                  <p className="text-12 font-medium leading-[17px] text-[#D92D20]">
                    Not enough {fundingSymbol}. You have {fundingBalanceDisplay} {fundingSymbol}.
                  </p>
                )}

                {/* Deposit-limit guard: one compact line that also stands in for the quote readout,
                    so an over-limit amount never stacks a second block or grows the card past its
                    fixed height. Mirrors the backend cap the buy+bridge is counted against. */}
                {!exceedsBalance && overDepositLimit && (
                  <p className="text-12 font-medium leading-[17px] text-[#D92D20]">{depositLimitMessage}</p>
                )}

                {/* Live readout: what the spend converts to, and how much it adds to the current balance. */}
                {!exceedsBalance && !overDepositLimit && amountValid && (quoteLoading || (fjOutput === null && !quoteError)) && <QuoteSkeleton />}
                {!exceedsBalance && !overDepositLimit && amountValid && quoteError && <p className="text-12 text-red-500">{quoteError}</p>}
                {!exceedsBalance && !overDepositLimit && amountValid && !quoteLoading && !quoteError && fjOutput !== null && (
                  <div className="rounded-lg bg-latest-grey-200 px-4 py-3 text-12 leading-[17px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-latest-grey-100">You receive</span>
                      <span className="font-semibold text-latest-black-100">~{formatFjAmount(fjOutput)} FJ</span>
                    </div>
                    {pctOfBalance != null && (
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-latest-grey-100">Adds to your {modeLabel.toLowerCase()} balance</span>
                        <span className="font-medium text-latest-grey-100">+{pctOfBalance.toFixed(0)}%</span>
                      </div>
                    )}
                    {!sufficiencyLoading && topUpCovers !== null && (
                      <div
                        className={`mt-2 border-t border-latest-grey-300 pt-2 font-medium ${
                          topUpCovers ? 'text-[#17235E]' : 'text-[#D92D20]'
                        }`}
                      >
                        {topUpCovers
                          ? `Covers a transaction (about ${feeLimitFj ?? claimFeeFj} FJ needed).`
                          : `This produces ~${formatFjAmount(fjOutput)} FJ but the transaction needs ~${
                              feeLimitFj ?? claimFeeFj
                            } FJ. ${recommended ? `Add about ${recommended} ${fundingSymbol}.` : 'Increase the amount.'}`}
                      </div>
                    )}
                  </div>
                )}

              </div>
            )}

            <ReactTooltip id="fj-mode-info" place="top" className="z-[100]" style={{ fontSize: '12px', maxWidth: '240px' }} />
          </>
        )}
      </div>

      {/* Pinned action row. Home is the ~20% secondary sharing the primary's row
          (SOP §4/#194) — this screen's only return affordance, so there is no
          separate top-left arrow to compete with it. */}
      <div className="shrink-0 space-y-2 pt-4">
        {footerExtra}
        {topUp.isPending && (
          <button
            type="button"
            onClick={() => router.push('/activity')}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-latest-grey-300 py-3 text-14 font-semibold text-latest-grey-100 transition-colors hover:border-latest-grey-400 hover:text-latest-black-100"
          >
            <Icon icon="ph:list-bullets" width={16} height={16} className="shrink-0" />
            Track it in Activity
          </button>
        )}
        <div className="flex items-stretch gap-2">
          {onHome && (
            <button
              type="button"
              onClick={onHome}
              title="Back to main screen"
              aria-label="Back to main screen"
              className={`flex items-center justify-center gap-2 rounded-lg border border-latest-grey-300 px-4 py-3 text-14 font-semibold text-latest-grey-100 transition-colors hover:border-latest-grey-400 hover:text-latest-black-100 ${
                primaryCta ? 'basis-1/5 shrink-0' : 'w-full'
              }`}
            >
              <Icon icon="ph:house" width={16} height={16} className="shrink-0" />
              {!primaryCta && 'Home'}
            </button>
          )}
          {primaryCta}
        </div>
      </div>
    </div>
  )
}

export default FeeJuiceTopUp
