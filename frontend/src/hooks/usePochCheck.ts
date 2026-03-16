import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'

/**
 * Lightweight pre-check: does the current user have Proof of Clean Hands (POCH)?
 * Calls GET /api/attestation/poch/check which verifies via Holonym without
 * issuing an attestation or incrementing nonces.
 *
 * Only enabled when both wallets are connected and privacy mode is on.
 */
export function usePochCheck() {
  const { isWaapConnected, isAztecConnected, waapAddress } = useWalletStore()
  const { isPrivacyModeEnabled } = useBridgeStore()

  return useQuery({
    queryKey: ['pochCheck', waapAddress],
    queryFn: async () => {
      try {
        const res = await api.get('/api/attestation/poch/check')
        return res.data as { eligible: boolean; reason?: string }
      } catch (err: any) {
        // Surface API errors as ineligible with a reason rather than letting the query fail silently
        const reason = err?.response?.data?.reason
          || err?.response?.data?.error
          || err?.message
          || 'Failed to check POCH eligibility'
        return { eligible: false, reason } as { eligible: boolean; reason?: string }
      }
    },
    enabled: isWaapConnected && isAztecConnected && !!waapAddress && isPrivacyModeEnabled,
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
    retry: false,
  })
}
