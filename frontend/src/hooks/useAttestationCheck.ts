import { useQuery } from '@tanstack/react-query'
import { useWalletStore } from '@/stores/walletStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useBridge } from '@/hooks/useBridge'

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
 * Returns a unified result that the UI consumes to decide button labels,
 * amount limits, and error messages.
 *
 * Required for both public and private flows — the L1 TokenPortal and L2
 * TokenBridge contracts gate every deposit and exit on a POCH or Passport
 * attestation regardless of privacy mode.
 */
export function useAttestationCheck() {
  const { isWaapConnected, isAztecConnected, waapAddress } = useWalletStore()
  const token = useAuthStore((s) => s.token)
  const bridge = useBridge()

  return useQuery<AttestationCheckResult>({
    queryKey: ['attestationCheck', waapAddress],
    queryFn: async (): Promise<AttestationCheckResult> => {
      // Step 1: Try POCH
      try {
        const pochData = await bridge.checkPochEligibility()
        if (pochData.eligible) {
          return { eligible: true, method: 'poch' }
        }
      } catch (err: any) {
        console.warn('[attestationCheck] POCH check failed, trying Passport:', err?.message)
      }

      // Step 2: Try Passport
      try {
        const passportData = await bridge.checkPassportEligibility()
        if (passportData.eligible) {
          return {
            eligible: true,
            method: 'passport',
            passportScore: passportData.score,
            passportThreshold: passportData.threshold,
            passportMaxAmount: BigInt(passportData.maxAmount),
          }
        }

        return {
          eligible: false,
          method: null,
          reason: passportData.reason,
          passportScore: passportData.score,
          passportThreshold: passportData.threshold,
          passportMaxAmount: BigInt(passportData.maxAmount),
        }
      } catch (err: any) {
        const parsed = err?.parsedBody as { reason?: string; error?: string } | null | undefined
        const reason =
          parsed?.reason ?? parsed?.error ?? err?.body ?? err?.message ?? 'Failed to check attestation eligibility'
        return {
          eligible: false,
          method: null,
          reason,
        }
      }
    },
    enabled: isWaapConnected && isAztecConnected && !!waapAddress && !!token,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
