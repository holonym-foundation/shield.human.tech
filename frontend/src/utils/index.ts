import { BridgeDirection } from '@prisma/client'

export const truncateDecimals = (
  value: number | string,
  decimals = 6
): number => {
  const [integerPart, decimalPart] = value.toString().split('.')

  return parseFloat(
    `${integerPart}.${decimalPart?.slice(0, decimals) || '0000'}`
  )
}

export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Serialize Aztec NodeInfo to a plain JSON-serializable object for storage/export.
 * Converts address-like values (EthAddress, etc.) to string.
 */
export function serializeNodeInfo(nodeInfo: {
  nodeVersion?: string
  l1ChainId?: number
  rollupVersion?: number
  enr?: string
  l1ContractAddresses?: Record<string, unknown>
  protocolContractAddresses?: Record<string, unknown>
} | null | undefined): Record<string, unknown> | null {
  if (nodeInfo == null) return null
  const toPlain = (obj: unknown): unknown => {
    if (obj == null) return obj
    if (typeof obj === 'object' && obj !== null && 'toString' in obj && typeof (obj as { toString: () => string }).toString === 'function') {
      const s = (obj as { toString: () => string }).toString()
      if (s && s !== '[object Object]') return s
    }
    if (Array.isArray(obj)) return obj.map(toPlain)
    if (typeof obj === 'object' && obj !== null) {
      return Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k, toPlain(v)])
      )
    }
    return obj
  }
  return {
    nodeVersion: nodeInfo.nodeVersion,
    l1ChainId: nodeInfo.l1ChainId,
    rollupVersion: nodeInfo.rollupVersion,
    enr: nodeInfo.enr,
    l1ContractAddresses: nodeInfo.l1ContractAddresses != null ? toPlain(nodeInfo.l1ContractAddresses) as Record<string, unknown> : undefined,
    protocolContractAddresses: nodeInfo.protocolContractAddresses != null ? toPlain(nodeInfo.protocolContractAddresses) as Record<string, unknown> : undefined,
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
 * Export L1→L2 claim data for backup
 */
export const exportClaimData = (claimData: any) => {
  const exportData = {
    type: BridgeDirection.L1_TO_L2,
    timestamp: new Date().toISOString(),
    warning: '⚠️ CRITICAL: Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
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
    warning: '⚠️ CRITICAL: Keep this file safe! To decrypt, sign the same message with the same wallet on the same domain.',
    data: {
      encryptedCiphertext: withdrawalData.encryptedCiphertext,
      encryptedIv: withdrawalData.encryptedIv,
      encryptedTag: withdrawalData.encryptedTag,
      keyDerivationDomain: withdrawalData.keyDerivationDomain,
      l2TxHash: withdrawalData.l2TxHash,
      l2BlockNumber:
        withdrawalData.l2BlockNumber ??
        withdrawalData.l2TxReceipt?.blockNumber,
      l2BlockNumberBeforeTx: withdrawalData.l2BlockNumberBeforeTx ?? undefined,
      nodeInfo: withdrawalData.nodeInfo ?? undefined,
      l2ToL1MessageIndex:
        withdrawalData.l2ToL1MessageIndex ?? withdrawalData.leafIndex,
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