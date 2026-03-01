'use client'

// import { AztecWalletSdk, obsidion } from 'raven-house-wallet-sdk'

import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { L2_NODE_URL } from '@/config'

// In the browser, proxy through our API route to avoid CORS / COEP issues.
// On the server (SSR), call the node directly.
const nodeUrl =
  typeof window !== 'undefined' ? '/api/aztec-node' : L2_NODE_URL

export const aztecNode = createAztecNodeClient(nodeUrl)

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
