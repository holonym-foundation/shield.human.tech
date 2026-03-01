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
import { buildCapabilityManifest } from '@/utils/walletCapabilities'
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

/** How long to wait for wallet-sdk providers to respond during discovery. */
const DISCOVERY_TIMEOUT_MS = 5000
/** Grace period after first wallet discovered before resolving (allows additional wallets). */
const DISCOVERY_GRACE_MS = 1000
/** Hard fallback if no wallets respond within this window. */
const DISCOVERY_FALLBACK_MS = 6000
/** Grace period before treating a disconnect event as real (absorbs HMR false positives). */
const DISCONNECT_GRACE_MS = 1000

// ============================================================================
// WALLET CONNECTION PHASE
// ============================================================================

export type WalletConnectionPhase =
  | 'idle'
  | 'discovering'
  | 'selecting'
  | 'verifying'
  | 'requesting'       // requestCapabilities in progress
  | 'account-select'   // user picks which account
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

  // Account selection state
  aztecAlias: string | null
  availableAccounts: Array<{ alias: string; address: string }>

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

  // Account selection actions
  selectAccount: (account: { alias: string; address: string }) => Promise<void>
  switchAztecAccount: (account: { alias: string; address: string }) => void

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

  // Account selection state
  aztecAlias: null,
  availableAccounts: [],

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
        timeout: DISCOVERY_TIMEOUT_MS,
        onWalletDiscovered: (provider) => {
          const entry = { name: provider.name ?? 'Aztec Wallet', provider }
          collectedWallets.push(entry)
          set({ discoveredWallets: [...collectedWallets] })

          if (graceTimer) clearTimeout(graceTimer)
          graceTimer = setTimeout(() => {
            resolve(collectedWallets.map((w) => w.provider))
          }, DISCOVERY_GRACE_MS)
        },
      })

      // Fallback: if no wallets respond within the timeout, resolve empty
      setTimeout(() => {
        if (graceTimer) clearTimeout(graceTimer)
        resolve(collectedWallets.map((w) => w.provider))
      }, DISCOVERY_FALLBACK_MS)
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
      // Await confirm() directly — no timeout. The timeout interferes with
      // the SDK's internal channel state. User can cancel manually if needed.
      const wallet = await pendingConnection.confirm()

      // Transition to 'requesting' phase while we request capabilities
      set({
        walletConnectionPhase: 'requesting',
        pendingConnection: null,
        verificationEmojis: null,
      })

      // Request scoped capabilities (preferred flow for external wallets).
      // This shows a single comprehensive dialog where the user selects
      // accounts AND grants permissions for simulations/transactions.
      // Fall back to getAccounts if requestCapabilities is not supported.
      let rawAccounts: Array<{ item?: unknown; address?: unknown; alias?: string } | unknown> = []
      try {
        const capabilities = await wallet.requestCapabilities(buildCapabilityManifest())
        const accountsCap = capabilities.granted.find(
          (c: { type: string }) => c.type === 'accounts'
        ) as { type: 'accounts'; accounts: Array<{ item?: unknown; address?: unknown; alias?: string }> } | undefined
        rawAccounts = accountsCap?.accounts ?? []
      } catch (capErr) {
        console.warn('[walletStore] requestCapabilities failed, falling back to getAccounts:', capErr)
      }

      // Fall back to getAccounts if requestCapabilities didn't yield accounts
      if (rawAccounts.length === 0) {
        const fallbackAccounts = await wallet.getAccounts()
        rawAccounts = fallbackAccounts ?? []
      }

      if (!rawAccounts || rawAccounts.length === 0) {
        throw new Error('No accounts returned from wallet')
      }

      // Parse all accounts into { alias, address } objects
      const parsedAccounts = rawAccounts.map((raw) => {
        const obj = raw as Record<string, unknown> | undefined
        const aztecAddr = obj?.item ?? obj?.address ?? raw
        const address = typeof aztecAddr === 'string'
          ? aztecAddr
          : typeof (aztecAddr as { toString?: () => string })?.toString === 'function'
            ? (aztecAddr as { toString: () => string }).toString()
            : String(aztecAddr)
        // Extract alias from Aliased<T> wrapper or use empty string
        const alias = (typeof obj?.alias === 'string' ? obj.alias : '') || ''
        return { alias, address }
      })

      // Set up disconnect handler with grace period to absorb spurious
      // disconnects caused by HMR / Fast Refresh / soft navigations.
      sdkProvider.onDisconnect(() => {
        setTimeout(() => {
          const { sdkProvider: currentProvider } = get()
          if (currentProvider?.isDisconnected?.()) {
            console.warn('[walletStore] Wallet disconnected by extension')
            showToast('warn', 'Aztec wallet disconnected. Please reconnect to continue.')
            get().disconnectAztecWallet()
          }
        }, DISCONNECT_GRACE_MS)
      })

      // Store wallet and available accounts
      set({
        sdkWallet: wallet,
        availableAccounts: parsedAccounts,
        isAztecConnecting: false,
      })

      if (parsedAccounts.length === 1) {
        // Single account — auto-select, no extra modal
        await get().selectAccount(parsedAccounts[0])
      } else {
        // Multiple accounts — show account selector modal
        set({ walletConnectionPhase: 'account-select' })
      }
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
        // Provide a more helpful message for known wallet extension errors
        const userMessage = errorMessage.includes('missing account data')
          ? 'Wallet did not provide account data. This wallet may not be compatible — try a different one.'
          : `Failed to confirm connection: ${errorMessage}`
        showToast('error', userMessage)
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

  // ─── Account selection ───────────────────────────────────────────────

  selectAccount: async (account: { alias: string; address: string }) => {
    const { sdkWallet } = get()
    if (!sdkWallet) {
      console.error('[walletStore] selectAccount: sdkWallet is null')
      return
    }

    try {
      // Import aztecNode for L1 contract addresses
      const { aztecNode } = await import('../aztec')

      // Create an account-like object for compatibility with existing code
      const connectedAccount = {
        address: { toString: () => account.address },
        sdkWallet,
        aztecNode,
      }

      // Update all state
      set({
        walletConnectionPhase: 'connected',
        isAztecConnecting: false,
        aztecAlias: account.alias,
      })

      get().setAztecLoginMethod('wallet-sdk')
      get().setAztecState({
        address: account.address,
        account: connectedAccount,
        isConnected: true,
      })
      set({ showWalletModal: false })

      logInfo('Aztec wallet connected successfully via wallet-sdk', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: account.address,
        chainId: null,
        userAction: 'aztec_wallet_connection_success',
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error('[walletStore] selectAccount failed:', errorMessage)
      set({
        walletConnectionPhase: 'idle',
        isAztecConnecting: false,
      })
      showToast('error', `Failed to select account: ${errorMessage}`)
    }
  },

  switchAztecAccount: (account: { alias: string; address: string }) => {
    const { sdkWallet, aztecAccount } = get()
    if (!sdkWallet) return

    // Reuse the existing aztecNode from the current connectedAccount
    const existingNode = aztecAccount?.aztecNode

    const connectedAccount = {
      address: { toString: () => account.address },
      sdkWallet,
      aztecNode: existingNode,
    }

    set({
      aztecAddress: account.address,
      aztecAlias: account.alias,
      aztecAccount: connectedAccount,
    })

    // No need to re-verify or re-request capabilities — Wallet session persists.
    // useWalletAdapter queryKey includes accountAddress, so changing aztecAccount
    // auto-invalidates the adapter cache and triggers a rebuild.
  },

  // ─── Connection management (public API) ────────────────────────────

  connectAztecWallet: async (_type?: AztecLoginMethod) => {
    // Guard: don't start if already in a connection flow
    const { walletConnectionPhase } = get()
    if (walletConnectionPhase !== 'idle') {
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
        aztecAlias: null,
        availableAccounts: [],
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
      const initialAccount = await getWaapAccount().catch(() => null)

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
        // User rejected chain switch — no action needed
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

      // Account selection
      aztecAlias: state.aztecAlias,
      availableAccounts: state.availableAccounts,
      selectAccount: state.selectAccount,
      switchAztecAccount: state.switchAztecAccount,

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
