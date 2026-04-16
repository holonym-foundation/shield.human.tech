import { BridgeDirection } from '@prisma/client'
import { createSigningMessage, deriveEncryptionKey, decryptData } from '@human.tech/aztec-bridge-sdk'

// Frontend-only anti-phishing guard: only prompt for encryption signatures on our domain.
// This is NOT an SDK concern — the SDK is domain-agnostic.
const ALLOWED_ENCRYPTION_DOMAIN = 'https://bridge.human.tech'

function isDevelopmentOrigin(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1'
}

/**
 * Verify the current page origin is allowed for encryption key derivation.
 * Prevents phishing sites from tricking users into signing key-derivation messages.
 * Must be called in the frontend before any signMessage used for encryption.
 */
export function verifyEncryptionDomain(): void {
  if (typeof window === 'undefined') return // SSR — skip
  const origin = window.location.origin
  if (origin === ALLOWED_ENCRYPTION_DOMAIN || isDevelopmentOrigin()) return
  throw new Error(
    `Security Error: Encryption key derivation is only allowed on ${ALLOWED_ENCRYPTION_DOMAIN}. ` +
    `Current origin: ${origin}. Please access the bridge at ${ALLOWED_ENCRYPTION_DOMAIN}`,
  )
}

export const truncateDecimals = (value: number | string, decimals = 6): number => {
  const [integerPart, decimalPart] = value.toString().split('.')

  return parseFloat(`${integerPart}.${decimalPart?.slice(0, decimals) || '0000'}`)
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Extract a human-readable error message from any thrown value.
 * Handles Error instances, wallet provider objects (plain { message, code } objects),
 * and falls back to String() for primitives.
 */
export function extractErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  if (typeof error === 'string') return error
  return fallback
}

/**
 * Serialize Aztec NodeInfo to a plain JSON-serializable object for storage/export.
 * Converts address-like values (EthAddress, etc.) to string.
 */
export function serializeNodeInfo(
  nodeInfo:
    | {
        nodeVersion?: string
        l1ChainId?: number
        rollupVersion?: number
        enr?: string
        l1ContractAddresses?: Record<string, unknown>
        protocolContractAddresses?: Record<string, unknown>
      }
    | null
    | undefined,
): Record<string, unknown> | null {
  if (nodeInfo == null) return null
  const toPlain = (obj: unknown): unknown => {
    if (obj == null) return obj
    if (
      typeof obj === 'object' &&
      obj !== null &&
      'toString' in obj &&
      typeof (obj as { toString: () => string }).toString === 'function'
    ) {
      const s = (obj as { toString: () => string }).toString()
      if (s && s !== '[object Object]') return s
    }
    if (Array.isArray(obj)) return obj.map(toPlain)
    if (typeof obj === 'object' && obj !== null) {
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, toPlain(v)]))
    }
    return obj
  }
  return {
    nodeVersion: nodeInfo.nodeVersion,
    l1ChainId: nodeInfo.l1ChainId,
    rollupVersion: nodeInfo.rollupVersion,
    enr: nodeInfo.enr,
    l1ContractAddresses:
      nodeInfo.l1ContractAddresses != null
        ? (toPlain(nodeInfo.l1ContractAddresses) as Record<string, unknown>)
        : undefined,
    protocolContractAddresses:
      nodeInfo.protocolContractAddresses != null
        ? (toPlain(nodeInfo.protocolContractAddresses) as Record<string, unknown>)
        : undefined,
  } as Record<string, unknown>
}

/**
 * Export data as JSON file for backup
 */
export const exportToJsonFile = (data: any, filename: string) => {
  const jsonString = JSON.stringify(data, null, 2)
  const blob = new Blob([jsonString], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/**
 * Copy text to clipboard
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (err) {
    // Fallback for older browsers
    try {
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.left = '-999999px'
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      const successful = document.execCommand('copy')
      document.body.removeChild(textArea)
      return successful
    } catch (err) {
      console.error('Failed to copy to clipboard:', err)
      return false
    }
  }
}

/**
 * Decrypt a field from an encrypted localStorage entry.
 * Shared by copyClaimSecret (L1→L2) and copyNonce (L2→L1).
 */
export async function decryptStorageEntry(
  storageKey: string,
  entryId: string,
  fieldName: string,
  signMessage: (message: string, address: string) => Promise<string>,
): Promise<{ value: string; entry: any } | null> {
  // Verify encryption domain before prompting for signature
  verifyEncryptionDomain()

  const raw = localStorage.getItem(storageKey)
  if (!raw) return null

  // Wrap JSON.parse in try/catch for malformed localStorage data
  let entries: any[]
  try {
    entries = JSON.parse(raw)
  } catch {
    return null
  }
  const entry = entries.find((e: any) => e.id === entryId)
  if (!entry?.encryptedCiphertext) return null

  const signingMessage = createSigningMessage(entry.l1Address, entry.keyDerivationDomain)
  const signature = await signMessage(signingMessage, entry.l1Address)
  const encryptionKey = await deriveEncryptionKey(entry.l1Address, signature, entry.keyDerivationDomain)
  const decrypted = JSON.parse(
    await decryptData(entry.encryptedCiphertext, entry.encryptedIv, entry.encryptedTag, encryptionKey)
  )

  const value = decrypted[fieldName]
  if (!value) return null

  return { value, entry }
}

/**
 * Export L1→L2 claim data for backup
 */
export const exportClaimData = (claimData: any) => {
  const exportData = {
    type: BridgeDirection.L1_TO_L2,
    timestamp: new Date().toISOString(),
    warning:
      '⚠️ CRITICAL: Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
    data: {
      id: claimData.id,
      claimSecretHash: claimData.claimSecretHash,
      encryptedCiphertext: claimData.encryptedCiphertext,
      encryptedIv: claimData.encryptedIv,
      encryptedTag: claimData.encryptedTag,
      keyDerivationDomain: claimData.keyDerivationDomain,
      messageHash: claimData.messageHash,
      messageLeafIndex: claimData.messageLeafIndex,
      claimAmount: claimData.claimAmount,
      l1Address: claimData.l1Address,
      l2Address: claimData.l2Address,
      l1TxHash: claimData.l1TxHash,
      l1TxUrl: claimData.l1TxUrl,
      l1BlockNumberBeforeTx: claimData.l1BlockNumberBeforeTx,
      nodeInfo: claimData.nodeInfo ?? undefined,
      isPrivacyModeEnabled: claimData.isPrivacyModeEnabled,
      status: claimData.status,
      // Contract snapshot (required for manual recovery)
      portalAddressL1: claimData.portalAddressL1 ?? undefined,
      bridgeAddressL2: claimData.bridgeAddressL2 ?? undefined,
      tokenAddressL1: claimData.tokenAddressL1 ?? undefined,
      tokenAddressL2: claimData.tokenAddressL2 ?? undefined,
      // Fuel recovery fields
      fuelMessageHash: claimData.fuelMessageHash ?? undefined,
      fuelMessageLeafIndex: claimData.fuelMessageLeafIndex ?? undefined,
      fuelAmount: claimData.fuelAmount ?? undefined,
    },
  }

  const filename = `aztec-bridge-claim-${claimData.id}-${Date.now()}.json`
  exportToJsonFile(exportData, filename)
}

/**
 * Export L2→L1 withdrawal data for backup
 * Supports both storage shapes: top-level l2BlockNumber / l2TxReceipt.blockNumber, leafIndex / l2ToL1MessageIndex
 */
export const exportWithdrawalData = (withdrawalData: any) => {
  const exportData = {
    type: BridgeDirection.L2_TO_L1,
    timestamp: new Date().toISOString(),
    warning:
      '⚠️ CRITICAL: Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
    data: {
      encryptedCiphertext: withdrawalData.encryptedCiphertext,
      encryptedIv: withdrawalData.encryptedIv,
      encryptedTag: withdrawalData.encryptedTag,
      keyDerivationDomain: withdrawalData.keyDerivationDomain,
      l2TxHash: withdrawalData.l2TxHash,
      l2BlockNumber: withdrawalData.l2BlockNumber ?? withdrawalData.l2TxReceipt?.blockNumber,
      l2BlockNumberBeforeTx: withdrawalData.l2BlockNumberBeforeTx ?? undefined,
      nodeInfo: withdrawalData.nodeInfo ?? undefined,
      l2ToL1MessageIndex: withdrawalData.l2ToL1MessageIndex ?? withdrawalData.leafIndex,
      siblingPath: withdrawalData.siblingPath,
      amount: withdrawalData.amount,
      l1Address: withdrawalData.l1Address,
      l2Address: withdrawalData.l2Address,
      bridgeAddressL2: withdrawalData.bridgeAddressL2 ?? withdrawalData.l2BridgeAddress,
      recipientL1Address: withdrawalData.recipientL1Address ?? withdrawalData.l1Address,
      status: withdrawalData.status,
      // Contract & version snapshot (required for manual recovery)
      portalAddressL1: withdrawalData.portalAddressL1 ?? undefined,
      rollupVersion: withdrawalData.rollupVersion ?? undefined,
      chainIdL1: withdrawalData.chainIdL1 ?? undefined,
      l1RollupAddress: withdrawalData.l1RollupAddress ?? undefined,
    },
  }

  const filename = `aztec-bridge-withdrawal-${withdrawalData.id}-${Date.now()}.json`
  exportToJsonFile(exportData, filename)
}
