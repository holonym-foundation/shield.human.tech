'use client'

// import { AztecWalletSdk, obsidion } from 'raven-house-wallet-sdk'
import { createAztecNodeClient } from '@aztec/aztec.js/node'

const NODE_URL = 'https://devnet-6.aztec-labs.com/'

// Create Aztec node client (for direct node access if needed)
export const aztecNode = createAztecNodeClient(NODE_URL)

// let sdkInstance: AztecWalletSdk | null = null

// Lazily create SDK on the client to avoid SSR localStorage errors
// L2 chain ID for devnet: l1ChainId ^ rollupVersion = 11155111 ^ rollupVersion = 1674512022
// export const getSdk = () => {
//   if (sdkInstance) return sdkInstance
//   if (typeof window === 'undefined') {
//     throw new Error('AztecWalletSdk must be initialized in the browser')
//   }
//   sdkInstance = new AztecWalletSdk({
//     aztecNode: NODE_URL,
//     connectors: [obsidion({})],
//   })
//   return sdkInstance
// }

// Function to connect to the specified wallet type
export const connectWallet = async (type: 'obsidion' | 'azguard') => {
  try {
    // const sdk = getSdk()
    // await sdk.connect(type)
    // const account = await sdk.getAccount()
    // return account
    throw new Error('Obsidion wallet support is disabled (SDK not yet on Devnet 6)')
  } catch (error) {
    throw error
  }
}
