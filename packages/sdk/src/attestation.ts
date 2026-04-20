/**
 * Attestation support for private bridge operations.
 *
 * Handles POCH (clean-hands) → Passport fallback cascade.
 * The backend API routes handle signing and nonce management;
 * this module just calls the endpoints and builds contract structs.
 */

import type { BridgeApiClient } from './api'
import { BridgeApiError } from './api'
import type {
  CleanHandsStruct,
  PassportStruct,
  L2CleanHandsStruct,
  L2PassportStruct,
  BridgeEventCallback,
} from './types'

// ─── Empty Structs ──────────────────────────────────────────────────

export function buildEmptyCleanHands(): CleanHandsStruct {
  return { nonce: 0n, signature: '0x' }
}

export function buildEmptyPassport(): PassportStruct {
  return { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' }
}

export function buildEmptyL2CleanHands(): L2CleanHandsStruct {
  return { nonce: 0n, signature: new Array(64).fill(0) }
}

export function buildEmptyL2Passport(): L2PassportStruct {
  return { max_amount: 0n, nonce: 0n, deadline: 0n, signature: new Array(64).fill(0) }
}

// ─── Attestation Invariants (defense-in-depth) ──────────────────────
//
// The cascade functions below (fetchAttestationsForDeposit /
// fetchAttestationsForWithdrawal) MUST return at least one non-empty struct
// for private operations — otherwise the on-chain verification path falls
// back to the "CleanHands & Passport both empty" code path which is a silent
// revert on mainnet.
//
// These asserters guard against future refactors that might accidentally
// allow empty structs to escape (e.g. a new branch in the cascade that
// returns defaults instead of throwing). Treated as invariant violations
// rather than transient errors — they indicate a code bug, not user error.

function isEmptyL1CleanHands(cleanHands: CleanHandsStruct): boolean {
  return cleanHands.nonce === 0n && cleanHands.signature === '0x'
}

function isEmptyL1Passport(passport: PassportStruct): boolean {
  return (
    passport.nonce === 0n &&
    passport.maxAmount === 0n &&
    passport.deadline === 0n &&
    passport.signature === '0x'
  )
}

function isEmptyL2CleanHands(cleanHands: L2CleanHandsStruct): boolean {
  return (
    cleanHands.nonce === 0n &&
    Array.isArray(cleanHands.signature) &&
    cleanHands.signature.every((b) => b === 0)
  )
}

function isEmptyL2Passport(passport: L2PassportStruct): boolean {
  return (
    passport.nonce === 0n &&
    passport.max_amount === 0n &&
    passport.deadline === 0n &&
    Array.isArray(passport.signature) &&
    passport.signature.every((b) => b === 0)
  )
}

/**
 * Assert that a private-deposit attestation result has at least one real
 * (non-empty) struct. Called after the cascade; protects against future
 * refactors that could silently leak empty defaults to the bridge contract.
 */
export function assertNonEmptyDepositAttestation(
  result: { cleanHands: CleanHandsStruct; passport: PassportStruct },
): void {
  if (isEmptyL1CleanHands(result.cleanHands) && isEmptyL1Passport(result.passport)) {
    throw new Error(
      'Invariant violation: deposit attestation cascade returned both empty CleanHands and empty Passport. ' +
      'This indicates a bug in the cascade logic — the L1 portal will revert on empty attestations.',
    )
  }
}

/**
 * Assert that a private-withdrawal attestation result has at least one real
 * (non-empty) struct. Same rationale as the deposit variant.
 */
export function assertNonEmptyWithdrawalAttestation(
  result: { cleanHands: L2CleanHandsStruct; passport: L2PassportStruct },
): void {
  if (isEmptyL2CleanHands(result.cleanHands) && isEmptyL2Passport(result.passport)) {
    throw new Error(
      'Invariant violation: withdrawal attestation cascade returned both empty CleanHands and empty Passport. ' +
      'This indicates a bug in the cascade logic — the L2 bridge will revert on empty attestations.',
    )
  }
}

// ─── Signature Format Validation ────────────────────────────────────
//
// Defense-in-depth: the backend could mis-wire its response (e.g. swap
// l1Signature and l2Signature) and the resulting tx would revert on-chain
// with a cryptic error after the user paid gas. Validate at the SDK boundary
// so we fail fast with an actionable message.
//
// L1 (ECDSA secp256k1): hex string, `0x` + 130 chars (65 bytes: r,s,v).
// L2 (Schnorr Grumpkin): number[] of length 64.

export function assertL1SignatureShape(sig: unknown, context: string): asserts sig is `0x${string}` {
  if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error(
      `Invalid L1 signature for ${context}: expected 0x-prefixed 65-byte hex (132 chars). ` +
      `Got ${typeof sig === 'string' ? `${sig.length}-char string` : typeof sig}.`,
    )
  }
}

export function assertL2SignatureShape(sig: unknown, context: string): asserts sig is number[] {
  if (!Array.isArray(sig) || sig.length !== 64 || !sig.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error(
      `Invalid L2 signature for ${context}: expected 64-byte Schnorr signature as number[64]. ` +
      `Got ${Array.isArray(sig) ? `array length ${sig.length}` : typeof sig}.`,
    )
  }
}

// ─── Fetch Attestations for L1 Deposit ──────────────────────────────

/**
 * Fetch attestation structs for depositToAztecPrivate (L1→L2).
 *
 * Cascade: POCH first, Passport fallback, empty structs as last resort.
 * Auth 401 throws immediately (auth problem, not attestation eligibility).
 */
export async function fetchAttestationsForDeposit(
  apiClient: BridgeApiClient,
  portalAddress: string,
  amount: bigint,
  decimals: number,
  emit?: BridgeEventCallback,
): Promise<{ cleanHands: CleanHandsStruct; passport: PassportStruct }> {
  // Try POCH first
  emit?.({ type: 'attestation_fetch', method: 'poch' })
  try {
    const poch = await apiClient.postPochAttestation(portalAddress)
    assertL1SignatureShape(poch.l1Signature, 'POCH (L1 CleanHands)')
    return {
      cleanHands: {
        nonce: BigInt(poch.nonce),
        signature: poch.l1Signature,
      },
      passport: buildEmptyPassport(),
    }
  } catch (err) {
    // 401 = auth problem, throw immediately
    if (err instanceof BridgeApiError && err.status === 401) {
      throw new Error('Authentication required for attestation. Please sign in first.')
    }
    // Malformed signature is a backend bug — surface it instead of silently
    // falling back to Passport (which may also be misconfigured).
    if (err instanceof Error && err.message.startsWith('Invalid L1 signature')) {
      throw err
    }

    const reason = err instanceof Error ? err.message : String(err)
    emit?.({ type: 'attestation_fallback', from: 'poch', to: 'passport', reason })
  }

  // Fallback to Passport
  emit?.({ type: 'attestation_fetch', method: 'passport' })
  try {
    const passport = await apiClient.postPassportAttestation(portalAddress)

    // Enforce amount limit
    const maxAmount = BigInt(passport.maxAmount)
    if (amount > maxAmount) {
      const maxDisplay = Number(maxAmount) / 10 ** decimals
      throw new Error(
        `Passport allows up to ${maxDisplay} per transaction. Mint a POCH SBT to remove this limit.`
      )
    }

    assertL1SignatureShape(passport.l1Signature, 'Passport (L1)')
    return {
      cleanHands: buildEmptyCleanHands(),
      passport: {
        maxAmount,
        nonce: BigInt(passport.nonce),
        deadline: BigInt(passport.deadline),
        signature: passport.l1Signature,
      },
    }
  } catch (err) {
    // Re-throw amount limit errors, auth errors, and signature-format errors.
    if (err instanceof BridgeApiError && err.status === 401) {
      throw new Error('Authentication required for attestation. Please sign in first.')
    }
    if (err instanceof Error && (
      err.message.includes('Passport allows up to') ||
      err.message.startsWith('Invalid L1 signature')
    )) {
      throw err
    }

    console.warn('[SDK Attestation] Both POCH and Passport failed:', err)
  }

  // Both failed — throw so the caller gets a clear error instead of a cryptic on-chain revert.
  throw new Error(
    'Attestation required: both POCH and Passport checks failed. ' +
    'Mint a POCH SBT or obtain a valid Passport to use private deposits.',
  )
  // NOTE: successful returns above go through assertNonEmptyDepositAttestation
  // in the caller path. A defensive wrapper at the function boundary would be
  // redundant since the two `return` statements above construct non-empty
  // structs by definition, but callers can additionally validate via the
  // exported assertion for defense-in-depth.
}

// ─── Fetch Attestations for L2 Withdrawal ───────────────────────────

/**
 * Fetch attestation structs for executeWithdrawToL1Private (L2→L1).
 *
 * Same cascade as deposit, but extracts L2 Schnorr signature components.
 */
export async function fetchAttestationsForWithdrawal(
  apiClient: BridgeApiClient,
  portalAddress: string,
  bridgeAddress: string,
  amount: bigint,
  decimals: number,
  emit?: BridgeEventCallback,
): Promise<{ cleanHands: L2CleanHandsStruct; passport: L2PassportStruct }> {
  // Try POCH first
  emit?.({ type: 'attestation_fetch', method: 'poch' })
  try {
    const poch = await apiClient.postPochAttestation(portalAddress)
    assertL2SignatureShape(poch.l2Signature, 'POCH (L2 CleanHands)')
    return {
      cleanHands: {
        nonce: BigInt(poch.nonce),
        signature: poch.l2Signature,
      },
      passport: buildEmptyL2Passport(),
    }
  } catch (err) {
    if (err instanceof BridgeApiError && err.status === 401) {
      throw new Error('Authentication required for attestation. Please sign in first.')
    }
    if (err instanceof Error && err.message.startsWith('Invalid L2 signature')) {
      throw err
    }

    const reason = err instanceof Error ? err.message : String(err)
    emit?.({ type: 'attestation_fallback', from: 'poch', to: 'passport', reason })
  }

  // Fallback to Passport
  emit?.({ type: 'attestation_fetch', method: 'passport' })
  try {
    const passport = await apiClient.postPassportAttestation(portalAddress, bridgeAddress)

    // Enforce amount limit
    const maxAmount = BigInt(passport.maxAmount)
    if (amount > maxAmount) {
      const maxDisplay = Number(maxAmount) / 10 ** decimals
      throw new Error(
        `Passport allows up to ${maxDisplay} per transaction. Mint a POCH SBT to remove this limit.`
      )
    }

    if (!passport.l2Signature) {
      throw new Error('Passport response missing L2 signature for withdrawal')
    }
    assertL2SignatureShape(passport.l2Signature, 'Passport (L2)')

    return {
      cleanHands: buildEmptyL2CleanHands(),
      passport: {
        max_amount: maxAmount,
        nonce: BigInt(passport.nonce),
        deadline: BigInt(passport.deadline),
        signature: passport.l2Signature,
      },
    }
  } catch (err) {
    if (err instanceof BridgeApiError && err.status === 401) {
      throw new Error('Authentication required for attestation. Please sign in first.')
    }
    if (err instanceof Error && (
      err.message.includes('Passport allows up to') ||
      err.message.includes('missing L2 signature') ||
      err.message.startsWith('Invalid L2 signature')
    )) {
      throw err
    }

    console.warn('[SDK Attestation] Both POCH and Passport failed:', err)
  }

  // Both failed — throw so the caller gets a clear error instead of a cryptic on-chain revert.
  throw new Error(
    'Attestation required: both POCH and Passport checks failed. ' +
    'Mint a POCH SBT or obtain a valid Passport to use private withdrawals.',
  )
}
