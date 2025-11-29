import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { AztecLoginMethod, WalletType, WaapLoginMethod, LOGIN_METHODS } from '@/types/wallet'
import { sdk, connectWallet } from '../aztec'
import { AzguardClient } from '@azguardwallet/client'
import { useAccount as useAztecAccount } from '@nemi-fi/wallet-sdk/react'
import { showToast } from '@/hooks/useToast'
import { sepolia } from 'wagmi/chains'
import { l1ChainId, silkConfig } from '@/config/l1.config'
import { initSilk, SILK_METHOD } from '@silk-wallet/silk-wallet-sdk'
import { logInfo, logError } from '@/utils/datadog'
import {
  discoveredProviders,
  detectWalletByProvider,
  getEIP6963Provider,
  getEIP6963WalletIcon,
  getWalletProviderName,
  handleWaapError,
  getWalletIconByMethod,
} from '@/stores/waapWalletHelpers'

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  interface Window {
    azguard?: any
    silk: any
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

const AZTEC_WALLET_KEY = 'aztecLoginMethod'

// ============================================================================
// INTERFACES
// ============================================================================

interface WalletState {
  // ============================================================================
  // UI STATE
  // ============================================================================
  showWalletModal: boolean
  showAzguardPrompt: boolean

  // ============================================================================
  // UI ACTIONS
  // ============================================================================
  setShowWalletModal: (show: boolean) => void
  setShowAzguardPrompt: (show: boolean) => void

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
  
  // Client instances
  azguardClient: AzguardClient | null

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
  connectAztecWallet: (type: AztecLoginMethod) => Promise<any>
  disconnectAztecWallet: () => Promise<void>
  
  // Transaction execution
  executeAztecTransaction: (actions: any[]) => Promise<string>

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

// WaaP wallet request function
export const requestWaapWallet = async (
  method: SILK_METHOD,
  params?: any[]
) => {
  return window.silk.request({ method, params })
}

// ============================================================================
// INITIAL STATE
// ============================================================================

const initialState = {
  // UI State
  showWalletModal: false,
  showAzguardPrompt: false,

  // Aztec Wallet State
  aztecLoginMethod: getInitialWalletType(),
  aztecAddress: null,
  aztecAccount: null,
  isAztecConnected: false,
  isAztecConnecting: false,
  aztecError: null,
  azguardClient: null,

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
  setShowAzguardPrompt: (show) => set({ showAzguardPrompt: show }),

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

  // Connection management
  connectAztecWallet: async (type: AztecLoginMethod) => {
    try {
      // Log wallet connection attempt
      logInfo('Aztec wallet connection initiated', {
        walletType: WalletType.AZTEC,
        loginMethod: type,
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_connection_attempt',
      })

      const connectedAccount = await connectWallet(type)

      // Update wallet type
      get().setAztecLoginMethod(type)

      // Update Aztec state
      get().setAztecState({
        address: connectedAccount?.address.toString() || null,
        account: connectedAccount,
        isConnected: !!connectedAccount,
      })

      // Close wallet modal
      set({ showWalletModal: false })

      // Log successful wallet connection
      logInfo('Aztec wallet connected successfully', {
        walletType: WalletType.AZTEC,
        loginMethod: type,
        address: connectedAccount?.address.toString() || '',
        chainId: null,
        userAction: 'aztec_wallet_connection_success',
      })

      return connectedAccount
    } catch (error) {
      // Log wallet connection failure
      logError('Failed to connect Aztec wallet', {
        walletType: WalletType.AZTEC,
        loginMethod: type,
        address: '',
        chainId: null,
        userAction: 'aztec_wallet_connection_failure',
        error: error instanceof Error ? error.message : 'Unknown error',
      })
      
      showToast(
        'error',
        `Failed to connect to ${type} wallet: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      )
      throw error
    }
  },

  disconnectAztecWallet: async () => {
    try {
      // Log disconnection attempt
      const { aztecAddress } = get()
      logInfo('Aztec wallet disconnection initiated', {
        walletType: WalletType.AZTEC,
        loginMethod: null,
        walletProvider: null,
        address: aztecAddress || '',
        chainId: null,
        userAction: 'aztec_wallet_disconnection_attempt',
      })

      await sdk.disconnect()
      set({
        azguardClient: null,
        aztecAddress: null,
        aztecAccount: null,
        isAztecConnected: false,
        aztecLoginMethod: null,
      })

      // Log successful disconnection
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

  // Transaction execution
  executeAztecTransaction: async (actions: any[]) => {
    const { aztecLoginMethod, azguardClient } = get()

    if (aztecLoginMethod === 'azguard' && azguardClient) {
      const results = await azguardClient.execute(actions)
      if (results.length > 0 && results[0].status === 'success') {
        return results[0].txHash
      } else {
        const error = new Error(
          `Transaction failed: ${results[0]?.error || 'Unknown error'}`
        )
        showToast('error', error.message)
        throw error
      }
    } else {
      const error = new Error(
        'Transaction execution not supported for this wallet type'
      )
      showToast('error', error.message)
      throw error
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
      initSilk(silkConfig)

      const { getWaapAccount, switchWaapChain, refreshWaapWalletInfo } = get()

      // Try to get initial account, but don't fail if it's not available
      const initialAccount = await getWaapAccount().catch((err) => {
        console.log(
          '⚠️ Initial account check failed (this is normal if wallet is not connected):',
          err
        )
        return null
      })

      // If wallet is already connected, refresh all wallet info
      if (initialAccount) {
        console.log('🔄 Wallet already connected, refreshing wallet info...')
        await refreshWaapWalletInfo()
      }

      // Set up event listeners
      window.silk.on('accountsChanged', async (accounts: string[]) => {
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

      window.silk.on('chainChanged', (chainId: string) => {
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

      const result = (await window.silk.login()) as WaapLoginMethod
      console.log('🚀MMM - ~ walletStore.ts ~ result:', result)

      // Check if login method is 'injected' but no wallet extension is available
      if (result === LOGIN_METHODS.INJECTED && !window.ethereum) {
        throw new Error(
          'No Ethereum wallet extension detected. Please install MetaMask or another Ethereum wallet.'
        )
      }

      // For injected wallets, force account selection if multiple wallets are available
      if (result === LOGIN_METHODS.INJECTED && window.ethereum) {
        // Check if we have multiple wallets via EIP-6963
        const hasMultipleWallets = discoveredProviders.length > 1

        // Also check for multiple wallets via window.ethereum.providers
        const hasMultipleProviders =
          Array.isArray(window.ethereum.providers) &&
          window.ethereum.providers.length > 1

        if (hasMultipleWallets || hasMultipleProviders) {
          try {
            // Force account selection popup
            await window.ethereum.request({
              method: 'wallet_requestPermissions',
              params: [{ eth_accounts: {} }],
            })
          } catch (permissionError) {
            // Some wallets might not support wallet_requestPermissions
            // This is expected and we should continue normally
          }
        }
      }

      const { getWaapAccount, switchWaapChain, getWaapChainId } = get()
      const address = await getWaapAccount()
      await switchWaapChain(l1ChainId)
      const chainId = await getWaapChainId()

      // Determine wallet provider based on login method
      const detectedProvider = get().getWaapWalletProvider()
      const walletProvider = getWalletProviderName(result, detectedProvider)

      // Get wallet icon from EIP-6963 if available
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

      // Log successful connection
      logInfo('WaaP wallet connection completed', {
        walletType: WalletType.WAAP,
        loginMethod: result,
        walletProvider: walletProvider,
        address: address || '',
        chainId: chainId,
        userAction: 'waap_wallet_connection_completed',
      })
    } catch (err: any) {
      // Provide more specific error messages based on the error type
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

      // Log connection failure
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

      // Show toast for both string and Error objects
      const errorMessageForToast = err instanceof Error ? err.message : String(err)
      showToast('error', errorMessageForToast)
      
      throw err
    }
  },

  disconnectWaapWallet: async () => {
    try {
      // Log disconnection attempt
      const { waapLoginMethod, waapWalletProvider, waapAddress, waapChainId } = get()
      logInfo('WaaP wallet disconnection initiated', {
        walletType: WalletType.WAAP,
        loginMethod: waapLoginMethod,
        walletProvider: waapWalletProvider,
        address: waapAddress || '',
        chainId: waapChainId,
        userAction: 'waap_wallet_disconnection_attempt',
      })
      
      await window.silk.logout()
    set({
        waapAddress: null,
        waapChainId: null,
        isWaapConnected: false,
        waapError: null,
        waapLoginMethod: null,
        waapWalletProvider: null,
        waapWalletIcon: null,
      })
      
      // Log successful disconnection
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
      await requestWaapWallet(SILK_METHOD.wallet_switchEthereumChain, [
        { chainId: chainIdHex },
      ])
      set({ waapChainId: chainId })
    } catch (err: any) {
      // Handle specific chain switching errors
      if (err?.code === 4902 || err?.code === -32603 || 
          (err?.message && err.message.includes('Unrecognized chain ID'))) {
        // Chain not added to wallet, try to add it
        try {
          await requestWaapWallet(SILK_METHOD.wallet_addEthereumChain, [
            {
              chainId: chainIdHex,
              chainName: chainId === 11155111 ? 'Sepolia' : `Chain ${chainId}`,
              nativeCurrency: {
                name: 'ETH',
                symbol: 'ETH',
                decimals: 18,
              },
              rpcUrls: chainId === 11155111 ? [process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL || 'https://sepolia.infura.io/'] : [],
              blockExplorerUrls: chainId === 11155111 ? ['https://sepolia.etherscan.io'] : [],
            },
          ])
          set({ waapChainId: chainId })
        } catch (addErr) {
          handleWaapError(addErr, 'Failed to add and switch to chain', set)
        }
      } else if (err?.code === 4001) {
        // User rejected the request
        console.log('User rejected chain switch request')
        // Don't throw error for user rejection, just log it
      } else {
        handleWaapError(err, 'Failed to switch chain', set)
      }
    }
  },

  getWaapChainId: async () => {
    try {
      const chainId = await requestWaapWallet(SILK_METHOD.eth_chainId)
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
      const accounts = await requestWaapWallet(SILK_METHOD.eth_requestAccounts)
      const address = (accounts as string[])[0]

      if (!address) {
        set({ waapAddress: null, isWaapConnected: false })
        return null
      }

      set({ waapAddress: address as `0x${string}`, isWaapConnected: !!address })
      return address
    } catch (err: any) {
      console.error('❌ getWaapAccount: Error getting account:', err)

      // Handle specific error cases gracefully
      if (err?.code === -32001) {
        console.log(
          '⚠️ getWaapAccount: Wallet is already processing a connection request'
        )
        set({ waapAddress: null, isWaapConnected: false, waapError: null })
        return null
      }

      if (err?.code === 4001) {
        console.log('⚠️ getWaapAccount: User rejected the connection request')
        set({ waapAddress: null, isWaapConnected: false, waapError: null })
        return null
      }

      // For other errors, still set disconnected state but don't throw
      console.log('⚠️ getWaapAccount: Setting disconnected state due to error')
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

      const signature = await requestWaapWallet(SILK_METHOD.personal_sign, [
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
      if (typeof window !== 'undefined' && window.silk) {
        const loginMethod =
          (await window.silk.getLoginMethod()) as WaapLoginMethod

        // Update state with login method
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

      // Get the current connected address to identify which wallet is active
      const { waapAddress } = get()
      if (!waapAddress) return null

      // Try EIP-6963 discovery first (most reliable)
      const eip6963Provider = getEIP6963Provider(waapAddress)
      if (eip6963Provider) {
        set({ waapWalletProvider: eip6963Provider })
        return eip6963Provider
      }

      // Fallback to window.ethereum detection
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

      // Get the current connected address to identify which wallet is active
      const { waapAddress, waapLoginMethod, waapWalletProvider } = get()
      if (!waapAddress) return null
      
      const walletIcon =   getWalletIconByMethod(waapLoginMethod, waapWalletProvider, waapAddress)

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

      // First, try EIP-6963 discovery (most reliable)
      if (discoveredProviders.length > 0) {
        for (const { info } of discoveredProviders) {
          if (!availableWallets.includes(info.name)) {
            availableWallets.push(info.name)
          }
        }
        return availableWallets
      }

      // Fallback to window.ethereum detection
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
      
      // Get login method
      await getWaapLoginMethod()
      
      // Get wallet provider (this will update state)
      getWaapWalletProvider()
      
      // Get wallet icon (this will update state)
      getWaapWalletIcon()
      
      console.log('✅ Wallet info refreshed successfully')
    } catch (err) {
      console.error('❌ Error refreshing wallet info:', err)
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
      showAzguardPrompt: state.showAzguardPrompt,

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
      
      // Client instances
      azguardClient: state.azguardClient,

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
      setShowAzguardPrompt: state.setShowAzguardPrompt,

      // ============================================================================
      // AZTEC WALLET ACTIONS
      // ============================================================================
      // State management
      setAztecLoginMethod: state.setAztecLoginMethod,
      setAztecState: state.setAztecState,
      
      // Connection management
      connectAztecWallet: state.connectAztecWallet,
      disconnectAztecWallet: state.disconnectAztecWallet,
      
      // Transaction execution
      executeAztecTransaction: state.executeAztecTransaction,

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