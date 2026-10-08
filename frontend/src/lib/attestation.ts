/**
 * Attestation signing utilities for POCH (clean hands) and Passport flows.
 *
 * L1 signatures use ECDSA/secp256k1 (verified by TokenPortal.sol).
 * L2 signatures use Schnorr/Grumpkin (verified by token_bridge/main.nr).
 */

import { keccak256, encodePacked, type Hex } from 'viem'
import { privateKeyToAccount, signMessage } from 'viem/accounts'
import { Schnorr } from '@aztec-labs/foundation/crypto/schnorr'
import {
  POCH_ATTESTER_PRIVATE_KEY,
  PASSPORT_SIGNER_PRIVATE_KEY,
  L2_POCH_ATTESTER_PRIVATE_KEY,
  L2_PASSPORT_SIGNER_PRIVATE_KEY,
  CLEAN_HANDS_CIRCUIT_ID,
  CLEAN_HANDS_ACTION_ID,
  PASSPORT_SCORE_THRESHOLD,
  PASSPORT_MAX_AMOUNT,
  BRIDGE_MAX_DEPOSIT_USD,
  TRAVEL_RULE_THRESHOLD_USD,
  HOLONYM_API_URL,
  PASSPORT_API_KEY,
  PASSPORT_SCORER_ID,
} from '@/config/env.config'
import { HOLONYM_POCH_PATH } from '@/config'
// 5.0.0 dropped the deriveSigningKey export; it was an alias for the IVSK_M derivation,
// so keep using that exact function to preserve previously-derived L2 account addresses.
import { deriveMasterIncomingViewingSecretKey as deriveSigningKey } from '@aztec-labs/stdlib/keys'
import { computeInnerAuthWitHash } from '@aztec-labs/stdlib/auth-witness'
import { Fr } from '@aztec-labs/aztec.js/fields'
import type { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin'

// ─── Config ──────────────────────────────────────────────────────────────────

function getAttesterPrivateKey(): Hex {
  if (!POCH_ATTESTER_PRIVATE_KEY) throw new Error('POCH_ATTESTER_PRIVATE_KEY not set')
  return (
    POCH_ATTESTER_PRIVATE_KEY.startsWith('0x') ? POCH_ATTESTER_PRIVATE_KEY : `0x${POCH_ATTESTER_PRIVATE_KEY}`
  ) as Hex
}

function getPassportSignerPrivateKey(): Hex {
  if (!PASSPORT_SIGNER_PRIVATE_KEY) throw new Error('PASSPORT_SIGNER_PRIVATE_KEY not set')
  return (
    PASSPORT_SIGNER_PRIVATE_KEY.startsWith('0x') ? PASSPORT_SIGNER_PRIVATE_KEY : `0x${PASSPORT_SIGNER_PRIVATE_KEY}`
  ) as Hex
}

function getL2PochAttesterPrivateKey(): string {
  if (!L2_POCH_ATTESTER_PRIVATE_KEY) throw new Error('L2_POCH_ATTESTER_PRIVATE_KEY not set')
  return L2_POCH_ATTESTER_PRIVATE_KEY.startsWith('0x')
    ? L2_POCH_ATTESTER_PRIVATE_KEY
    : `0x${L2_POCH_ATTESTER_PRIVATE_KEY}`
}

function getL2PassportSignerPrivateKey(): string {
  if (!L2_PASSPORT_SIGNER_PRIVATE_KEY) throw new Error('L2_PASSPORT_SIGNER_PRIVATE_KEY not set')
  return L2_PASSPORT_SIGNER_PRIVATE_KEY.startsWith('0x')
    ? L2_PASSPORT_SIGNER_PRIVATE_KEY
    : `0x${L2_PASSPORT_SIGNER_PRIVATE_KEY}`
}

export function getCircuitId(): bigint {
  return BigInt(CLEAN_HANDS_CIRCUIT_ID)
}

export function getDefaultActionId(): bigint {
  return BigInt(CLEAN_HANDS_ACTION_ID)
}

export function getPassportScoreThreshold(): number {
  return parseInt(PASSPORT_SCORE_THRESHOLD, 10)
}

export function getPassportMaxAmount(): bigint {
  return BigInt(PASSPORT_MAX_AMOUNT)
}

/**
 * Alpha Mainnet per-user, per-day (rolling 24h) deposit cap in USD.
 * Returns 0 when unset/'0'/'' — callers treat 0 as "no limit".
 */
export function getBridgeMaxDepositUsd(): number {
  const parsed = Number(BRIDGE_MAX_DEPOSIT_USD)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
}

/**
 * Cumulative per-human lifetime deposit volume (USD) at or above which the
 * passport tier is refused and POCH is required. Returns 0 when unset/'0'/''
 * — callers treat 0 as "no threshold".
 */
export function getTravelRuleThresholdUsd(): number {
  const parsed = Number(TRAVEL_RULE_THRESHOLD_USD)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
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
      [params.nonce, params.circuitId, params.actionId, params.userAddress as `0x${string}`],
    ),
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
      ],
    ),
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
  const sig = await schnorrInstance.constructSignature(hash, signingKey)
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
  const sig = await schnorrInstance.constructSignature(hash, signingKey)
  return [...sig.toBuffer()]
}

// ─── Holonym API ─────────────────────────────────────────────────────────────

const HOLONYM_API_BASE = HOLONYM_API_URL

export async function checkCleanHands(
  userAddress: string,
  actionId?: bigint,
): Promise<{
  isUnique: boolean
  signature?: string
  circuitId?: string
}> {
  const aid = actionId ?? getDefaultActionId()
  const url = `${HOLONYM_API_BASE}${HOLONYM_POCH_PATH}?action-id=${aid}&address=${userAddress}`
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
  const apiKey = PASSPORT_API_KEY
  const scorerId = PASSPORT_SCORER_ID
  if (!apiKey || !scorerId) {
    throw new Error('Missing PASSPORT_API_KEY or PASSPORT_SCORER_ID')
  }

  const resp = await fetch(`https://api.passport.xyz/v2/stamps/${scorerId}/score/${address}`, {
    headers: { 'X-API-KEY': apiKey },
  })
  if (!resp.ok) {
    throw new Error(`Passport API error: ${resp.status} ${resp.statusText}`)
  }

  const data = await resp.json()
  const score = parseInt(data.score) || 0
  const threshold = getPassportScoreThreshold()

  return { score, passing: score >= threshold }
}

export interface PassportPointsData {
  totalPoints: number
  multiplier: number
  breakdown: Record<string, number>
}

// points_data.total_points is pre-multiplier; the effective balance is
// total × multiplier (1 or 2) — same math the Covenant HUMN Points service uses.
export async function fetchPassportPoints(address: string): Promise<PassportPointsData> {
  const apiKey = PASSPORT_API_KEY
  const scorerId = PASSPORT_SCORER_ID
  if (!apiKey || !scorerId) {
    throw new Error('Missing PASSPORT_API_KEY or PASSPORT_SCORER_ID')
  }

  const resp = await fetch(`https://api.passport.xyz/v2/stamps/${scorerId}/score/${address}`, {
    headers: { 'X-API-KEY': apiKey },
  })
  if (!resp.ok) {
    throw new Error(`Passport API error: ${resp.status} ${resp.statusText}`)
  }

  const data = await resp.json()
  const points = data.points_data
  const multiplier = Number(points?.multiplier) || 1
  return {
    totalPoints: (Number(points?.total_points) || 0) * multiplier,
    multiplier,
    breakdown: points?.breakdown ?? {},
  }
}
