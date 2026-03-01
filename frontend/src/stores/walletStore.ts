import { L1_CHAIN_ID } from '@/config'
import { waapConfig } from '@/config/l1.config'
import { showToast } from '@/hooks/useToast'
import {
  detectWalletByProvider,
  discoveredProviders,
  getEIP6963Provider,
  getEIP6963WalletIcon,
  getWalletIconByMethod,
  getWalletProviderName,
  handleWaapError,
} from '@/stores/waapWalletHelpers'
import { AztecLoginMethod, LOGIN_METHODS, WaapLoginMethod, WalletType } from '@/types/wallet'
import { logError, logInfo } from '@/utils/datadog'
import {
  discoverWallets,
  connectToProvider,
  hashToEmoji,
  type WalletProvider,
  type PendingConnection,
} from '@/utils/walletSdkConnection'
import type { Wallet } from '@aztec/aztec.js/wallet'
import type { DiscoverySession } from '@/utils/walletSdkConnection'
import { initWaaP } from '@human.tech/waap-sdk'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

// Module-level state (not in Zustand — DiscoverySession is not serializable)
let activeDiscoverySession: DiscoverySession | null = null
let isDiscoveryInProgress = false
let isConfirmInProgress = false

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  interface Window {
    waap: any
    ethereum?: any
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

const AZTEC_WALLET_KEY = 'aztecLoginMethod'

// ============================================================================
// WALLET CONNECTION PHASE
// ============================================================================

export type WalletConnectionPhase =
  | 'idle'
  | 'discovering'
  | 'selecting'
  | 'verifying'
  | 'connected'

// ============================================================================
// INTERFACES
// ============================================================================

interface WalletState {
  // ============================================================================
  // UI STATE
  // ============================================================================
  showWalletModal: boolean
  showWalletInstallPrompt: boolean

  // ============================================================================
  // UI ACTIONS
  // ============================================================================
  setShowWalletModal: (show: boolean) => void
  setShowWalletInstallPrompt: (show: boolean) => void

  // ============================================================================
  // AZTEC WALLET STATE
  // ============================================================================
  // Connection state
  aztecLoginMethod: AztecLoginMethod | null
  aztecAddress: string | null
  aztecAccount: any | null
  isAztecConnected: boolean
  isAztecConnecting: boolean
  aztecError: Error | null

  // Wallet SDK instances
  sdkWallet: Wallet | null
  sdkProvider: WalletProvider | null

  // Wallet connection flow state
  walletConnectionPhase: WalletConnectionPhase
  verificationEmojis: string | null
  pendingConnection: PendingConnection | null
  discoveredWallets: Array<{ name: string; provider: WalletProvider }>

  // ============================================================================
  // AZTEC WALLET ACTIONS
  // ============================================================================
  // State management
  setAztecLoginMethod: (type: AztecLoginMethod | null) => void
  setAztecState: (state: {
    address: string | null
    account: any | null
    isConnected: boolean
    error?: Error | null
  }) => void

  // Connection management
  connectAztecWallet: (type?: AztecLoginMethod) => Promise<any>
  disconnectAztecWallet: () => Promise<void>
  initializeAztecWallet: () => Promise<void>

  // Wallet SDK connection flow actions
  startWalletDiscovery: () => Promise<void>
  selectWallet: (provider: WalletProvider) => Promise<void>
  confirmWalletConnection: () => Promise<any>
  cancelWalletConnection: () => void

  // ============================================================================
  // WAAP WALLET STATE
  // ============================================================================
  // Connection state
  waapAddress: `0x${string}` | null
  waapChainId: number | null
  isWaapConnected: boolean
  waapError: Error | null

  // Wallet identification
  waapLoginMethod: WaapLoginMethod | null
  waapWalletProvider: string | null
  waapWalletIcon: string | null

  // Initialization state
  isWaapInitialized: boolean

  // ============================================================================
  // WAAP WALLET ACTIONS
  // ============================================================================
  // Initialization
  initializeWaapWallet: () => Promise<void>

  // Connection management
  connectWaapWallet: () => Promise<void>
  disconnectWaapWallet: () => Promise<void>

  // Network management
  switchWaapChain: (chainId: number) => Promise<void>
  getWaapChainId: () => Promise<number>

  // Account management
  getWaapAccount: () => Promise<string | null>
  signWaapMessage: (message: string) => Promise<string>

  // Wallet identification
  getWaapLoginMethod: () => Promise<WaapLoginMethod | null>
  getWaapWalletProvider: () => string | null
  getWaapWalletIcon: () => string | null
  getAllAvailableWallets: () => string[]

  // Utility functions
  refreshWaapWalletInfo: () => Promise<void>

  // ============================================================================
  // UTILITY ACTIONS
  // ============================================================================
  reset: () => void
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

// Helper function to get initial wallet type from localStorage
const getInitialWalletType = (): AztecLoginMethod | null => {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(AZTEC_WALLET_KEY)
  return stored ? (stored as AztecLoginMethod) : null
}

// WAAP_METHOD enum equivalent for WaaP
export const WAAP_METHOD = {
  eth_requestAccounts: 'eth_requestAccounts',
  eth_chainId: 'eth_chainId',
  wallet_switchEthereumChain: 'wallet_switchEthereumChain',
  wallet_addEthereumChain: 'wallet_addEthereumChain',
  personal_sign: 'personal_sign',
  eth_sendTransaction: 'eth_sendTransaction',
  eth_call: 'eth_call',
  eth_getBalance: 'eth_getBalance',
  eth_getTransactionReceipt: 'eth_getTransactionReceipt',
} as const

// WaaP wallet request function
export const requestWaapWallet = async (
  method: string,
  params?: any[]
) => {
  return window.waap.request({ method, params })
}

// ============================================================================
// INITIAL STATE
// ============================================================================

const initialState = {
  // UI State
  showWalletModal: false,
  showWalletInstallPrompt: false,

  // Aztec Wallet State
  aztecLoginMethod: getInitialWalletType(),
  aztecAddress: null,
  aztecAccount: null,
  isAztecConnected: false,
  isAztecConnecting: false,
  aztecError: null,
  sdkWallet: null,
  sdkProvider: null,

  // Wallet connection flow state
  walletConnectionPhase: 'idle' as WalletConnectionPhase,
  verificationEmojis: null,
  pendingConnection: null,
  discoveredWallets: [],

  // WaaP Wallet State
  waapAddress: null,
  waapChainId: null,
  isWaapConnected: false,
  waapError: null,
  waapLoginMethod: null,
  waapWalletProvider: null,
  waapWalletIcon: null,
  isWaapInitialized: false,
}

// ============================================================================
// WALLET STORE IMPLEMENTATION
// ============================================================================

const walletStore = create<WalletState>((set, get) => ({
  ...initialState,

  // ============================================================================
  // UI ACTIONS
  // ============================================================================
  setShowWalletModal: (show) => set({ showWalletModal: show }),
  setShowWalletInstallPrompt: (show) => set({ showWalletInstallPrompt: show }),

  // ============================================================================
  // AZTEC WALLET ACTIONS
  // ============================================================================

  // State management
  setAztecLoginMethod: (type) => {
    if (type) {
      localStorage.setItem(AZTEC_WALLET_KEY, type)
    } else {
      localStorage.removeItem(AZTEC_WALLET_KEY)
    }
    set({ aztecLoginMethod: type })
  },

  setAztecState: (state) => {
    // Get wallet type from localStorage if not already set
    const storedWalletType = localStorage.getItem(
      AZTEC_WALLET_KEY
    ) as AztecLoginMethod | null

    set({
      aztecAddress: state.address,
      aztecAccount: state.account,
      isAztecConnected: state.isConnected,
      aztecError: state.error || null,
      aztecLoginMethod: storedWalletType,
    })
  },

  // ─── Wallet SDK connection flow ────────────────────────────────────

  startWalletDiscovery: async () => {
    // Guard against concurrent discovery calls
    if (isDiscoveryInProgress) {
      console.log('[walletStore] Discovery already in progress, skipping')
      return
    }

    // Cancel any stale session
    if (activeDiscoverySession) {
      try { activeDiscoverySession.cancel() } catch { /* ignore */ }
      activeDiscoverySession = null
    }

    isDiscoveryInProgress = true

    set({
      walletConnectionPhase: 'discovering',
      discoveredWallets: [],
      isAztecConnecting: true,
    })

    logInfo('Aztec wallet discovery started', {
      walletType: WalletType.AZTEC,
      loginMethod: 'wallet-sdk',
      address: '',
      chainId: null,
      userAction: 'aztec_wallet_discovery_start',
    })

    const collectedWallets: Array<{ name: string; provider: WalletProvider }> = []

    // Resolve as soon as the first wallet is discovered (with a short
    // grace period for additional wallets), NOT after the full timeout.
    // Waiting the full 5-10s causes stale-provider key exchange timeouts.
    const result = await new Promise<WalletProvider[]>((resolve) => {
      let graceTimer: ReturnType<typeof setTimeout> | null = null

      activeDiscoverySession = discoverWallets({
        timeout: 5000,
        onWalletDiscovered: (provider) => {
          const entry = { name: provider.name ?? 'Aztec Wallet', provider }
          collectedWallets.push(entry)
          set({ discoveredWallets: [...collectedWallets] })

          // Give a 1s grace period for more wallets, then resolve
          if (graceTimer) clearTimeout(graceTimer)
          graceTimer = setTimeout(() => {
            resolve(collectedWallets.map((w) => w.provider))
          }, 1000)
        },
      })

      // Fallback: if no wallets respond within 6s, resolve empty
      setTimeout(() => {
        if (graceTimer) clearTimeout(graceTimer)
        resolve(collectedWallets.map((w) => w.provider))
      }, 6000)
    })

    isDiscoveryInProgress = false
    activeDiscoverySession = null

    if (result.length === 0) {
      set({
        walletConnectionPhase: 'idle',
        isAztecConnecting: false,
        showWalletInstallPrompt: true,
        showWalletModal: false,
      })
    } else if (result.length === 1) {
      // Auto-select the only wallet — connect immediately
      await get().selectWallet(result[0])
    } else {
      // Multiple wallets — show selection UI
      set({ walletConnectionPhase: 'selecting' })
    }
  },

  selectWallet: async (provider: WalletProvider) => {
    try {
      set({ walletConnectionPhase: 'verifying', isAztecConnecting: false })

      const pending = await connectToProvider(provider)
      const emojis = hashToEmoji(pending.verificationHash)

      set({
        pendingConnection: pending,
        verificationEmojis: emojis,
        sdkProvider: provider,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logError('Failed to establish secure channel', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_channel_failed',
        error: errorMessage,
      })
      set({
        walletConnectionPhase: 'idle',
        isAztecConnecting: false,
        pendingConnection: null,
        verificationEmojis: null,
      })
      showToast('error', `Failed to connect wallet: ${errorMessage}`)
    }
  },

  confirmWalletConnection: async () => {
    // Guard against concurrent confirm calls (e.g. double-click, HMR replay)
    if (isConfirmInProgress) {
      console.log('[walletStore] confirmWalletConnection: already in progress, skipping')
      return
    }

    const { pendingConnection, sdkProvider } = get()
    if (!pendingConnection || !sdkProvider) {
      console.warn('[walletStore] confirmWalletConnection: pendingConnection or sdkProvider is null', {
        hasPending: !!pendingConnection,
        hasProvider: !!sdkProvider,
      })
      return
    }

    isConfirmInProgress = true

    // Show loading state while confirming
    set({ isAztecConnecting: true })

    try {
      console.log('[walletStore] Calling pendingConnection.confirm()...')

      // Await confirm() directly — no timeout. The timeout interferes with
      // the SDK's internal channel state. User can cancel manually if needed.
      const wallet = await pendingConnection.confirm()

      console.log('[walletStore] confirm() resolved, getting accounts...')

      // Get the account address from the wallet
      // getAccounts() returns Aliased<AztecAddress>[] — unwrap with .item
      const accounts = await wallet.getAccounts()
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts returned from wallet')
      }
      const rawAccount: any = accounts[0]
      const aztecAddr = rawAccount?.item ?? rawAccount?.address ?? rawAccount
      const address = typeof aztecAddr === 'string'
        ? aztecAddr
        : typeof aztecAddr?.toString === 'function'
          ? aztecAddr.toString()
          : String(aztecAddr)

      console.log('[walletStore] Connected to account:', address)

      // Set up disconnect handler
      sdkProvider.onDisconnect(() => {
        get().disconnectAztecWallet()
      })

      // Import aztecNode for L1 contract addresses
      const { aztecNode } = await import('../aztec')

      // Create an account-like object for compatibility with existing code
      const connectedAccount = {
        address: { toString: () => address },
        sdkWallet: wallet,
        aztecNode,
      }

      // Update all state
      set({
        sdkWallet: wallet,
        walletConnectionPhase: 'connected',
        pendingConnection: null,
        verificationEmojis: null,
        isAztecConnecting: false,
      })

      get().setAztecLoginMethod('wallet-sdk')
      get().setAztecState({
        address,
        account: connectedAccount,
        isConnected: true,
      })
      set({ showWalletModal: false })

      logInfo('Aztec wallet connected successfully via wallet-sdk', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address,
        chainId: null,
        userAction: 'aztec_wallet_connection_success',
      })

      return connectedAccount
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error('[walletStore] confirmWalletConnection failed:', errorMessage)
      logError('Failed to confirm wallet connection', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_confirm_failed',
        error: errorMessage,
      })
      // Only reset state if we're not already connected (avoid nuking a
      // successful first confirm when a stale second call fails)
      if (get().walletConnectionPhase !== 'connected') {
        set({
          walletConnectionPhase: 'idle',
          isAztecConnecting: false,
          pendingConnection: null,
          verificationEmojis: null,
        })
        showToast('error', `Failed to confirm connection: ${errorMessage}`)
      }
    } finally {
      isConfirmInProgress = false
    }
  },

  cancelWalletConnection: () => {
    const { pendingConnection } = get()
    if (pendingConnection) {
      try {
        pendingConnection.cancel()
      } catch {
        // ignore cancel errors
      }
    }
    // Clean up module-level state
    if (activeDiscoverySession) {
      try { activeDiscoverySession.cancel() } catch { /* ignore */ }
      activeDiscoverySession = null
    }
    isDiscoveryInProgress = false
    isConfirmInProgress = false

    set({
      walletConnectionPhase: 'idle',
      isAztecConnecting: false,
      pendingConnection: null,
      verificationEmojis: null,
      discoveredWallets: [],
    })
  },

  // ─── Connection management (public API) ────────────────────────────

  connectAztecWallet: async (_type?: AztecLoginMethod) => {
    // Guard: don't start if already in a connection flow
    const { walletConnectionPhase } = get()
    if (walletConnectionPhase !== 'idle') {
      console.log('[walletStore] connectAztecWallet: already in progress (phase:', walletConnectionPhase, '), skipping')
      return
    }

    try {
      logInfo('Aztec wallet connection initiated', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_connection_attempt',
      })

      // Start the wallet-sdk discovery flow
      await get().startWalletDiscovery()
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      logError('Failed to connect Aztec wallet', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_connection_failure',
        error: errorMessage,
      })
      showToast('error', `Failed to connect Aztec wallet: ${errorMessage}`)
      throw error
    }
  },

  initializeAztecWallet: async () => {
    // No-op on load: discovery is deferred until the user explicitly
    // clicks "Connect L2 Wallet". We only store the login method so
    // the UI can remember the user's preference.
  },

  disconnectAztecWallet: async () => {
    try {
      const { aztecAddress, sdkProvider, aztecLoginMethod } = get()

      logInfo('Aztec wallet disconnection initiated', {
        walletType: WalletType.AZTEC,
        loginMethod: aztecLoginMethod || null,
        walletProvider: null,
        address: aztecAddress || '',
        chainId: null,
        userAction: 'aztec_wallet_disconnection_attempt',
      })

      // Disconnect via provider
      if (sdkProvider) {
        try {
          await sdkProvider.disconnect()
        } catch (error) {
          console.error('Error disconnecting wallet-sdk provider:', error)
        }
      }

      // Clean up module-level state
      if (activeDiscoverySession) {
        try { activeDiscoverySession.cancel() } catch { /* ignore */ }
        activeDiscoverySession = null
      }
      isDiscoveryInProgress = false
      isConfirmInProgress = false

      set({
        sdkWallet: null,
        sdkProvider: null,
        aztecAddress: null,
        aztecAccount: null,
        isAztecConnected: false,
        isAztecConnecting: false,
        aztecLoginMethod: null,
        walletConnectionPhase: 'idle',
        pendingConnection: null,
        verificationEmojis: null,
        discoveredWallets: [],
      })

      localStorage.removeItem(AZTEC_WALLET_KEY)

      logInfo('Aztec wallet disconnected successfully', {
        walletType: WalletType.AZTEC,
        loginMethod: null,
        walletProvider: null,
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_disconnection_success',
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      set({ aztecError: error })

      logError('Failed to disconnect Aztec wallet', {
        walletType: WalletType.AZTEC,
        loginMethod: null,
        walletProvider: null,
        address: get().aztecAddress || '',
        chainId: null,
        userAction: 'aztec_wallet_disconnection_failure',
        error
      })

      showToast('error', `Failed to disconnect Aztec wallet: ${error.message}`)
    }
  },

  // ============================================================================
  // WAAP WALLET ACTIONS
  // ============================================================================

  // Initialization
  initializeWaapWallet: async () => {
    const { isWaapInitialized } = get()

    if (isWaapInitialized) {
      return
    }

    try {
      initWaaP(waapConfig)

      const { getWaapAccount, switchWaapChain, refreshWaapWalletInfo } = get()

      // Try to get initial account, but don't fail if it's not available
      const initialAccount = await getWaapAccount().catch((err) => {
        console.log(
          'Initial account check failed (this is normal if wallet is not connected):',
          err
        )
        return null
      })

      // If wallet is already connected, refresh all wallet info
      if (initialAccount) {
        await refreshWaapWalletInfo()
      }

      // Set up event listeners
      window.waap.on('accountsChanged', async (accounts: string[]) => {
        const isConnected = accounts.length > 0
        set({ waapAddress: accounts[0] as `0x${string}` || null, isWaapConnected: isConnected })

        // If wallet is connected, retrieve the login method
        if (isConnected) {
          const { getWaapLoginMethod } = get()
          if (getWaapLoginMethod) {
            await getWaapLoginMethod()
          }
        }
      })

      window.waap.on('chainChanged', (chainId: string) => {
        const chainIdNumber = parseInt(chainId, 16)
        set({ waapChainId: chainIdNumber })
      })

      // Mark as initialized
      set({ isWaapInitialized: true })
    } catch (err) {
      handleWaapError(err, 'Failed to initialize Ethereum wallet', set)
    }
  },

  // Connection management
  connectWaapWallet: async () => {
    try {
      // Log connection attempt
      const { waapLoginMethod, waapWalletProvider, waapAddress, waapChainId } = get()
      logInfo('WaaP wallet connection initiated', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: 'waap_wallet_connection_attempt',
      })

      const result = (await window.waap.login()) as WaapLoginMethod

      // Check if login method is 'injected' but no wallet extension is available
      if (result === LOGIN_METHODS.INJECTED && !window.ethereum) {
        throw new Error(
          'No Ethereum wallet extension detected. Please install MetaMask or another Ethereum wallet.'
        )
      }

      // For injected wallets, force account selection if multiple wallets are available
      if (result === LOGIN_METHODS.INJECTED && window.ethereum) {
        const hasMultipleWallets = discoveredProviders.length > 1
        const hasMultipleProviders =
          Array.isArray(window.ethereum.providers) &&
          window.ethereum.providers.length > 1

        if (hasMultipleWallets || hasMultipleProviders) {
          try {
            await window.ethereum.request({
              method: 'wallet_requestPermissions',
              params: [{ eth_accounts: {} }],
            })
          } catch (permissionError) {
            // Some wallets might not support wallet_requestPermissions
          }
        }
      }

      const { getWaapAccount, switchWaapChain, getWaapChainId } = get()
      const address = await getWaapAccount()
      await switchWaapChain(L1_CHAIN_ID)
      const chainId = await getWaapChainId()

      const detectedProvider = get().getWaapWalletProvider()
      const walletProvider = getWalletProviderName(result, detectedProvider)
      const walletIcon = getEIP6963WalletIcon(address || '')

      const state = {
        waapAddress: address as `0x${string}` || null,
        waapChainId: chainId,
        isWaapConnected: !!address,
        waapError: null,
        waapLoginMethod: result,
        waapWalletProvider: walletProvider,
        waapWalletIcon: walletIcon,
      }

      set(state)

      logInfo('WaaP wallet connection completed', {
        walletType: WalletType.WAAP,
        loginMethod: result,
        walletProvider: walletProvider,
        address: address || '',
        chainId: chainId,
        userAction: 'waap_wallet_connection_completed',
      })
    } catch (err: any) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'

      if (errorMessage.includes('No Ethereum wallet extension detected')) {
        handleWaapError(
          err,
          'No Ethereum wallet extension found. Please install MetaMask or another Ethereum wallet to continue.',
          set
        )
      } else if (
        errorMessage.includes('rejected') ||
        errorMessage.includes('denied')
      ) {
        handleWaapError(
          err,
          'Ethereum wallet connection was rejected by user.',
          set
        )
      } else if (errorMessage.includes('install')) {
        handleWaapError(
          err,
          'Please install an Ethereum wallet extension to continue.',
          set
        )
      } else {
        handleWaapError(err, 'Failed to connect Ethereum wallet', set)
      }

      const { waapLoginMethod, waapWalletProvider, waapAddress, waapChainId } = get()
      logError('Failed to connect WaaP wallet', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: 'waap_wallet_connection_failure',
        error: err
      })

      const errorMessageForToast = err instanceof Error ? err.message : String(err)
      showToast('error', errorMessageForToast)

      throw err
    }
  },

  disconnectWaapWallet: async () => {
    try {
      const { waapLoginMethod, waapWalletProvider, waapAddress, waapChainId } = get()
      logInfo('WaaP wallet disconnection initiated', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: 'waap_wallet_disconnection_attempt',
      })

      await window.waap.logout()
    set({
        waapAddress: null,
        waapChainId: null,
        isWaapConnected: false,
        waapError: null,
        waapLoginMethod: null,
        waapWalletProvider: null,
        waapWalletIcon: null,
      })

      logInfo('WaaP wallet disconnected successfully', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: 'waap_wallet_disconnection_success',
      })
    } catch (err) {
      const { waapLoginMethod, waapWalletProvider, waapAddress, waapChainId } = get()
      logError('Failed to disconnect WaaP wallet', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: 'waap_wallet_disconnection_failure',
        error: err
      })
      showToast('error', 'Failed to disconnect Ethereum wallet')
    }
  },

  // Network management
  switchWaapChain: async (chainId: number) => {
    const chainIdHex = `0x${chainId.toString(16)}`

    try {
      await requestWaapWallet(WAAP_METHOD.wallet_switchEthereumChain, [
        { chainId: chainIdHex },
      ])
      set({ waapChainId: chainId })
    } catch (err: any) {
      if (err?.code === 4902 || err?.code === -32603 ||
          (err?.message && err.message.includes('Unrecognized chain ID'))) {
        try {
          await requestWaapWallet(WAAP_METHOD.wallet_addEthereumChain, [
            {
              chainId: chainIdHex,
              chainName: chainId === L1_CHAIN_ID ? 'Sepolia' : `Chain ${chainId}`,
              nativeCurrency: {
                name: 'ETH',
                symbol: 'ETH',
                decimals: 18,
              },
              rpcUrls: chainId === L1_CHAIN_ID ? [process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || 'https://sepolia.infura.io/'] : [],
              blockExplorerUrls: chainId === L1_CHAIN_ID ? ['https://sepolia.etherscan.io'] : [],
            },
          ])
          set({ waapChainId: chainId })
        } catch (addErr) {
          handleWaapError(addErr, 'Failed to add and switch to chain', set)
        }
      } else if (err?.code === 4001) {
        console.log('User rejected chain switch request')
      } else {
        handleWaapError(err, 'Failed to switch chain', set)
      }
    }
  },

  getWaapChainId: async () => {
    try {
      const chainId = await requestWaapWallet(WAAP_METHOD.eth_chainId)
      const chainIdNumber = parseInt(chainId as string, 16)
      set({ waapChainId: chainIdNumber })
      return chainIdNumber
    } catch (err) {
      return handleWaapError(err, 'Failed to get chain ID', set)
    }
  },

  // Account management
  getWaapAccount: async () => {
    try {
      const accounts = await requestWaapWallet(WAAP_METHOD.eth_requestAccounts)
      const address = (accounts as string[])[0]

      if (!address) {
        set({ waapAddress: null, isWaapConnected: false })
        return null
      }

      set({ waapAddress: address as `0x${string}`, isWaapConnected: !!address })
      return address
    } catch (err: any) {
      console.error('getWaapAccount: Error getting account:', err)

      if (err?.code === -32001) {
        console.log(
          'getWaapAccount: Wallet is already processing a connection request'
        )
        set({ waapAddress: null, isWaapConnected: false, waapError: null })
        return null
      }

      if (err?.code === 4001) {
        set({ waapAddress: null, isWaapConnected: false, waapError: null })
        return null
      }

      set({ waapAddress: null, isWaapConnected: false, waapError: null })
      return null
    }
  },

  signWaapMessage: async (message: string) => {
    try {
      const { waapAddress } = get()
      if (!waapAddress) {
        throw new Error('No wallet connected')
      }

      const signature = await requestWaapWallet(WAAP_METHOD.personal_sign, [
        message,
        waapAddress,
      ])
      return signature as string
    } catch (err) {
      return handleWaapError(
        err,
        'Failed to sign message with Ethereum wallet',
        set
      )
    }
  },

  // Wallet identification
  getWaapLoginMethod: async () => {
    try {
      if (typeof window !== 'undefined' && window.waap) {
        const loginMethod =
          (await window.waap.getLoginMethod()) as WaapLoginMethod

        set((state) => ({
          ...state,
          waapLoginMethod: loginMethod,
        }))

        return loginMethod
      }
      return null
    } catch (err) {
      return null
    }
  },

  getWaapWalletProvider: () => {
    try {
      if (typeof window === 'undefined') return null

      const { waapAddress } = get()
      if (!waapAddress) return null

      const eip6963Provider = getEIP6963Provider(waapAddress)
      if (eip6963Provider) {
        set({ waapWalletProvider: eip6963Provider })
        return eip6963Provider
      }

      if (window.ethereum) {
        const walletName = detectWalletByProvider(window.ethereum)
        set({ waapWalletProvider: walletName })
        return walletName
      }
      return null
    } catch (err) {
      console.error('Error detecting wallet provider:', err)
      return null
    }
  },

  getWaapWalletIcon: () => {
    try {
      if (typeof window === 'undefined') return null

      const { waapAddress, waapLoginMethod, waapWalletProvider } = get()
      if (!waapAddress) return null

      const walletIcon = getWalletIconByMethod(waapLoginMethod, waapWalletProvider, waapAddress)

      set({ waapWalletIcon: walletIcon })
      return walletIcon
    } catch (err) {
      console.error('Error getting wallet icon:', err)
      const fallbackIcon = '/assets/wallets/wally-dark.svg'
      set({ waapWalletIcon: fallbackIcon })
      return fallbackIcon
    }
  },

  getAllAvailableWallets: () => {
    try {
      if (typeof window === 'undefined') {
        return []
      }

      const availableWallets: string[] = []

      if (discoveredProviders.length > 0) {
        for (const { info } of discoveredProviders) {
          if (!availableWallets.includes(info.name)) {
            availableWallets.push(info.name)
          }
        }
        return availableWallets
      }

      if (window.ethereum) {
        const walletName = detectWalletByProvider(window.ethereum)
        availableWallets.push(walletName)
      }

      return availableWallets
    } catch (err) {
      console.error('Error getting all available wallets:', err)
      return []
    }
  },

  // Utility functions
  refreshWaapWalletInfo: async () => {
    try {
      const { getWaapLoginMethod, getWaapWalletProvider, getWaapWalletIcon } = get()

      await getWaapLoginMethod()
      getWaapWalletProvider()
      getWaapWalletIcon()

    } catch (err) {
      console.error('Error refreshing wallet info:', err)
    }
  },

  // ============================================================================
  // UTILITY ACTIONS
  // ============================================================================
  reset: () => {
    localStorage.removeItem(AZTEC_WALLET_KEY)
    set(initialState)
  },
}))

// ============================================================================
// EXPORTS
// ============================================================================

// Export main store with all state and actions
export const useWalletStore = () =>
  walletStore(
    useShallow((state) => ({
      // ============================================================================
      // UI STATE
      // ============================================================================
      showWalletModal: state.showWalletModal,
      showWalletInstallPrompt: state.showWalletInstallPrompt,

      // ============================================================================
      // AZTEC WALLET STATE
      // ============================================================================
      // Connection state
      aztecLoginMethod: state.aztecLoginMethod,
      aztecAddress: state.aztecAddress,
      aztecAccount: state.aztecAccount,
      isAztecConnected: state.isAztecConnected,
      isAztecConnecting: state.isAztecConnecting,
      aztecError: state.aztecError,

      // Wallet SDK instances
      sdkWallet: state.sdkWallet,

      // Wallet connection flow state
      walletConnectionPhase: state.walletConnectionPhase,
      verificationEmojis: state.verificationEmojis,
      discoveredWallets: state.discoveredWallets,

      // ============================================================================
      // WAAP WALLET STATE
      // ============================================================================
      // Connection state
      waapAddress: state.waapAddress,
      waapChainId: state.waapChainId,
      isWaapConnected: state.isWaapConnected,
      waapError: state.waapError,

      // Wallet identification
      waapLoginMethod: state.waapLoginMethod,
      waapWalletProvider: state.waapWalletProvider,
      waapWalletIcon: state.waapWalletIcon,

      // ============================================================================
      // UI ACTIONS
      // ============================================================================
      setShowWalletModal: state.setShowWalletModal,
      setShowWalletInstallPrompt: state.setShowWalletInstallPrompt,

      // ============================================================================
      // AZTEC WALLET ACTIONS
      // ============================================================================
      // State management
      setAztecLoginMethod: state.setAztecLoginMethod,
      setAztecState: state.setAztecState,

      // Connection management
      connectAztecWallet: state.connectAztecWallet,
      disconnectAztecWallet: state.disconnectAztecWallet,
      initializeAztecWallet: state.initializeAztecWallet,

      // Wallet SDK flow actions
      selectWallet: state.selectWallet,
      confirmWalletConnection: state.confirmWalletConnection,
      cancelWalletConnection: state.cancelWalletConnection,

      // ============================================================================
      // WAAP WALLET ACTIONS
      // ============================================================================
      // Initialization
      initializeWaapWallet: state.initializeWaapWallet,

      // Connection management
      connectWaapWallet: state.connectWaapWallet,
      disconnectWaapWallet: state.disconnectWaapWallet,

      // Network management
      switchWaapChain: state.switchWaapChain,
      getWaapChainId: state.getWaapChainId,

      // Account management
      getWaapAccount: state.getWaapAccount,
      signWaapMessage: state.signWaapMessage,

      // Wallet identification
      getWaapLoginMethod: state.getWaapLoginMethod,
      getWaapWalletProvider: state.getWaapWalletProvider,
      getWaapWalletIcon: state.getWaapWalletIcon,
      getAllAvailableWallets: state.getAllAvailableWallets,

      // Utility functions
      refreshWaapWalletInfo: state.refreshWaapWalletInfo,

      // ============================================================================
      // UTILITY ACTIONS
      // ============================================================================
      reset: state.reset,
    }))
  )

// Export the store directly for use with getState
export { walletStore }
