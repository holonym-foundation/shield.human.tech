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
import { getAddress } from 'viem'

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

// Every KDF string set this codebase has shipped, current first. The second set is
// what envelope version 1 used, before 87d76c5 renamed the runtime identifiers; it is
// kept because decrypt has to be able to reproduce either one, and nothing stored
// alongside a ciphertext says which applies. See `deriveEncryptionKeyCandidates`.
const KDF_STRINGS = [
  { prefix: 'Shield Human Tech Encryption Key', info: 'shield-human-tech-key' },
  { prefix: 'Aztec Bridge Encryption Key', info: 'aztec-bridge-key' },
] as const

/**
 * Derives a 256-bit encryption key from a wallet signature using HKDF-SHA256.
 *
 * Because the signing message is deterministic (same for a given wallet + domain),
 * the same wallet will always produce the same signature, and thus the same key.
 *
 * The address is lowercased first. Callers pass it straight through from the wallet
 * provider, which is inconsistent about checksum casing, and an address that reaches
 * the KDF raw makes the key depend on that casing — the #2185 defect.
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
  return deriveKey(l1Address.toLowerCase(), signature, domain, KDF_STRINGS[0])
}

async function deriveKey(
  l1Address: string,
  signature: string,
  domain: string,
  strings: (typeof KDF_STRINGS)[number],
): Promise<Uint8Array> {
  const keyDerivationInput = `${strings.prefix}\nDomain: ${domain}\nL1 Address: ${l1Address}\nSignature: ${signature}`
  const te = new TextEncoder()
  const ikm = te.encode(keyDerivationInput)
  const salt = te.encode(domain)
  const info = te.encode(strings.info)

  return hkdf(sha256, ikm, salt, info, 32)
}

/**
 * Every key that could have encrypted a payload for this wallet, best guess first.
 *
 * Two independent things have varied over time, and neither is recorded alongside
 * the ciphertext:
 *
 *  - **Address casing.** `createSigningMessage` lowercases the address, but this KDF
 *    used to interpolate it raw. Callers pass the address straight through from the
 *    wallet provider, which returns checksummed or lowercase depending on the provider
 *    and the code path, so the same wallet could derive two different keys across two
 *    sessions. Decrypt therefore tries every casing.
 *  - **KDF strings.** 87d76c5 changed them and bumped ENCRYPTION_VERSION 1 -> 2, but
 *    that version is never persisted (both storage writes and the event payload pick
 *    ciphertext/iv/tag only), so there is nothing to branch on. Decrypt tries both sets.
 *
 * Trialling is safe: GCM authenticates, so a wrong key throws rather than returning
 * plausible garbage.
 *
 * One wallet signature covers all of them: the signing message already lowercases the
 * address, so every candidate here shares the same signature and the user is prompted once.
 *
 * `version` (when the record carries one) only ORDERS the candidates, it never drops any.
 * A stored version narrows the likely derivation, but a row could still have been written
 * by a path that recorded the wrong one, and silently refusing to try the others would
 * turn a recoverable operation into a lost one.
 */
export async function deriveEncryptionKeyCandidates(
  l1Address: string,
  signature: string,
  domain: string,
  version?: number | null,
): Promise<Uint8Array[]> {
  const forms: string[] = [l1Address.toLowerCase()]
  if (l1Address && !forms.includes(l1Address)) forms.push(l1Address)
  try {
    const checksummed = getAddress(l1Address)
    if (!forms.includes(checksummed)) forms.push(checksummed)
  } catch {
    // Not a well-formed address; the raw and lowercased forms above still apply.
  }

  // Version 1 is the only one written with the old KDF strings; 2 and 3 (and anything
  // newer) use the current set, so it leads unless the record says otherwise.
  const setOrder = version === 1 ? [KDF_STRINGS[1], KDF_STRINGS[0]] : [KDF_STRINGS[0], KDF_STRINGS[1]]

  const keys: Uint8Array[] = []
  for (const strings of setOrder) {
    for (const form of forms) {
      keys.push(await deriveKey(form, signature, domain, strings))
    }
  }
  return keys
}

// ─── Encryption ─────────────────────────────────────────────────────

/**
 * Current encryption envelope format version. Increment on KDF, cipher, or payload changes.
 *
 * 1 -> 2: KDF strings renamed (87d76c5).
 * 2 -> 3: the L1 address is lowercased before it enters the KDF, so a key no longer
 *         depends on whether the wallet provider handed back a checksummed address.
 *
 * Persisted as `encryptedVersion` on API and localStorage records. Rows written before
 * that column existed carry none, so decrypt uses the version only to order the
 * candidate keys and still trials all of them (`deriveEncryptionKeyCandidates`).
 */
export const ENCRYPTION_VERSION = 3

/**
 * Encrypts data using AES-256-GCM.
 *
 * @param plaintext - Data to encrypt (string)
 * @param key - 32-byte encryption key
 * @returns Encrypted data with IV, authentication tag, and format version (hex-encoded)
 */
export async function encryptData(
  plaintext: string,
  key: Uint8Array,
): Promise<EncryptedData> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = gcm(key, iv)
  const plaintextBytes = new TextEncoder().encode(plaintext)
  const encrypted = cipher.encrypt(plaintextBytes)

  // GCM appends 16-byte auth tag to ciphertext
  const tag = encrypted.slice(-16)
  const ciphertext = encrypted.slice(0, -16)

  return {
    ciphertext: toHex(ciphertext),
    iv: toHex(iv),
    tag: toHex(tag),
    version: ENCRYPTION_VERSION,
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
): Promise<string> {
  const ivBytes = fromHex(iv)
  const tagBytes = fromHex(tag)
  const ciphertextBytes = fromHex(ciphertext)

  const cipher = gcm(key, ivBytes)

  // GCM expects ciphertext + tag concatenated
  const encrypted = new Uint8Array(ciphertextBytes.length + tagBytes.length)
  encrypted.set(ciphertextBytes)
  encrypted.set(tagBytes, ciphertextBytes.length)

  try {
    const decrypted = cipher.decrypt(encrypted)
    return new TextDecoder().decode(decrypted)
  } catch {
    throw new Error(DECRYPTION_FAILED_MESSAGE)
  }
}

const DECRYPTION_FAILED_MESSAGE =
  'Decryption failed. This could mean:\n' +
  '1. The encryption key is incorrect\n' +
  '2. The data was tampered with\n' +
  '3. The signature used for key derivation was different'

/**
 * Decrypt with the first key that works, from `deriveEncryptionKeyCandidates`.
 *
 * GCM authenticates, so a wrong key fails cleanly rather than returning garbage —
 * trialling keys cannot produce a false positive.
 */
export async function decryptDataWithCandidates(
  ciphertext: string,
  iv: string,
  tag: string,
  keys: Uint8Array[],
): Promise<string> {
  for (const key of keys) {
    try {
      return await decryptData(ciphertext, iv, tag, key)
    } catch {
      continue
    }
  }
  throw new Error(DECRYPTION_FAILED_MESSAGE)
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

  const keys = await deriveEncryptionKeyCandidates(
    l1Address,
    signature,
    effectiveDomain,
    operation.encryptedVersion,
  )
  const plaintext = await decryptDataWithCandidates(
    operation.encryptedCiphertext,
    operation.encryptedIv,
    operation.encryptedTag,
    keys,
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
