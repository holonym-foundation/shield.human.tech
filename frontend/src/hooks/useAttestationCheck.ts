import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useAuthStore } from '@/stores/useAuthStore'

interface AttestationCheckResult {
  eligible: boolean
  method: 'poch' | 'passport' | null
  reason?: string
  passportScore?: number
  passportThreshold?: number
  passportMaxAmount?: bigint
}

/**
 * Cascading attestation check: POCH first, then Passport fallback.
 *
 * Replaces usePochCheck — returns a unified result that the UI consumes
 * to decide button labels, amount limits, and error messages.
 *
 * Only enabled when both wallets are connected and privacy mode is on.
 */
export function useAttestationCheck() {
  const { isWaapConnected, isAztecConnected, waapAddress } = useWalletStore()
  const { isPrivacyModeEnabled } = useBridgeStore()
  const token = useAuthStore((s) => s.token)

  return useQuery<AttestationCheckResult>({
    queryKey: ['attestationCheck', waapAddress],
    queryFn: async (): Promise<AttestationCheckResult> => {
      // Step 1: Try POCH
      try {
        const pochRes = await api.get('/api/attestation/poch/check')
        const pochData = pochRes.data as { eligible: boolean; reason?: string }
        if (pochData.eligible) {
          return { eligible: true, method: 'poch' }
        }
      } catch (err: any) {
        // POCH check failed — continue to Passport
        console.warn('[attestationCheck] POCH check failed, trying Passport:', err?.message)
      }

      // Step 2: Try Passport
      try {
        const passportRes = await api.get('/api/attestation/passport/check')
        const passportData = passportRes.data as {
          eligible: boolean
          score: number
          threshold: number
          maxAmount: string
          reason?: string
        }
        if (passportData.eligible) {
          return {
            eligible: true,
            method: 'passport',
            passportScore: passportData.score,
            passportThreshold: passportData.threshold,
            passportMaxAmount: BigInt(passportData.maxAmount),
          }
        }

        // Both failed — return Passport reason (more actionable than POCH reason)
        return {
          eligible: false,
          method: null,
          reason: passportData.reason,
          passportScore: passportData.score,
          passportThreshold: passportData.threshold,
          passportMaxAmount: BigInt(passportData.maxAmount),
        }
      } catch (err: any) {
        const reason = err?.response?.data?.reason
          || err?.response?.data?.error
          || err?.message
          || 'Failed to check attestation eligibility'
        return {
          eligible: false,
          method: null,
          reason,
        }
      }
    },
    enabled: isWaapConnected && isAztecConnected && !!waapAddress && isPrivacyModeEnabled && !!token,
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
    retry: false,
  })
}
