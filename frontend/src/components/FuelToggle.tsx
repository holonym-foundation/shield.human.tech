'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address'
import { formatFjAmount, getFeeJuicePriceUsd, getTokenPriceUsd, usdToTokenAmount } from '@/utils/fuelPricing'
import { buildSwapCandidates, getBestRoute } from '@/utils/fuelPricing'
import { BRIDGED_FPC_ADDRESS, L1_RPC_URL } from '@/config'
import { useTokenPrices } from '@/utils/coinGeckoPrice'
import { useClaimFeeEstimate } from '@/hooks/useL2Operations'
import { pushNotification, useNotificationsStore } from '@/stores/useNotificationsStore'

interface FuelToggleProps {
  fuelEnabled: boolean
  fuelAmount: string
  bridgeAmount: string
  // Token amount received on L2 after the fuel carve-out AND the portal fee. Passed in
  // (rather than derived from bridge - fuel) so it matches the main "You will receive".
  youWillReceive?: string
  tokenSymbol: string
  tokenDecimals: number
  tokenAddress: string
  onToggle: (enabled: boolean) => void
  onAmountChange: (amount: string) => void
  feeJuiceBalance?: string
  privateFeeJuiceBalance?: string
  feeJuiceBalanceLoading?: boolean
  privateFeeJuiceBalanceLoading?: boolean
  fuelType: 'public' | 'private'
  onFuelTypeChange: (type: 'public' | 'private') => void
  onSufficiencyChange?: (sufficient: boolean) => void
  /**
   * Whether the third-party fuel-recipient form is in a valid state. The parent uses this to
   * gate the bridge button so we don't accept an unparseable address.
   */
  onRecipientValidityChange?: (valid: boolean) => void
  // Fuel is carved OUT of the bridge amount, so the SDK requires `fuel < bridge` strictly.
  onFuelAmountValidChange?: (valid: boolean) => void
  isPrivacyModeEnabled?: boolean
  /** L2 address of the bridger — used as the default fuel recipient and for "self" comparisons. */
  selfAztecAddress?: string
  fuelRecipientOverride: string
  onFuelRecipientOverrideChange: (address: string) => void
  /** Controlled detail-accordion state, so the parent can enforce mutual exclusivity with the
   * Transaction breakdown (opening one collapses the other → the card fits with no scroll). */
  detailOpen?: boolean
  onDetailOpenChange?: (open: boolean) => void
  /** Surfaces the live V4 quote (FJ output for the current fuel amount) so the breakdown can
   * show where the reserved token goes. Null when fuel is off or the amount is invalid. */
  onFuelQuoteChange?: (fjOutput: bigint | null) => void
}

const USD_PRESETS = [1, 5, 10]

// Never silently auto-reserve more than this fraction of the bridge for gas. On a healthy
// pool the real requirement is far below this and the cap never binds; on a mis-priced testnet
// pool it stops the auto-fill from quietly eating half the deposit — we cap + warn + let the
// user opt into the full (honest) amount instead.
const MAX_AUTOFILL_FRACTION = 0.25

// Motion values mirrored from the human-tech design system (docs/tokens.css):
// --dur-normal / --ease-default for the inline detail accordion reveal.
const DS_DUR_NORMAL = 0.28
const DS_EASE_DEFAULT: [number, number, number, number] = [0.4, 0, 0.2, 1]

/**
 * Hook that fetches a real V4 on-chain quote, debounced by 500ms.
 */
function useV4FuelQuote(
  fuelAmount: string,
  tokenAddress: string,
  tokenDecimals: number,
): { fjOutput: bigint | null; loading: boolean; error: string | null } {
  const [fjOutput, setFjOutput] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const amount = Number(fuelAmount)
    if (!fuelAmount || amount <= 0 || !tokenAddress) {
      setFjOutput(null)
      setError(null)
      return
    }

    const inputRaw = BigInt(Math.floor(amount * 10 ** tokenDecimals))
    if (inputRaw <= 0n) {
      setFjOutput(null)
      return
    }

    setLoading(true)
    setError(null)

    const timeout = setTimeout(async () => {
      try {
        const candidates = buildSwapCandidates(tokenAddress as `0x${string}`)
        const best = await getBestRoute({
          candidates,
          inputAmount: inputRaw,
          l1RpcUrl: L1_RPC_URL,
        })
        console.log(
          `[FuelToggle] Best route: ${best.route.label} → ${(Number(best.expectedOutput) / 1e18).toFixed(4)} FJ`,
        )
        setFjOutput(best.expectedOutput)
        setError(null)
      } catch (err) {
        console.error('[FuelToggle] V4 quote failed:', err)
        setFjOutput(null)
        const errMsg = err instanceof Error ? err.message : String(err)
        const isRevert = errMsg.includes('reverted') || errMsg.includes('execution reverted')
        setError(isRevert ? 'Swap amount exceeds pool liquidity, try a smaller amount' : 'Quote failed')
      } finally {
        setLoading(false)
      }
    }, 500)

    return () => clearTimeout(timeout)
  }, [fuelAmount, tokenAddress, tokenDecimals])

  return { fjOutput, loading, error }
}

/**
 * Compute a fuel token amount expected to cover the L2 claim gas.
 *
 * We probe the actual V4 pool for its real FeeJuice-per-token rate rather than
 * trusting the FJ price feed, because off mainnet the feed and the pool diverge wildly,
 * so any price-based sizing is wrong. The price feed is used only to pick a
 * sensible probe *size*; the rate that sizes the recommendation comes from the
 * on-chain quote. The live sufficiency check downstream still validates the result.
 */
interface FuelRecommendation {
  /** Amount to actually pre-fill — the honest amount, clamped to the sane ceiling. */
  amount: string
  /** Full token amount that covers the L2 claim gas at the current pool rate (uncapped). */
  honestAmount: string
  forType: 'public' | 'private'
  /** True when the honest amount exceeded the sane ceiling, so `amount` is the capped value. */
  capped: boolean
  /** Honest amount as a percentage of the bridge amount (for the warning copy). */
  honestPct: number
}

function useRecommendedFuelAmount(
  enabled: boolean,
  fuelType: 'public' | 'private',
  claimFeeLimit: bigint | undefined,
  existingFj: number,
  tokenAddress: string,
  tokenDecimals: number,
  tokenSymbol: string,
  bridgeNum: number,
  prices: Record<string, number> | null | undefined,
): FuelRecommendation | null {
  // Tagged with the fuel type it was computed for, so a stale (previous-mode) value is
  // never applied to the current mode during a public<->private switch.
  const [recommended, setRecommended] = useState<FuelRecommendation | null>(null)

  useEffect(() => {
    // Clear any stale recommendation immediately so consumers never act on a value
    // sized for a different fuel type while the new probe is still in flight.
    setRecommended(null)
    if (!enabled || claimFeeLimit == null || !tokenAddress || bridgeNum <= 0) return
    let cancelled = false
    const timeout = setTimeout(async () => {
      try {
        const needFj = Number(claimFeeLimit) / 1e18
        // Existing FJ already covers the claim → recommend nothing (no top-up required).
        if (existingFj >= needFj) return
        // PUBLIC: only the shortfall needs bridging (existing + claimed pay together).
        // PRIVATE: the fresh bridge self-funds its landing claim, so size to the whole claim.
        const requiredFj = fuelType === 'public' ? needFj - existingFj : needFj
        const fjUsd = getFeeJuicePriceUsd(prices)
        const tokenUsd = getTokenPriceUsd(tokenSymbol, prices)
        // Order-of-magnitude probe size (not the rate; the rate is measured on-chain).
        const guess = tokenUsd > 0 && fjUsd > 0 ? (requiredFj * fjUsd) / tokenUsd : bridgeNum * 0.05
        const probeToken = Math.min(Math.max(guess, 1e-6), bridgeNum * 0.9)
        const probeRaw = BigInt(Math.floor(probeToken * 10 ** tokenDecimals))
        if (probeRaw <= 0n) return
        const candidates = buildSwapCandidates(tokenAddress as `0x${string}`)
        const best = await getBestRoute({ candidates, inputAmount: probeRaw, l1RpcUrl: L1_RPC_URL })
        if (cancelled || best.expectedOutput <= 0n) return
        const fjPerToken = Number(best.expectedOutput) / 1e18 / probeToken
        if (fjPerToken <= 0) return
        const BUFFER = 1.3 // headroom for price impact between probe and final size + swap slippage
        // Honest amount that actually covers gas at the measured pool rate. On a healthy pool this
        // is tiny; on a mis-priced testnet pool it can be a huge fraction of the bridge — which is
        // why we never blindly pre-fill it (see the cap below).
        const recToken = (requiredFj * BUFFER) / fjPerToken
        // Round the honest amount UP to a token-aware precision (~$0.01 granularity), so it's a
        // clean number without ever dipping below the computed (buffered) amount. Cheap
        // tokens like USDC get 2 dp; high-value tokens (WBTC) keep more so it's not coarse.
        const centsDecimals = tokenUsd > 0 ? Math.ceil(Math.log10(tokenUsd) + 2) : 2
        const displayDecimals = Math.min(Math.max(centsDecimals, 2), tokenDecimals)
        const factor = 10 ** displayDecimals
        const honestRounded = Math.ceil(recToken * factor) / factor
        // Sane ceiling: the auto-fill never silently exceeds MAX_AUTOFILL_FRACTION of the bridge.
        // When the honest requirement is above the ceiling the pool rate is unusable — we pre-fill
        // the capped amount and the UI warns + offers a one-tap opt-in to the full honest amount.
        const ceiling = bridgeNum * MAX_AUTOFILL_FRACTION
        const capped = honestRounded > ceiling
        const autoFill = capped ? Math.max(Math.floor(ceiling * factor) / factor, 0) : honestRounded
        const honestPct = bridgeNum > 0 ? (honestRounded / bridgeNum) * 100 : 0
        if (honestRounded > 0 && !cancelled) {
          setRecommended({
            amount: String(autoFill),
            honestAmount: String(honestRounded),
            forType: fuelType,
            capped,
            honestPct,
          })
        }
      } catch {
        if (!cancelled) setRecommended(null)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [enabled, fuelType, claimFeeLimit, existingFj, tokenAddress, tokenDecimals, tokenSymbol, bridgeNum, prices])

  return recommended
}

/**
 * Hook that checks whether the expected FJ output is sufficient to cover L2 claim gas costs.
 * Debounced: only runs when fjOutput changes and is non-null.
 */
function useFuelSufficiency(fjOutput: bigint | null, fuelType: 'public' | 'private'): {
  sufficient: boolean | null
  feeLimitFj: string | null
  loading: boolean
} {
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
        const { checkFuelSufficiency } = await import('@/utils/fuelGasEstimate')
        const result = await checkFuelSufficiency(fjOutput, fuelType)
        if (!cancelled) {
          setSufficient(result.sufficient)
          setFeeLimitFj(result.feeLimitFj)
        }
      } catch (err) {
        console.warn('[FuelToggle] Sufficiency check failed:', err)
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

function QuoteSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-4 bg-neutral-300 rounded w-3/4" />
      <div className="h-4 bg-neutral-300 rounded w-full" />
    </div>
  )
}

function shortenAztecAddress(addr: string): string {
  if (!addr) return ''
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

const FuelToggle: React.FC<FuelToggleProps> = ({
  fuelEnabled,
  fuelAmount,
  bridgeAmount,
  youWillReceive,
  tokenSymbol,
  tokenDecimals,
  tokenAddress,
  onToggle,
  onAmountChange,
  feeJuiceBalance,
  privateFeeJuiceBalance,
  feeJuiceBalanceLoading,
  privateFeeJuiceBalanceLoading,
  fuelType,
  onFuelTypeChange,
  onSufficiencyChange,
  onRecipientValidityChange,
  onFuelAmountValidChange,
  isPrivacyModeEnabled = false,
  selfAztecAddress = '',
  fuelRecipientOverride,
  onFuelRecipientOverrideChange,
  detailOpen: detailOpenProp,
  onDetailOpenChange,
  onFuelQuoteChange,
}) => {
  const bridgeNum = Number(bridgeAmount) || 0
  const fuelNum = Number(fuelAmount) || 0
  const isValid = fuelNum > 0 && fuelNum < bridgeNum
  const netBridge = bridgeNum - fuelNum
  const hasBridgedFpc = !!BRIDGED_FPC_ADDRESS
  const router = useRouter()

  // The enable switch and the detail accordion are independent: fuel top-up defaults ON
  // (business logic), but its editing UI (public/private, amount, send-to) stays collapsed
  // until the user asks for it — this is what keeps the card in-viewport by default.
  // Controlled when the parent passes detailOpen/onDetailOpenChange (used to enforce mutual
  // exclusivity with the Transaction breakdown), otherwise falls back to local state.
  const [detailOpenInternal, setDetailOpenInternal] = useState(false)
  const detailOpen = detailOpenProp ?? detailOpenInternal
  const setDetailOpen = (next: boolean | ((open: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(detailOpen) : next
    if (onDetailOpenChange) onDetailOpenChange(value)
    else setDetailOpenInternal(value)
  }
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Worst-case FeeJuice the final L2 claim will cost, surfaced up front so the
  // user knows the gas requirement before committing the (irreversible) deposit.
  const { data: claimFeeLimit, isLoading: claimFeeLoading } = useClaimFeeEstimate(fuelType)

  // Only the FeeJuice balance for the active fuel mode is relevant: public fuel
  // pays the claim from the user's own FJ, private fuel from the BridgedFPC.
  const usePrivateFj = fuelType === 'private' && hasBridgedFpc
  const activeFjBalance = usePrivateFj ? privateFeeJuiceBalance : feeJuiceBalance
  const activeFjLoading = usePrivateFj ? privateFeeJuiceBalanceLoading : feeJuiceBalanceLoading
  // Existing FeeJuice in the active mode's balance. For PUBLIC fuel this pays the L2 claim
  // alongside freshly-claimed FJ (existing + swap pay together), so it counts toward sufficiency.
  // For PRIVATE fuel the fresh bridge self-funds its own landing claim (BridgedFPC mint_and_pay_fee
  // asserts the fresh amount alone covers gas, issue #47), so existing private FJ does NOT pay that
  // claim — it only means "no top-up needed" when it already covers the claim on its own.
  const existingActiveFj =
    activeFjBalance != null && activeFjBalance !== '--' ? Number(activeFjBalance) : 0

  // Privacy mode drives fuel type: a private deposit requires private (BridgedFPC) fuel.
  // Force private while privacy is on, and default back to public when it turns off
  // (else fuelType stays stuck on 'private' and the FJ estimate never reverts). The
  // off->public reset is transition-only so the Public/Private tabs stay usable.
  const prevPrivacyRef = useRef(isPrivacyModeEnabled)
  useEffect(() => {
    if (isPrivacyModeEnabled && fuelType !== 'private') {
      onFuelTypeChange('private')
    } else if (prevPrivacyRef.current && !isPrivacyModeEnabled && fuelType !== 'public') {
      onFuelTypeChange('public')
    }
    prevPrivacyRef.current = isPrivacyModeEnabled
  }, [isPrivacyModeEnabled, fuelType, onFuelTypeChange])

  // Recipient-override UI is only shown for public fuel; private fuel always routes to the FPC.
  const recipientOverrideAvailable = fuelType === 'public'
  const [recipientOverrideOpen, setRecipientOverrideOpen] = useState(false)
  // Auto-open the override section if the store already has an address (e.g. on page reload).
  useEffect(() => {
    if (recipientOverrideAvailable && fuelRecipientOverride.trim().length > 0) {
      setRecipientOverrideOpen(true)
    }
  }, [recipientOverrideAvailable, fuelRecipientOverride])
  // Close + clear when fuel mode flips to private (FJ goes to FPC, not a user L2).
  useEffect(() => {
    if (!recipientOverrideAvailable) {
      setRecipientOverrideOpen(false)
      if (fuelRecipientOverride.length > 0) onFuelRecipientOverrideChange('')
    }
  }, [recipientOverrideAvailable, fuelRecipientOverride, onFuelRecipientOverrideChange])

  const recipientStatus = useMemo<{
    valid: boolean
    isThirdParty: boolean
    error: string | null
    parsed: string | null
  }>(() => {
    const raw = fuelRecipientOverride.trim()
    if (raw.length === 0) {
      return { valid: true, isThirdParty: false, error: null, parsed: null }
    }
    try {
      const parsed = AztecAddress.fromStringUnsafe(raw).toString()
      const isSelf = !!selfAztecAddress && parsed.toLowerCase() === selfAztecAddress.toLowerCase()
      return { valid: true, isThirdParty: !isSelf, error: null, parsed }
    } catch {
      return { valid: false, isThirdParty: false, error: 'Not a valid Aztec address', parsed: null }
    }
  }, [fuelRecipientOverride, selfAztecAddress])

  // Inline confirmation that the user understands FJ is non-transferable. Only required when
  // the recipient resolves to a third-party L2 (different from self).
  const [confirmedThirdParty, setConfirmedThirdParty] = useState(false)
  useEffect(() => {
    // Reset the checkbox when the override clears or flips to self — guards against stale consent.
    if (!recipientStatus.isThirdParty) setConfirmedThirdParty(false)
  }, [recipientStatus.isThirdParty])

  // Bubble validity up so the parent can disable the bridge button if the override is broken
  // or the third-party warning hasn't been acknowledged.
  useEffect(() => {
    const ok =
      !recipientOverrideAvailable ||
      fuelRecipientOverride.trim().length === 0 ||
      (recipientStatus.valid && (!recipientStatus.isThirdParty || confirmedThirdParty))
    onRecipientValidityChange?.(ok)
  }, [
    recipientOverrideAvailable,
    fuelRecipientOverride,
    recipientStatus.valid,
    recipientStatus.isThirdParty,
    confirmedThirdParty,
    onRecipientValidityChange,
  ])

  const { prices, isLoading: pricesLoading, error: pricesError } = useTokenPrices()

  const { fjOutput, loading, error } = useV4FuelQuote(isValid ? fuelAmount : '', tokenAddress, tokenDecimals)
  // feeLimitFj/sufficiencyLoading feed the copy; the actual sufficiency decision is computed
  // below crediting the user's EXISTING FJ (mode-aware), not from the swap output alone.
  const { feeLimitFj, loading: sufficiencyLoading } = useFuelSufficiency(fjOutput, fuelType)

  // Mode-aware sufficiency (mirrors the /fee-juice FeeJuiceTopUp fix):
  //  - needFj: worst-case FJ the L2 claim costs.
  //  - PUBLIC: existing public FJ + freshly-claimed swap FJ pay the claim together
  //    → sufficient when (existingActiveFj + swapFj) >= needFj; and if existingActiveFj >= needFj
  //      the user is fully covered and needs no top-up at all.
  //  - PRIVATE: the fresh bridge must self-fund its landing claim → swapFj alone must clear needFj
  //    (but existing private FJ >= needFj still means "already covered, no top-up needed").
  const needFj = claimFeeLimit != null ? Number(claimFeeLimit) / 1e18 : null
  const swapFj = fjOutput != null ? Number(fjOutput) / 1e18 : null
  const alreadyCovered = needFj != null && existingActiveFj >= needFj
  const effectiveSufficient: boolean | null = alreadyCovered
    ? true
    : needFj == null || swapFj == null
      ? null
      : usePrivateFj
        ? swapFj >= needFj
        : existingActiveFj + swapFj >= needFj

  useEffect(() => {
    if (!fuelEnabled) {
      onSufficiencyChange?.(true)
      return
    }
    // Existing balance already covers the claim → sufficient regardless of any swap.
    if (alreadyCovered) {
      onSufficiencyChange?.(true)
      return
    }
    if (!isValid) {
      onSufficiencyChange?.(true)
      return
    }
    if (!sufficiencyLoading && effectiveSufficient !== null) {
      onSufficiencyChange?.(effectiveSufficient)
    }
  }, [fuelEnabled, isValid, alreadyCovered, effectiveSufficient, sufficiencyLoading, onSufficiencyChange])

  // Fuel is carved OUT of the bridge, so a POSITIVE top-up must be strictly less than the bridge.
  // An empty/zero amount is valid — it just means "no carve" (e.g. top-up is optional because the
  // user is already covered), and must never block the bridge button. Only a positive amount that
  // meets-or-exceeds the bridge is an invalid pair.
  const fuelAmountValid = !fuelEnabled || fuelNum <= 0 || fuelNum < bridgeNum
  useEffect(() => {
    onFuelAmountValidChange?.(fuelAmountValid)
  }, [fuelAmountValid, onFuelAmountValidChange])

  // Surface the live FJ quote up to the parent so the Transaction breakdown can show the
  // fee-juice destination. Null whenever fuel is off or the amount is invalid.
  useEffect(() => {
    onFuelQuoteChange?.(fuelEnabled && isValid ? fjOutput : null)
  }, [fuelEnabled, isValid, fjOutput, onFuelQuoteChange])

  // Auto-size: when gas top-up is switched on with no amount yet, pre-fill an amount
  // sized from the real pool rate to cover the L2 claim gas. One-time per enable
  // (ref resets on toggle-off) so we never fight a user who edits the field.
  const recommendedFuel = useRecommendedFuelAmount(
    fuelEnabled,
    fuelType,
    claimFeeLimit,
    existingActiveFj,
    tokenAddress,
    tokenDecimals,
    tokenSymbol,
    bridgeNum,
    prices,
  )
  // Track which fuel type we last auto-sized for. Fill on first enable (only if the
  // user hasn't typed their own amount), and re-fill whenever the fuel type changes,
  // since public vs private have different requirements. recommendedFuel is null while
  // the new-mode probe is in flight, so we always fill with a value sized for this mode.
  const autoSizedForRef = useRef<'public' | 'private' | null>(null)
  useEffect(() => {
    if (!fuelEnabled) {
      autoSizedForRef.current = null
      return
    }
    // Only apply a recommendation computed for the current fuel type (guards the
    // switch race where a stale previous-mode value is still in state).
    if (!recommendedFuel || recommendedFuel.forType !== fuelType) return
    const firstFill = autoSizedForRef.current === null && !fuelAmount
    const modeChanged = autoSizedForRef.current !== null && autoSizedForRef.current !== fuelType
    if (!firstFill && !modeChanged) return
    autoSizedForRef.current = fuelType
    onAmountChange(recommendedFuel.amount)
  }, [fuelEnabled, fuelType, fuelAmount, recommendedFuel, onAmountChange])

  // Check which USD preset is currently selected (if any)
  const activePreset = USD_PRESETS.find((usd) => fuelAmount === usdToTokenAmount(usd, tokenSymbol, prices))

  // High-priority bad-rate alert (#4): the testnet pool would charge more than the sane
  // ceiling to cover the shortfall, so we capped the auto-reserve. The card carries only a
  // compact chip; the full explanation + one-tap "reserve the honest amount" action lives in
  // Messages as a keyed, persistent warning. Dismiss it the moment the condition clears (user
  // covered, edited past the honest amount, or turned gas off) so a stale alert never lingers.
  const badRate =
    fuelEnabled && !alreadyCovered && !!recommendedFuel?.capped && fuelNum < Number(recommendedFuel.honestAmount)
  useEffect(() => {
    const dismissBadRate = () => {
      const existing = useNotificationsStore.getState().notifications.find((n) => n.key === 'fuel-bad-rate')
      if (existing) useNotificationsStore.getState().dismiss(existing.id)
    }
    if (!badRate || !recommendedFuel) {
      dismissBadRate()
      return
    }
    const honest = recommendedFuel.honestAmount
    const reserved = fuelAmount || '0'
    pushNotification({
      type: 'warning',
      title: 'Gas rate high on testnet',
      message:
        `Fully covering L2 gas would cost about ${honest} ${tokenSymbol} ` +
        `(${recommendedFuel.honestPct.toFixed(0)}% of your bridge). We reserved a capped ` +
        `${reserved} ${tokenSymbol} instead. Edit the amount, turn gas top-up off, or reserve the ` +
        `full amount to fully cover gas.`,
      key: 'fuel-bad-rate',
      action: {
        label: 'Top Up Gas',
        onClick: () => router.push('/fee-juice'),
      },
    })
    // router is stable across renders; excluding it keeps the effect keyed on the alert's data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [badRate, recommendedFuel, fuelAmount, tokenSymbol])

  // Heads-up (#5): public fuel while privacy mode is on would deanonymize the claim.
  // Fire once per entry into that state. It holds until the user dismisses it (#2148) —
  // the previous 6s timer pulled the sentence off screen mid-read, and a warning nobody
  // finishes reading is worse than one that lingers.
  const publicRevealFiredRef = useRef(false)
  useEffect(() => {
    const shouldWarn = fuelEnabled && isPrivacyModeEnabled && fuelType === 'public'
    if (!shouldWarn) {
      publicRevealFiredRef.current = false
      return
    }
    if (publicRevealFiredRef.current) return
    publicRevealFiredRef.current = true
    pushNotification({
      type: 'warning',
      title: 'Public fee juice reveals your claim',
      message: 'Use Private fee juice to keep your claim anonymous.',
      key: 'fuel-public-reveal',
    })
  }, [fuelEnabled, isPrivacyModeEnabled, fuelType])

  // Consistent FJ display: route BOTH the requirement estimate and the balance through
  // formatFjAmount so "~11.84 FJ" and "25.81 FJ" always render with the same precision.
  const toRawFj = (v: string | number): bigint | null => {
    const s = (typeof v === 'number' ? String(v) : v).trim()
    if (!s || !/^-?\d*\.?\d*$/.test(s)) return null
    const neg = s.startsWith('-')
    const [whole, frac = ''] = s.replace('-', '').split('.')
    const raw = BigInt(whole || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18))
    return neg ? -raw : raw
  }
  const fmtFj = (v: string | number | null | undefined): string => {
    if (v == null || v === '--' || v === '') return '--'
    const raw = toRawFj(v)
    return raw == null ? '--' : formatFjAmount(raw, 2)
  }

  // The L2 claim gas is "covered" when the user's existing FJ and/or the in-bridge fuel swap
  // clear the requirement (effectiveSufficient already folds in alreadyCovered). A blue check
  // reflects that; otherwise a maroon short marker + the "Top Up Gas" route.
  const gasCovered = effectiveSufficient === true
  const needsTopUp = needFj != null && !alreadyCovered && effectiveSufficient !== true
  const shortfallFj = needFj != null ? Math.max(needFj - existingActiveFj, 0) : null
  const suffTooltip = gasCovered
    ? 'You hold enough Fee Juice to cover this transaction’s L2 gas.'
    : shortfallFj != null
      ? `You need about ${fmtFj(shortfallFj)} more FJ to cover this transaction’s L2 gas.`
      : 'Checking whether your Fee Juice covers this transaction’s L2 gas.'

  // Honest reason for the top-up state (#451). The auto-fund swap couldn't cover the L2 claim.
  // On a mis-priced testnet pool the honest amount to cover gas can exceed the auto-fill safety
  // ceiling (MAX_AUTOFILL_FRACTION), so the bridge is (correctly) blocked rather than left to
  // strand funds at the claim. Two shapes:
  //  - honest amount still fits inside the bridge → offer a one-tap "reserve the full amount" that
  //    makes the bridge viable and funds gas as part of the tx (no separate top-up needed).
  //  - honest amount exceeds the whole bridge → the swap genuinely can't source enough FJ for a
  //    deposit this size at the current pool rate; the only honest path is a separate top-up.
  const honestAmountStr = recommendedFuel?.honestAmount ?? null
  const honestPctStr = recommendedFuel ? recommendedFuel.honestPct.toFixed(0) : '0'
  const honestNum = honestAmountStr != null ? Number(honestAmountStr) : null
  const canReserveHonest =
    needsTopUp &&
    !!recommendedFuel?.capped &&
    honestNum != null &&
    honestNum > 0 &&
    honestNum < bridgeNum &&
    fuelNum < honestNum
  const poolCantCover =
    needsTopUp && !!recommendedFuel?.capped && honestNum != null && honestNum >= bridgeNum
  const topUpReason = poolCantCover
    ? 'The current testnet pool can’t source enough Fee Juice for a bridge this size. Top up gas separately to continue.'
    : canReserveHonest && honestAmountStr != null
      ? `Covering L2 gas needs about ${honestAmountStr} ${tokenSymbol} (~${honestPctStr}% of this bridge) at the current pool rate.`
      : shortfallFj != null
        ? `You need about ${fmtFj(shortfallFj)} more FJ to cover the L2 claim.`
        : 'You don’t have enough Fee Juice to cover the L2 claim yet.'

  return (
    <div className="bg-[#F5F5F5] rounded-md p-2.5 mt-1.5 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon icon="ph:gas-pump-fill" width={14} height={14} className="shrink-0 text-[#17235E]" />
          <span className="text-sm font-medium text-latest-grey-700">Aztec Fees</span>
          <Icon
            icon="ph:info"
            width={13}
            height={13}
            className="shrink-0 cursor-help text-[#17235E]/[0.60]"
            data-tooltip-id="fj-about"
            data-tooltip-content="Aztec transactions are paid in Fee Juice, the network's gas token. You need some to claim your bridged funds on Aztec."
          />
        </span>
        {/* Toggle purpose: cover this transaction's L2 gas automatically inside the bridge (an
            atomic Fee Juice swap). When the user's balance already covers gas there is nothing
            to enable, so the switch is hidden — no self-contradicting "enable + top up" prompt.
            The switch is labelled inline ("Auto-fund gas") so it isn't a mystery control (#451). */}
        {!alreadyCovered && (
          <span className="flex shrink-0 items-center gap-1.5">
            <span
              className="cursor-help text-xs font-medium text-latest-grey-700"
              data-tooltip-id="fj-auto"
              data-tooltip-content="Swaps part of your bridge into Fee Juice to pay Aztec (L2) gas, so you don't need to hold any yourself."
            >
              Auto-fund gas
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={fuelEnabled}
              aria-label="Auto-fund L2 gas by swapping part of this bridge into Fee Juice"
              className="relative shrink-0"
              onClick={() => onToggle(!fuelEnabled)}
            >
              <div
                className="w-9 h-5 rounded-full transition-colors"
                style={{ backgroundColor: fuelEnabled ? '#81133B' : '#d1d5db' }}
              />
              <div
                className="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform"
                style={{
                  transform: fuelEnabled ? 'translateX(1rem)' : 'translateX(0)',
                }}
              />
            </button>
          </span>
        )}
      </div>

      {/* Requirement (left) + balance & coverage (right) on one row. Both numbers route through
          the same fmt path so they stay consistent. The public/private mode is implicit here — a
          private claim can only spend private Fee Juice, and the user already sees privacy mode. */}
      <div className="mt-1.5 flex items-center justify-between gap-2 text-xs text-latest-grey-700">
        <span className="text-latest-grey-500">
          Est. gas{' '}
          <span className="font-semibold text-latest-black-300">
            {claimFeeLoading || claimFeeLimit == null ? '…' : `~${formatFjAmount(claimFeeLimit, 2)} FJ`}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-medium">
            You have{' '}
            {activeFjLoading ? (
              <span className="inline-block h-2.5 w-10 rounded bg-neutral-300 align-middle animate-pulse" />
            ) : (
              <span className="font-semibold text-latest-black-300">{fmtFj(activeFjBalance)} FJ</span>
            )}
          </span>
          {!activeFjLoading &&
            needFj != null &&
            (gasCovered ? (
              <Icon
                icon="ph:check-circle-fill"
                width={14}
                height={14}
                className="cursor-help text-[#17235E]"
                data-tooltip-id="fj-suff"
                data-tooltip-content={suffTooltip}
              />
            ) : (
              <Icon
                icon="ph:warning-circle-fill"
                width={14}
                height={14}
                className="cursor-help text-[#81133B]"
                data-tooltip-id="fj-suff"
                data-tooltip-content={suffTooltip}
              />
            ))}
        </span>
      </div>

      <ReactTooltip id="fj-suff" place="top" className="z-[100]" style={{ fontSize: '12px', maxWidth: '240px' }} />
      <ReactTooltip id="fj-about" place="top" className="z-[100]" style={{ fontSize: '12px', maxWidth: '240px' }} />
      <ReactTooltip id="fj-auto" place="top" className="z-[100]" style={{ fontSize: '12px', maxWidth: '240px' }} />

      {/* Short: existing FJ doesn't cover gas and the in-bridge swap isn't confirmed sufficient.
          Name WHY honestly (#451) rather than a bare button, then offer the fitting action: a
          one-tap "reserve the full amount" when the honest amount still fits the bridge (funds gas
          inside the tx), else route to the standalone top-up flow on /fee-juice (navy outline
          secondary — never a text link buried in a callout, SOP §8/#386). */}
      {needsTopUp && (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-[11px] leading-[15px] text-latest-grey-700">{topUpReason}</p>
          <div className="flex items-center gap-1.5">
            {canReserveHonest && (
              <button
                type="button"
                onClick={() => honestAmountStr != null && onAmountChange(honestAmountStr)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#81133B] px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#BF1254]"
              >
                <Icon icon="ph:gas-pump-fill" width={14} height={14} />
                Reserve full amount
              </button>
            )}
            <button
              type="button"
              onClick={() => router.push('/fee-juice')}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-[#17235E] bg-transparent px-3 py-1.5 text-[12px] font-semibold text-[#17235E] transition-colors hover:bg-[#17235E]/[0.08]"
            >
              <Icon icon="ph:gas-pump-fill" width={14} height={14} />
              Top Up Gas
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default FuelToggle
