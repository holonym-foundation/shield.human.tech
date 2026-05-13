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
} from '@/hooks/useL1Operations'
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
} from '@/hooks/useL2Operations'
import { showToast, useToast } from '@/hooks/useToast'
import { extractErrorMessage } from '@/utils'
import clsxm from '@/utils/clsxm'
import NetworkModal from '@/components/model/Network'
import TokensModal from '@/components/model/TokensModal'
import { BridgeDirection, BridgeState, Network as NetworkType, Token as TokenType } from '@/types/bridge'
import BridgeSection from '@/components/BridgeSection'
import TransactionBreakdown from '@/components/TransactionBreakdown'
import BridgeFooter from '@/components/BridgeFooter'
import BridgeHeader from '@/components/BridgeHeader'
import { motion, AnimatePresence } from 'framer-motion'
import BridgeActionButton from '@/components/BridgeActionButton'
import {
  L1_CHAIN_ID,
  L1_NETWORKS,
  L2_NETWORKS,
  L1_TOKENS,
  L2_TOKENS,
  getL2PairedToken,
  getL1PairedToken,
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
import { useRouter } from 'next/navigation'
import MaintenanceOverlay from '@/components/MaintenanceOverlay'
import FuelToggle from '@/components/FuelToggle'
import {
  BRIDGED_FPC_ADDRESS,
  MAINTENANCE_MODE,
  MAINTENANCE_MESSAGE,
  MAINTENANCE_TITLE,
  SWAP_BRIDGE_ROUTER_ADDRESS,
} from '@/config'

const variants = {
  hidden: { opacity: 0, y: 100 },
  enter: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -100 },
}

export default function Home() {
  const router = useRouter()

  // UI state
  const [selectNetwork, setSelectNetwork] = useState<boolean>(false)
  const [selectToken, setSelectToken] = useState<boolean>(false)
  const [isFromSection, setIsFromSection] = useState<boolean>(true)
  const [showBreakdown, setShowBreakdown] = useState(false)
  const [mounted, setMounted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
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

  // Get wallet state from useWalletStore. Modal-driving fields (walletConnectionPhase,
  // discoveredWallets, verificationEmojis, etc.) are consumed inside <AztecWalletConnectionModals />
  // and don't need to be pulled in here.
  const {
    isWaapConnected,
    isAztecConnected,
    connectWaapWallet,
    connectAztecWallet,
    disconnectWaapWallet,
    disconnectAztecWallet,
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

  // Bridge success callback (runs after L1→L2 bridge or L2→L1 withdrawal)
  const handleBridgeSuccess = useCallback(
    (_data: any) => {
      notify.promise(
        Promise.all([
          refetchL1Balance(),
          refetchL2Balance(),
          refetchFeeJuiceBalance(),
          refetchPrivateFeeJuiceBalance(),
        ]),
        {
          pending: 'Refreshing balances...',
          success: 'Balances updated',
          error: 'Failed to refresh balances',
        },
      )
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
      notify,
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
      notify('error', `Error minting SBT: ${extractErrorMessage(error)}`)
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

      notify('error', `Failed to connect wallet: ${extractErrorMessage(error)}`)
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
      <RootStyle>
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

        <div
          className={`grid grid-rows-[max-content_1fr_max-content] h-full ${
            MAINTENANCE_MODE ? 'pointer-events-none' : ''
          }`}
        >
          <div className="p-5">
            <BridgeHeader
              onClick={async () => {
                await disconnectWaapWallet()
                await disconnectAztecWallet()
                localStorage.clear()
                window.location.reload()
              }}
            />
          </div>

          <div className="px-5">
            <AnimatePresence mode="popLayout">
              {!showBreakdown ? (
                <motion.div
                  key="bridge"
                  initial="hidden"
                  animate="enter"
                  exit="exit"
                  variants={variants}
                  transition={{ ease: 'easeInOut', duration: 0.5 }}
                >
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
                    onSwap={swapDirection}
                    isPrivacyModeEnabled={isPrivacyModeEnabled}
                    feeJuiceBalance={feeJuiceBalance}
                    feeJuiceLoading={feeJuiceBalanceLoading}
                    attestationMethod={attestationData?.method ?? null}
                    passportMaxAmount={attestationData?.passportMaxAmount}
                  />
                  {bridgeConfig.direction === BridgeDirection.L1_TO_L2 &&
                    !!SWAP_BRIDGE_ROUTER_ADDRESS &&
                    (!isPrivacyModeEnabled || !!BRIDGED_FPC_ADDRESS) && (
                      <FuelToggle
                        fuelEnabled={fuelEnabled}
                        fuelAmount={fuelAmount}
                        bridgeAmount={bridgeConfig.amount}
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
                      />
                    )}
                  <TransactionBreakdown isOpen={false} onToggle={() => setShowBreakdown(true)} />
                </motion.div>
              ) : (
                <motion.div
                  key="breakdown"
                  initial="hidden"
                  animate="enter"
                  exit="exit"
                  variants={variants}
                  transition={{ ease: 'easeInOut', duration: 0.5 }}
                >
                  <TransactionBreakdown isOpen={true} onToggle={() => setShowBreakdown(false)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="self-end">
            <div className="rounded-[16px] border border-[#D4D4D4] bg-white shadow-[0px_0px_16px_0px_rgba(0,0,0,0.16)] flex flex-col items-center gap-[16px] pt-[16px] pr-[10px] pb-0 pl-[10px] w-full">
              <BridgeActionButton
                // Fuel gating only applies once both wallets are connected — otherwise it
                // disables the Connect CTAs the button itself drives.
                isDisabled={
                  (isWaapConnected && isAztecConnected &&
                    (!fuelSufficient || !fuelRecipientValid || !fuelAmountValid)) ||
                  authFailed
                }
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
                needsTokensOnly={needsTokensOnly || false}
                // SBT related
                hasL1SBT={hasL1SBT}
                hasL2SBT={hasL2SBT}
                setShowSBTModal={setShowSBTModal}
                setCurrentSBTChain={setCurrentSBTChain}
                // Privacy mode / attestation
                isPrivacyModeEnabled={isPrivacyModeEnabled}
                pochEligible={attestationData?.eligible}
                pochLoading={attestationLoading}
                pochReason={attestationData?.reason}
                attestationMethod={attestationData?.method ?? null}
                passportMaxAmount={attestationData?.passportMaxAmount}
                passportScore={attestationData?.passportScore}
                passportThreshold={attestationData?.passportThreshold}
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
