/**
 * Utility functions for Aztec-related operations
 */

/**
 * Get L1 contract addresses from Aztec account
 * 
 * @param aztecAccount - The Aztec account object with aztecNode property
 * @returns L1 contract addresses or null if account/node is not available
 */
export async function getL1ContractAddresses(aztecAccount: any): Promise<any | null> {
  if (!aztecAccount?.aztecNode) {
    return null
  }
  return await aztecAccount.aztecNode.getL1ContractAddresses()
}

