/**
 * Encryption utilities for bridge operation secrets
 *
 * This module provides client-side encryption/decryption using keys derived
 * from wallet signatures. The server never sees plaintext secrets.
 *
 * Key derivation is DETERMINISTIC: same wallet + same message = same key.
 * This allows users to always recover their encrypted secrets by re-signing.
 */

import { toHex, fromHex } from 'viem'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'

// Domain verification
const ALLOWED_DOMAIN = 'https://bridge.human.tech/'

/** True when running on localhost or 127.0.0.1 (development) */
function isDevelopmentOrigin(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname
  return h === 'localhost' || h === '127.0.0.1'
}

/**
 * Domain used for key derivation and signing message.
 * Verifies the current origin is allowed, then returns the domain.
 * Production: https://bridge.human.tech/
 * Development: current origin (e.g. http://localhost:3000/)
 */
export function getKeyDerivationDomain(): string {
  verifyDomain()
  if (typeof window === 'undefined') return ALLOWED_DOMAIN
  return isDevelopmentOrigin() ? window.location.origin + '/' : ALLOWED_DOMAIN
}

/**
 * Verify that the current domain is allowed (production or localhost in dev)
 * Throws an error if domain doesn't match (security check)
 */
export function verifyDomain(): void {
  if (typeof window === 'undefined') {
    throw new Error('Domain verification requires browser environment')
  }
  const currentDomain = window.location.origin + '/'
  const allowed = currentDomain === ALLOWED_DOMAIN || isDevelopmentOrigin()
  if (!allowed) {
    throw new Error(
      `🔒 Security Error: Encryption key derivation is only allowed on ${ALLOWED_DOMAIN}\n` +
      `Current domain: ${currentDomain}\n` +
      `Please access the bridge at ${ALLOWED_DOMAIN}`
    )
  }
}

/**
 * Creates a DETERMINISTIC signing message for encryption key derivation.
 *
 * The message is fixed for a given (l1Address, domain) pair — no timestamp
 * or randomness. This means the user can always re-sign the same message
 * to derive the same encryption key and decrypt their stored secrets.
 *
 * Security: domain-bound + wallet-bound. personal_sign is deterministic
 * for the same message and wallet.
 */
export function createSigningMessage(l1Address: string): string {
  const domain = getKeyDerivationDomain()
  return [
    'Aztec Bridge - Unlock My Secrets',
    '',
    'This signature derives an encryption key that protects your bridge operation secrets.',
    'Your encrypted data is stored securely and can only be decrypted by you.',
    '',
    `ONLY sign this on: ${domain}`,
    `Wallet: ${l1Address.toLowerCase()}`,
  ].join('\n')
}

/**
 * Derives a 256-bit encryption key from a wallet signature using HKDF-SHA256.
 *
 * Because the signing message is deterministic (same for a given wallet + domain),
 * the same wallet will always produce the same signature, and thus the same key.
 *
 * @param l1Address - User's L1 (Ethereum) address
 * @param signature - Signature from wallet.signMessage()
 * @param domain - Domain used for key derivation
 * @returns 32-byte encryption key (256 bits)
 */
export async function deriveEncryptionKey(
  l1Address: string,
  signature: string,
  domain: string = ALLOWED_DOMAIN,
): Promise<Uint8Array> {
  const allowedDomain =
    domain === ALLOWED_DOMAIN ||
    (typeof window !== 'undefined' &&
      isDevelopmentOrigin() &&
      domain === window.location.origin + '/')
  if (!allowedDomain) {
    throw new Error(
      `Invalid domain for key derivation. Expected ${ALLOWED_DOMAIN} or development origin, got ${domain}`
    )
  }

  const keyDerivationInput = `Aztec Bridge Encryption Key\nDomain: ${domain}\nL1 Address: ${l1Address}\nSignature: ${signature}`
  const te = new TextEncoder()
  const ikm = te.encode(keyDerivationInput)
  const salt = te.encode(domain)
  const info = te.encode('aztec-bridge-key')

  const key = hkdf(sha256, ikm, salt, info, 32)
  return key
}

/**
 * Encrypts data using AES-256-GCM
 * 
 * @param plaintext - Data to encrypt (string)
 * @param key - 32-byte encryption key
 * @returns Encrypted data with IV and authentication tag
 */
export async function encryptData(
  plaintext: string,
  key: Uint8Array
): Promise<{ ciphertext: string; iv: string; tag: string; version: number }> {
  // Generate random IV (Initialization Vector)
  // 12 bytes is standard for GCM mode
  const iv = crypto.getRandomValues(new Uint8Array(12))
  
  // Create AES-GCM cipher
  const cipher = gcm(key, iv)
  
  // Convert plaintext to bytes
  const plaintextBytes = new TextEncoder().encode(plaintext)
  
  // Encrypt
  const encrypted = cipher.encrypt(plaintextBytes)
  
  // In GCM mode, the tag is appended to the ciphertext
  // Extract tag (last 16 bytes) and ciphertext (rest)
  const tag = encrypted.slice(-16)
  const ciphertext = encrypted.slice(0, -16)
  
  return {
    ciphertext: toHex(ciphertext),
    iv: toHex(iv),
    tag: toHex(tag),
    version: ENCRYPTION_VERSION,
  }
}

/**
 * Decrypts data using AES-256-GCM
 * 
 * @param ciphertext - Encrypted data (hex string)
 * @param iv - Initialization vector (hex string)
 * @param tag - Authentication tag (hex string)
 * @param key - 32-byte decryption key (must match encryption key)
 * @returns Decrypted plaintext
 */
export async function decryptData(
  ciphertext: string,
  iv: string,
  tag: string,
  key: Uint8Array
): Promise<string> {
  // Convert hex strings to Uint8Array
  const ivBytes = fromHex(iv as `0x${string}`, 'bytes')
  const tagBytes = fromHex(tag as `0x${string}`, 'bytes')
  const ciphertextBytes = fromHex(ciphertext as `0x${string}`, 'bytes')
  
  // Create AES-GCM cipher
  const cipher = gcm(key, ivBytes)
  
  // Combine ciphertext and tag (GCM requires both)
  const encrypted = new Uint8Array([
    ...ciphertextBytes,
    ...tagBytes,
  ])
  
  // Decrypt (will throw if tag doesn't match - prevents tampering)
  try {
    const decrypted = cipher.decrypt(encrypted)
    return new TextDecoder().decode(decrypted)
  } catch (error) {
    throw new Error(
      'Decryption failed. This could mean:\n' +
      '1. The encryption key is incorrect\n' +
      '2. The data was tampered with\n' +
      '3. The signature used for key derivation was different'
    )
  }
}

/**
 * Type definitions for encrypted data
 */
/** Current encryption format version. Increment when changing KDF, cipher, or payload structure. */
export const ENCRYPTION_VERSION = 1

export interface EncryptedData {
  ciphertext: string
  iv: string
  tag: string
  /** Encryption format version — allows future migration to different schemes. */
  version?: number
  /** Domain used for key derivation — needed to decrypt if domain changes. */
  keyDerivationDomain?: string
}

export interface BridgeActivityData {
  // L1→L2: claim secrets (encrypted blob only — server never sees these)
  claimSecret?: string
  claimSecretHash?: string

  // L1→L2: fuel secrets (encrypted blob only)
  fuelSecret?: string
  fuelSecretHash?: string
  privateFuelSalt?: string
  privateFuelSecret?: string
  privateFuelSecretHash?: string

  // L1→L2: snapshot stored in blob for offline recovery
  l1BlockNumberBeforeTx?: string
  nodeInfo?: Record<string, unknown>

  // L2→L1: authwit nonce (encrypted blob only — needed to re-attempt interrupted burn)
  nonce?: string
  l2BridgeAddress?: string
  portalAddressL1?: string

  // Common (present in both L1→L2 and L2→L1 blobs)
  amount?: string
  l1Address?: string
  l2Address?: string
  isPrivacyModeEnabled?: boolean
}
