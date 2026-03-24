import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useWalletStore } from '@/stores/walletStore'
import {
  createSigningMessage,
  getKeyDerivationDomain,
  deriveEncryptionKey,
  decryptData,
} from '@/utils/encryption'
import type { BridgeActivityData } from '@/utils/encryption'
import { logInfo } from '@/utils/datadog'

/** Shape returned by GET /api/bridge/operations */
export interface BridgeOperation {
  id: string
  direction: string
  status: string
  amountL1: string | null
  amountL2: string | null
  amountDisplayL1: string | null
  amountDisplayL2: string | null
  tokenSymbolL1: string | null
  tokenSymbolL2: string | null
  l1TxHash: string | null
  l1TxUrl: string | null
  l2TxHash: string | null
  l2TxUrl: string | null
  // L1→L2 recovery fields
  messageHash: string | null
  messageLeafIndex: string | null
  l1BlockNumberBeforeTx: string | null
  // L1→L2 fuel recovery fields
  fuelMessageHash: string | null
  fuelMessageLeafIndex: string | null
  fuelAmount: string | null
  // L2→L1 recovery fields
  l2BlockNumber: string | null
  l2BlockNumberBeforeTx: string | null
  l2ToL1MessageIndex: string | null
  siblingPath: string[] | null
  epoch: number | null
  recipientL1Address: string | null
  // Recovery-critical contract & version snapshot
  rollupVersion: number | null
  chainIdL1: number | null
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  l1RollupAddress: string | null
  l1OutboxAddress: string | null
  // Token info
  tokenSymbol: string | null
  tokenAddressL1: string | null
  tokenAddressL2: string | null
  tokenDecimalsL1: number | null
  tokenDecimalsL2: number | null
  tokenNameL1: string | null
  tokenNameL2: string | null
  // Network names
  fromNetworkName: string | null
  toNetworkName: string | null
  // Additional contract snapshot
  chainIdL2: number | null
  l1InboxAddress: string | null
  l1RegistryAddress: string | null
  // Progress tracking
  currentStep: number | null
  // Common
  isPrivacyModeEnabled: boolean | null
  lastErrorMessage: string | null
  nodeInfo: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
  // Encrypted fields
  encryptedCiphertext: string | null
  encryptedIv: string | null
  encryptedTag: string | null
  keyDerivationMessage: string | null
  keyDerivationDomain: string | null
}

/**
 * Hook to fetch the authenticated user's bridge operations from the backend.
 * Returns raw operations (encrypted fields are NOT decrypted here).
 */
export function useBridgeOperations() {
  const { waapAddress: l1Address } = useWalletStore()

  return useQuery<BridgeOperation[]>({
    queryKey: ['bridgeOperations', l1Address],
    queryFn: async () => {
      const res = await api.get('/api/bridge/operations')
      return res.data.operations ?? []
    },
    enabled: !!l1Address,
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
  if (
    !operation.encryptedCiphertext ||
    !operation.encryptedIv ||
    !operation.encryptedTag
  ) {
    return null
  }

  const domain =
    operation.keyDerivationDomain ?? getKeyDerivationDomain()
  const signingMessage = createSigningMessage(l1Address)
  const signature = await signMessage(signingMessage)
  if (!signature) {
    throw new Error('Wallet signature required to decrypt operation data')
  }

  const key = await deriveEncryptionKey(l1Address, signature, domain)
  const plaintext = await decryptData(
    operation.encryptedCiphertext,
    operation.encryptedIv,
    operation.encryptedTag,
    key,
  )

  logInfo('bridge.decrypt_operation', {
    operationId: operation.id,
    direction: operation.direction,
    status: operation.status,
    l1Address,
    isPrivacyModeEnabled: operation.isPrivacyModeEnabled,
    tokenSymbol: operation.tokenSymbol,
    userAction: 'decrypt_operation_payload',
  })

  return JSON.parse(plaintext) as BridgeActivityData
}
