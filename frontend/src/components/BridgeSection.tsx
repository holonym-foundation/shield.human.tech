import React, { useEffect, useRef, useState } from 'react'
import StyledImage from './StyledImage'
import { BridgeDirection, BridgeState, Network as NetworkType, Token as TokenType } from '@/types/bridge'
import { motion } from 'framer-motion'
import SwapIcon from './SwapIcon'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { POCH_MINT_URL } from '@/config'
import { BRIDGE_MAX_DEPOSIT_USD, TRAVEL_RULE_THRESHOLD_USD, PASSPORT_SCORE_THRESHOLD } from '@/config/env.config'
import { useWalletStore } from '@/stores/walletStore'
import { useSessionLinkedL2 } from '@/hooks/useBindingStatus'
import { LOGIN_METHODS } from '@/types/wallet'

// The connected wallet on a box's network, shown beside the From/To header (#423,
// #428). Reads `From  [wallet-icon] 0x123…abcd` — the wallet-type icon sits before
// the truncated address so the box self-identifies which wallet funds land on.
// Matters for the shielding story: the user needs to SEE the destination (e.g.
// withdrawing to a fresh L1 address with no history). Copyable, never the focus.
// Uses the same 0x123…abcd shape as the account dropdown so the two never disagree.
function AddressChip({ address, icon }: { address: string; icon?: string }) {
  const [copied, setCopied] = useState(false)
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(address).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          },
          () => {},
        )
      }}
      title={copied ? 'Copied' : `Copy address ${address}`}
      aria-label={copied ? 'Address copied' : `Copy address ${short}`}
      className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-latest-grey-500 transition-colors hover:text-latest-black-100"
    >
      {icon && <StyledImage src={icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-full" />}
      <span>{short}</span>
      <Icon icon={copied ? 'ph:check-bold' : 'ph:copy'} width={11} height={11} className="shrink-0" />
    </button>
  )
}

// Aztec box address selector (#428). The Aztec network can carry several connected
// Azguard accounts, so its box header is a dropdown (the L1/WaaP box can't switch
// accounts yet, so it stays a plain AddressChip). Trigger mirrors AddressChip
// (wallet icon + truncated 0x… + caret). The menu lists every connected account;
// only the LINKED account (server-disclosed pair for this wallet) plus the CURRENT
// one are selectable — unlinked accounts are grayed, disabled and non-selectable
// with a reason, since switching to an unlinked L2 would break the wallet pairing.
// Absolutely-positioned overlay so it never pushes layout or grows the fixed card.
function AztecAddressMenu({
  address,
  icon,
  accounts,
  linkedL2,
  onSwitch,
}: {
  address: string
  icon: string
  accounts: Array<{ alias: string; address: string; index: number }>
  linkedL2: string | null
  onSwitch: (account: { alias: string; address: string; index: number }) => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const short = `${address.slice(0, 6)}…${address.slice(-4)}`

  useEffect(() => {
    if (!open) return
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClickOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const copy = () => {
    navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      },
      () => {},
    )
  }

  return (
    <div className="relative shrink-0" ref={rootRef}>
      {/* Symmetry with the L1 address chip (#434): the address itself is a one-click
          COPY target (icon + address + copy glyph, exactly like AddressChip); the caret
          is a SEPARATE button that opens the account switcher. Both live in one chip. */}
      <div className="flex shrink-0 items-center rounded-full bg-white pl-2 pr-1 py-0.5 text-[11px] font-medium text-latest-grey-500">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            copy()
          }}
          title={copied ? 'Copied' : `Copy address ${address}`}
          aria-label={copied ? 'Address copied' : `Copy address ${short}`}
          className="flex items-center gap-1 transition-colors hover:text-latest-black-100"
        >
          <StyledImage src={icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-full" />
          <span>{short}</span>
          <Icon icon={copied ? 'ph:check-bold' : 'ph:copy'} width={11} height={11} className="shrink-0" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Switch Aztec account"
          className="ml-1 flex items-center border-l border-latest-grey-300 pl-1 transition-colors hover:text-latest-black-100"
        >
          <Icon
            icon="ph:caret-down"
            width={11}
            height={11}
            className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 w-[224px] rounded-md border border-latest-grey-300 bg-white p-1 shadow-lg"
        >
          {accounts.map((acc, i) => {
            const isCurrent = acc.address === address
            const isLinked = !!linkedL2 && acc.address.toLowerCase() === linkedL2.toLowerCase()
            const selectable = isLinked || isCurrent
            const rowShort = `${acc.address.slice(0, 6)}…${acc.address.slice(-4)}`
            return (
              <button
                key={acc.address}
                type="button"
                disabled={!selectable}
                onClick={() => {
                  setOpen(false)
                  if (!isCurrent && selectable) onSwitch(acc)
                }}
                title={selectable ? acc.address : 'Not linked to this wallet yet'}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                  selectable
                    ? 'cursor-pointer hover:bg-[#F5F5F5]'
                    : 'cursor-not-allowed opacity-40 select-none'
                }`}
              >
                <Icon
                  icon={isCurrent ? 'ph:check' : 'ph:wallet'}
                  width={13}
                  height={13}
                  className={`shrink-0 ${isCurrent ? 'text-shield' : 'text-latest-grey-500'}`}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[11px] font-medium text-latest-black-100">
                    {acc.alias || `Account ${(acc.index ?? i) + 1}`}
                  </span>
                  <span className="truncate text-[10px] text-latest-grey-500">
                    {rowShort}
                    {isCurrent ? ' · Current' : !isLinked ? ' · Not linked to this wallet yet' : ''}
                  </span>
                </span>
                {isLinked && (
                  <span
                    className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-medium text-shield"
                    title="Linked to this wallet"
                  >
                    <Icon icon="ph:link-simple" width={12} height={12} className="shrink-0" />
                    Linked
                  </span>
                )}
              </button>
            )
          })}
          <div className="my-1 border-t border-latest-grey-300" />
          <button
            type="button"
            onClick={copy}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] font-medium text-latest-grey-500 transition-colors hover:bg-[#F5F5F5] hover:text-latest-black-100"
          >
            <Icon icon={copied ? 'ph:check-bold' : 'ph:copy'} width={13} height={13} className="shrink-0" />
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </div>
      )}
    </div>
  )
}

interface BridgeSectionProps {
  bridgeConfig: BridgeState
  setIsFromSection: (isFrom: boolean) => void
  setSelectNetwork: (open: boolean) => void
  setSelectToken: (open: boolean) => void
  inputAmount: string
  setInputAmount: (amount: string) => void
  l1NativeBalance: string | number | null | undefined
  l1Balance: string | number | null | undefined
  l2Balance: {
    privateBalance: string | number | null | undefined
    publicBalance: string | number | null | undefined
  }
  direction: BridgeDirection
  inputRef: React.RefObject<HTMLInputElement>
  onSwap?: () => void
  isPrivacyModeEnabled: boolean
  feeJuiceBalance?: string
  feeJuiceLoading?: boolean
  attestationMethod?: 'poch' | 'passport' | null
  passportMaxAmount?: bigint
  // Max USD the user can bridge right now (remaining budget under the active cap). Undefined
  // when the cap is disabled — the pill then falls back to the static cap label.
  remainingDepositUsd?: number
  // Passport tier is bound by the Travel Rule (the lifetime threshold), not the daily
  // deposit cap. This is the USD left before that threshold — the remaining figure the pill must
  // show for a Passport user. remainingDepositUsd is the deposit-cap remainder and does not apply
  // to them, so using it produced the "$24,700 of $1,000 left" nonsense.
  travelRuleRemainingUsd?: number
  // Passport tier score vs threshold, for the "score ≥ threshold" badge tooltip.
  passportScore?: number
  passportThreshold?: number
  // USD held by a pending attestation reservation (already netted out of remainingDepositUsd).
  // Surfaced in the badge tooltip as a temporary hold when > 0.
  reservedDepositUsd?: number
  // Clean-Hands (PoCH) daily deposit limit in USD, for the verified-tier pill. Undefined when
  // the value is not surfaced to the client — the pill then shows the verified state with no
  // fabricated figure. Never hardcode it here; thread the real config/backend value in.
  pochDailyLimitUsd?: number
  // Post-fee amount the user receives on the destination (net of the portal fee)
  youWillReceive?: string
  // Space-yielding: when a detail accordion below (Transaction breakdown / fuel detail)
  // expands, the From/To sections collapse to one-line summary rows so the expanded detail
  // fits inside the card's no-scroll budget instead of scrolling. Restores on collapse.
  compact?: boolean
}

// Amount fit-to-width bounds. The typed amount stays at the prominent max until the value is
// too wide for the input, then scales DOWN to the exact size that fits — never below the floor,
// which is low enough that even a max-length balance shows every character rather than clipping.
const AMOUNT_MAX_FONT_PX = 32
const AMOUNT_MIN_FONT_PX = 11

// Full USD for the limit headline / hold detail: 1000 → "$1,000",
// 1234.5 → "$1,234.50". Drops cents when the amount is whole.
function formatUsd(usd: number): string {
  const hasCents = !Number.isInteger(usd)
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 })}`
}

// Network marks sit on white/light selector chips. The Aztec mark is a light-green
// diamond that vanishes on a light surface, so it gets a dark circular chip with the
// mark inset. Every other mark renders bare.
function NetworkMark({
  src,
  network,
  chip,
  inner,
}: {
  src: string
  network?: string
  chip: string
  inner: string
}) {
  if (network === 'aztec') {
    return (
      <span className={`inline-flex items-center justify-center rounded-full bg-[#0A0A0A] shrink-0 ${chip}`}>
        <StyledImage src={src} alt="" className={inner} />
      </span>
    )
  }
  return <StyledImage src={src} alt="" className={`${chip} shrink-0`} />
}

const BridgeSection: React.FC<BridgeSectionProps> = ({
  bridgeConfig: bridge,
  setIsFromSection,
  setSelectNetwork,
  setSelectToken,
  inputAmount,
  setInputAmount,
  l1NativeBalance,
  l1Balance,
  l2Balance,
  direction,
  inputRef,
  onSwap,
  isPrivacyModeEnabled,
  feeJuiceBalance,
  feeJuiceLoading = false,
  attestationMethod,
  passportMaxAmount,
  remainingDepositUsd,
  travelRuleRemainingUsd,
  passportScore,
  passportThreshold,
  reservedDepositUsd,
  pochDailyLimitUsd,
  youWillReceive,
  compact = false,
}) => {
  // Normalize balances to strings
  const l1NativeBalanceStr = l1NativeBalance != null ? l1NativeBalance.toString() : ''
  const l1BalanceStr = l1Balance != null ? l1Balance.toString() : ''

  const l2PublicBalanceStr = l2Balance?.publicBalance != null ? l2Balance?.publicBalance.toString() : ''
  const l2PrivateBalanceStr = l2Balance?.privateBalance != null ? l2Balance?.privateBalance.toString() : ''

  const l2BalanceStr = isPrivacyModeEnabled ? l2PrivateBalanceStr : l2PublicBalanceStr

  // Swap icon rotation state
  const [swapRotation, setSwapRotation] = useState(0)
  // Local override for the compact/collapsed summary: parent drives `compact` when a detail
  // accordion expands, but the founder expects tapping the collapsed From row to reopen the
  // full box. This lets the user re-expand without a setter from the parent.
  const [userExpanded, setUserExpanded] = useState(false)
  const handleSwapClick = () => {
    setSwapRotation((prev) => prev + 180)
    if (onSwap) onSwap()
  }

  // Attestation indicator + Proof of Clean Hands nudge. The cascade picks one method,
  // so only that tier is badged.
  const isPoch = attestationMethod === 'poch'

  // Per-human deposit LIMIT for the ACTIVE tier: the figure the pill shows. Passport-only
  // is held to the Travel-Rule threshold. Clean Hands (PoCH) is held to the alpha daily
  // cap. These are strictly tier-gated so a Passport-only user never sees the
  // Clean-Hands cap. pochDailyLimitUsd is threaded from BRIDGE_MAX_DEPOSIT_USD upstream;
  // fall back to the same config value if it isn't passed.
  const cleanHandsLimitUsd = pochDailyLimitUsd ?? Number(BRIDGE_MAX_DEPOSIT_USD)
  const passportLimitUsd = Number(TRAVEL_RULE_THRESHOLD_USD)
  // Personhood score gate for the Passport tier. Sourced from the config constant
  // (source of truth) rather than the per-request passportThreshold prop, which was
  // surfacing the scorer's internal passing value (1) instead of the real gate.
  const passportScoreThreshold = Number(PASSPORT_SCORE_THRESHOLD)
  const tierLimitUsd = isPoch ? cleanHandsLimitUsd : passportLimitUsd

  const amountNum = Number(inputAmount)
  // The alpha deposit cap is deposit-only (L1->L2). Showing a per-human limit on funds
  // LEAVING Aztec is misleading and implies double-counting, so the limit indicator (both
  // the "Limit: $X" state and the Clean Hands nudge) renders only when this flow is a deposit.
  const isDeposit = direction === BridgeDirection.L1_TO_L2
  // Each box shows the address of the wallet on THAT box's network, so it stays
  // correct in both directions: L1 (Ethereum) uses the EVM/WaaP address, L2 (Aztec)
  // uses the Aztec address. On a deposit From is L1 and To is L2; a withdrawal flips
  // both. Read live from the store so a disconnect/switch clears them (SOP §8/#303).
  const waapAddress = useWalletStore((s) => s.waapAddress)
  const aztecAddress = useWalletStore((s) => s.aztecAddress)
  const fromAddress = isDeposit ? waapAddress : aztecAddress
  const toAddress = isDeposit ? aztecAddress : waapAddress
  // Wallet-type icon shown beside each box's address (#428). Mirrors AccountChip's
  // source of truth: the L1/WaaP box uses the Silk mark when the login is the
  // embedded WaaP wallet (the founder wants the WaaP brand for WaaP wallets), else
  // the injected wallet's own icon (fallback Wally). The L2 box always uses the
  // Aztec wallet mark. Which box is L1 vs L2 flips with direction: From is L1 on a
  // deposit, L2 on a withdrawal; To is the opposite.
  const waapWalletIcon = useWalletStore((s) => s.waapWalletIcon)
  const waapLoginMethod = useWalletStore((s) => s.waapLoginMethod)
  const availableAccounts = useWalletStore((s) => s.availableAccounts)
  const switchAztecAccount = useWalletStore((s) => s.switchAztecAccount)
  // Server-disclosed Aztec account bound to this EVM wallet — the only account
  // (besides the current one) the Aztec dropdown lets the user switch to.
  const sessionLinkedL2 = useSessionLinkedL2(waapAddress)
  const l1WalletIcon =
    waapLoginMethod === LOGIN_METHODS.WAAP
      ? '/assets/svg/silk-logo.svg'
      : waapWalletIcon || '/assets/wallets/wally-dark.svg'
  const aztecWalletIcon = '/assets/svg/aztec-wallet-logo.svg'
  const fromIsL1 = isDeposit
  const toIsL1 = !isDeposit
  const fromIcon = fromIsL1 ? l1WalletIcon : aztecWalletIcon
  const toIcon = toIsL1 ? l1WalletIcon : aztecWalletIcon
  // The Aztec box gets the account dropdown; the L1 box stays a plain chip (we
  // can't switch WaaP accounts yet). Falls back to a plain chip when there is 0/1
  // Aztec account (nothing to choose).
  const renderBoxAddress = (addr: string | null, icon: string, isL1: boolean) => {
    if (!addr) return null
    if (!isL1 && availableAccounts.length > 1) {
      return (
        <AztecAddressMenu
          address={addr}
          icon={icon}
          accounts={availableAccounts}
          linkedL2={sessionLinkedL2}
          onSwitch={switchAztecAccount}
        />
      )
    }
    return <AddressChip address={addr} icon={icon} />
  }
  // Fit-to-width: the typed amount owns the free space and scales its font size DOWN so a long
  // number (e.g. "1234.5678", or a full balance) stays fully visible instead of being clipped
  // behind the input's right edge. A prior length-based heuristic (200/length) ignored the real
  // pixel width the input actually gets, so it still clipped when the row's right column was wide.
  // Instead we measure the rendered text against the input's true content width and pick the exact
  // size that fits: text width scales linearly with font-size, so fit = max * (available / width).
  // A ResizeObserver re-fits whenever the input's width changes (e.g. the balance figure grows or
  // the layout reflows), keeping the number un-clipped without touching the row's height.
  const [amountFontPx, setAmountFontPx] = useState(AMOUNT_MAX_FONT_PX)
  const amountMeasureCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const el = inputRef.current
    if (!el || typeof window === 'undefined') return

    const fitAmountFont = () => {
      const styles = window.getComputedStyle(el)
      const paddingX = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0')
      const available = el.clientWidth - paddingX
      if (!(available > 0)) return

      const canvas = amountMeasureCanvasRef.current ?? (amountMeasureCanvasRef.current = document.createElement('canvas'))
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const text = inputAmount || el.placeholder || '0'
      ctx.font = `${styles.fontWeight} ${AMOUNT_MAX_FONT_PX}px ${styles.fontFamily}`
      const widthAtMax = ctx.measureText(text).width

      // 0.98 leaves a hair of slack so sub-pixel rounding never re-introduces a clip.
      let next = AMOUNT_MAX_FONT_PX
      if (widthAtMax > available) {
        next = Math.floor(AMOUNT_MAX_FONT_PX * (available / widthAtMax) * 0.98)
      }
      next = Math.max(AMOUNT_MIN_FONT_PX, Math.min(AMOUNT_MAX_FONT_PX, next))
      setAmountFontPx((prev) => (prev === next ? prev : next))
    }

    fitAmountFont()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(fitAmountFont)
    observer.observe(el)
    return () => observer.disconnect()
  }, [inputAmount, inputRef])
  // Mutually exclusive with the "Limit: $X" indicator: once a Passport-only user crosses the
  // tier cap, the Clean Hands nudge REPLACES the limit indicator in the same slot. PoCH users
  // already hold the higher cap, so they keep the plain limit indicator and are never nagged.
  const showCleanHandsNudge =
    attestationMethod === 'passport' &&
    !isNaN(amountNum) &&
    amountNum > 0 &&
    amountNum > tierLimitUsd

  // Verified-tier badge: the tier's brand mark alongside the per-human limit. Passport
  // tier uses the Human Passport mark, Clean Hands tier uses the Clean Hands mark. The
  // mark is rendered in black via CSS mask so it reads as the real brand logo, not a tint.
  const badgeIconSrc = isPoch ? '/assets/svg/clean-hands.svg' : '/assets/svg/passport.svg'
  // Compact cap shown under the balance. Passport is a per-human lifetime limit; the Clean
  // Hands cap is a DAILY cap, so it carries a "/day" suffix. The "per human" framing lives in the tooltip.
  const limitLabel = tierLimitUsd > 0 ? `Limit: ${formatUsd(tierLimitUsd)}${isPoch ? '/day' : ''}` : null
  // Tier-appropriate remaining budget for the pill. A PoCH user is bound by the daily deposit
  // cap, so theirs is remainingDepositUsd. A Passport user is bound by the Travel Rule (the
  // lifetime threshold), so theirs is travelRuleRemainingUsd — remainingDepositUsd would surface
  // a deposit-cap remainder they can never reach. Clamp into [0, tierLimitUsd] so the pill never
  // reads a remaining larger than the tier's own cap.
  const tierRemainingRaw = attestationMethod === 'passport' ? travelRuleRemainingUsd : remainingDepositUsd
  const remaining =
    tierRemainingRaw != null ? Math.min(Math.max(tierRemainingRaw, 0), tierLimitUsd) : undefined
  // Live remaining budget under the active cap, shown in the same slot as the static limit
  // pill (e.g. "$740 of $1,000 left"). Falls back to the static cap label when the backend
  // doesn't surface a remaining figure (cap disabled). Deposit-only, like the rest of this slot.
  const remainingKnown = remaining != null && tierLimitUsd > 0
  // Heads-up: the entered amount would spend past what's left of the cap. Distinct from the
  // Clean Hands nudge, which fires only once the amount clears the FULL tier cap; guard on
  // !showCleanHandsNudge so this single slot stays mutually exclusive.
  const overRemaining =
    isDeposit &&
    remainingKnown &&
    !isNaN(amountNum) &&
    amountNum > 0 &&
    amountNum > (remaining as number) &&
    !showCleanHandsNudge
  // Temporary hold from a pending deposit, appended to the badge tooltip when present.
  const reservedNote =
    reservedDepositUsd != null && reservedDepositUsd > 0
      ? ` ${formatUsd(reservedDepositUsd)} on hold from a pending deposit.`
      : ''
  const badgeTooltip = isPoch
    ? `Verified with Proof of Clean Hands. Bridge up to ${formatUsd(cleanHandsLimitUsd)}/day per human.${reservedNote}`
    : `Verified with Passport (score above ${passportScoreThreshold}). Bridge up to ${formatUsd(passportLimitUsd)} per human.${reservedNote} Verify with Proof of Clean Hands to unlock ${formatUsd(cleanHandsLimitUsd)}/day.`

  // Compact summary rows shown while a detail accordion is expanded — e.g.
  // "From Eth Sepolia · 100 USDC" / "To Aztec · cUSDC". Tapping either row reopens the
  // full From/To boxes (the founder-reported dead click). userExpanded lets the local
  // control override the parent's compact request until the user is done editing.
  if (compact && !userExpanded) {
    const fromSummary = `${bridge.from.network?.title ?? ''} · ${inputAmount || '0'} ${bridge.from.token?.symbol ?? ''}`
    const toReceive = youWillReceive ?? inputAmount
    const toSummary = `${bridge.to.network?.title ?? ''} · ${toReceive || '0'} ${bridge.to.token?.symbol ?? ''}`
    return (
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => setUserExpanded(true)}
          aria-label="Expand From section"
          className="bg-[#F5F5F5] rounded-md px-3 py-2 flex items-center justify-between gap-2 text-left"
        >
          <span className="text-12 font-semibold text-latest-grey-100 shrink-0">From</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <NetworkMark
              src={bridge.from.network?.img || '/assets/svg/ethLogo.svg'}
              network={bridge.from.network?.network}
              chip="h-4 w-4"
              inner="h-3 w-3"
            />
            <span className="text-14 font-medium text-latest-black-100 truncate">{fromSummary}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setUserExpanded(true)}
          aria-label="Expand To section"
          className="bg-[#F5F5F5] rounded-md px-3 py-2 flex items-center justify-between gap-2 text-left"
        >
          <span className="text-12 font-semibold text-latest-grey-100 shrink-0">To</span>
          <span className="flex items-center gap-1.5 min-w-0">
            <NetworkMark
              src={bridge.to.network?.img || ''}
              network={bridge.to.network?.network}
              chip="h-4 w-4"
              inner="h-3 w-3"
            />
            <span className="text-14 font-medium text-latest-black-100 truncate">{toSummary}</span>
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {/* From Section */}
      {/* Extra bottom padding (pb-5) keeps the last content row clear of the swap
          toggle, which is absolutely positioned at bottom-[-30px] and straddles the
          From/To boundary. Without it the toggle's top edge overlaps the attestation pill. */}
      <div className="bg-[#F5F5F5] rounded-md p-2.5 pb-5 relative">
        {/* Header: the address sits directly beside the "From" label (icon + 0x…),
            not pushed to the far right, so the box self-identifies its wallet (#428). */}
        <div className="flex items-center gap-2">
          <p className="text-14 font-semibold text-latest-grey-100">From</p>
          {renderBoxAddress(fromAddress, fromIcon, fromIsL1)}
        </div>
        {/* mt-3 opens a clear gap between the header/address and the Network row (#428). */}
        <div className="flex justify-between mt-3">
          {/* Network selector */}
          <div className="flex flex-col mt-1 gap-0.5">
            <p className="text-12 text-[#747474]">Network</p>
            <div
              className="flex gap-2 items-center rounded-[12px] cursor-pointer bg-white p-[2px] max-w-[172px]"
              onClick={() => {
                setIsFromSection(true)
                setSelectNetwork(true)
              }}
            >
              <NetworkMark
                src={bridge.from.network?.img || '/assets/svg/ethLogo.svg'}
                network={bridge.from.network?.network}
                chip="h-5 w-5"
                inner="h-3.5 w-3.5"
              />
              <p className="text-16 font-medium text-latest-black-100 w-[106px]">{bridge.from.network?.title}</p>
              <StyledImage src="/assets/svg/dropDown.svg" alt="" className="h-2.5 w-1.5 p-1.5 mr-1.5" />
            </div>
          </div>
          {/* Token selector */}
          <div className="flex flex-col mt-1 gap-0.5">
            <p className="text-12 text-[#747474]">Asset</p>
            <div
              className="flex gap-2 items-center rounded-md cursor-pointer bg-white p-[2px]"
              onClick={() => {
                setIsFromSection(true)
                setSelectToken(true)
              }}
            >
              <StyledImage src={bridge.from.token?.img || ''} alt="" className="h-5 w-5" />
              <p className="text-16 font-medium text-latest-black-100">
                {bridge.from.token?.symbol}
              </p>
              <StyledImage src="/assets/svg/dropDown.svg" alt="" className="h-2.5 w-1.5 p-1.5 mr-1.5" />
            </div>
          </div>
        </div>
        <hr className="text-latest-grey-300 my-1" />
        {/* The typed amount OWNS its own full-width row (large, focal). Balance + Max
            drop to their own row directly below it, and the withdrawal Fee-Juice line
            below that (#428) — nothing crowds the number on the right anymore. The
            fit-to-width font (amountFontPx) now has the whole box width to work with. */}
        <input
          ref={inputRef}
          type="text"
          placeholder="0"
          value={inputAmount}
          onChange={(e) => setInputAmount(e.target.value)}
          className="w-full min-w-0 placeholder-latest-grey-400 outline-none bg-[transparent] leading-tight font-medium"
          style={{ fontSize: `${amountFontPx}px` }}
          autoFocus
        />
        <div className="mt-1 flex items-center gap-1.5">
          <div
            className="flex gap-1 items-center cursor-pointer text-latest-grey-500 hover:text-latest-black-100 transition-colors"
            onClick={() => setInputAmount(direction === BridgeDirection.L1_TO_L2 ? l1BalanceStr : l2BalanceStr)}
            title="Use full balance"
          >
            <p className="text-12 font-medium">Balance:</p>
            <p className="text-12 font-medium break-all">
              {direction === BridgeDirection.L1_TO_L2 ? l1BalanceStr : l2BalanceStr}
            </p>
            <p className="text-12 font-medium">{bridge.from.token?.title}</p>
          </div>
          <p
            className="text-12 font-medium text-latest-black-200 bg-white px-2 rounded-[32px] leading-5 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              setInputAmount(direction === BridgeDirection.L1_TO_L2 ? l1BalanceStr : l2BalanceStr)
            }}
          >
            Max
          </p>
        </div>
        {direction === BridgeDirection.L2_TO_L1 && (
          <div className="mt-0.5 flex gap-1">
            <p className="text-latest-grey-500 text-12 font-medium break-all">
              {feeJuiceLoading ? 'Loading...' : (feeJuiceBalance ?? '--')}
            </p>
            <p className="text-latest-grey-500 text-12 font-medium">Fee Juice</p>
          </div>
        )}
        {/* Compact deposit-limit BAR directly under the balance line (#436). A slim usage meter
            replaces the old full-width pill row, reclaiming the vertical space it ate. The track
            fills toward the tier cap as budget is consumed; the full per-human detail lives one
            hover away (SOP §7) instead of as inline copy. Three mutually-exclusive states share
            the one slot: normal (tier tint fill + badgeTooltip), over-remaining (warning orange +
            an "over your limit" sentence), and — once a Passport amount clears the whole cap — the
            Clean Hands upgrade (orange bar + a reachable link to PoCH). Deposit-only: the cap does
            not apply to withdrawals, and the whole meter stays a compact single line. */}
        {isDeposit && attestationMethod && (
          <div className="mt-1 flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-[12px] w-[12px] shrink-0 bg-[#0A0A0A]"
              style={{
                maskImage: `url(${badgeIconSrc})`,
                WebkitMaskImage: `url(${badgeIconSrc})`,
                maskRepeat: 'no-repeat',
                WebkitMaskRepeat: 'no-repeat',
                maskPosition: 'center',
                WebkitMaskPosition: 'center',
                maskSize: 'contain',
                WebkitMaskSize: 'contain',
              }}
            />
            <div
              data-tooltip-id="attestation-info"
              data-tooltip-content={
                showCleanHandsNudge
                  ? `Above ${formatUsd(passportLimitUsd)} needs Proof of Clean Hands`
                  : overRemaining
                    ? `Over your limit, ${formatUsd(remaining as number)} of ${formatUsd(tierLimitUsd)} left`
                    : badgeTooltip
              }
              className="relative h-1.5 max-w-[200px] flex-1 overflow-hidden rounded-full bg-[rgba(10,10,10,0.10)] cursor-default"
            >
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${
                  overRemaining || showCleanHandsNudge
                    ? 'bg-[#B54708]'
                    : isPoch
                      ? 'bg-[#0F7B4F]'
                      : 'bg-[#17235E]'
                }`}
                style={{
                  width: `${
                    showCleanHandsNudge
                      ? 100
                      : remainingKnown
                        ? Math.min(100, Math.max(0, ((tierLimitUsd - (remaining as number)) / tierLimitUsd) * 100))
                        : 0
                  }%`,
                }}
              />
            </div>
            {showCleanHandsNudge ? (
              <a
                href={POCH_MINT_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-tooltip-id="attestation-info"
                data-tooltip-content={`Above ${formatUsd(passportLimitUsd)} needs Proof of Clean Hands`}
                className="inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[#B54708] hover:underline"
              >
                <Icon icon="ph:arrow-up-right-bold" width={11} height={11} className="shrink-0" />
                Clean Hands
              </a>
            ) : (
              <span
                data-tooltip-id="attestation-info"
                data-tooltip-content={
                  overRemaining
                    ? `Over your limit, ${formatUsd(remaining as number)} of ${formatUsd(tierLimitUsd)} left`
                    : badgeTooltip
                }
                className={`shrink-0 cursor-default text-[11px] font-medium ${overRemaining ? 'text-[#B54708]' : 'text-neutral-600'}`}
              >
                {remainingKnown ? `${formatUsd(remaining as number)} left` : limitLabel}
              </span>
            )}
          </div>
        )}
        {isDeposit && attestationMethod && (
          <ReactTooltip
            id="attestation-info"
            place="top"
            style={{ fontSize: '12px', maxWidth: '220px', zIndex: 9999 }}
          />
        )}
        {onSwap && <SwapIcon onClick={onSwap} />}
      </div>

      {/* To Section */}
      {/* mt-6 opens the inter-card gap so the swap toggle (44px, hanging 30px below the
          From card) has clear space and does not crowd the "To" header below it. */}
      <div className="mt-6 bg-[#F5F5F5] rounded-md p-2.5">
        {/* Header: address beside the "To" label (icon + 0x…), mirroring From (#428). */}
        <div className="flex items-center gap-2">
          <p className="text-14 font-semibold text-latest-grey-100">To</p>
          {renderBoxAddress(toAddress, toIcon, toIsL1)}
        </div>
        <div className="flex justify-between mt-3">
          {/* Network selector */}
          <div className="flex flex-col mt-1 gap-0.5">
            <p className="text-12 text-[#747474]">Network</p>
            <div
              className="flex gap-2 items-center rounded-[12px] cursor-pointer bg-white p-[2px] max-w-[172px]"
              onClick={() => {
                setIsFromSection(false)
                setSelectNetwork(true)
              }}
            >
              <NetworkMark
                src={bridge.to.network?.img || ''}
                network={bridge.to.network?.network}
                chip="h-5 w-5"
                inner="h-3.5 w-3.5"
              />
              <p className="text-16 font-medium text-latest-black-100 w-[106px]">{bridge.to.network?.title}</p>
              <StyledImage src="/assets/svg/dropDown.svg" alt="" className="h-2.5 w-1.5 p-1.5 mr-1.5" />
            </div>
          </div>

          {/* Token selector */}
          <div className="flex flex-col mt-1 gap-0.5">
            <p className="text-12 text-[#747474]">Asset</p>
            <div
              className="flex gap-2 items-center rounded-md cursor-pointer bg-white p-[2px]"
              onClick={() => {
                setIsFromSection(false)
                setSelectToken(true)
              }}
            >
              <StyledImage src={bridge.to.token?.img || ''} alt="" className="h-5 w-5" />
              <p className="text-16 font-medium text-latest-black-100">
                {bridge.to.token?.symbol}
              </p>
              <StyledImage src="/assets/svg/dropDown.svg" alt="" className="h-2.5 w-1.5 p-1.5 mr-1.5" />
            </div>
          </div>
        </div>
        <hr className="text-latest-grey-300 my-1" />
        <div className="flex justify-between">
          <p className="text-14 font-medium text-latest-grey-100">You will receive</p>
          <p className="text-black text-14 font-semibold">
            {youWillReceive ?? inputAmount} {bridge.to.token?.title}
          </p>
        </div>
        <div className="flex justify-between mt-0.5">
          <p className="text-latest-grey-500 text-12 font-medium">Current Balance:</p>
          <p className="text-latest-grey-500 text-12 font-medium break-all">
            {direction === BridgeDirection.L1_TO_L2 ? l2BalanceStr : l1BalanceStr} {bridge.to.token?.title}
          </p>
        </div>
      </div>
    </div>
  )
}

export default BridgeSection
