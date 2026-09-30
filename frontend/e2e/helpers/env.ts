/**
 * Server config for the e2e run.
 *
 * `src/config/env.config.ts` reads `process.env` once at module load, so these
 * have to be in place before any route module is imported — vitest applies them
 * through `test.env` in vitest.e2e.config.ts, and this file is the single
 * description of what they mean.
 *
 * The keys are throwaway constants, not secrets: they only have to be
 * well-formed (a valid secp256k1 scalar for the L1 signers, a valid BN254 field
 * element for the L2 Schnorr keys) so the signing paths execute for real and
 * the tests can recover the signer from the signature.
 */
export const E2E_ENV = {
  // Long enough for the minimum the signer enforces: HS256 is a keyed hash, so a
  // short secret is recoverable offline from any issued token.
  JWT_SECRET: 'e2e-jwt-secret-0000000000000000000',
  AUTH_EXPECTED_DOMAIN: 'e2e.shield.test',

  PASSPORT_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  POCH_ATTESTER_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  L2_PASSPORT_SIGNER_PRIVATE_KEY: `0x${'13'.repeat(32)}`,
  L2_POCH_ATTESTER_PRIVATE_KEY: `0x${'24'.repeat(32)}`,

  PASSPORT_API_KEY: 'e2e-passport-key',
  PASSPORT_SCORER_ID: 'e2e-scorer',
  PASSPORT_SCORE_THRESHOLD: '20',
  // 1000 USDC (6 decimals) per transaction.
  PASSPORT_MAX_AMOUNT: '1000000000',

  BRIDGE_MAX_DEPOSIT_USD: '25000',
  TRAVEL_RULE_THRESHOLD_USD: '1000',

  SANCTIONS_SCREENING_ENABLED: 'true',
  SANCTIONS_IO_API_KEY: 'e2e-sanctions-key',

  // The hold resolver reads the portals' nonce mappings to decide whether an
  // expired hold was abandoned. Point it at a host the upstream stub answers, so
  // that decision is steerable instead of permanently unreadable.
  NEXT_PUBLIC_L1_RPC_SEPOLIA: 'https://l1-rpc.e2e.test',
} as const

export const E2E_ORIGIN = `https://${E2E_ENV.AUTH_EXPECTED_DOMAIN}`
