import { WaapLoginMethod, LOGIN_METHODS } from '@/types/wallet'

// EIP-6963 types
export interface EIP6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo
  provider: any
}

// EIP-6963 provider discovery
export const discoveredProviders: EIP6963ProviderDetail[] = []

// Listen for EIP-6963 provider announcements
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event: any) => {
    discoveredProviders.push(event.detail)
    // console.log('🔍 EIP-6963: Wallet announced:', {
    //   name: event.detail.info.name,
    //   rdns: event.detail.info.rdns,
    //   uuid: event.detail.info.uuid,
    //   icon: event.detail.info.icon,
    //   provider: event.detail.provider
    // })
    // console.log('📊 Total discovered providers:', discoveredProviders.length)
  })

  // Request providers to announce themselves (with delay to handle conflicts)
  setTimeout(() => {
    window.dispatchEvent(new Event('eip6963:requestProvider'))
  }, 1000)

  // Also send immediately in case some wallets are ready
  window.dispatchEvent(new Event('eip6963:requestProvider'))

  // Log initial state
  // console.log('🔍 Initial window.ethereum state:', {
  //   exists: !!window.ethereum,
  //   isArray: Array.isArray(window.ethereum),
  //   isMetaMask: window.ethereum?.isMetaMask,
  //   isRabby: window.ethereum?.isRabby,
  //   isBraveWallet: window.ethereum?.isBraveWallet,
  //   isCoinbaseWallet: window.ethereum?.isCoinbaseWallet,
  //   selectedAddress: window.ethereum?.selectedAddress,
  //   providers: window.ethereum?.providers
  // })

  // // Log the error we're seeing
  // console.log('⚠️ Multiple wallet conflict detected! This is why we need EIP-6963!')
  // console.log('🔍 Current window.ethereum is likely controlled by:',
  //   window.ethereum?.isRabby ? 'Rabby' :
  //   window.ethereum?.isMetaMask ? 'MetaMask' :
  //   window.ethereum?.isBraveWallet ? 'Brave Wallet' :
  //   'Unknown wallet'
  // )
}

// Helper function to detect wallet by provider properties
export const detectWalletByProvider = (provider: any): string => {
  if (!provider) return 'Injected Wallet'

  // Check for MetaMask (most common)
  if (provider.isMetaMask && !provider.isBraveWallet && !provider.isRabby) {
    return 'MetaMask'
  }

  // Check for Coinbase Wallet
  if (provider.isCoinbaseWallet) {
    return 'Coinbase Wallet'
  }

  // Check for Rabby (can override MetaMask)
  if (provider.isRabby) {
    return 'Rabby'
  }

  // Check for Brave Wallet (can override MetaMask)
  if (provider.isBraveWallet) {
    return 'Brave Wallet'
  }

  // Check for Trust Wallet
  if (provider.isTrust) {
    return 'Trust Wallet'
  }

  // Check for Opera Wallet
  if (provider.isOpera) {
    return 'Opera Wallet'
  }

  // Check for Rainbow Wallet
  if (provider.isRainbow) {
    return 'Rainbow Wallet'
  }

  // Check for Phantom (if it has Ethereum support)
  if (provider.isPhantom) {
    return 'Phantom'
  }

  // Check for other common wallets
  if (provider.isFrame) {
    return 'Frame'
  }

  if (provider.isTally) {
    return 'Tally'
  }

  if (provider.isTokenPocket) {
    return 'TokenPocket'
  }

  // Check for wallet name in provider info
  if (provider.providerInfo?.name) {
    return provider.providerInfo.name
  }

  return 'Injected Wallet'
}

// Helper function to get provider via EIP-6963
export const getEIP6963Provider = (address: string): string | null => {
  if (!address || discoveredProviders.length === 0) {
    console.log('⚠️ EIP-6963: No address or no providers found')
    return null
  }

  // Log all discovered providers
  // discoveredProviders.forEach(({ info, provider }, index) => {
  //   console.log(`🔍 EIP-6963 Provider ${index + 1}:`, {
  //     name: info.name,
  //     rdns: info.rdns,
  //     selectedAddress: provider.selectedAddress,
  //     isConnected: provider.isConnected,
  //     matches: provider.selectedAddress === address
  //   })
  // })

  // Find provider that has the connected address
  for (const { info, provider } of discoveredProviders) {
    if (provider.selectedAddress === address) {
      return info.name
    }
  }

  // If no exact match, return the first available provider
  if (discoveredProviders.length > 0) {
    return discoveredProviders[0].info.name
  }

  return null
}

// Helper function to get wallet icon via EIP-6963
export const getEIP6963WalletIcon = (address: string): string | null => {
  if (!address || discoveredProviders.length === 0) {
    return null
  }

  // Find provider that has the connected address
  for (const { info, provider } of discoveredProviders) {
    if (provider.selectedAddress === address) {
      return info.icon
    }
  }

  // If no exact match, return the first available provider's icon
  if (discoveredProviders.length > 0) {
    return discoveredProviders[0].info.icon
  }

  return null
}

// Helper function to get fallback wallet icon based on login method and provider
export const getWalletIconByMethod = (
  loginMethod: WaapLoginMethod | null,
  walletProvider: string | null,
  address?: string
): string => {
  if (loginMethod === LOGIN_METHODS.WALLETCONNECT) {
    return '/assets/wallets/wallet-connect-logo.svg'
  } else if (loginMethod === LOGIN_METHODS.WAAP) {
    return '/assets/wallets/wally-dark.svg' // WaaP/Human wallet logo
  } else if (loginMethod === LOGIN_METHODS.INJECTED) {
    // For injected wallets, try EIP-6963 discovery first
    if (address) {
      const eip6963Icon = getEIP6963WalletIcon(address)
      if (eip6963Icon) {
        return eip6963Icon
      }
    }
    
    // Fallback to provider-specific icons
    if (walletProvider) {
      const providerLower = walletProvider.toLowerCase()
      if (providerLower.includes('metamask')) {
        return '/assets/wallets/metamask-logo.svg'
      } else if (providerLower.includes('rabby')) {
        return '/assets/wallets/rabby-wallet.svg' // Rabby wallet logo
      } else if (providerLower.includes('coinbase')) {
        return '/assets/wallets/metamask-logo.svg' // Fallback to MetaMask icon
      } else if (providerLower.includes('brave')) {
        return '/assets/wallets/metamask-logo.svg' // Fallback to MetaMask icon
      }
    }
  }

  // Default fallback
  return '/assets/svg/silk-logo.svg'
}

// Utility function to determine wallet provider based on login method
export const getWalletProviderName = (
  loginMethod: WaapLoginMethod | null,
  injectedProvider: string | null
): string => {
  if (!loginMethod) return 'Unknown'

  switch (loginMethod) {
    case LOGIN_METHODS.WAAP:
      return 'Wallet as a Protocol'
    case LOGIN_METHODS.WALLETCONNECT:
      return 'WalletConnect'
    case LOGIN_METHODS.INJECTED:
      return injectedProvider || 'Injected Wallet'
    default:
      return 'Unknown'
  }
}

// Utility function for common error handling
export const handleWaapError = (err: unknown, message: string, set: any) => {
  console.error(message, err)
  
  let errorMessage = message
  if (err instanceof Error) {
    errorMessage = `${message}: ${err.message}`
  } else if (err && typeof err === 'object') {
    // Handle error objects with code and message properties
    const errorObj = err as any
    if (errorObj.code && errorObj.message) {
      errorMessage = `${message}: ${errorObj.message} (Code: ${errorObj.code})`
    } else if (errorObj.message) {
      errorMessage = `${message}: ${errorObj.message}`
    } else {
      errorMessage = `${message}: ${JSON.stringify(err)}`
    }
  } else {
    errorMessage = `${message}: ${String(err)}`
  }
  
  const error = new Error(errorMessage)
  set({ error })
  throw error
}
