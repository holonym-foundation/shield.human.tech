import { useQuery } from '@tanstack/react-query'
import { useWalletStore } from '@/stores/walletStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useBridge } from '@/hooks/useBridge'
import {
  decryptOperationPayload as sdkDecrypt,
} from '@human.tech/aztec-bridge-sdk'
import type { BridgeOperation, BridgeActivityData } from '@human.tech/aztec-bridge-sdk'
import { logInfo, DatadogUserAction } from '@/utils/datadog'

/**
 * Hook to fetch the authenticated user's bridge operations from the backend.
 * Returns raw operations (encrypted fields are NOT decrypted here).
 */
export function useBridgeOperations() {
  const { waapAddress: l1Address } = useWalletStore()
  const { token } = useAuthStore()
  const bridge = useBridge()

  return useQuery<BridgeOperation[]>({
    queryKey: ['bridgeOperations', l1Address],
    queryFn: async () => {
      return bridge.getOperations()
    },
    // Gate on both l1Address AND auth token to avoid 401 errors during
    // the window between wallet state restoration and JWT restoration.
    enabled: !!l1Address && !!token,
    refetchOnWindowFocus: true,
    staleTime: 30_000, // 30s
  })
}

/**
 * Decrypt an operation's encrypted payload using a wallet signature.
 *
 * The caller must provide a `signMessage` function (e.g. from `useWalletStore().signWaapMessage`).
 * The signing message is deterministic so the same wallet always produces the same key.
 *
 * @returns The decrypted claim data, or null if the operation has no encrypted payload.
 */
export async function decryptOperationPayload(
  operation: BridgeOperation,
  l1Address: string,
  signMessage: (msg: string) => Promise<string | null>,
): Promise<BridgeActivityData | null> {
  const domain = typeof window !== 'undefined' ? window.location.host : ''
  const result = await sdkDecrypt(
    operation,
    signMessage as (msg: string) => Promise<string>,
    domain,
    l1Address,
  )

  if (result) {
    logInfo('bridge.decrypt_operation', {
      operationId: operation.id,
      direction: operation.direction,
      status: operation.status,
      l1Address,
      isPrivacyModeEnabled: operation.isPrivacyModeEnabled,
      tokenSymbol: operation.tokenSymbol,
      userAction: DatadogUserAction.DECRYPT_OPERATION_PAYLOAD,
    })
  }

  return result
}
