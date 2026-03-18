/**
 * Shared input validation and sanitization for API routes.
 *
 * Stack: Zod (schema validation) + validator.js (escape) + sanitize-html (strip HTML).
 *
 * Two sanitization pipelines:
 *
 *   1. `stripHtml` — trim + strip all HTML tags. Used for structured data
 *      (URLs, encrypted payloads, SIWE messages, signatures) where
 *      validator.escape() would mangle valid characters like : / = +
 *
 *   2. `sanitize` — trim + strip HTML + validator.escape(). Used for
 *      free-text fields rendered in the browser (token names, error
 *      messages, display amounts) where XSS is the risk.
 *
 * Regex-validated fields (hex, addresses, numeric strings) don't need
 * either pipeline — their character sets cannot contain HTML.
 *
 * No length limits — Prisma / DB schema handles column sizes.
 */

import { z } from 'zod'
import validator from 'validator'
import sanitizeHtml from 'sanitize-html'

// ─── Core sanitize pipelines ──────────────────────────────────────────

/** Strip all HTML tags and trim whitespace. Safe for structured data. */
function stripHtml(str: string): string {
  const stripped = sanitizeHtml(str, { allowedTags: [], allowedAttributes: {} })
  return validator.trim(stripped)
}

/** Strip HTML tags, trim, AND escape special chars (&<>"'). For display text only. */
function sanitize(str: string): string {
  return validator.escape(stripHtml(str))
}

// ─── Regex patterns ─────────────────────────────────────────────────────

/** Ethereum address: 0x followed by 40 hex chars. */
export const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/

/** Ethereum tx hash: 0x followed by 64 hex chars. */
export const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/

/** Hex string (with 0x prefix, variable length). Used for Aztec addresses and message hashes. */
export const HEX_STRING_REGEX = /^0x[a-fA-F0-9]+$/

/** Numeric string (non-negative integer). Used for amounts, block numbers, and leaf indices. */
export const NUMERIC_STRING_REGEX = /^\d+$/

// ─── Zod primitives ────────────────────────────────────────────────────

/**
 * Display text: trim + strip HTML + escape.
 * Use for fields that get rendered in the browser (token names, error messages, etc.).
 */
export const zDisplayText = z.string().transform(sanitize).pipe(z.string().min(1))

/**
 * Structured string: trim + strip HTML (no escape).
 * Use for fields with special chars that must be preserved
 * (URLs, SIWE messages, signatures, encrypted payloads, etc.).
 */
export const zCleanString = z.string().transform(stripHtml).pipe(z.string().min(1))

/**
 * Ethereum address: 0x + 40 hex chars → lowercase.
 * Regex rejects all non-hex chars, so no HTML stripping needed.
 */
export const zEthAddress = z
  .string()
  .trim()
  .regex(ETH_ADDRESS_REGEX, 'Must be 0x + 40 hex chars')
  .transform((s) => s.toLowerCase())

/**
 * Hex string (0x-prefixed, variable length) → lowercase.
 * Used for Aztec addresses and message hashes.
 */
export const zHexString = z
  .string()
  .trim()
  .regex(HEX_STRING_REGEX, 'Must be 0x-prefixed hex')
  .transform((s) => s.toLowerCase())

/** Ethereum tx hash: 0x + 64 hex chars → lowercase. */
export const zTxHash = z
  .string()
  .trim()
  .regex(TX_HASH_REGEX, 'Must be 0x + 64 hex chars')
  .transform((s) => s.toLowerCase())

/** Numeric string (non-negative integer, as string). Used for amounts, block numbers. */
export const zNumericString = z.string().trim().regex(NUMERIC_STRING_REGEX, 'Must be a numeric string')

/** URL (http or https only). */
export const zUrl = z
  .string()
  .trim()
  .refine(
    (s) => {
      try {
        const url = new URL(s)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    },
    { message: 'Must be a valid http/https URL' },
  )

/** URL or relative asset path (e.g. /assets/tokens/usdc.svg). */
export const zUrlOrPath = z
  .string()
  .trim()
  .refine(
    (s) => {
      // Check absolute URL
      try {
        const url = new URL(s)
        if (url.protocol === 'http:' || url.protocol === 'https:') return true
      } catch {
        // Not an absolute URL — check relative path
      }
      return /^\/[a-zA-Z0-9_\-/.]+$/.test(s)
    },
    { message: 'Must be a valid URL or relative path' },
  )

/** Finite integer (from number or numeric string). */
export const zInt = z
  .union([z.number(), z.string().transform(Number)])
  .pipe(z.number().int().finite())

/** Boolean (strict). */
export const zBoolean = z.boolean()

/**
 * Ciphertext: strip HTML + trim (no escape — base64 uses + / = chars).
 */
export const zCiphertext = z.string().transform(stripHtml).pipe(z.string().min(1))

/**
 * Sibling path: array of hex strings, each validated and lowercased.
 */
export const zSiblingPath = z.array(zHexString)

/**
 * NodeInfo: plain object, stripped of prototype via JSON round-trip.
 */
export const zNodeInfo = z
  .record(z.string(), z.unknown())
  .transform((obj) => JSON.parse(JSON.stringify(obj)) as Record<string, unknown>)

// ─── Route-level schemas ───────────────────────────────────────────────

/** POST /api/bridge/operations — Create a new bridge operation. */
export const CreateOperationSchema = z.object({
  // Encrypted payload (structured — no escape)
  encryptedCiphertext: zCiphertext,
  encryptedIv: zCleanString,
  encryptedTag: zCleanString,
  keyDerivationMessage: zCleanString,
  keyDerivationDomain: zCleanString,
  // Direction
  direction: z.enum(['L1_TO_L2', 'L2_TO_L1']),
  // Addresses
  l1Address: zEthAddress,
  l2Address: zHexString,
  // Amounts
  amountL1: zNumericString,
  amountL2: zNumericString,
  amountDisplayL1: zDisplayText.optional(),
  amountDisplayL2: zDisplayText.optional(),
  // Options
  isPrivacyModeEnabled: zBoolean.optional(),
  // Block numbers
  l1BlockNumberBeforeTx: zNumericString.optional(),
  l2BlockNumberBeforeTx: zNumericString.optional(),
  // L2→L1 recipient
  recipientL1Address: zEthAddress.optional(),
  // Node info
  nodeInfo: zNodeInfo.optional(),
  // Recovery-critical contract & version snapshot
  rollupVersion: zInt.optional(),
  chainIdL1: zInt.optional(),
  chainIdL2: zInt.optional(),
  portalAddressL1: zEthAddress.optional(),
  bridgeAddressL2: zHexString.optional(),
  l1RollupAddress: zEthAddress.optional(),
  l1OutboxAddress: zEthAddress.optional(),
  l1InboxAddress: zEthAddress.optional(),
  l1RegistryAddress: zEthAddress.optional(),
  // Token info (display text — escaped)
  tokenSymbol: zDisplayText.optional(),
  tokenSymbolL1: zDisplayText.optional(),
  tokenSymbolL2: zDisplayText.optional(),
  tokenNameL1: zDisplayText.optional(),
  tokenNameL2: zDisplayText.optional(),
  tokenAddressL1: zEthAddress.optional(),
  tokenAddressL2: zHexString.optional(),
  tokenDecimalsL1: zInt.optional(),
  tokenDecimalsL2: zInt.optional(),
  tokenLogoUrlL1: zUrlOrPath.optional(),
  tokenLogoUrlL2: zUrlOrPath.optional(),
  // Progress
  currentStep: zInt.optional(),
})

/** PATCH /api/bridge/operations/:id — Update a bridge operation. */
export const PatchOperationSchema = z.object({
  status: z
    .enum([
      'pending', 'deposited', 'claimed', 'submitted',
      'ready', 'pending_finalize', 'completed', 'failed',
    ])
    .optional(),
  // L1 transaction
  l1TxHash: zTxHash.optional(),
  l1TxUrl: zUrl.optional(),
  // L1→L2 message
  messageHash: zHexString.optional(),
  messageLeafIndex: zNumericString.optional(),
  // L2 transaction (l2TxHash is an Aztec tx effect hash — structured, not display text)
  l2TxHash: zCleanString.optional(),
  l2TxUrl: zUrl.optional(),
  lastErrorMessage: zDisplayText.optional(),
  // Completion
  completedAt: zCleanString.optional(),
  // L2→L1 withdrawal fields
  l2BlockNumber: zNumericString.optional(),
  l2BlockNumberBeforeTx: zNumericString.optional(),
  l2ToL1MessageIndex: zNumericString.optional(),
  siblingPath: zSiblingPath.optional(),
  recipientL1Address: zEthAddress.optional(),
  currentStep: zInt.optional(),
  // Fuel fields
  fuelMessageHash: zHexString.optional(),
  fuelMessageLeafIndex: zNumericString.optional(),
  fuelAmount: zNumericString.optional(),
  // Confirmed block number
  l1BlockNumber: zNumericString.optional(),
  // L1→L2 post-fee amount
  amountAfterFee: zNumericString.optional(),
  // L2→L1 witness epoch
  epoch: zInt.optional(),
  // Immutable fields — included so we can detect and reject them
  encryptedCiphertext: z.unknown().optional(),
  encryptedIv: z.unknown().optional(),
  encryptedTag: z.unknown().optional(),
  amountL1: z.unknown().optional(),
  amountL2: z.unknown().optional(),
  direction: z.unknown().optional(),
  l1BlockNumberBeforeTx: z.unknown().optional(),
  keyDerivationMessage: z.unknown().optional(),
  keyDerivationDomain: z.unknown().optional(),
  rollupVersion: z.unknown().optional(),
  chainIdL1: z.unknown().optional(),
  chainIdL2: z.unknown().optional(),
  portalAddressL1: z.unknown().optional(),
  bridgeAddressL2: z.unknown().optional(),
  tokenAddressL1: z.unknown().optional(),
  tokenAddressL2: z.unknown().optional(),
  l1RollupAddress: z.unknown().optional(),
  l1OutboxAddress: z.unknown().optional(),
  l1InboxAddress: z.unknown().optional(),
  l1RegistryAddress: z.unknown().optional(),
})

/** POST /api/auth/authenticate — SIWE auth body. */
export const AuthenticateSchema = z.object({
  // SIWE message and signature contain special chars — no escape
  message: zCleanString,
  signature: zCleanString,
  // Login metadata (display text — escaped)
  l1LoginMethod: zDisplayText.optional(),
  l1WalletProvider: zDisplayText.optional(),
  l2LoginMethod: zDisplayText.optional(),
  l2WalletProvider: zDisplayText.optional(),
})

/** POST /api/attestation/passport — Attestation request body. */
export const PassportAttestationSchema = z.object({
  portalAddress: zEthAddress,
  bridgeAddress: zCleanString.optional(),
  deadline: zInt.optional(),
})

/** POST /api/attestation/poch — POCH attestation request body. */
export const PochAttestationSchema = z.object({
  portalAddress: zEthAddress,
})

// ─── Immutable fields list (for PATCH guard) ───────────────────────────

export const IMMUTABLE_FIELDS = [
  'encryptedCiphertext',
  'encryptedIv',
  'encryptedTag',
  'amountL1',
  'amountL2',
  'direction',
  'l1BlockNumberBeforeTx',
  'l2BlockNumberBeforeTx',
  'keyDerivationMessage',
  'keyDerivationDomain',
  'rollupVersion',
  'chainIdL1',
  'chainIdL2',
  'portalAddressL1',
  'bridgeAddressL2',
  'tokenAddressL1',
  'tokenAddressL2',
  'l1RollupAddress',
  'l1OutboxAddress',
  'l1InboxAddress',
  'l1RegistryAddress',
] as const

/** Write-once fields: can be set when DB value is null, never overwritten. */
export const WRITE_ONCE_FIELDS = new Set([
  'messageHash',
  'l1TxHash',
  'l1TxUrl',
  'l2TxHash',
  'l2TxUrl',
  'l2BlockNumber',
  'l1BlockNumber',
  'fuelMessageHash',
  'fuelMessageLeafIndex',
  'fuelAmount',
  'amountAfterFee',
])

/** Valid forward-only status transitions. */
export const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ['submitted', 'deposited', 'completed', 'failed'],
  deposited: ['claimed', 'completed', 'failed'],
  claimed: ['completed', 'failed'],
  submitted: ['ready', 'pending_finalize', 'completed', 'failed'],
  ready: ['pending_finalize', 'completed', 'failed'],
  pending_finalize: ['completed', 'failed'],
}
