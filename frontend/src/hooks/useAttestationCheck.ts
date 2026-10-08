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
  // Alpha deposit cap (L1→L2 only). undefined when the cap is disabled.
  depositLimitReached?: boolean
  remainingDepositUsd?: number
  // Travel Rule: passport tier blocked because lifetime volume reached the threshold.
  travelRuleExceeded?: boolean
  // Travel Rule: USD budget left before the threshold (undefined = disabled). Lets the UI
  // pre-block a deposit that would cross, before the user submits.
  travelRuleRemainingUsd?: number
  // USD held by an outstanding attestation reservation (already netted out of the remaining
  // budgets above). Present only when > 0 — a block carrying it is a temporary hold, not a
  // permanent cap, so the UI can say "retry once your pending deposit confirms".
  reservedDepositUsd?: number
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
  const { isWaapConnected, isAztecConnected, waapAddress, aztecAddress } = useWalletStore()
  const token = useAuthStore((s) => s.token)
  const bridge = useBridge()

  return useQuery<AttestationCheckResult>({
    // Keyed on BOTH addresses. The server checks eligibility for the (L1, L2) pair —
    // address binding in particular is a property of the pair, not of the L1 wallet — so
    // keying on waapAddress alone served a stale verdict for `staleTime` (5 min) after the
    // user switched Aztec accounts. That is #2065's "switching the Aztec account does not
    // clear it": a user who reconnected the correct account still saw the binding error.
    queryKey: ['attestationCheck', waapAddress, aztecAddress],
    queryFn: async (): Promise<AttestationCheckResult> => {
      // Step 1: Try POCH
      try {
        const pochData = await bridge.checkPochEligibility()
        if (pochData.eligible) {
          return {
            eligible: true,
            method: 'poch',
            depositLimitReached: pochData.depositLimitReached,
            remainingDepositUsd: pochData.remainingUsd,
          }
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
            depositLimitReached: passportData.depositLimitReached,
            remainingDepositUsd: passportData.remainingUsd,
            travelRuleRemainingUsd: passportData.travelRuleRemainingUsd,
            reservedDepositUsd: passportData.reservedUsd,
          }
        }

        return {
          eligible: false,
          method: null,
          reason: passportData.reason,
          passportScore: passportData.score,
          passportThreshold: passportData.threshold,
          passportMaxAmount: BigInt(passportData.maxAmount),
          depositLimitReached: passportData.depositLimitReached,
          remainingDepositUsd: passportData.remainingUsd,
          travelRuleExceeded: passportData.travelRuleExceeded,
          travelRuleRemainingUsd: passportData.travelRuleRemainingUsd,
          reservedDepositUsd: passportData.reservedUsd,
        }
      } catch (err: any) {
        // Prefer the server's own human-readable reason; never surface a raw
        // error body/message (can be technical or a full HTML error page).
        const parsed = err?.parsedBody as { reason?: string; error?: string } | null | undefined
        const reason =
          parsed?.reason ?? parsed?.error ?? 'We could not check your verification status. Please try again.'
        console.warn('[attestationCheck] eligibility check failed:', err?.message ?? err)
        return {
          eligible: false,
          method: null,
          reason,
        }
      }
    },
    enabled: isWaapConnected && isAztecConnected && !!waapAddress && !!aztecAddress && !!token,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
