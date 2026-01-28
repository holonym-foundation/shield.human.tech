'use client'

// import { AztecWalletSdk, obsidion } from 'raven-house-wallet-sdk'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { L2_NODE_URL } from '@/config'

// Create Aztec node client (for direct node access if needed)
export const aztecNode = createAztecNodeClient(L2_NODE_URL)

// let sdkInstance: AztecWalletSdk | null = null

// Lazily create SDK on the client to avoid SSR localStorage errors

// export const getSdk = () => {
//   if (sdkInstance) return sdkInstance
//   if (typeof window === 'undefined') {
//     throw new Error('AztecWalletSdk must be initialized in the browser')
//   }
//   sdkInstance = new AztecWalletSdk({
//     aztecNode: L2_NODE_URL,
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
