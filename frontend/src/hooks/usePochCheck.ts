import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useWalletStore } from '@/stores/walletStore'

/**
 * Lightweight pre-check: does the current user have Proof of Clean Hands (POCH)?
 * Calls GET /api/attestation/poch/check which verifies via Holonym without
 * issuing an attestation or incrementing nonces.
 *
 * Only enabled when both wallets are connected (JWT is available).
 */
export function usePochCheck() {
  const { isWaapConnected, isAztecConnected, waapAddress } = useWalletStore()

  return useQuery({
    queryKey: ['pochCheck', waapAddress],
    queryFn: async () => {
      const res = await api.get('/api/attestation/poch/check')
      return res.data as { eligible: boolean; reason?: string }
    },
    enabled: isWaapConnected && isAztecConnected && !!waapAddress,
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
    retry: false,
  })
}
