/**
 * Shared input validation and sanitization helpers for API routes.
 *
 * All user-facing string inputs should be trimmed and length-limited before
 * being written to the database to prevent oversized payloads, injection
 * attempts, and accidental whitespace issues.
 */

import { z } from 'zod'

// ─── Regex patterns (declared first so Zod schemas below can reference them) ─

/** Ethereum address: 0x followed by 40 hex chars. */
export const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

/** Ethereum tx hash: 0x followed by 64 hex chars. */
export const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/

/** Hex string (with 0x prefix, variable length). Used for Aztec addresses and message hashes. */
export const HEX_STRING_REGEX = /^0x[a-fA-F0-9]+$/

/** Numeric string (non-negative integer). Used for amounts, block numbers, and leaf indices. */
export const NUMERIC_STRING_REGEX = /^\d+$/

// ─── Zod Schemas ──────────────────────────────────────────────────────

/** Schema for POST /api/auth/authenticate.
 *  Bound message/signature length so an attacker can't post megabytes
 *  of payload and force the SIWE parser/verifier to do meaningful work. */
export const AuthenticateSchema = z.object({
  // SIWE messages are typically ~500-800 chars; 2048 is generous.
  message: z.string().min(1).max(2048),
  // ECDSA hex signatures are 132 chars; 256 is generous.
  signature: z.string().min(1).max(256),
  l1LoginMethod: z.string().max(64).optional(),
  l1WalletProvider: z.string().max(64).optional(),
  l2LoginMethod: z.string().max(64).optional(),
  l2WalletProvider: z.string().max(64).optional(),
})

/** Schema for POST /api/attestation/passport.
 *  portalAddress is REQUIRED — the L1 ECDSA passport attestation is bound
 *  to a specific TokenPortal so the signature can't be replayed against any
 *  other portal. Allowing it to be optional + signing `?? ''` produced
 *  wildcard-binding attestations. */
export const PassportAttestationSchema = z.object({
  l2Address: z.string().min(1),
  isPrivate: z.boolean().optional().default(false),
  bridgeAddress: z.string().regex(ETH_ADDRESS_REGEX, 'bridgeAddress must be 0x + 40 hex chars').optional(),
  portalAddress: z.string().regex(ETH_ADDRESS_REGEX, 'portalAddress must be 0x + 40 hex chars'),
  deadline: z.number().int().nonnegative().optional(),
})

/** Schema for POST /api/attestation/poch */
export const PochAttestationSchema = z.object({
  l2Address: z.string().min(1),
  isPrivate: z.boolean().optional().default(false),
})

// ─── Length limits ──────────────────────────────────────────────────────

/** Max length for standard string fields (tx hashes, addresses, URLs). */
export const MAX_STRING_LENGTH = 512

/** Max length for error messages stored in the DB. */
export const MAX_ERROR_LENGTH = 500

/** Max length for encrypted ciphertext (base64-encoded AES-256-GCM). */
export const MAX_CIPHERTEXT_LENGTH = 10_000

/** Max length for nodeInfo JSON when serialized. */
export const MAX_NODE_INFO_LENGTH = 20_000

/** Max length for a single sibling path entry. */
export const MAX_SIBLING_PATH_ENTRY_LENGTH = 200

/** Max number of sibling path entries. */
export const MAX_SIBLING_PATH_ENTRIES = 128

// ─── Sanitization helpers ───────────────────────────────────────────────

/** Trim and limit a string field. Returns undefined if input is falsy. */
export function sanitizeString(value: unknown, maxLength: number = MAX_STRING_LENGTH): string | undefined {
  if (value == null || typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.length) return undefined
  return trimmed.slice(0, maxLength)
}

/** Sanitize and validate an Ethereum address (0x + 40 hex). Returns lowercase or undefined. */
export function sanitizeEthAddress(value: unknown): string | undefined {
  const s = sanitizeString(value, 42)
  if (!s || !ETH_ADDRESS_REGEX.test(s)) return undefined
  return s.toLowerCase()
}

/** Sanitize and validate a hex string (0x-prefixed). Returns lowercase or undefined. */
export function sanitizeHexString(value: unknown, maxLength: number = MAX_STRING_LENGTH): string | undefined {
  const s = sanitizeString(value, maxLength)
  if (!s || !HEX_STRING_REGEX.test(s)) return undefined
  return s.toLowerCase()
}

/** Sanitize and validate an Ethereum tx hash (0x + 64 hex). Returns lowercase or undefined. */
export function sanitizeTxHash(value: unknown): string | undefined {
  const s = sanitizeString(value, 66)
  if (!s || !TX_HASH_REGEX.test(s)) return undefined
  return s.toLowerCase()
}

/** Sanitize and validate a numeric string (integer). Returns the string or undefined. */
export function sanitizeNumericString(value: unknown): string | undefined {
  const s = sanitizeString(value, 78) // max 78 digits covers uint256
  if (!s || !NUMERIC_STRING_REGEX.test(s)) return undefined
  return s
}

/** Known-good explorer URL prefixes for transaction links. */
const ALLOWED_URL_PREFIXES = [
  'https://etherscan.io/',
  'https://sepolia.etherscan.io/',
  'https://goerli.etherscan.io/',
  'https://holesky.etherscan.io/',
  'https://aztec.network/',
  'https://aztecscan.io/',
  'https://aztecscan.xyz/',
  'https://devnet.aztecscan.xyz/',
  'https://testnet.aztecscan.xyz/',
  'https://aztecexplorer.xyz/',
]

/** Sanitize a URL string. Only allows known explorer hosts. Returns trimmed URL or undefined. */
export function sanitizeUrl(value: unknown): string | undefined {
  const s = sanitizeString(value, 2048)
  if (!s) return undefined
  try {
    const url = new URL(s)
    if (url.protocol !== 'https:') return undefined
    if (!ALLOWED_URL_PREFIXES.some((prefix) => s.startsWith(prefix))) return undefined
    return s
  } catch {
    return undefined
  }
}

/** Validate an integer is within range. Returns the value or undefined if out of range. */
export function sanitizeInt(value: unknown, min: number = 0, max: number = 1000): number | undefined {
  if (value == null) return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined
  if (n < min || n > max) return undefined
  return n
}

/** Validate a boolean. Returns the boolean or undefined. */
export function sanitizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  return undefined
}

/**
 * Sanitize ciphertext: reject (not truncate) if oversized, since truncation
 * would silently corrupt encrypted data and make it unrecoverable.
 */
export function sanitizeCiphertext(value: unknown, maxLength: number = MAX_CIPHERTEXT_LENGTH): string | undefined {
  if (value == null || typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed.length) return undefined
  if (trimmed.length > maxLength) return undefined // reject, don't truncate
  return trimmed
}

/**
 * Sanitize nodeInfo JSON object.
 * Ensures it's a plain object, strips prototype chains via JSON round-trip,
 * and enforces serialized size limits.
 */
export function sanitizeNodeInfo(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length > MAX_NODE_INFO_LENGTH) return undefined
    return JSON.parse(serialized) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Sanitize siblingPath array.
 * Ensures each entry is a valid hex string and the array isn't too large.
 */
export function sanitizeSiblingPath(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length > MAX_SIBLING_PATH_ENTRIES) return undefined
  const sanitized: string[] = []
  for (const entry of value) {
    const s = sanitizeHexString(entry, MAX_SIBLING_PATH_ENTRY_LENGTH)
    if (!s) return undefined // invalid entry (not valid hex) → reject entire path
    sanitized.push(s)
  }
  return sanitized
}
