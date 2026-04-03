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
    connectionGeneration,
  } = useWalletStore()

  const accountAddress = aztecAccount?.address?.toString() ?? null
  const { data: adapter } = useQuery({
    // connectionGeneration busts the cache on each new connection, preventing
    // stale adapters (wrapping a disconnected wallet) from being reused.
    queryKey: ['walletAdapter', aztecLoginMethod, !!sdkWallet, accountAddress, connectionGeneration],
    queryFn: async () => {
      if (!aztecLoginMethod || !sdkWallet) {
        return null
      }

      const walletContext: WalletContext = {
        loginMethod: aztecLoginMethod,
        sdkWallet,
        aztecAccount: aztecAccount || null,
      }

      const result = await createWalletAdapter(walletContext)
      return result
    },
    enabled: !!aztecLoginMethod && !!sdkWallet,
    staleTime: Infinity, // Adapter doesn't change within a single connection
    gcTime: 0, // Evict immediately when the query key changes (disconnect/reconnect)
  })

  return adapter ?? null
}
