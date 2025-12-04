'use client'

import { AztecWalletSdk, obsidion } from 'raven-house-wallet-sdk'
import { createAztecNodeClient } from '@aztec/aztec.js/node'

const NODE_URL = "https://devnet.aztec-labs.com/"

// Create Aztec node client (for direct node access if needed)
export const aztecNode = createAztecNodeClient(NODE_URL)

// Create the Aztec Wallet SDK instance
// L2 chain ID for devnet: l1ChainId ^ rollupVersion = 11155111 ^ rollupVersion = 1674512022
export const sdk = new AztecWalletSdk({
  aztecNode: NODE_URL,
  connectors: [obsidion({})],
})

// Function to connect to the specified wallet type
export const connectWallet = async (type: 'obsidion' | 'azguard') => {
  try {
    await sdk.connect(type)
    const account = await sdk.getAccount()
    return account
  } catch (error) {
    throw error
  }
}
