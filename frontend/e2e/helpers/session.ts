import { SiweMessage } from 'siwe'
import { privateKeyToAccount } from 'viem/accounts'
import type { PrivateKeyAccount } from 'viem'

import { GET as nonceRoute } from '@/app/api/auth/nonce/route'
import { POST as authenticateRoute } from '@/app/api/auth/authenticate/route'

import { E2E_ENV, E2E_ORIGIN } from './env'
import { call } from './request'

export interface Session {
  token: string
  userId: string
  l1Address: string
  l2Address: string
  account: PrivateKeyAccount
}

/** Deterministic wallet per test, so a failure names the same actor every run. */
export function wallet(index: number): PrivateKeyAccount {
  return privateKeyToAccount(`0x${index.toString(16).padStart(64, '0')}` as `0x${string}`)
}

/** A well-formed Aztec address (0x + 64 hex) derived from an index. */
export function aztecAddress(index: number): string {
  return `0x${index.toString(16).padStart(64, '0')}`
}

/** Fetch a server-issued SIWE nonce through the real route. */
export async function fetchNonce(): Promise<string> {
  const result = await call(nonceRoute, '/api/auth/nonce')
  if (result.status !== 200) throw new Error(`nonce route returned ${result.status}`)
  return result.text
}

export interface SiweOptions {
  domain?: string
  uri?: string
  resources?: string[]
  chainId?: number
  issuedAt?: string
  expirationTime?: string
  /** What the client reports about the Aztec wallet's network. Binding requires `true`. */
  l2NetworkVerified?: boolean
}

/** Build and sign a SIWE message the way the app's wallet connector does. */
export async function signSiwe(
  account: PrivateKeyAccount,
  l2Address: string,
  nonce: string,
  options: SiweOptions = {},
): Promise<{ message: string; signature: string }> {
  const siwe = new SiweMessage({
    domain: options.domain ?? E2E_ENV.AUTH_EXPECTED_DOMAIN,
    address: account.address,
    statement: 'Sign in to Shield',
    uri: options.uri ?? E2E_ORIGIN,
    version: '1',
    chainId: options.chainId ?? 1,
    nonce,
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    ...(options.expirationTime ? { expirationTime: options.expirationTime } : {}),
    resources: options.resources ?? [`${options.uri ?? E2E_ORIGIN}/aztec/address/${l2Address}`],
  })

  const message = siwe.prepareMessage()
  const signature = await account.signMessage({ message })

  return { message, signature }
}

/** Run the whole login: nonce → signed SIWE → JWT. */
export function login(index: number, options: SiweOptions = {}): Promise<Session> {
  return loginWithL2(index, aztecAddress(index), options)
}

/** Same login, with an L2 address that is not the wallet index's default. */
export async function loginWithL2(
  index: number,
  l2Address: string,
  options: SiweOptions = {},
): Promise<Session> {
  const account = wallet(index)
  const nonce = await fetchNonce()
  const { message, signature } = await signSiwe(account, l2Address, nonce, options)

  const result = await call(authenticateRoute, '/api/auth/authenticate', {
    method: 'POST',
    body: {
      message,
      signature,
      l1LoginMethod: 'injected',
      l2LoginMethod: 'azguard',
      l2NetworkVerified: options.l2NetworkVerified ?? true,
    },
  })

  if (result.status !== 200) {
    throw new Error(`login failed: ${result.status} ${result.text}`)
  }

  return {
    token: result.body.token,
    userId: result.body.user.id,
    l1Address: result.body.user.l1Address,
    l2Address: result.body.user.l2Address,
    account,
  }
}
