import { useQuery } from '@tanstack/react-query'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useBridge } from '@/hooks/useBridge'

/**
 * Lightweight pre-check: does the current user have Proof of Clean Hands (POCH)?
 * Does not issue an attestation or increment nonces.
 *
 * Only enabled when both wallets are connected and privacy mode is on.
 */
export function usePochCheck() {
  const { isWaapConnected, isAztecConnected, waapAddress } = useWalletStore()
  const { isPrivacyModeEnabled } = useBridgeStore()
  const token = useAuthStore((s) => s.token)
  const bridge = useBridge()

  return useQuery({
    queryKey: ['pochCheck', waapAddress],
    queryFn: async () => {
      try {
        return await bridge.checkPochEligibility()
      } catch (err: any) {
        const parsed = err?.parsedBody as { reason?: string; error?: string } | null | undefined
        const reason =
          parsed?.reason ?? parsed?.error ?? err?.body ?? err?.message ?? 'Failed to check POCH eligibility'
        return { eligible: false, reason } as { eligible: boolean; reason?: string }
      }
    },
    enabled: isWaapConnected && isAztecConnected && !!waapAddress && isPrivacyModeEnabled && !!token,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
