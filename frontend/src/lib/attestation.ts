/**
 * Attestation signing utilities for POCH (clean hands) and Passport flows.
 *
 * L1 signatures use ECDSA/secp256k1 (verified by TokenPortal.sol).
 * L2 signatures use Schnorr/Grumpkin (verified by token_bridge/main.nr).
 */

import { keccak256, encodePacked, type Hex } from 'viem'
import { privateKeyToAccount, signMessage } from 'viem/accounts'
import { Schnorr } from '@aztec/foundation/crypto/schnorr'
import { deriveSigningKey } from '@aztec/stdlib/keys'
import { computeInnerAuthWitHash } from '@aztec/stdlib/auth-witness'
import { Fr } from '@aztec/aztec.js/fields'
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin'

// ─── Config ──────────────────────────────────────────────────────────────────

function getAttesterPrivateKey(): Hex {
  const key = process.env.POCH_ATTESTER_PRIVATE_KEY
  if (!key) throw new Error('POCH_ATTESTER_PRIVATE_KEY not set')
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex
}

function getPassportSignerPrivateKey(): Hex {
  const key = process.env.PASSPORT_SIGNER_PRIVATE_KEY
  if (!key) throw new Error('PASSPORT_SIGNER_PRIVATE_KEY not set')
  return (key.startsWith('0x') ? key : `0x${key}`) as Hex
}

function getL2PochAttesterPrivateKey(): string {
  const key = process.env.L2_POCH_ATTESTER_PRIVATE_KEY
  if (!key) throw new Error('L2_POCH_ATTESTER_PRIVATE_KEY not set')
  return key.startsWith('0x') ? key : `0x${key}`
}

function getL2PassportSignerPrivateKey(): string {
  const key = process.env.L2_PASSPORT_SIGNER_PRIVATE_KEY
  if (!key) throw new Error('L2_PASSPORT_SIGNER_PRIVATE_KEY not set')
  return key.startsWith('0x') ? key : `0x${key}`
}

export function getCircuitId(): bigint {
  return BigInt(process.env.CLEAN_HANDS_CIRCUIT_ID || '0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19')
}

export function getDefaultActionId(): bigint {
  return BigInt(process.env.CLEAN_HANDS_ACTION_ID || '123456789')
}

export function getPassportScoreThreshold(): number {
  return parseInt(process.env.PASSPORT_SCORE_THRESHOLD || '20', 10)
}

export function getPassportMaxAmount(): bigint {
  return BigInt(process.env.PASSPORT_MAX_AMOUNT || '1000000000') // 1000 USDC (6 decimals)
}

export function getAttesterAddress(): string {
  return privateKeyToAccount(getAttesterPrivateKey()).address
}

export function getPassportSignerAddress(): string {
  return privateKeyToAccount(getPassportSignerPrivateKey()).address
}

// ─── L2 Schnorr key management ──────────────────────────────────────────────

const schnorrInstance = new Schnorr()

let l2PochSigningKey: GrumpkinScalar | null = null
let l2PassportSigningKey: GrumpkinScalar | null = null

async function getL2PochSigningKey(): Promise<GrumpkinScalar> {
  if (!l2PochSigningKey) {
    const secretKey = Fr.fromString(getL2PochAttesterPrivateKey())
    l2PochSigningKey = deriveSigningKey(secretKey)
  }
  return l2PochSigningKey
}

async function getL2PassportSigningKey(): Promise<GrumpkinScalar> {
  if (!l2PassportSigningKey) {
    const secretKey = Fr.fromString(getL2PassportSignerPrivateKey())
    l2PassportSigningKey = deriveSigningKey(secretKey)
  }
  return l2PassportSigningKey
}

// ─── L1 POCH (Clean Hands) attestation (ECDSA) ─────────────────────────────

/**
 * Sign a clean hands attestation for the L1 TokenPortal.
 *
 * L1 verifies: keccak256(abi.encodePacked(nonce, circuitId, actionId, userAddress))
 * then personal_sign, then ECDSA recover == humanIdAttester.
 */
export async function signCleanHandsAttestation(params: {
  nonce: bigint
  circuitId: bigint
  actionId: bigint
  userAddress: string
}): Promise<Hex> {
  const digest = keccak256(
    encodePacked(
      ['uint256', 'uint256', 'uint256', 'address'],
      [params.nonce, params.circuitId, params.actionId, params.userAddress as `0x${string}`]
    )
  )
  const signature = await signMessage({
    privateKey: getAttesterPrivateKey(),
    message: { raw: digest },
  })
  return signature
}

// ─── L1 Passport attestation (ECDSA) ────────────────────────────────────────

/**
 * Sign a passport attestation for the L1 TokenPortal.
 *
 * L1 verifies: keccak256(abi.encodePacked(msg.sender, maxAmount, nonce, deadline, address(this)))
 * then personal_sign, then ECDSA recover == passportSigner.
 */
export async function signPassportAttestation(params: {
  userAddress: string
  maxAmount: bigint
  nonce: bigint
  deadline: bigint
  portalAddress: string
}): Promise<Hex> {
  const digest = keccak256(
    encodePacked(
      ['address', 'uint256', 'uint256', 'uint256', 'address'],
      [
        params.userAddress as `0x${string}`,
        params.maxAmount,
        params.nonce,
        params.deadline,
        params.portalAddress as `0x${string}`,
      ]
    )
  )
  const signature = await signMessage({
    privateKey: getPassportSignerPrivateKey(),
    message: { raw: digest },
  })
  return signature
}

// ─── L2 POCH attestation (Schnorr/Grumpkin) ─────────────────────────────────

/**
 * Sign a clean hands attestation for the L2 token bridge using Schnorr/Grumpkin.
 *
 * L2 verifies: compute_inner_authwit_hash([circuitId, actionId, nonce, userAddress])
 * then schnorr::verify_signature against stored Grumpkin pubkey.
 */
export async function signL2CleanHandsAttestation(params: {
  circuitId: bigint
  actionId: bigint
  nonce: bigint
  userAztecAddress: string // hex string of the Aztec address
}): Promise<number[]> {
  const signingKey = await getL2PochSigningKey()
  const hash = await computeInnerAuthWitHash([
    new Fr(params.circuitId),
    new Fr(params.actionId),
    new Fr(params.nonce),
    new Fr(BigInt(params.userAztecAddress)),
  ])
  const sig = await schnorrInstance.constructSignature(hash.toBuffer(), signingKey)
  return [...sig.toBuffer()]
}

// ─── L2 Passport attestation (Schnorr/Grumpkin) ─────────────────────────────

/**
 * Sign a passport attestation for the L2 token bridge using Schnorr/Grumpkin.
 *
 * L2 verifies: compute_inner_authwit_hash([userAddress, maxAmount, nonce, deadline, bridgeAddress])
 * then schnorr::verify_signature against stored Grumpkin pubkey.
 */
export async function signL2PassportAttestation(params: {
  userAztecAddress: string // hex string of the Aztec address
  maxAmount: bigint
  nonce: bigint
  deadline: bigint
  bridgeAddress: string // hex string of the bridge contract address
}): Promise<number[]> {
  const signingKey = await getL2PassportSigningKey()
  const hash = await computeInnerAuthWitHash([
    new Fr(BigInt(params.userAztecAddress)),
    new Fr(params.maxAmount),
    new Fr(params.nonce),
    new Fr(params.deadline),
    new Fr(BigInt(params.bridgeAddress)),
  ])
  const sig = await schnorrInstance.constructSignature(hash.toBuffer(), signingKey)
  return [...sig.toBuffer()]
}

// ─── Holonym API ─────────────────────────────────────────────────────────────

const HOLONYM_API_BASE = process.env.HOLONYM_API_URL || 'https://api.holonym.io'

export async function checkCleanHands(userAddress: string, actionId?: bigint): Promise<{
  isUnique: boolean
  signature?: string
  circuitId?: string
}> {
  if (process.env.NEXT_PUBLIC_DEV_ATTESTATION === 'true') {
    console.log('[DEV] Mocking Holonym clean hands check for', userAddress)
    return { isUnique: true }
  }
  const aid = actionId ?? getDefaultActionId()
  const url = `${HOLONYM_API_BASE}/sandbox/attestation/sbts/clean-hands?action-id=${aid}&address=${userAddress}`
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Holonym API error: ${resp.status} ${resp.statusText}`)
  }
  return resp.json()
}

// ─── Passport score API ──────────────────────────────────────────────────────

export async function fetchPassportScore(address: string): Promise<{
  score: number
  passing: boolean
}> {
  if (process.env.NEXT_PUBLIC_DEV_ATTESTATION === 'true') {
    console.log('[DEV] Mocking Gitcoin Passport score for', address)
    return { score: 50, passing: true }
  }
  const apiKey = process.env.PASSPORT_API_KEY
  const scorerId = process.env.PASSPORT_SCORER_ID
  if (!apiKey || !scorerId) {
    throw new Error('Missing PASSPORT_API_KEY or PASSPORT_SCORER_ID')
  }

  const resp = await fetch(
    `https://api.passport.xyz/v2/stamps/${scorerId}/score/${address}`,
    { headers: { 'X-API-KEY': apiKey } }
  )
  if (!resp.ok) {
    throw new Error(`Passport API error: ${resp.status} ${resp.statusText}`)
  }

  const data = await resp.json()
  const score = parseInt(data.score) || 0
  const threshold = getPassportScoreThreshold()

  return { score, passing: score >= threshold }
}
