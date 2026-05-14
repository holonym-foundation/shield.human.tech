import { useToast } from '@/hooks/useToast'

export type L2ErrorType = 'BALANCE' | 'NODE' | 'CONTRACT' | 'TRANSACTION' | 'GENERAL'

function getDefaultValue<T>(type: L2ErrorType): T {
  switch (type) {
    case 'BALANCE':
      return { publicBalance: '0', privateBalance: '0' } as T
    case 'NODE':
      return 0 as T
    default:
      return null as T
  }
}

export const useL2ErrorHandler = () => {
  const notify = useToast()

  const handleError = <T>(error: unknown, type: L2ErrorType = 'GENERAL'): T => {
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            typeof (error as { message: unknown }).message === 'string'
          ? (error as { message: string }).message
          : typeof error === 'string'
            ? error
            : 'Unknown error'

    // Log the error for debugging
    console.error(`L2 ${type} Error:`, error)

    // Operation-specific messages
    const operationMessages = {
      BALANCE: 'Failed to load the balance',
      NODE: 'Failed to connect to the node',
      CONTRACT: 'Failed to interact with the contract',
      TRANSACTION: 'Failed to process the transaction',
      GENERAL: 'An error occurred',
    }

    let fullMessage = ''

    // Check for wallet disconnect errors — silently return defaults.
    // The disconnect handler in walletStore already shows a toast when
    // the disconnection is unexpected; showing it again per-query is noisy.
    const isWalletDisconnected = /wallet.*disconnect|disconnect.*wallet|backend.*disconnect/i.test(errorMessage)
    if (isWalletDisconnected) {
      return getDefaultValue<T>(type)
    }

    // Aztec wallet is locked — tell user to unlock it
    const isWalletLocked = /locked/i.test(errorMessage)
    if (isWalletLocked) {
      notify('warn', {
        heading: 'Aztec Wallet Locked',
        message: 'Your Aztec wallet is locked. Please open the Aztec wallet extension and unlock it to load your balances.',
      })
      return getDefaultValue<T>(type)
    }

    // Check for Aztec network / node errors (any node URL or Failed to fetch)
    const isNodeUnavailable =
      errorMessage.includes('500 from server') ||
      errorMessage.includes('Failed to fetch') ||
      /aztec.*\.(zkv\.xyz|aztec-labs\.com)/i.test(errorMessage)
    if (isNodeUnavailable) {
      fullMessage =
        'Unable to connect to Aztec network. The bridge service is temporarily unavailable. Please check back later.'
      fullMessage = `${operationMessages[type]} - ${fullMessage}`
    } else {
      fullMessage = `${operationMessages[type]} - ${errorMessage}`
    }

    notify('error', fullMessage)
    return getDefaultValue<T>(type)
  }

  return handleError
}
