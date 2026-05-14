import {
  createSigningMessage,
  deriveEncryptionKey,
  decryptData,
  buildDepositExport,
  buildWithdrawalExport,
  getDepositById,
  getWithdrawalById,
} from '@human.tech/aztec-bridge-sdk'

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
 *
 * Looks up the entry via the SDK's storage helpers (getDepositById /
 * getWithdrawalById) rather than reading localStorage directly — matches the
 * canonical storage shape the SDK writes.
 */
export async function decryptStorageEntry(
  storageKey: string,
  entryId: string,
  fieldName: string,
  signMessage: (message: string, address: string) => Promise<string>,
): Promise<{ value: string; entry: any } | null> {
  verifyEncryptionDomain()

  const entry = storageKey.includes('deposits') ? getDepositById(entryId) : getWithdrawalById(entryId)
  if (!entry?.encryptedCiphertext) return null

  const signingMessage = createSigningMessage(entry.l1Address, entry.keyDerivationDomain)
  const signature = await signMessage(signingMessage, entry.l1Address)
  const encryptionKey = await deriveEncryptionKey(entry.l1Address, signature, entry.keyDerivationDomain)
  const decrypted = JSON.parse(
    await decryptData(entry.encryptedCiphertext, entry.encryptedIv, entry.encryptedTag, encryptionKey),
  )

  const value = decrypted[fieldName]
  if (!value) return null

  return { value, entry }
}

/** Trigger a browser download of the L1→L2 claim recovery JSON. */
export const exportClaimData = (claimData: any) => {
  const payload = buildDepositExport(claimData)
  exportToJsonFile(payload, `aztec-bridge-claim-${claimData.id}-${Date.now()}.json`)
}

/** Trigger a browser download of the L2→L1 withdrawal recovery JSON. */
export const exportWithdrawalData = (withdrawalData: any) => {
  const payload = buildWithdrawalExport(withdrawalData)
  exportToJsonFile(payload, `aztec-bridge-withdrawal-${withdrawalData.id}-${Date.now()}.json`)
}
