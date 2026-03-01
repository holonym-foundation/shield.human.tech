/**
 * Custom hook for creating and using wallet adapters
 *
 * This hook simplifies wallet adapter usage by automatically creating
 * the appropriate adapter based on the connected wallet type.
 */

import { useWalletStore } from '@/stores/walletStore'
import { createWalletAdapter, type WalletContext } from '@/utils/walletAdapters'
import { useQuery } from '@tanstack/react-query'

/**
 * Hook to get a wallet adapter for the currently connected wallet
 *
 * @returns Wallet adapter instance or null if wallet not connected
 */
export function useWalletAdapter() {
  const {
    aztecLoginMethod,
    sdkWallet,
    aztecAccount,
  } = useWalletStore()

  const { data: adapter } = useQuery({
    queryKey: ['walletAdapter', aztecLoginMethod, !!sdkWallet, aztecAccount?.address?.toString()],
    queryFn: async () => {
      if (!aztecLoginMethod || !sdkWallet) {
        return null
      }

      const walletContext: WalletContext = {
        loginMethod: aztecLoginMethod,
        sdkWallet,
        aztecAccount: aztecAccount || null,
      }

      return await createWalletAdapter(walletContext)
    },
    enabled: !!aztecLoginMethod && !!sdkWallet,
    staleTime: Infinity, // Adapter doesn't change once created
    gcTime: Infinity, // Keep adapter in cache
  })

  return adapter ?? null
}
