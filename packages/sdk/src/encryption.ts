/**
 * Encryption utilities for bridge operation secrets
 *
 * Client-side encryption/decryption using keys derived from wallet signatures.
 * The server never sees plaintext secrets.
 *
 * Key derivation is DETERMINISTIC: same wallet + same message = same key.
 * This allows users to always recover their encrypted secrets by re-signing.
 */

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'

import type { EncryptedData, BridgeOperation, BridgeActivityData } from './types'

// ─── Signing Message ────────────────────────────────────────────────

/**
 * Creates a DETERMINISTIC signing message for encryption key derivation.
 *
 * The message is fixed for a given (l1Address, domain) pair — no timestamp
 * or randomness. The user can always re-sign the same message to derive
 * the same encryption key and decrypt their stored secrets.
 */
export function createSigningMessage(
  l1Address: string,
  domain: string,
): string {
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

// ─── Key Derivation ─────────────────────────────────────────────────

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
  domain: string,
): Promise<Uint8Array> {
  const keyDerivationInput = `Aztec Bridge Encryption Key\nDomain: ${domain}\nL1 Address: ${l1Address.toLowerCase()}\nSignature: ${signature}`
  const te = new TextEncoder()
  const ikm = te.encode(keyDerivationInput)
  const salt = te.encode(domain)
  const info = te.encode('aztec-bridge-key')

  return hkdf(sha256, ikm, salt, info, 32)
}

// ─── Encryption ─────────────────────────────────────────────────────

/**
 * Encrypts data using AES-256-GCM.
 *
 * @param plaintext - Data to encrypt (string)
 * @param key - 32-byte encryption key
 * @returns Encrypted data with IV and authentication tag (hex-encoded)
 */
export async function encryptData(
  plaintext: string,
  key: Uint8Array,
  aad?: string,
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aadBytes = aad ? new TextEncoder().encode(aad) : undefined
  const cipher = gcm(key, iv, aadBytes)
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const encrypted = cipher.encrypt(plaintextBytes)

  // GCM appends 16-byte auth tag to ciphertext
  const tag = encrypted.slice(-16)
  const ciphertext = encrypted.slice(0, -16)

  return {
    ciphertext: toHex(ciphertext),
    iv: toHex(iv),
    tag: toHex(tag),
  }
}

// ─── Decryption ─────────────────────────────────────────────────────

/**
 * Decrypts data using AES-256-GCM.
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
  key: Uint8Array,
  aad?: string,
): Promise<string> {
  const ivBytes = fromHex(iv)
  const tagBytes = fromHex(tag)
  const ciphertextBytes = fromHex(ciphertext)

  const aadBytes = aad ? new TextEncoder().encode(aad) : undefined
  const cipher = gcm(key, ivBytes, aadBytes)

  // GCM expects ciphertext + tag concatenated
  const encrypted = new Uint8Array(ciphertextBytes.length + tagBytes.length)
  encrypted.set(ciphertextBytes)
  encrypted.set(tagBytes, ciphertextBytes.length)

  try {
    const decrypted = cipher.decrypt(encrypted)
    return new TextDecoder().decode(decrypted)
  } catch {
    throw new Error(
      'Decryption failed. This could mean:\n' +
        '1. The encryption key is incorrect\n' +
        '2. The data was tampered with\n' +
        '3. The signature used for key derivation was different',
    )
  }
}

// ─── Decrypt Operation Payload ───────────────────────────────────────

/**
 * Decrypt an operation's encrypted payload using a wallet signature.
 *
 * Supports two calling conventions:
 * 1. With explicit `l1Address` — used by frontend hooks that know the connected wallet.
 * 2. With `l1AddressHint` — used by resume, which may extract the address from the
 *    stored signing message via regex fallback.
 *
 * @returns The decrypted activity data, or null if the operation has no encrypted payload.
 */
export async function decryptOperationPayload(
  operation: BridgeOperation,
  signMessage: (msg: string) => Promise<string>,
  domain: string,
  l1AddressHint?: string,
): Promise<BridgeActivityData | null> {
  if (
    !operation.encryptedCiphertext ||
    !operation.encryptedIv ||
    !operation.encryptedTag
  ) {
    return null
  }

  const effectiveDomain = operation.keyDerivationDomain ?? domain

  // Determine L1 address: prefer explicit hint, fall back to regex from signing message
  let l1Address = l1AddressHint ?? ''
  if (!l1Address) {
    const msg = operation.keyDerivationMessage ?? ''
    const match = msg.match(/Wallet: (0x[a-f0-9]+)/i)
    l1Address = match?.[1] ?? ''
  }
  if (!l1Address) {
    throw new Error(
      'Cannot determine L1 address for decryption. Pass l1Address or ensure keyDerivationMessage is stored.',
    )
  }

  const signingMessage = operation.keyDerivationMessage ?? createSigningMessage(l1Address, effectiveDomain)
  const signature = await signMessage(signingMessage)
  if (!signature) {
    throw new Error('Wallet signature required to decrypt operation data')
  }

  const key = await deriveEncryptionKey(l1Address, signature, effectiveDomain)
  const plaintext = await decryptData(
    operation.encryptedCiphertext,
    operation.encryptedIv,
    operation.encryptedTag,
    key,
  )

  return JSON.parse(plaintext) as BridgeActivityData
}

// ─── Hex Utilities ──────────────────────────────────────────────────

function toHex(bytes: Uint8Array): string {
  return (
    '0x' +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  )
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error(`fromHex: odd-length hex string (${clean.length} chars)`)
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(clean.substring(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`fromHex: invalid hex character at position ${i * 2}`)
    }
    bytes[i] = byte
  }
  return bytes
}
