'use client'
import TextButton from '@/components/TextButton'
import { ChangeEvent, useCallback, useEffect, useState, useRef } from 'react'
import RootStyle from '@/components/RootStyle'
import SBT from '@/components/model/SBT'
import StyledImage from '@/components/StyledImage'
import {
  useL1BridgeToL2,
  useL1Faucet,
  useL1HasSoulboundToken,
  useL1MintSoulboundToken,
  useL1TokenBalance,
  useL1TokenBalances,
  usePortalFeeBps,
} from '@/hooks/useL1Operations'
import { useTokenPrices } from '@/utils/coinGeckoPrice'
import { computePortalFee, getTokenPriceUsd, formatFjAmount } from '@/utils/fuelPricing'
import { parseUnits, formatUnits } from 'viem'
import { useAttestationCheck } from '@/hooks/useAttestationCheck'
import {
  useL2HasSoulboundToken,
  useL2MintSoulboundToken,
  useL2TokenBalance,
  useL2FeeJuiceBalance,
  useL2PrivateFeeJuiceBalance,
  useL2WithdrawTokensToL1,
  useL1ContractAddresses,
  useL2NodeIsReady,
  useClaimFeeEstimate,
} from '@/hooks/useL2Operations'
import { showToast, useToast } from '@/hooks/useToast'
import { extractErrorMessage, humanizeError, truncateDecimals } from '@/utils'
import clsxm from '@/utils/clsxm'
import NetworkModal from '@/components/model/Network'
import TokensModal from '@/components/model/TokensModal'
import { BridgeDirection, BridgeState, Network as NetworkType, Token as TokenType } from '@/types/bridge'
import BridgeSection from '@/components/BridgeSection'
import { Icon } from '@iconify/react'
import TransactionBreakdown from '@/components/TransactionBreakdown'
import BridgeFooter from '@/components/BridgeFooter'
import BridgeHeader from '@/components/BridgeHeader'
import VerificationStep from '@/components/VerificationStep'
import BridgeActionButton from '@/components/BridgeActionButton'
import {
  L1_CHAIN_ID,
  L1_NETWORKS,
  L2_NETWORKS,
  L1_TOKENS,
  L2_TOKENS,
  getL2PairedToken,
  getL1PairedToken,
  LEGACY_MODE,
} from '@/config'
import MetaMaskPrompt from '@/components/model/MetaMaskPrompt'
import BalanceCard from '@/components/BalanceCard'
import { logInfo, logError, DatadogUserAction } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecLoginMethod } from '@/types/wallet'
import AztecWalletConnectionModals from '@/components/AztecWalletConnectionModals'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { pushNotification, useNotificationsStore } from '@/stores/useNotificationsStore'
import { useBindingStatus, describeConflict, shortAddr, conflictMessage } from '@/hooks/useBindingStatus'
import { useRouter } from 'next/navigation'
import MaintenanceOverlay from '@/components/MaintenanceOverlay'
import FuelToggle from '@/components/FuelToggle'
import WithdrawFuelPanel from '@/components/WithdrawFuelPanel'
import {
  BRIDGED_FPC_ADDRESS,
  MAINTENANCE_MODE,
  MAINTENANCE_MESSAGE,
  MAINTENANCE_TITLE,
  SWAP_BRIDGE_ROUTER_ADDRESS,
} from '@/config'
import { BRIDGE_MAX_DEPOSIT_USD } from '@/config/env.config'

export default function Home() {
  const router = useRouter()

  // UI state
  const [selectNetwork, setSelectNetwork] = useState<boolean>(false)
  const [selectToken, setSelectToken] = useState<boolean>(false)
  const [isFromSection, setIsFromSection] = useState<boolean>(true)
  const [showBreakdown, setShowBreakdown] = useState(false)
  // Lifted so the bridge card runs a single mutually-exclusive accordion: opening the
  // Transaction breakdown collapses the fuel detail (and vice-versa), yielding space so the
  // card fits within its no-scroll budget instead of scrolling internally.
  const [fuelDetailOpen, setFuelDetailOpen] = useState(false)
  // Live FJ output for the current fuel amount, surfaced by FuelToggle for the breakdown summary.
  const [fuelFjOutput, setFuelFjOutput] = useState<bigint | null>(null)
  const [showVerification, setShowVerification] = useState(false)
  // Deep-link into verification: the account dropdown's "Complete verification" nudge routes
  // here with ?verify=1 (the verify modal is local state, so it can't be opened from the
  // dropdown directly). Open it once on mount, then strip the param so a refresh doesn't reopen.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('verify') === '1') {
      setShowVerification(true)
      params.delete('verify')
      const qs = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
    }
  }, [])
  const [mounted, setMounted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Bottom scroll cue for the card's internal scroll region: the transaction breakdown
  // (and expanded accordions) can sit below the fold with no signal it's there. `canScrollDown`
  // lights a faint bottom fade + chevron while there's content past the fold and clears once
  // the region is scrolled to its end. Content-height driven (accordions animate open), so a
  // ResizeObserver re-measures rather than a one-shot read that would miss the animation.
  const scrollRegionRef = useRef<HTMLDivElement>(null)
  const scrollContentRef = useRef<HTMLDivElement>(null)
  const [canScrollDown, setCanScrollDown] = useState(false)
  const updateScrollAffordance = useCallback(() => {
    const el = scrollRegionRef.current
    if (!el) return
    // A few px of slack so sub-pixel rounding at the true bottom doesn't keep the cue lit.
    setCanScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 6)
  }, [])
  useEffect(() => {
    const region = scrollRegionRef.current
    if (!region || typeof ResizeObserver === 'undefined') {
      updateScrollAffordance()
      return
    }
    const ro = new ResizeObserver(() => updateScrollAffordance())
    ro.observe(region)
    if (scrollContentRef.current) ro.observe(scrollContentRef.current)
    updateScrollAffordance()
    return () => ro.disconnect()
  }, [updateScrollAffordance])
  const [inputAmount, setInputAmount] = useState('')
  const [usdValue, setUsdValue] = useState('')

  // Operational state
  const [showSBTModal, setShowSBTModal] = useState(false)
  const [currentSBTChain, setCurrentSBTChain] = useState<'Ethereum' | 'Aztec'>('Ethereum')
  const [bridgeCompleted, setBridgeCompleted] = useState(false)
  const [fuelSufficient, setFuelSufficient] = useState(true)
  const [fuelRecipientValid, setFuelRecipientValid] = useState(true)
  // Fuel amount must be strictly less than the bridge amount (carved out, not additive). The
  // FuelToggle shows an inline error for the user; this flag also disables the bridge button
  // so we never push an invalid pair to the SDK.
  const [fuelAmountValid, setFuelAmountValid] = useState(true)

  // Notification system
  const notify = useToast()

  // Bridge store
  const {
    bridgeConfig,
    isPrivacyModeEnabled,
    updateNetwork,
    updateToken,
    swapDirection,
    setDirection,
    setBridgeConfig,
    resetStepState,
    reset: resetBridgeStore,
    fuelEnabled,
    fuelAmount,
    fuelType,
    fuelRecipientOverride,
    setFuelEnabled,
    setFuelAmount,
    setFuelType,
    setFuelRecipientOverride,
    setCurrentOperationId,
  } = useBridgeStore()

  // ── Portal fee (TokenPortal deducts feeBasisPoints from the bridged token) ──
  const { data: portalFeeBps } = usePortalFeeBps()
  const { prices: tokenPrices } = useTokenPrices()
  const feeTokenDecimals = bridgeConfig.from.token?.decimals ?? 6
  const feeTokenSymbol = bridgeConfig.from.token?.symbol ?? 'USDC'
  const parseTokenAmount = (v?: string): bigint => {
    if (!v || isNaN(Number(v))) return 0n
    try {
      return parseUnits(v as `${number}`, feeTokenDecimals)
    } catch {
      return 0n
    }
  }
  const depositFuelEnabled = bridgeConfig.direction === BridgeDirection.L1_TO_L2 && fuelEnabled
  const { baseRaw: portalBaseRaw, feeRaw: portalFeeRaw, receiveRaw: portalReceiveRaw } = computePortalFee({
    amount: parseTokenAmount(bridgeConfig.amount),
    fuelAmount: parseTokenAmount(fuelAmount),
    fuelEnabled: depositFuelEnabled,
    feeBps: portalFeeBps ?? 0n,
  })
  const portalFeeKnown = portalFeeBps != null
  const portalFeeToken = portalFeeKnown ? `${truncateDecimals(formatUnits(portalFeeRaw, feeTokenDecimals), 6)}` : undefined
  const portalFeeUsd = portalFeeKnown
    ? (Number(formatUnits(portalFeeRaw, feeTokenDecimals)) * getTokenPriceUsd(feeTokenSymbol, tokenPrices)).toFixed(2)
    : undefined
  // Fee as a percentage of the fee base (amount net of any fuel carve-out) — computed from the
  // actual fee, so integer-division rounding in the portal is reflected. e.g. 2.54 USDC / 100 → "2.54".
  const bridgeFeePercent =
    portalFeeKnown && portalBaseRaw > 0n
      ? ((Number(portalFeeRaw) / Number(portalBaseRaw)) * 100).toFixed(2)
      : undefined
  const youWillReceiveAmount = `${truncateDecimals(formatUnits(portalReceiveRaw, feeTokenDecimals), 6)}`
  // Fee-juice carve summary for the breakdown (deposit + fuel only).
  const fuelReserveToken = depositFuelEnabled && Number(fuelAmount) > 0 ? fuelAmount : undefined
  const fuelReserveFj = fuelReserveToken && fuelFjOutput != null ? formatFjAmount(fuelFjOutput) : undefined

  // Get wallet state from useWalletStore. Modal-driving fields (walletConnectionPhase,
  // discoveredWallets, verificationEmojis, etc.) are consumed inside <AztecWalletConnectionModals />
  // and don't need to be pulled in here.
  const {
    isWaapConnected,
    isAztecConnected,
    connectWaapWallet,
    connectAztecWallet,
    waapLoginMethod: loginMethod,
    waapWalletIcon: walletIcon,
    waapWalletProvider: walletProvider,
    getWaapWalletProvider: getWalletProvider,
    showWalletModal,
    setShowWalletModal,
    aztecAddress,
    waapAddress,
  } = useWalletStore()

  // Disable the bridge action when JWT issuance failed; the deposit/withdraw
  // backup POST to /api/bridge/operations would 401, aborting before any
  // on-chain tx but only after the user clicked through. Block at the button.
  const authFailed = useAuthStore((s) => s.authFailed)

  // Binding button guard (issues #98/#130): if the connected (L1, L2) pair is a
  // CONFLICT (mismatch — the EVM wallet is bound to a different Aztec account, or
  // vice-versa), block the primary action up-front and name the linked wallet, so
  // the user can't start a bridge into a guaranteed-failing pair. Only 'conflict'
  // yields a non-null result here — a matched 'bound' pair or a fresh 'unbound'
  // pair does NOT block. The query key includes waapAddress + aztecAddress, so
  // switching to the linked Aztec account re-runs it and clears this instantly.
  const { data: pairBindingStatus } = useBindingStatus()
  const bindingConflict = describeConflict(pairBindingStatus?.binding, waapAddress, aztecAddress)
  const bindingBlockedLabel = !bindingConflict
    ? undefined
    : bindingConflict.kind === 'evm-linked-elsewhere'
      ? `Switch to your linked Aztec wallet ${shortAddr(bindingConflict.counterpart)}`
      : bindingConflict.kind === 'aztec-linked-elsewhere'
        ? `Reconnect your linked EVM wallet ${shortAddr(bindingConflict.counterpart)}`
        : `Switch to your linked wallet pair ${shortAddr(bindingConflict.counterpart)}`

  // #297b: keep the full binding-conflict notice OUT of the button. The button
  // just disables with a concise reason; the detailed "switch to your linked pair
  // (0x…)" copy lives as a PERSISTENT, keyed Messages entry (also surfaced in the
  // header mini-bar chip). Keyed upsert = one row, no spam; dismissed by key the
  // moment the conflict clears (e.g. the user switches to the linked account).
  const bindingConflictActive = !!bindingConflict && isWaapConnected && isAztecConnected
  useEffect(() => {
    if (bindingConflictActive && bindingConflict) {
      pushNotification({
        type: 'warning',
        key: 'binding-conflict',
        title: 'Wallet mismatch',
        message: conflictMessage(bindingConflict),
      })
    } else {
      const existing = useNotificationsStore.getState().notifications.find((n) => n.key === 'binding-conflict')
      if (existing) useNotificationsStore.getState().dismiss(existing.id)
    }
    // Primitive deps: bindingConflict is a fresh object each render, so key off its
    // stable fields to avoid re-pushing (and re-dismissing) on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingConflictActive, bindingConflict?.kind, bindingConflict?.counterpart])

  // Specific reason the primary button is blocked by a deposit-side fuel/auth gate (the same
  // condition that drives BridgeActionButton's isDisabled). Surfaced under the button so a
  // disabled state never reads as a silent greyed control. These gates leave the label as the
  // plain "Bridge Tokens", so the reason line is what tells the user what to fix.
  const depositGateActive =
    bridgeConfig.direction === BridgeDirection.L1_TO_L2 && isWaapConnected && isAztecConnected
  const bridgeDisabledReason = authFailed
    ? 'Session error. Reconnect your wallet to continue.'
    : depositGateActive && !fuelAmountValid
      ? 'Gas top-up must be less than the bridge amount.'
      : depositGateActive && !fuelSufficient
        ? 'Not enough gas for the L2 claim yet. Adjust it in Aztec Fees above.'
        : depositGateActive && !fuelRecipientValid
          ? 'Check the fee juice recipient address.'
          : undefined

  // Success callbacks
  const mintL1SBTOnSuccess = (_data: any) => {
    setShowSBTModal(false)
  }

  const mintL2SBTOnSuccess = (_data: any) => {
    setShowSBTModal(false)
  }

  const {
    data: l2NodeIsReady,
    isLoading: l2NodeIsReadyLoading,
    error: l2NodeIsReadyError,
    isError: l2NodeIsReadyIsError,
  } = useL2NodeIsReady()

  // L1 (Ethereum) balances and operations
  const {
    data: l1TokenBalances = [],
    isLoading: l1BalanceLoading,
    isPending: l1BalancePending,
    refetch: refetchL1Balance,
  } = useL1TokenBalances()

  // native token
  const sepoliaNativeTokens = l1TokenBalances.find(
    (token) => token.type === 'native' && token.network?.chainId === L1_CHAIN_ID,
  )
  const l1NativeBalance = sepoliaNativeTokens?.balance_formatted

  const selectedFromToken = bridgeConfig.from.token
  // Alchemy-based ERC20 balance (may not index custom test tokens)
  const l1BalanceAlchemy = l1TokenBalances.find(
    (token) =>
      token.type === 'erc20' &&
      token.network?.chainId === L1_CHAIN_ID &&
      token.address === (selectedFromToken?.l1TokenContract ?? L1_TOKENS[0]?.l1TokenContract),
  )?.balance_formatted

  // Direct RPC balance via eth_call (works for any ERC20 including custom test tokens)
  const { data: l1BalanceRpc } = useL1TokenBalance()

  // Prefer Alchemy if available, fall back to direct RPC
  const l1Balance = l1BalanceAlchemy ?? l1BalanceRpc
  const { data: attestationData, isLoading: attestationLoading } = useAttestationCheck()
  const { data: hasL1SBT } = useL1HasSoulboundToken()
  const { mutate: mintL1SBT, isPending: mintL1SBTPending } = useL1MintSoulboundToken(mintL1SBTOnSuccess)

  // const { mutate: mintL1Tokens, isPending: mintL1TokensPending } =
  //   useL1MintTokens()

  // L2 (Aztec) balances and operations
  const {
    data: l2Balance = { privateBalance: null, publicBalance: null },
    isLoading: l2BalanceLoading,
    isPending: l2BalancePending,
    refetch: refetchL2Balance,
    error: l2BalanceError,
    isError: isL2BalanceError,
  } = useL2TokenBalance()

  const l2PrivateBalance = l2Balance?.privateBalance
  const l2PublicBalance = l2Balance?.publicBalance
  const {
    data: feeJuiceBalance,
    isLoading: feeJuiceBalanceLoading,
    isPending: feeJuicePending,
    refetch: refetchFeeJuiceBalance,
  } = useL2FeeJuiceBalance()
  const {
    data: privateFeeJuiceBalance,
    isLoading: privateFeeJuiceBalanceLoading,
    refetch: refetchPrivateFeeJuiceBalance,
  } = useL2PrivateFeeJuiceBalance()
  const { data: hasL2SBT } = useL2HasSoulboundToken()
  const { mutate: mintL2SBT, isPending: mintL2SBTPending } = useL2MintSoulboundToken(mintL2SBTOnSuccess)

  // Claim-gas guard: the final L2 claim needs FeeJuice. It self-funds only when
  // fuel is enabled and directed to the bridger; otherwise the claim is paid from
  // the bridger's standing FJ. We can only *read* public FJ (claim_public), so we
  // hard-block just the provable stuck case: public deposit, no self-directed
  // fuel, zero FJ, then steer the user into enabling gas top-up.
  const { data: claimFeeLimitWei } = useClaimFeeEstimate(fuelType)
  const claimPaidFromStandingFj =
    bridgeConfig.direction === BridgeDirection.L1_TO_L2 && (!fuelEnabled || !!fuelRecipientOverride)
  const noClaimGas =
    claimPaidFromStandingFj &&
    !isPrivacyModeEnabled &&
    Number(bridgeConfig.amount) > 0 &&
    feeJuiceBalance != null &&
    Number(feeJuiceBalance) === 0
  // Auto-enable trigger: the balance for the active mode won't cover the claim estimate.
  // Public mode reads the user's own FJ; private mode reads the BridgedFPC balance (the
  // readable "can pay a private claim" figure), so this works with privacy on too.
  const claimGasBalance = isPrivacyModeEnabled ? privateFeeJuiceBalance : feeJuiceBalance
  const insufficientClaimGas =
    claimPaidFromStandingFj &&
    Number(bridgeConfig.amount) > 0 &&
    claimGasBalance != null &&
    claimFeeLimitWei != null &&
    Number(claimGasBalance) < Number(claimFeeLimitWei) / 1e18

  // Auto-enable gas top-up when the claim would be underfunded. One-time latch so we
  // never re-flip it back on after the user deliberately turns it off.
  const autoFuelRef = useRef(false)
  useEffect(() => {
    if (insufficientClaimGas && !fuelEnabled && !autoFuelRef.current) {
      autoFuelRef.current = true
      setFuelEnabled(true)
    }
  }, [insufficientClaimGas, fuelEnabled, setFuelEnabled])

  // ── Withdraw-direction fuel gate (L2 → L1) ──────────────────────────────
  // A withdrawal burns on Aztec, paid from the user's standing fuel: the private
  // BridgedFPC balance in privacy mode (spent via pay_fee), else the public
  // FeeJuice balance. The BridgedFPC balance is a DIFFERENT quantity from the raw
  // private Fee Juice a user sees in their wallet, so a user can hold in-wallet FJ
  // yet have zero here and be genuinely unable to pay the burn.
  //
  // Only an EMPTY balance blocks. `useClaimFeeEstimate` bounds an L1→L2 *claim*
  // (a 2M-L2-gas ceiling at 2-3x base fee), not this burn, so a user holding
  // slightly less than that ceiling was being told to top up for gas they would
  // very likely never spend. The wallet sizes the real fee by simulating the burn
  // and refuses to send when the balance truly falls short — nothing moves on a
  // failed preflight — so a non-zero balance is left to that authority and the
  // panel only advises.
  const withdrawFuelType: 'public' | 'private' =
    isPrivacyModeEnabled && !!BRIDGED_FPC_ADDRESS ? 'private' : 'public'
  const withdrawFuelBalance = withdrawFuelType === 'private' ? privateFeeJuiceBalance : feeJuiceBalance
  const withdrawFuelInsufficient =
    bridgeConfig.direction === BridgeDirection.L2_TO_L1 &&
    isWaapConnected &&
    isAztecConnected &&
    withdrawFuelBalance != null &&
    Number(withdrawFuelBalance) === 0
  const withdrawDisabledReason = withdrawFuelInsufficient
    ? withdrawFuelType === 'private'
      ? 'No private fuel to pay the L2 burn. Top up to withdraw.'
      : 'No Fee Juice to pay the L2 burn. Top up to withdraw.'
    : undefined

  // Bridge success callback (runs after L1→L2 bridge or L2→L1 withdrawal)
  const handleBridgeSuccess = useCallback(
    (_data: any) => {
      // BridgeHeader now carries the live "Refreshing balances" status (it reads
      // the same balance-query fetching flags), so the pending/success corner
      // toast is gone. Only a genuine refresh failure is surfaced, via the feed.
      Promise.all([
        refetchL1Balance(),
        refetchL2Balance(),
        refetchFeeJuiceBalance(),
        refetchPrivateFeeJuiceBalance(),
      ]).catch(() => {
        pushNotification({ type: 'error', title: 'Failed to refresh balances' })
      })
      setBridgeConfig({
        ...bridgeConfig,
        amount: '',
      })
      setBridgeCompleted(true)

      setTimeout(() => {
        setBridgeCompleted(false)
      }, 3000)
    },
    [
      refetchL1Balance,
      refetchL2Balance,
      refetchFeeJuiceBalance,
      refetchPrivateFeeJuiceBalance,
      setBridgeConfig,
      bridgeConfig,
    ],
  )

  const { mutate: bridgeTokensToL2, isPending: bridgeTokensToL2Pending } = useL1BridgeToL2(handleBridgeSuccess)

  const { mutate: withdrawTokensToL1, isPending: withdrawTokensToL1Pending } =
    useL2WithdrawTokensToL1(handleBridgeSuccess)

  // Faucet operations
  const useExternalFaucet = true // Set to true to redirect to Google Cloud faucet, false to use internal API
  const {
    mutate: requestFaucet,
    isPending: requestFaucetPending,
    needsGas,
    needsTokens,
    needsTokensOnly,
    isEligibleForFaucet,
    hasGas,
    balancesLoaded,
  } = useL1Faucet()

  // External faucet handler
  const handleExternalFaucet = () => {
    const googleFaucetUrl = 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia'

    // Log faucet redirect to Google
    logInfo('Faucet redirect to Google initiated', {
      walletType: WalletType.WAAP,
      loginMethod: loginMethod,
      walletProvider: walletProvider,
      address: '',
      chainId: null,
      faucetProvider: 'Google Cloud',
      faucetUrl: googleFaucetUrl,
      redirectType: 'external',
      userAction: DatadogUserAction.FAUCET_REDIRECT,
      network: 'Ethereum Sepolia',
    })

    window.open(googleFaucetUrl, '_blank')
  }

  // Helper functions for bridge operations
  const getCurrentSection = () => (isFromSection ? 'from' : 'to')
  const getOppositeSection = () => (isFromSection ? 'to' : 'from')

  // Handle network selection
  const handleSelectNetwork = (network: NetworkType) => {
    const section = getCurrentSection()
    updateNetwork(section, network)
  }

  // Handle token selection with auto-pairing
  const handleSelectToken = (token: TokenType) => {
    const section = getCurrentSection()
    updateToken(section, token)
    // Auto-pair: set the counterpart on the other side
    const oppositeSection = getOppositeSection()
    const paired =
      section === 'from'
        ? bridgeConfig.direction === BridgeDirection.L1_TO_L2
          ? getL2PairedToken(token)
          : getL1PairedToken(token)
        : bridgeConfig.direction === BridgeDirection.L1_TO_L2
          ? getL1PairedToken(token)
          : getL2PairedToken(token)
    if (paired) {
      updateToken(oppositeSection, paired)
    }
  }

  // Input amount change handler
  const handleAmountChange = (value: string) => {
    if (value === '' || !isNaN(Number(value))) {
      setBridgeConfig({
        ...bridgeConfig,
        amount: value,
      })
    }
  }

  // SBT minting handler
  const handleSBTMinted = async () => {
    try {
      if (bridgeConfig.direction === BridgeDirection.L2_TO_L1) {
        await mintL2SBT()
      } else {
        await mintL1SBT()
      }
    } catch (error) {
      console.error('[page] SBT mint failed:', error)
      logError('SBT mint failed', {
        errorType: 'sbt_mint_failed',
        error: extractErrorMessage(error),
      })
      notify('error', `Couldn't mint your SBT. ${humanizeError(error)}`)
    }
  }

  // Handle wallet selection (starts wallet-sdk discovery flow)
  const handleWalletSelect = async () => {
    try {
      logInfo('Attempting to connect Aztec wallet', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        walletProvider: null,
        address: '',
        chainId: null,
        userAction: DatadogUserAction.WALLET_CONNECTION_ATTEMPT,
      })

      await connectAztecWallet()
      setShowWalletModal(false)
    } catch (error) {
      logError('Aztec wallet connection failed from UI', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        walletProvider: null,
        address: '',
        chainId: null,
        userAction: DatadogUserAction.WALLET_CONNECTION_FAILURE,
        error: extractErrorMessage(error),
      })

      notify('error', `Couldn't connect your wallet. ${humanizeError(error)}`)
    }
  }

  // Prefetch routes this page navigates to
  useEffect(() => {
    router.prefetch('/progress')
  }, [router])

  // Page visit tracking and component mount effects
  useEffect(() => {
    setMounted(true)

    // Log page visit/session start
    logInfo('User session started - page loaded', {
      walletType: null,
      loginMethod: null,
      walletProvider: null,
      address: '',
      chainId: null,
      sessionStart: true,
      pageUrl: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: Date.now(),
      referrer: document.referrer,
      userAction: DatadogUserAction.SESSION_START,
    })
  }, [])

  useEffect(() => {
    resetStepState()
    resetBridgeStore()
  }, [resetStepState, resetBridgeStore])

  if (!mounted) return null

  const handleBridgeTokensToL2 = (amount: string) => {
    if (LEGACY_MODE) return
    setCurrentOperationId(null)
    setDirection(BridgeDirection.L1_TO_L2)
    setBridgeConfig({
      ...bridgeConfig,
      amount: amount,
    })
    router.push('/progress')
  }

  const handleWithdrawTokensToL1 = (amount: string) => {
    setCurrentOperationId(null)
    setDirection(BridgeDirection.L2_TO_L1)
    setBridgeConfig({
      ...bridgeConfig,
      amount: amount,
    })
    router.push('/progress')
  }

  return (
    <>
      <RootStyle
        // No-scroll budget: cap the card so it never grows the RootStyle region past
        // its 90vh floor (min-h-[650px] would otherwise push card+py-10 over 90vh on
        // short laptops). Content beyond the cap scrolls inside the card, never the page.
        className="overflow-hidden"
      >
        {/* Maintenance Overlay - blocks all interactions when enabled */}
        {MAINTENANCE_MODE && <MaintenanceOverlay title={MAINTENANCE_TITLE} message={MAINTENANCE_MESSAGE} />}
        <AztecWalletConnectionModals />
        {selectNetwork && (
          <NetworkModal
            setNetworkData={handleSelectNetwork}
            networkData={bridgeConfig[getCurrentSection()].network}
            handleClose={() => setSelectNetwork(false)}
            direction={bridgeConfig.direction}
            isFromSection={isFromSection}
          />
        )}
        {selectToken && (
          <TokensModal
            setTokensData={handleSelectToken}
            tokensData={bridgeConfig[getCurrentSection()].token}
            handleClose={() => setSelectToken(false)}
            direction={bridgeConfig.direction}
            isFromSection={isFromSection}
          />
        )}
        {showSBTModal && (
          <SBT
            address={waapAddress || ''}
            buttonText={`Get SBT on ${currentSBTChain}`}
            chain={currentSBTChain}
            onMint={handleSBTMinted}
            onClose={() => setShowSBTModal(false)}
            isPending={bridgeConfig.direction === BridgeDirection.L2_TO_L1 ? mintL2SBTPending : mintL1SBTPending}
          />
        )}
        {/* Wallet selection is now handled by WalletDiscoveryModal above */}

        {/* A user who is ALREADY Passport-verified can only be here to unlock a higher
            cap, so the verify screen must route them to Proof of Clean Hands (the
            upgrade), never show the Passport success they already hold (#422). An
            unverified user gets the first-time cascade. */}
        {showVerification && (
          <VerificationStep
            onClose={() => setShowVerification(false)}
            intent={
              attestationData?.eligible && attestationData?.method === 'passport'
                ? 'upgrade'
                : 'initial'
            }
          />
        )}

        {/* No-scroll budget: a flex column capped at the same 90vh-5rem viewport
            floor as the card. Header + footer are shrink-0; only the middle region
            flexes and scrolls. Flex (not grid `1fr`) is used deliberately: a grid
            `1fr` track under an indefinite (max-height-only) container resolves to
            its content height, so `overflow-y-auto` inside it never engages and the
            taller withdraw content spills/clips instead of scrolling. Flex-shrink on
            a `flex-1 min-h-0` child bounds it correctly, so withdraw scrolls INSIDE
            the card and the page never grows. */}
        <div
          className={`flex flex-col w-full h-full overflow-hidden ${
            MAINTENANCE_MODE ? 'pointer-events-none' : ''
          }`}
        >
          <div className="shrink-0 px-5 pt-2 pb-1.5">
            <BridgeHeader />
          </div>

          {/* Scrolls internally (never the page) if an expanded accordion can't fit.
              A faint bottom fade + chevron signals there's more below the fold (e.g. the
              transaction breakdown) and clears once scrolled to the end. */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            <div
              ref={scrollRegionRef}
              onScroll={updateScrollAffordance}
              className="min-h-0 flex-1 overflow-y-auto px-5 pb-5"
            >
            <div ref={scrollContentRef}>
            <BridgeSection
              bridgeConfig={bridgeConfig}
              setIsFromSection={setIsFromSection}
              setSelectNetwork={setSelectNetwork}
              setSelectToken={setSelectToken}
              inputAmount={bridgeConfig.amount}
              setInputAmount={handleAmountChange}
              l1NativeBalance={l1NativeBalance}
              l1Balance={l1Balance}
              l2Balance={l2Balance}
              direction={bridgeConfig.direction}
              inputRef={inputRef as React.RefObject<HTMLInputElement>}
              onSwap={LEGACY_MODE ? undefined : swapDirection}
              isPrivacyModeEnabled={isPrivacyModeEnabled}
              feeJuiceBalance={feeJuiceBalance}
              feeJuiceLoading={feeJuiceBalanceLoading}
              attestationMethod={attestationData?.method ?? null}
              passportMaxAmount={attestationData?.passportMaxAmount}
              remainingDepositUsd={attestationData?.remainingDepositUsd}
              travelRuleRemainingUsd={attestationData?.travelRuleRemainingUsd}
              passportScore={attestationData?.passportScore}
              passportThreshold={attestationData?.passportThreshold}
              reservedDepositUsd={attestationData?.reservedDepositUsd}
              pochDailyLimitUsd={Number(BRIDGE_MAX_DEPOSIT_USD)}
              youWillReceive={youWillReceiveAmount}
              // Space-yielding: when either detail accordion is expanded, collapse From/To to
              // one-line summary rows so the expanded detail fits without scrolling the card.
              compact={showBreakdown || fuelDetailOpen}
            />
            {bridgeConfig.direction === BridgeDirection.L1_TO_L2 &&
              !!SWAP_BRIDGE_ROUTER_ADDRESS &&
              (!isPrivacyModeEnabled || !!BRIDGED_FPC_ADDRESS) && (
                <FuelToggle
                  fuelEnabled={fuelEnabled}
                  fuelAmount={fuelAmount}
                  bridgeAmount={bridgeConfig.amount}
                  youWillReceive={youWillReceiveAmount}
                  tokenSymbol={bridgeConfig.from.token?.symbol ?? 'USDC'}
                  tokenDecimals={bridgeConfig.from.token?.decimals ?? 6}
                  tokenAddress={bridgeConfig.from.token?.l1TokenContract ?? ''}
                  onToggle={setFuelEnabled}
                  onAmountChange={setFuelAmount}
                  feeJuiceBalance={feeJuiceBalance}
                  privateFeeJuiceBalance={privateFeeJuiceBalance}
                  feeJuiceBalanceLoading={feeJuiceBalanceLoading}
                  privateFeeJuiceBalanceLoading={privateFeeJuiceBalanceLoading}
                  fuelType={fuelType}
                  onFuelTypeChange={setFuelType}
                  onSufficiencyChange={setFuelSufficient}
                  onRecipientValidityChange={setFuelRecipientValid}
                  onFuelAmountValidChange={setFuelAmountValid}
                  isPrivacyModeEnabled={isPrivacyModeEnabled}
                  selfAztecAddress={aztecAddress ?? ''}
                  fuelRecipientOverride={fuelRecipientOverride}
                  onFuelRecipientOverrideChange={setFuelRecipientOverride}
                  detailOpen={fuelDetailOpen}
                  onDetailOpenChange={(open) => {
                    setFuelDetailOpen(open)
                    // Mutual exclusivity: opening the fuel detail collapses the breakdown.
                    if (open) setShowBreakdown(false)
                  }}
                  onFuelQuoteChange={setFuelFjOutput}
                />
              )}
            {bridgeConfig.direction === BridgeDirection.L2_TO_L1 && (
              <WithdrawFuelPanel
                feeJuiceBalance={feeJuiceBalance}
                privateFeeJuiceBalance={privateFeeJuiceBalance}
                feeJuiceBalanceLoading={feeJuiceBalanceLoading}
                privateFeeJuiceBalanceLoading={privateFeeJuiceBalanceLoading}
                isPrivacyModeEnabled={isPrivacyModeEnabled}
              />
            )}
            <TransactionBreakdown
              isOpen={showBreakdown}
              onToggle={() =>
                setShowBreakdown((prev) => {
                  const next = !prev
                  // Mutual exclusivity: opening the breakdown collapses the fuel detail so the
                  // card yields space instead of scrolling.
                  if (next) setFuelDetailOpen(false)
                  return next
                })
              }
              bridgeFee={portalFeeToken}
              bridgeFeeUsd={portalFeeUsd}
              bridgeFeePercent={bridgeFeePercent}
              receiveAmount={youWillReceiveAmount}
              tokenSymbol={feeTokenSymbol}
              fuelReserveToken={fuelReserveToken}
              fuelReserveFj={fuelReserveFj}
            />
            </div>
            </div>
            {/* Scroll cue: fades to the card's white base and holds a subtle chevron while
                there's content below the fold. pointer-events-none so it never blocks taps;
                fades out at the end of the scroll. White base reads in both light and Privacy
                Mode since the card itself stays white in both. */}
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-x-0 bottom-0 flex h-11 items-end justify-center pb-1.5 bg-gradient-to-t from-[#ffffff] via-[rgba(255,255,255,0.82)] to-[rgba(255,255,255,0)] transition-opacity duration-200 ${
                canScrollDown ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <Icon icon="ph:caret-down-bold" width={16} height={16} className="text-neutral-600" />
            </div>
          </div>

          <div className="shrink-0">
            <div className="sticky bottom-0 rounded-[16px] border border-[#D4D4D4] bg-white shadow-[0px_0px_16px_0px_rgba(0,0,0,0.16)] flex flex-col items-center gap-[6px] pt-[8px] pr-[10px] pb-0 pl-[10px] w-full">
              <BridgeActionButton
                // Fuel gating is a DEPOSIT-only concern (fuel is carved out of the L1→L2
                // bridge amount; withdrawals have no fuel carve). The FuelToggle that
                // computes these flags only mounts in the L1_TO_L2 direction, so applying
                // them to a withdrawal would gate it on a stale deposit-side value — the
                // flags stay at whatever FuelToggle last reported and are never refreshed
                // for L2_TO_L1. Scope the term to L1_TO_L2 so withdraw is symmetric and
                // enables on first valid load without needing a deposit-direction round-trip.
                // Also only gate once both wallets are connected — otherwise it would
                // disable the Connect CTAs the button itself drives.
                isDisabled={
                  (bridgeConfig.direction === BridgeDirection.L1_TO_L2 &&
                    isWaapConnected && isAztecConnected &&
                    (!fuelSufficient || !fuelRecipientValid || !fuelAmountValid)) ||
                  withdrawFuelInsufficient ||
                  authFailed
                }
                disabledReason={bridgeDisabledReason ?? withdrawDisabledReason}
                // Binding conflict guard — disable + name the linked wallet
                // before bridging into a guaranteed-failing pair.
                bindingBlocked={!!bindingConflict}
                bindingBlockedLabel={bindingBlockedLabel}
                // Connection states
                isWaapConnected={isWaapConnected}
                connectWaapWallet={connectWaapWallet}
                getWalletProvider={getWalletProvider}
                loginMethod={loginMethod}
                walletProvider={walletProvider}
                isAztecConnected={isAztecConnected}
                // connectAztec={() => setShowWalletModal(true)}

                connectAztec={() => connectAztecWallet()}
                inputRef={inputRef}
                // Balance and amount states
                inputAmount={bridgeConfig.amount}
                l1Balance={l1Balance?.toString() || '0'}
                l2Balance={l2PublicBalance || '0'}
                l1BalanceLoading={l1BalancePending}
                l2BalanceLoading={l2BalancePending}
                feeJuiceLoading={feeJuicePending}
                // Bridge direction
                direction={bridgeConfig.direction}
                // Core operations
                bridgeTokensToL2={handleBridgeTokensToL2}
                withdrawTokensToL1={handleWithdrawTokensToL1}
                requestFaucet={requestFaucet}
                useExternalFaucet={useExternalFaucet}
                handleExternalFaucet={handleExternalFaucet}
                // Loading states
                isStateInitialized={balancesLoaded}
                requestFaucetPending={requestFaucetPending}
                bridgeTokensToL2Pending={bridgeTokensToL2Pending}
                withdrawTokensToL1Pending={withdrawTokensToL1Pending}
                // Faucet related
                isEligibleForFaucet={isEligibleForFaucet || false}
                needsGas={needsGas || false}
                needsTokens={needsTokens || false}
                needsTokensOnly={needsTokensOnly || false}
                // SBT related
                hasL1SBT={hasL1SBT}
                hasL2SBT={hasL2SBT}
                setShowSBTModal={setShowSBTModal}
                setCurrentSBTChain={setCurrentSBTChain}
                // Compliance attestation
                needsClaimGas={noClaimGas}
                onAddClaimGas={() => setFuelEnabled(true)}
                pochEligible={attestationData?.eligible}
                pochLoading={attestationLoading}
                pochReason={attestationData?.reason}
                onRequestVerification={() => setShowVerification(true)}
                attestationMethod={attestationData?.method ?? null}
                passportMaxAmount={attestationData?.passportMaxAmount}
                remainingDepositUsd={attestationData?.remainingDepositUsd}
                travelRuleBlocked={attestationData?.travelRuleExceeded}
                travelRuleRemainingUsd={attestationData?.travelRuleRemainingUsd}
                reservedDepositUsd={attestationData?.reservedDepositUsd}
                // Operation completion state
                bridgeCompleted={bridgeCompleted}
                // Disable if L2 node error
                l2NodeError={l2NodeIsReadyIsError && !l2NodeIsReadyLoading}
                l2NodeIsReadyLoading={l2NodeIsReadyLoading}
                feeJuiceBalanceLoading={
                  feeJuiceBalanceLoading ||
                  privateFeeJuiceBalanceLoading ||
                  (isAztecConnected && feeJuiceBalance == null)
                }
              />
              <BridgeFooter />
            </div>
          </div>
        </div>
      </RootStyle>
    </>
  )
}
