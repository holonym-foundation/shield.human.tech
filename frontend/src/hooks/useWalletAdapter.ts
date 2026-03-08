import { useWalletStore } from '@/stores/walletStore'
import { createWalletAdapter, type WalletContext } from '@/utils/walletAdapters'
import { useQuery } from '@tanstack/react-query'

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
    staleTime: Infinity, // Adapter doesn't change within a single connection
    gcTime: 0, // Evict immediately when the query key changes (disconnect/reconnect)
  })

  return adapter ?? null
}
