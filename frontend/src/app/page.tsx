'use client'
import TextButton from '@/components/TextButton'
import { ChangeEvent, useCallback, useEffect, useState, useRef } from 'react'
import { Oval } from 'react-loader-spinner'
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
  useL2WithdrawTokensToL1,
  useL2NodeIsReady,
} from '@/hooks/useL2Operations'
import { showToast, useToast } from '@/hooks/useToast'
import clsxm from '@/utils/clsxm'
import NetworkModal from '@/components/model/Network'
import TokensModal from '@/components/model/TokensModal'
import {
  BridgeDirection,
  BridgeState,
  Network as NetworkType,
  Token as TokenType,
} from '@/types/bridge'
import BridgeSection from '@/components/BridgeSection'
// import TransactionBreakdown from '@/components/TransactionBreakdown'
import BridgeFooter from '@/components/BridgeFooter'
import BridgeHeader from '@/components/BridgeHeader'
// import { motion, AnimatePresence } from 'framer-motion'
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
import { logInfo, logError } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecLoginMethod } from '@/types/wallet'
import EmojiVerificationModal from '@/components/model/EmojiVerificationModal'
import AccountSelectorModal from '@/components/model/AccountSelectorModal'
import WalletDiscoveryModal from '@/components/model/WalletDiscoveryModal'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useRouter } from 'next/navigation'
import MaintenanceOverlay from '@/components/MaintenanceOverlay'
import FuelToggle from '@/components/FuelToggle'
import {
  MAINTENANCE_MODE,
  MAINTENANCE_MESSAGE,
  MAINTENANCE_TITLE,
  BRIDGE_AND_FUEL_ADDRESS,
} from '@/config'

export default function Home() {
  const router = useRouter()

  // UI state
  const [selectNetwork, setSelectNetwork] = useState<boolean>(false)
  const [selectToken, setSelectToken] = useState<boolean>(false)
  const [isFromSection, setIsFromSection] = useState<boolean>(true)
  const [mounted, setMounted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputAmount, setInputAmount] = useState('')
  const [usdValue, setUsdValue] = useState('')

  // Operational state
  const [showSBTModal, setShowSBTModal] = useState(false)
  const [currentSBTChain, setCurrentSBTChain] = useState<'Ethereum' | 'Aztec'>(
    'Ethereum',
  )
  const [bridgeCompleted, setBridgeCompleted] = useState(false)

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
    setFuelEnabled,
    setFuelAmount,
  } = useBridgeStore()

  // Get wallet state from useWalletStore
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
    // Wallet SDK connection flow
    walletConnectionPhase,
    verificationEmojis,
    discoveredWallets,
    selectWallet,
    confirmWalletConnection,
    cancelWalletConnection,
    // Account selection
    availableAccounts,
    selectAccount,
  } = useWalletStore()

  // Get UI state from walletStore
  const {
    showWalletModal,
    showWalletInstallPrompt,
    setShowWalletModal,
    setShowWalletInstallPrompt,
    aztecAddress,
    waapAddress,
    isAztecConnecting,
  } = useWalletStore()

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
    (token) =>
      token.type === 'native' && token.network?.chainId === L1_CHAIN_ID,
  )
  const l1NativeBalance = sepoliaNativeTokens?.balance_formatted

  const selectedFromToken = bridgeConfig.from.token
  // Alchemy-based ERC20 balance (may not index custom test tokens)
  const l1BalanceAlchemy = l1TokenBalances.find(
    (token) =>
      token.type === 'erc20' &&
      token.network?.chainId === L1_CHAIN_ID &&
      token.address ===
        (selectedFromToken?.l1TokenContract ?? L1_TOKENS[0]?.l1TokenContract),
  )?.balance_formatted

  // Direct RPC balance via eth_call (works for any ERC20 including custom test tokens)
  const { data: l1BalanceRpc } = useL1TokenBalance()

  // Prefer Alchemy if available, fall back to direct RPC
  const l1Balance = l1BalanceAlchemy ?? l1BalanceRpc
  const { token: authToken, authFailed } = useAuthStore()
  const isAuthenticated = !!authToken
  const { data: attestationData, isLoading: attestationLoading } = useAttestationCheck()
  const { data: hasL1SBT } = useL1HasSoulboundToken()
  const { mutate: mintL1SBT, isPending: mintL1SBTPending } =
    useL1MintSoulboundToken(mintL1SBTOnSuccess)

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
  const { data: feeJuiceBalance, isLoading: feeJuiceLoading, isPending: feeJuicePending, refetch: refetchFeeJuiceBalance } =
    useL2FeeJuiceBalance()
  const { data: hasL2SBT } = useL2HasSoulboundToken()
  const { mutate: mintL2SBT, isPending: mintL2SBTPending } =
    useL2MintSoulboundToken(mintL2SBTOnSuccess)

  // Bridge success callback (runs after L1→L2 bridge or L2→L1 withdrawal)
  const handleBridgeSuccess = useCallback(
    (_data: any) => {
      notify.promise(
        Promise.all([
          refetchL1Balance(),
          refetchL2Balance(),
          refetchFeeJuiceBalance(),
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
      setBridgeConfig,
      bridgeConfig,
      notify,
    ],
  )

  const { mutate: bridgeTokensToL2, isPending: bridgeTokensToL2Pending } =
    useL1BridgeToL2(handleBridgeSuccess)

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
    const googleFaucetUrl =
      'https://cloud.google.com/application/web3/faucet/ethereum/sepolia'

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
      userAction: 'faucet_redirect',
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
      notify(
        'error',
        `Error minting SBT: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      )
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
        userAction: 'wallet_connection_attempt',
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
        userAction: 'wallet_connection_failure',
        error: error instanceof Error ? error.message : 'Unknown error',
      })

      notify(
        'error',
        `Failed to connect wallet: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      )
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
      userAction: 'session_start',
    })
  }, [])

  useEffect(() => {
    resetStepState()
    resetBridgeStore()
  }, [resetStepState, resetBridgeStore])

  if (!mounted) return null

  const handleBridgeTokensToL2 = (amount: string) => {
    setDirection(BridgeDirection.L1_TO_L2)
    setBridgeConfig({
      ...bridgeConfig,
      amount: amount,
    })
    router.push('/progress')
  }

  const handleWithdrawTokensToL1 = (amount: string) => {
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
        {MAINTENANCE_MODE && (
          <MaintenanceOverlay
            title={MAINTENANCE_TITLE}
            message={MAINTENANCE_MESSAGE}
          />
        )}
        {showWalletInstallPrompt && (
          <WalletDiscoveryModal
            isOpen={true}
            wallets={[]}
            isDiscovering={false}
            onSelectWallet={() => {}}
            onClose={() => setShowWalletInstallPrompt(false)}
          />
        )}
        {(walletConnectionPhase === 'discovering' ||
          walletConnectionPhase === 'selecting') && (
          <WalletDiscoveryModal
            isOpen={true}
            wallets={discoveredWallets}
            isDiscovering={walletConnectionPhase === 'discovering'}
            onSelectWallet={selectWallet}
            onClose={cancelWalletConnection}
          />
        )}
        {walletConnectionPhase === 'verifying' && verificationEmojis && (
          <EmojiVerificationModal
            isOpen={true}
            emojis={verificationEmojis}
            isConfirming={isAztecConnecting}
            onConfirm={confirmWalletConnection}
            onCancel={cancelWalletConnection}
          />
        )}
        {walletConnectionPhase === 'requesting' && (
          <div className='absolute inset-0 bg-latest-grey-1000 z-20 rounded-lg flex flex-col items-center justify-center gap-4'>
            <Oval
              height={40}
              width={40}
              color='#3b82f6'
              secondaryColor='#93c5fd'
              strokeWidth={4}
            />
            <p className='text-latest-grey-600 text-14 font-medium'>
              Requesting permissions...
            </p>
          </div>
        )}
        {walletConnectionPhase === 'account-select' && (
          <AccountSelectorModal
            isOpen={true}
            accounts={availableAccounts}
            onSelect={selectAccount}
            onCancel={cancelWalletConnection}
            title='Select Account'
          />
        )}
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
            isPending={
              bridgeConfig.direction === BridgeDirection.L2_TO_L1
                ? mintL2SBTPending
                : mintL1SBTPending
            }
          />
        )}
        <div
          className={`grid grid-rows-[max-content_1fr_max-content] h-full ${
            MAINTENANCE_MODE ? 'pointer-events-none' : ''
          }`}>
          <div className='p-5'>
            <BridgeHeader
              onClick={async () => {
                await disconnectWaapWallet()
                await disconnectAztecWallet()
                localStorage.removeItem('aztecLoginMethod')
                localStorage.removeItem('privacyModeEnabled')
                localStorage.removeItem('aztec-bridge-query-state')
                window.location.reload()
              }}
            />
          </div>

          <div className='px-5'>
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
              feeJuiceLoading={feeJuiceLoading}
              attestationMethod={attestationData?.method ?? null}
              passportMaxAmount={attestationData?.passportMaxAmount}
            />
            {bridgeConfig.direction === BridgeDirection.L1_TO_L2 &&
              !isPrivacyModeEnabled &&
              !!BRIDGE_AND_FUEL_ADDRESS && (
                <FuelToggle
                  fuelEnabled={fuelEnabled}
                  fuelAmount={fuelAmount}
                  bridgeAmount={bridgeConfig.amount}
                  tokenSymbol={bridgeConfig.from.token?.symbol ?? 'USDC'}
                  tokenDecimals={bridgeConfig.from.token?.decimals ?? 6}
                  onToggle={setFuelEnabled}
                  onAmountChange={setFuelAmount}
                  feeJuiceBalance={feeJuiceBalance}
                />
              )}
          </div>

          <div className='self-end'>
            <div className='rounded-[16px] border border-[#D4D4D4] bg-white shadow-[0px_0px_16px_0px_rgba(0,0,0,0.16)] flex flex-col items-center gap-[16px] pt-[16px] pr-[10px] pb-0 pl-[10px] w-full'>
              <BridgeActionButton
                // isDisabled={isWaapConnected && isAztecConnected && isL2BalanceError}
                // isDisabled={isWaapConnected && isAztecConnected && true}
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
                // Auth state
                isAuthenticated={isAuthenticated}
                authFailed={authFailed}
                // Disable if L2 node error
                l2NodeError={l2NodeIsReadyIsError && !l2NodeIsReadyLoading}
                l2NodeIsReadyLoading={l2NodeIsReadyLoading}
              />
              <BridgeFooter />
            </div>
          </div>
        </div>
      </RootStyle>
    </>
  )
}
