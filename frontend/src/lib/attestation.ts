/**
 * Attestation signing utilities for POCH (clean hands) and Passport flows.
 *
 * These mirror the signing logic in bridge-script/index-devnet-compliant.ts
 * and produce signatures that are verified on-chain by TokenPortal.sol (L1)
 * and token_bridge/main.nr (L2).
 */

import { keccak256, encodePacked, type Hex } from 'viem'
import { privateKeyToAccount, signMessage } from 'viem/accounts'

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

export function getCircuitId(): bigint {
  return BigInt(process.env.CLEAN_HANDS_CIRCUIT_ID || '1')
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

// ─── POCH (Clean Hands) attestation ──────────────────────────────────────────

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

// ─── Passport attestation ────────────────────────────────────────────────────

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

// ─── Holonym API ─────────────────────────────────────────────────────────────

const HOLONYM_API_BASE = process.env.HOLONYM_API_URL || 'https://api.holonym.io'

export async function checkCleanHands(userAddress: string, actionId?: bigint): Promise<{
  isUnique: boolean
  signature?: string
  circuitId?: string
}> {
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
