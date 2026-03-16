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
  const { data: adapter, error } = useQuery({
    // connectionGeneration busts the cache on each new connection, preventing
    // stale adapters (wrapping a disconnected wallet) from being reused.
    queryKey: ['walletAdapter', aztecLoginMethod, !!sdkWallet, accountAddress, connectionGeneration],
    queryFn: async () => {
      console.log('[DEBUG-WALLET] TODO remove after debugging — useWalletAdapter queryFn called:', { aztecLoginMethod, hasSdkWallet: !!sdkWallet, accountAddress, connectionGeneration }) // TODO remove after debugging
      if (!aztecLoginMethod || !sdkWallet) {
        console.log('[DEBUG-WALLET] TODO remove after debugging — useWalletAdapter: returning null (missing loginMethod or sdkWallet)') // TODO remove after debugging
        return null
      }

      const walletContext: WalletContext = {
        loginMethod: aztecLoginMethod,
        sdkWallet,
        aztecAccount: aztecAccount || null,
      }

      console.log('[DEBUG-WALLET] TODO remove after debugging — useWalletAdapter: creating adapter...') // TODO remove after debugging
      const result = await createWalletAdapter(walletContext)
      console.log('[DEBUG-WALLET] TODO remove after debugging — useWalletAdapter: adapter created:', !!result) // TODO remove after debugging
      return result
    },
    enabled: !!aztecLoginMethod && !!sdkWallet,
    staleTime: Infinity, // Adapter doesn't change within a single connection
    gcTime: 0, // Evict immediately when the query key changes (disconnect/reconnect)
  })

  if (error) {
    console.error('[DEBUG-WALLET] TODO remove after debugging — useWalletAdapter error:', error) // TODO remove after debugging
  }

  return adapter ?? null
}
