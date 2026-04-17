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
    // Re-throw amount limit errors and auth errors
    if (err instanceof BridgeApiError && err.status === 401) {
      throw new Error('Authentication required for attestation. Please sign in first.')
    }
    if (err instanceof Error && err.message.includes('Passport allows up to')) {
      throw err
    }

    console.warn('[SDK Attestation] Both POCH and Passport failed:', err)
  }

  // Both failed — throw so the caller gets a clear error instead of a cryptic on-chain revert.
  throw new Error(
    'Attestation required: both POCH and Passport checks failed. ' +
    'Mint a POCH SBT or obtain a valid Passport to use private deposits.',
  )
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
      err.message.includes('missing L2 signature')
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
