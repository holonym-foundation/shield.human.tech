import { L1_CHAIN_ID, L1_RPC_URL, ROLLUP_VERSION, L2_NETWORKS, versionScopedKey, publicAsset } from '@/config'
import { networkConfig, waapConfig } from '@/config/l1.config'
import { showToast } from '@/hooks/useToast'
import { dismissNotificationByKey, pushNotification } from '@/stores/useNotificationsStore'
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
import { extractErrorMessage, humanizeError, isWalletSchemaMismatch, walletVersionMismatchMessage } from '@/utils'
import { logError, logInfo, DatadogUserAction } from '@/utils/datadog'
import {
  discoverWallets,
  connectToProvider,
  hashToEmoji,
  type WalletProvider,
  type PendingConnection,
} from '@/utils/walletSdkConnection'
import { buildCapabilityManifest } from '@/utils/walletCapabilities'
import type { Wallet } from '@aztec-labs/aztec.js/wallet'
import type { DiscoverySession } from '@/utils/walletSdkConnection'
import { initWaaP } from '@human.tech/waap-sdk'
import { create } from 'zustand'

// Module-level state (not in Zustand — DiscoverySession is not serializable)
let activeDiscoverySession: DiscoverySession | null = null
let isDiscoveryInProgress = false
let isConfirmInProgress = false
// Set when the user explicitly submits a web-wallet URL via the discovery
// modal's "Connect" button. The matching web provider is then auto-selected the
// moment discovery surfaces it, so "Connect" actually connects rather than only
// re-probing and leaving the user to click the wallet a second time.
let autoSelectWebWallet = false

// In-memory session cache for the deterministic "Unlock My Secrets" signature.
// The signing message is fixed per (address, domain) — no nonce/timestamp — so
// re-signing yields the same signature and same derived encryption key. Caching
// it lets the wallet prompt ONCE per session instead of on every deposit /
// withdrawal / resume. Keyed by (lowercased address + exact message) so a cached
// signature is NEVER returned for a different address or a different message.
// NOT persisted — lives only for the tab session (never localStorage/logs) and is
// cleared on disconnect and account change.
const waapSignatureCache = new Map<string, string>()

function waapSignatureCacheKey(address: string, message: string): string {
  return `${address.toLowerCase()}${message}`
}

function clearWaapSignatureCache(): void {
  waapSignatureCache.clear()
}

// Normalize an Aztec chain-info field to a canonical decimal string so a wallet's
// Fr value can be compared against the app's config number/string. Aztec Fr
// exposes toBigInt() and stringifies to hex, while config carries a plain
// number, so comparing their raw toString() outputs would give false mismatches.
// Returns null when the value cannot be read, which the caller treats as
// "unknown" and skips (fail open) rather than a mismatch.
// The wrong-network check fails open, and until now a skip was only a console.warn —
// which Datadog does not forward (it forwards console.error only). So there was no way to
// know how often wallets connect unverified, which is exactly the blind spot behind #2065
// and #2295: the check has existed since 2026-07-22 yet both were reported after it. Logged
// at info level deliberately, so it is measurable without inflating error rates (#1817).
function logSkippedNetworkCheck(reason: string): void {
  logInfo('Aztec wrong-network check skipped', {
    walletType: WalletType.AZTEC,
    loginMethod: 'wallet-sdk',
    userAction: DatadogUserAction.AZTEC_WALLET_NETWORK_CHECK_SKIPPED,
    reason,
  })
}

function normalizeChainValue(value: unknown): string | null {
  if (value == null) return null
  const asBigInt = (value as { toBigInt?: () => bigint }).toBigInt
  if (typeof asBigInt === 'function') {
    try {
      return asBigInt.call(value).toString()
    } catch {
      /* fall through to other coercions */
    }
  }
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isFinite(value) ? BigInt(value).toString() : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    try {
      // Handles both 0x-hex (Fr.toString()) and decimal strings.
      return BigInt(trimmed).toString()
    } catch {
      return trimmed
    }
  }
  return null
}

declare global {
  interface Window {
    waap: any
    ethereum?: any
  }
}

const AZTEC_WALLET_KEY = versionScopedKey('aztecLoginMethod')
const WEB_WALLET_URL_KEY = versionScopedKey('aztecWebWalletUrl')

// Stable feed key for the "signature needed" alert (#417). The mini-bar ticker
// selects this key so the alert wins priority while a signature is pending, and
// the row is retired by key the instant the request resolves — so it never
// lingers on an idle bridge.
export const SIGNATURE_NEEDED_KEY = 'waap-signature-needed'

// Long enough to cover a wallet that only answers after the user unlocks it (Azguard asks for its
// password first); the modal shows its "not found" fast path after a few seconds regardless.
const DISCOVERY_TIMEOUT_MS = 3 * 60_000
// requestCapabilities waits on the wallet's own approval screen (often behind a PIN or password
// unlock), so it must outlast a human reviewing the request; a short timeout falls through to the
// getAccounts fallback, which wallets refuse without the accounts grant.
const CAPABILITIES_TIMEOUT_MS = 5 * 60_000
const DISCONNECT_GRACE_MS = 1000

export type WalletConnectionPhase =
  | 'idle'
  | 'discovering'
  | 'selecting'
  | 'verifying'
  | 'requesting' // requestCapabilities in progress
  | 'account-select' // user picks which account
  | 'connected'

interface WalletState {
  showWalletModal: boolean
  showWalletInstallPrompt: boolean

  setShowWalletModal: (show: boolean) => void
  setShowWalletInstallPrompt: (show: boolean) => void

  // Connection state
  aztecLoginMethod: AztecLoginMethod | null
  aztecAddress: string | null
  /** True only when the wallet positively reported the pinned Aztec network at connect.
   *  The check fails open, so false/absent means "unverified", not "wrong network". */
  aztecNetworkVerified: boolean
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

  // User-supplied web (iframe) wallet URL, probed alongside extension discovery.
  webWalletUrl: string

  // Account selection state
  aztecAlias: string | null
  availableAccounts: Array<{ alias: string; address: string; index: number }>

  // Connection generation counter — increments on each successful connection.
  // Used by useWalletAdapter to bust the React Query cache so a fresh adapter
  // is created for each connection (prevents stale adapter reuse after disconnect).
  connectionGeneration: number

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
  setWebWalletUrl: (url: string) => void
  startWalletDiscovery: () => Promise<void>
  selectWallet: (provider: WalletProvider) => Promise<void>
  confirmWalletConnection: () => Promise<any>
  cancelWalletConnection: () => void

  // Account selection actions
  selectAccount: (account: { alias: string; address: string; index?: number }) => Promise<void>
  switchAztecAccount: (account: { alias: string; address: string; index?: number }) => void

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

  // Anti-abandonment (#408/#417): set while a wallet signature/approval is being
  // requested and awaited; cleared the moment it resolves OR rejects. Drives the
  // sticky mini-bar ticker alert + the tab-title flip so a user who missed the
  // wallet popup is pulled back instead of silently abandoning the flow — never a
  // layout-pushing banner. `onReRequest`, when present, re-invokes the pending
  // wallet call.
  pendingSignature: { label: string; onReRequest?: () => void } | null
  setPendingSignature: (pending: { label: string; onReRequest?: () => void } | null) => void

  reset: () => void
}

const getInitialWalletType = (): AztecLoginMethod | null => {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem(AZTEC_WALLET_KEY)
  return stored ? (stored as AztecLoginMethod) : null
}

const getInitialWebWalletUrl = (): string => {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(WEB_WALLET_URL_KEY) ?? ''
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
  eth_signTypedData_v4: 'eth_signTypedData_v4',
} as const

export const requestWaapWallet = async (method: string, params?: any[]) => {
  return window.waap.request({ method, params })
}

const initialState = {
  // UI State
  showWalletModal: false,
  showWalletInstallPrompt: false,

  // Aztec Wallet State
  aztecLoginMethod: getInitialWalletType(),
  aztecAddress: null,
  aztecNetworkVerified: false,
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
  webWalletUrl: getInitialWebWalletUrl(),

  // Account selection state
  aztecAlias: null,
  availableAccounts: [],

  // Connection generation counter
  connectionGeneration: 0,

  // WaaP Wallet State
  waapAddress: null,
  waapChainId: null,
  isWaapConnected: false,
  waapError: null,
  waapLoginMethod: null,
  waapWalletProvider: null,
  waapWalletIcon: null,
  isWaapInitialized: false,

  // Anti-abandonment signal (#408) — no signature awaited at rest.
  pendingSignature: null,
}

const walletStore = create<WalletState>((set, get) => ({
  ...initialState,

  setShowWalletModal: (show) => set({ showWalletModal: show }),
  setShowWalletInstallPrompt: (show) => set({ showWalletInstallPrompt: show }),

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
    const storedWalletType = localStorage.getItem(AZTEC_WALLET_KEY) as AztecLoginMethod | null

    set({
      aztecAddress: state.address,
      aztecAccount: state.account,
      isAztecConnected: state.isConnected,
      aztecError: state.error || null,
      aztecLoginMethod: storedWalletType,
    })
  },

  // ─── Wallet SDK connection flow ────────────────────────────────────

  setWebWalletUrl: (url: string) => {
    const trimmed = url.trim()
    if (trimmed) {
      localStorage.setItem(WEB_WALLET_URL_KEY, trimmed)
    } else {
      localStorage.removeItem(WEB_WALLET_URL_KEY)
    }
    set({ webWalletUrl: trimmed })

    // A submitted URL is an explicit request to connect that web wallet, so
    // carry it through to a real connection once discovery finds it.
    autoSelectWebWallet = !!trimmed

    // Web wallet URLs are only read when discovery is configured, so an
    // in-flight discovery must be torn down and restarted to probe the new URL.
    if (activeDiscoverySession) {
      try {
        activeDiscoverySession.cancel()
      } catch {
        /* ignore */
      }
      activeDiscoverySession = null
    }
    isDiscoveryInProgress = false
    set({ discoveredWallets: [], showWalletInstallPrompt: false })
    void get().startWalletDiscovery()
  },

  startWalletDiscovery: async () => {
    if (isDiscoveryInProgress) return

    // Cancel any stale session
    if (activeDiscoverySession) {
      try {
        activeDiscoverySession.cancel()
      } catch {
        /* ignore */
      }
      activeDiscoverySession = null
    }

    isDiscoveryInProgress = true

    set({
      walletConnectionPhase: 'discovering',
      discoveredWallets: [],
      isAztecConnecting: true,
      // Starting (or re-running) discovery makes any prior "not found" state
      // stale. Clear it here so the install-prompt and the discovery modal can
      // never be mounted at the same time (#332).
      showWalletInstallPrompt: false,
    })
    logInfo('Aztec wallet discovery started', {
      walletType: WalletType.AZTEC,
      loginMethod: 'wallet-sdk',
      address: '',
      chainId: null,
      userAction: DatadogUserAction.AZTEC_WALLET_DISCOVERY_START,
    })

    const collectedWallets: Array<{ name: string; provider: WalletProvider }> = []

    const { webWalletUrl } = get()

    activeDiscoverySession = discoverWallets({
      timeout: DISCOVERY_TIMEOUT_MS,
      webWalletUrls: webWalletUrl ? [webWalletUrl] : [],
      onWalletDiscovered: (provider) => {
        const entry = { name: provider.name ?? 'Aztec Wallet', provider }
        collectedWallets.push(entry)
        set({ discoveredWallets: [...collectedWallets] })

        // Transition to 'selecting' on first wallet — user can click immediately
        const { walletConnectionPhase } = get()
        if (walletConnectionPhase === 'discovering') {
          set({ walletConnectionPhase: 'selecting' })
        }

        // The user submitted this web wallet's URL and clicked Connect. Advance
        // straight to verification the instant it appears, instead of making
        // them pick it out of the list again.
        if (autoSelectWebWallet && provider.type === 'web') {
          autoSelectWebWallet = false
          void get().selectWallet(provider)
        }
      },
    })

    // Don't block on discovery — let it run in the background.
    // selectWallet cancels the session once the user picks a wallet.
    // We only need to handle the "no wallets found" timeout case.
    const session = activeDiscoverySession
    session.done
      .catch(() => {
        /* cancelled or timed out — that's fine */
      })
      .finally(() => {
        // Only clean up if this is still the active session (not replaced by a new one)
        if (activeDiscoverySession === session) {
          isDiscoveryInProgress = false
          activeDiscoverySession = null
        }

        // If still in discovering/selecting phase and no wallets found, show install prompt
        const { walletConnectionPhase, discoveredWallets } = get()
        if (
          (walletConnectionPhase === 'discovering' || walletConnectionPhase === 'selecting') &&
          discoveredWallets.length === 0
        ) {
          set({
            walletConnectionPhase: 'idle',
            isAztecConnecting: false,
            showWalletInstallPrompt: true,
            showWalletModal: false,
          })
        }
      })
  },

  selectWallet: async (provider: WalletProvider) => {
    try {
      // Cancel discovery — user already picked a wallet, no need to wait
      if (activeDiscoverySession) {
        try {
          activeDiscoverySession.cancel()
        } catch {
          /* ignore */
        }
        activeDiscoverySession = null
        isDiscoveryInProgress = false
      }

      set({ walletConnectionPhase: 'verifying', isAztecConnecting: false })

      const pending = await connectToProvider(provider)

      const emojis = hashToEmoji(pending.verificationHash)

      set({
        pendingConnection: pending,
        verificationEmojis: emojis,
        sdkProvider: provider,
      })
    } catch (error) {
      const errorMessage = extractErrorMessage(error)
      logError('Failed to establish secure channel', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: DatadogUserAction.AZTEC_WALLET_CHANNEL_FAILED,
        error: errorMessage,
      })
      set({
        walletConnectionPhase: 'idle',
        isAztecConnecting: false,
        pendingConnection: null,
        verificationEmojis: null,
      })
      // Show a friendlier message for known errors
      const isTimeout = errorMessage.toLowerCase().includes('timeout')
      const userMessage = isTimeout
        ? 'Wallet took too long to respond. Please try connecting again.'
        : `Couldn't connect your wallet. ${humanizeError(error)}`
      showToast('error', userMessage)
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
      // Generous timeout — only fires when the connection is truly stuck.
      // Short timeouts interfere with the SDK's internal channel state,
      // but 60s is well above normal connection time.
      const wallet = await Promise.race([
        pendingConnection.confirm(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Wallet connection timed out after 60 seconds. Please try again.')),
            60_000,
          ),
        ),
      ])

      // Wrong-network guard. An Azguard wallet locked to a different Aztec
      // network connects fine here but every later tx fails with no
      // explanation. The wallet-sdk has no switch-network call and a connected
      // wallet is pinned to one network for the session, so the only fix is to
      // detect the mismatch now and prompt the user to switch and reconnect.
      // Fail open: any read error skips the check so a benign glitch never locks
      // out an otherwise valid wallet.
      try {
        const readChainInfo = (wallet as { getChainInfo?: () => Promise<{ chainId: unknown; version: unknown }> })
          .getChainInfo
        if (typeof readChainInfo === 'function') {
          // One retry: a single failed read leaves the wallet unverified for the whole
          // session, and creating a permanent AddressBinding then refuses until the user
          // reconnects. A brief blip right after the secure channel opens is the common case.
          const walletChainInfo = await readChainInfo.call(wallet).catch(async () => {
            await new Promise((r) => setTimeout(r, 500))
            return readChainInfo.call(wallet)
          })
          const walletVersion = normalizeChainValue(walletChainInfo?.version)
          const walletChainId = normalizeChainValue(walletChainInfo?.chainId)
          const expectedVersion = normalizeChainValue(ROLLUP_VERSION)
          const expectedChainId = normalizeChainValue(L1_CHAIN_ID)

          // version is the key discriminator between Aztec networks/deployments;
          // L1 chainId is checked too. Only compare fields we could read on both
          // sides. A null (unreadable) field is skipped, not treated as a miss.
          const versionMismatch =
            walletVersion != null && expectedVersion != null && walletVersion !== expectedVersion
          const chainIdMismatch =
            walletChainId != null && expectedChainId != null && walletChainId !== expectedChainId

          if (versionMismatch || chainIdMismatch) {
            const expectedNetworkName = L2_NETWORKS[0]?.title ?? 'the expected Aztec network'
            logError('Aztec wallet connected on wrong network', {
              walletType: WalletType.AZTEC,
              loginMethod: 'wallet-sdk',
              address: '',
              chainId: null,
              userAction: DatadogUserAction.AZTEC_WALLET_CONFIRM_FAILED,
              error: `wallet version=${walletVersion} chainId=${walletChainId} expected version=${expectedVersion} chainId=${expectedChainId}`,
            })

            // Abort cleanly. Tear down the secure channel and wipe wallet state
            // so no half-connected wrong-network wallet is left behind.
            const { sdkProvider: providerToTearDown } = get()
            if (providerToTearDown) {
              try {
                await providerToTearDown.disconnect()
              } catch {
                /* ignore teardown errors */
              }
            }
            set({
              walletConnectionPhase: 'idle',
              isAztecConnecting: false,
              pendingConnection: null,
              verificationEmojis: null,
              sdkProvider: null,
              sdkWallet: null,
            })
            showToast(
              'error',
              `Your Aztec wallet is on the wrong network. Switch Azguard to ${expectedNetworkName} and reconnect.`,
            )
            return
          }
          // Positively confirmed. Recorded because creating a permanent AddressBinding
          // requires it server-side: an address from a wallet that could not prove its
          // network must not be written into an irreversible link (#2065/#2295).
          // Only the rollup version tells Aztec networks apart; every testnet rollup shares
          // Sepolia's L1 chain id, so a readable chainId alone proves nothing.
          set({ aztecNetworkVerified: walletVersion != null })
        } else {
          console.warn('[walletStore] wallet.getChainInfo unavailable, skipping wrong-network check')
          logSkippedNetworkCheck('getChainInfo unavailable')
        }
      } catch (chainCheckErr) {
        console.warn('[walletStore] wrong-network check skipped (chain info read failed):', chainCheckErr)
        logSkippedNetworkCheck(
          `chain info read failed: ${chainCheckErr instanceof Error ? chainCheckErr.message : String(chainCheckErr)}`,
        )
      }

      // Transition to 'requesting' phase while we request capabilities
      set({
        walletConnectionPhase: 'requesting',
        pendingConnection: null,
        verificationEmojis: null,
      })

      // Account access is granted only through the accounts capability
      // (canGet) in the manifest; getAccounts is authorized as a side effect of
      // that grant. So capabilities must be requested first, and accounts read
      // from the grant. getAccounts is kept only as a fallback for wallets that
      // authorize it independently of the capability model.
      let rawAccounts: Array<{ item?: unknown; address?: unknown; alias?: string } | unknown> = []
      const manifest = buildCapabilityManifest()
      console.info(
        '[walletStore] requesting capabilities:',
        JSON.stringify(manifest.capabilities.map((c) => ({ type: c.type, canGet: (c as { canGet?: boolean }).canGet }))),
      )
      try {
        const capabilities = await Promise.race([
          wallet.requestCapabilities(manifest),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('requestCapabilities timed out')), CAPABILITIES_TIMEOUT_MS),
          ),
        ])
        console.info('[walletStore] requestCapabilities granted:', JSON.stringify(capabilities?.granted?.map((c: { type: string }) => c.type)), capabilities)
        const accountsCap = capabilities.granted.find((c: { type: string }) => c.type === 'accounts') as
          | {
              type: 'accounts'
              accounts: Array<{
                item?: unknown
                address?: unknown
                alias?: string
              }>
            }
          | undefined
        rawAccounts = accountsCap?.accounts ?? []
      } catch (capErr) {
        console.warn('[walletStore] requestCapabilities failed/timed out:', capErr)
      }

      if (rawAccounts.length === 0) {
        try {
          const directAccounts = await wallet.getAccounts()
          console.info('[walletStore] getAccounts fallback returned:', directAccounts?.length, directAccounts)
          rawAccounts = directAccounts ?? []
        } catch (accErr) {
          console.warn('[walletStore] getAccounts fallback failed:', accErr)
        }
      }

      if (!rawAccounts || rawAccounts.length === 0) {
        throw new Error('No accounts returned from wallet')
      }

      // Parse all accounts into { alias, address, index } objects. The `index`
      // is the account's original position in the wallet's list — retained so
      // the UI can render a stable "Account N" label even after the dropdown
      // filters out the currently-active account (which would otherwise renumber
      // a bare array-position fallback).
      const parsedAccounts = rawAccounts.map((raw, index) => {
        const obj = raw as Record<string, unknown> | undefined
        const aztecAddr = obj?.item ?? obj?.address ?? raw
        const address =
          typeof aztecAddr === 'string'
            ? aztecAddr
            : typeof (aztecAddr as { toString?: () => string })?.toString === 'function'
              ? (aztecAddr as { toString: () => string }).toString()
              : String(aztecAddr)
        // Extract alias from Aliased<T> wrapper or use empty string
        const rawAlias = typeof obj?.alias === 'string' ? obj.alias.trim() : ''
        // Treat generic placeholder names as empty so the UI falls back to a
        // stable "Account N" label (see accountLabel in useBindingStatus).
        const alias = rawAlias && rawAlias.toLowerCase() !== 'account' ? rawAlias : ''
        return { alias, address, index }
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
      const errorMessage = extractErrorMessage(error)
      console.error('[walletStore] confirmWalletConnection failed:', errorMessage)
      logError('Failed to confirm wallet connection', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: DatadogUserAction.AZTEC_WALLET_CONFIRM_FAILED,
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
        const networkName = L2_NETWORKS[0]?.title ?? 'this Aztec network'
        const userMessage = errorMessage.includes('missing account data')
          ? 'Wallet did not provide account data. This wallet may not be compatible. Try a different one.'
          : errorMessage.includes('No accounts returned from wallet')
            ? // A wallet keys its accounts by the network the app requests, so one built for
              // another Aztec version (or never used here) has none to return.
              `Your Aztec wallet has no account on ${networkName}. Create one in the wallet, or connect a wallet for ${networkName}.`
            : isWalletSchemaMismatch(error)
              ? walletVersionMismatchMessage(networkName)
              : `Couldn't confirm your wallet connection. ${humanizeError(error)}`
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
      try {
        activeDiscoverySession.cancel()
      } catch {
        /* ignore */
      }
      activeDiscoverySession = null
    }
    isDiscoveryInProgress = false
    isConfirmInProgress = false
    autoSelectWebWallet = false

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

      // Update all state — increment connectionGeneration so the adapter
      // cache (useWalletAdapter) is busted and a fresh adapter is created.
      // A discovery session can outlive the connection (e.g. a wallet that answers late after an
      // unlock); without this its picker or "not found" state stays mounted over the app.
      if (activeDiscoverySession) {
        try {
          activeDiscoverySession.cancel()
        } catch {
          /* already settled */
        }
        activeDiscoverySession = null
      }
      isDiscoveryInProgress = false
      set((prev) => ({
        walletConnectionPhase: 'connected' as const,
        isAztecConnecting: false,
        showWalletInstallPrompt: false,
        discoveredWallets: [],
        aztecAlias: account.alias,
        connectionGeneration: prev.connectionGeneration + 1,
      }))

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
        userAction: DatadogUserAction.AZTEC_WALLET_CONNECTION_SUCCESS,
      })
    } catch (error) {
      const errorMessage = extractErrorMessage(error)
      console.error('[walletStore] selectAccount failed:', errorMessage)
      logError('Failed to select account', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: DatadogUserAction.AZTEC_WALLET_CONNECTION_FAILURE,
        error: errorMessage,
      })
      set({
        walletConnectionPhase: 'idle',
        isAztecConnecting: false,
      })
      showToast('error', `Couldn't select that account. ${humanizeError(error)}`)
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
        userAction: DatadogUserAction.AZTEC_WALLET_CONNECTION_ATTEMPT,
      })

      // Start the wallet-sdk discovery flow
      await get().startWalletDiscovery()
    } catch (error) {
      const errorMessage = extractErrorMessage(error)
      logError('Failed to connect Aztec wallet', {
        walletType: WalletType.AZTEC,
        loginMethod: 'wallet-sdk',
        address: '',
        chainId: null,
        userAction: DatadogUserAction.AZTEC_WALLET_CONNECTION_FAILURE,
        error: errorMessage,
      })
      showToast('error', `Couldn't connect your Aztec wallet. ${humanizeError(error)}`)
      throw error
    }
  },

  initializeAztecWallet: async () => {},

  disconnectAztecWallet: async () => {
    try {
      const { aztecAddress, sdkProvider, aztecLoginMethod } = get()

      logInfo('Aztec wallet disconnection initiated', {
        walletType: WalletType.AZTEC,
        loginMethod: aztecLoginMethod || null,
        walletProvider: null,
        address: aztecAddress || '',
        chainId: null,
        userAction: DatadogUserAction.AZTEC_WALLET_DISCONNECTION_ATTEMPT,
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
        try {
          activeDiscoverySession.cancel()
        } catch {
          /* ignore */
        }
        activeDiscoverySession = null
      }
      isDiscoveryInProgress = false
      isConfirmInProgress = false
      autoSelectWebWallet = false

      set({
        sdkWallet: null,
        sdkProvider: null,
        aztecAddress: null,
        aztecNetworkVerified: false,
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
        userAction: DatadogUserAction.AZTEC_WALLET_DISCONNECTION_SUCCESS,
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
        userAction: DatadogUserAction.AZTEC_WALLET_DISCONNECTION_FAILURE,
        error,
      })

      showToast('error', `Couldn't disconnect your Aztec wallet. ${humanizeError(error)}`)
    }
  },

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
        // Address changed or disconnected — a cached signature/key must never
        // cross accounts, so drop the whole cache on any account change. Any
        // in-flight sign prompt is now stale, so retire the pending signal too.
        clearWaapSignatureCache()

        const isConnected = accounts.length > 0
        set({
          waapAddress: (accounts[0] as `0x${string}`) || null,
          isWaapConnected: isConnected,
          pendingSignature: null,
        })
        dismissNotificationByKey(SIGNATURE_NEEDED_KEY)

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
        userAction: DatadogUserAction.WAAP_WALLET_CONNECTION_ATTEMPT,
      })

      const result = (await window.waap.login()) as WaapLoginMethod

      // Check if login method is 'injected' but no wallet extension is available
      if (result === LOGIN_METHODS.INJECTED && !window.ethereum) {
        throw new Error('No Ethereum wallet extension detected. Please install MetaMask or another Ethereum wallet.')
      }

      // For injected wallets, force account selection if multiple wallets are available
      if (result === LOGIN_METHODS.INJECTED && window.ethereum) {
        const hasMultipleWallets = discoveredProviders.length > 1
        const hasMultipleProviders = Array.isArray(window.ethereum.providers) && window.ethereum.providers.length > 1

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
        waapAddress: (address as `0x${string}`) || null,
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
        userAction: DatadogUserAction.WAAP_WALLET_CONNECTION_COMPLETED,
      })
    } catch (err: any) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'

      if (errorMessage.includes('No Ethereum wallet extension detected')) {
        handleWaapError(
          err,
          'No Ethereum wallet extension found. Please install MetaMask or another Ethereum wallet to continue.',
          set,
        )
      } else if (errorMessage.includes('rejected') || errorMessage.includes('denied')) {
        handleWaapError(err, 'Ethereum wallet connection was rejected by user.', set)
      } else if (errorMessage.includes('install')) {
        handleWaapError(err, 'Please install an Ethereum wallet extension to continue.', set)
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
        userAction: DatadogUserAction.WAAP_WALLET_CONNECTION_FAILURE,
        error: err,
      })

      showToast('error', humanizeError(err))

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
        userAction: DatadogUserAction.WAAP_WALLET_DISCONNECTION_ATTEMPT,
      })

      await window.waap.logout()
      clearWaapSignatureCache()
      set({
        waapAddress: null,
        waapChainId: null,
        isWaapConnected: false,
        waapError: null,
        waapLoginMethod: null,
        waapWalletProvider: null,
        waapWalletIcon: null,
        pendingSignature: null,
      })
      dismissNotificationByKey(SIGNATURE_NEEDED_KEY)

      logInfo('WaaP wallet disconnected successfully', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: DatadogUserAction.WAAP_WALLET_DISCONNECTION_SUCCESS,
      })
    } catch (err) {
      const { waapLoginMethod, waapWalletProvider, waapAddress, waapChainId } = get()
      logError('Failed to disconnect WaaP wallet', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: DatadogUserAction.WAAP_WALLET_DISCONNECTION_FAILURE,
        error: err,
      })
      showToast('error', 'Failed to disconnect Ethereum wallet')
    }
  },

  // Network management
  switchWaapChain: async (chainId: number) => {
    const chainIdHex = `0x${chainId.toString(16)}`

    try {
      await requestWaapWallet(WAAP_METHOD.wallet_switchEthereumChain, [{ chainId: chainIdHex }])
      set({ waapChainId: chainId })
    } catch (err: any) {
      if (
        err?.code === 4902 ||
        err?.code === -32603 ||
        (err?.message && err.message.includes('Unrecognized chain ID'))
      ) {
        try {
          await requestWaapWallet(WAAP_METHOD.wallet_addEthereumChain, [
            {
              chainId: chainIdHex,
              chainName: chainId === L1_CHAIN_ID ? (networkConfig[L1_CHAIN_ID]?.name ?? 'Ethereum') : `Chain ${chainId}`,
              nativeCurrency: {
                name: 'ETH',
                symbol: 'ETH',
                decimals: 18,
              },
              rpcUrls: chainId === L1_CHAIN_ID ? [L1_RPC_URL || 'https://sepolia.infura.io/'] : [],
              blockExplorerUrls:
                chainId === L1_CHAIN_ID
                  ? [(networkConfig[L1_CHAIN_ID]?.blockExplorer ?? 'https://etherscan.io/').replace(/\/+$/, '')]
                  : [],
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

      set({
        waapAddress: address as `0x${string}`,
        isWaapConnected: !!address,
      })
      return address
    } catch (err) {
      console.error('getWaapAccount: Error getting account:', err)
      set({ waapAddress: null, isWaapConnected: false, waapError: null })
      return null
    }
  },

  setPendingSignature: (pending) => set({ pendingSignature: pending }),

  signWaapMessage: async (message: string) => {
    try {
      const { waapAddress } = get()
      if (!waapAddress) {
        throw new Error('No wallet connected')
      }

      // Deterministic message → cached signature is valid for this session.
      // A hit skips both the wallet popup and the "check your wallet" toast.
      const cacheKey = waapSignatureCacheKey(waapAddress, message)
      const cached = waapSignatureCache.get(cacheKey)
      if (cached) {
        return cached
      }

      const requestSignature = () => requestWaapWallet(WAAP_METHOD.personal_sign, [message, waapAddress])

      // The wallet signature popup is easy to miss; nudge the user to check it.
      // Stable toastId so rapid re-signs refresh in place instead of stacking.
      // feed:false — the keyed feed record below is the persistent entry, so the
      // toast must not also auto-mirror a duplicate generic row.
      // autoClose:false (#408 / T4): the required-signature toast stays until the
      // sign resolves or rejects (dismissed in the finally below), instead of
      // vanishing after a few seconds while the user is still in their wallet.
      showToast('info', 'Check your wallet. A signature is required to continue.', {
        toastId: 'waap-sign-request',
        autoClose: false,
        feed: false,
      })
      // Persistent, recoverable feed record (#417). Typed `warning` so it also
      // surfaces in the mini-bar ticker, and keyed so it collapses to one row and
      // is retired by key the instant the signature resolves. The Re-request
      // action re-opens the wallet popup straight from the Messages feed.
      pushNotification({
        type: 'warning',
        key: SIGNATURE_NEEDED_KEY,
        title: 'Signature needed. Check your wallet to continue.',
        action: {
          label: 'Re-request',
          onClick: () => {
            void requestSignature()
          },
        },
      })

      // Anti-abandonment signal (#408 / T1): drives the sticky ticker alert and
      // the tab-title flip while we await the wallet. onReRequest re-opens the
      // wallet request for a user who dismissed or missed the popup. Cleared in
      // the finally so it never outlives the await.
      set({
        pendingSignature: {
          label: 'Unlock My Secrets',
          onReRequest: () => {
            void requestSignature()
          },
        },
      })
      try {
        const signature = await requestSignature()
        waapSignatureCache.set(cacheKey, signature as string)
        return signature as string
      } finally {
        set({ pendingSignature: null })
        dismissNotificationByKey(SIGNATURE_NEEDED_KEY)
        showToast.dismiss('waap-sign-request')
      }
    } catch (err) {
      return handleWaapError(err, 'Failed to sign message with Ethereum wallet', set)
    }
  },

  // Wallet identification
  getWaapLoginMethod: async () => {
    try {
      if (typeof window !== 'undefined' && window.waap) {
        const loginMethod = (await window.waap.getLoginMethod()) as WaapLoginMethod

        set({ waapLoginMethod: loginMethod })

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
      const fallbackIcon = publicAsset('/assets/wallets/wally-dark.svg')
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

  reset: () => {
    localStorage.removeItem(AZTEC_WALLET_KEY)
    set(initialState)
  },
}))

export const useWalletStore = walletStore
export { walletStore }
