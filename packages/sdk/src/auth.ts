// packages/sdk/src/auth.ts
/**
 * SIWE (EIP-4361) authentication module for the bridge SDK.
 *
 * Handles wallet signature-based authentication using the SIWE standard.
 * Returns a JWT token for subsequent API calls.
 *
 * BREAKING CHANGE from v1: authenticate() now uses SIWE messages instead
 * of custom deterministic messages. Callers must update.
 */

import { SiweMessage } from 'siwe'
import { getAddress } from 'viem'
import type { BridgeApiClient } from './api'

export const L2_RESOURCE_PREFIX = 'https://bridge.human.tech/aztec/address/'

/**
 * Authenticate with the bridge backend using SIWE.
 *
 * 1. Fetches a nonce from the backend (or uses one provided)
 * 2. Constructs a SIWE message with the nonce, domain, and addresses
 * 3. Asks the caller to sign via the signMessage callback
 * 4. POSTs the signed message to /api/auth/authenticate
 * 5. Sets the JWT token on the API client
 *
 * @returns The JWT token and user ID
 */
export async function authenticate(
  apiClient: BridgeApiClient,
  params: {
    l1Address: string
    l2Address: string
    domain: string
    uri: string
    chainId: number
    signMessage: (msg: string) => Promise<string>
    nonce?: string // If omitted, fetched from /api/auth/nonce
    l1LoginMethod?: string
    l1WalletProvider?: string
    l2LoginMethod?: string
    l2WalletProvider?: string
  },
): Promise<{
  token: string
  userId: number
  user: {
    id: number
    l1Address: string
    l2Address: string
    l1LoginMethod: string | null
    l1WalletProvider: string | null
    l2LoginMethod: string | null
    l2WalletProvider: string | null
  }
}> {
  const { l1Address, l2Address, domain, uri, chainId, signMessage } = params

  // Fetch nonce if not provided
  const nonce = params.nonce ?? await apiClient.getText('/api/auth/nonce')

  // Build SIWE message — EIP-55 checksum required by SIWE spec
  const checksumAddress = getAddress(l1Address)
  const siweMessage = new SiweMessage({
    domain,
    address: checksumAddress,
    statement: 'Sign in to Aztec Bridge to manage your cross-chain operations.',
    uri,
    version: '1',
    chainId,
    nonce,
    expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    resources: [`${L2_RESOURCE_PREFIX}${l2Address.toLowerCase()}`],
  })

  const messageStr = siweMessage.prepareMessage()
  const signature = await signMessage(messageStr)

  if (!signature) {
    throw new Error('Wallet signature required for authentication')
  }
  const res = await apiClient.post<{
    success: boolean
    token: string
    user: {
      id: number
      l1Address: string
      l2Address: string
      l1LoginMethod: string | null
      l1WalletProvider: string | null
      l2LoginMethod: string | null
      l2WalletProvider: string | null
    }
  }>('/api/auth/authenticate', {
    message: messageStr,
    signature,
    l1LoginMethod: params.l1LoginMethod,
    l1WalletProvider: params.l1WalletProvider,
    l2LoginMethod: params.l2LoginMethod,
    l2WalletProvider: params.l2WalletProvider,
  })

  apiClient.setAuthToken(res.token)

  return { token: res.token, userId: res.user.id, user: res.user }
}
