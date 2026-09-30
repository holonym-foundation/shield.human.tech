/**
 * Centralized environment variable config.
 *
 * All env vars are read here — no other file should use `process.env` directly
 * (except NODE_ENV checks). Import what you need from this module.
 *
 * Client-side vars need NEXT_PUBLIC_ prefix. Server-only vars don't.
 * This file runs on both client and server — guard server-only vars with
 * typeof window === 'undefined' if needed.
 */

// ─── Network (client + server) ──────────────────────────────────────

export const L1_RPC_SEPOLIA = process.env.NEXT_PUBLIC_L1_RPC_SEPOLIA ?? ''
export const L1_RPC_MAINNET = process.env.NEXT_PUBLIC_L1_RPC_MAINNET ?? ''

export const AZTEC_NODE_DEVNET = process.env.NEXT_PUBLIC_AZTEC_NODE_DEVNET ?? 'https://v4-devnet-3.aztec-labs.com'
export const AZTEC_NODE_TESTNET = process.env.NEXT_PUBLIC_AZTEC_NODE_TESTNET ?? 'https://v5.testnet.rpc.aztec-labs.com'
export const AZTEC_NODE_MAINNET = process.env.NEXT_PUBLIC_AZTEC_NODE_MAINNET ?? 'https://lb.drpc.live/aztec-mainnet/AhqdYXubU0sPoLfwNfap2bZnSOPShQgR8ankwosiOHdW'

export const L1_CHAIN_ID_SEPOLIA = Number(process.env.NEXT_PUBLIC_L1_CHAIN_ID_SEPOLIA ?? '11155111')
export const L1_CHAIN_ID_MAINNET = Number(process.env.NEXT_PUBLIC_L1_CHAIN_ID_MAINNET ?? '1')

export const AZTEC_ENV = (process.env.NEXT_PUBLIC_AZTEC_ENV ?? '') as 'devnet' | 'testnet' | 'mainnet' | ''

// ─── WalletConnect (client) ─────────────────────────────────────────

export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? ''

// ─── Alchemy (server) ───────────────────────────────────────────────

export const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY ?? ''

// ─── Faucet / Mint (server) ─────────────────────────────────────────

export const FAUCET_PRIVATE_KEY = process.env.FAUCET_PRIVATE_KEY ?? ''

// ─── Auth (server) ──────────────────────────────────────────────────

export const JWT_SECRET = process.env.JWT_SECRET ?? ''
// There is no revocation path, so this is the only bound on a stolen token.
// Shorten it with JWT_EXPIRES_IN; the cost is a SIWE re-signature that often.
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? '7d'

// ─── Attestation (server) ───────────────────────────────────────────

export const POCH_ATTESTER_PRIVATE_KEY = process.env.POCH_ATTESTER_PRIVATE_KEY ?? ''
export const PASSPORT_SIGNER_PRIVATE_KEY = process.env.PASSPORT_SIGNER_PRIVATE_KEY ?? ''
export const L2_POCH_ATTESTER_PRIVATE_KEY = process.env.L2_POCH_ATTESTER_PRIVATE_KEY ?? ''
export const L2_PASSPORT_SIGNER_PRIVATE_KEY = process.env.L2_PASSPORT_SIGNER_PRIVATE_KEY ?? ''
export const CLEAN_HANDS_CIRCUIT_ID =
  process.env.CLEAN_HANDS_CIRCUIT_ID ?? '0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19'
export const CLEAN_HANDS_ACTION_ID = process.env.CLEAN_HANDS_ACTION_ID ?? '123456789'
export const PASSPORT_SCORE_THRESHOLD = process.env.PASSPORT_SCORE_THRESHOLD ?? '20'
export const PASSPORT_MAX_AMOUNT = process.env.PASSPORT_MAX_AMOUNT ?? '1000000000'
// Alpha Mainnet per-user, per-day (rolling 24h) deposit cap (USD). '' or '0' disables it.
export const BRIDGE_MAX_DEPOSIT_USD = process.env.BRIDGE_MAX_DEPOSIT_USD ?? '25000'
// Cumulative per-human lifetime volume (USD) above which the passport tier is
// refused and POCH (Clean Hands) is required. '' or '0' disables it.
export const TRAVEL_RULE_THRESHOLD_USD = process.env.TRAVEL_RULE_THRESHOLD_USD ?? '1000'
export const HOLONYM_API_URL = process.env.HOLONYM_API_URL ?? 'https://api.holonym.io'
export const PASSPORT_API_KEY = process.env.PASSPORT_API_KEY ?? ''
export const PASSPORT_SCORER_ID = process.env.PASSPORT_SCORER_ID ?? ''

// ─── Passport embed (client) ────────────────────────────────────────
// The in-app Passport score widget runs in the browser but never holds the
// API key: its embed calls are routed through the same-origin proxy at
// /api/passport-embed, which injects the server-only PASSPORT_API_KEY. So the
// only client-side inputs are a keyless on/off flag and the (non-secret)
// scorer id used to build the request path. When the flag is unset the app
// falls back to the out-link to app.passport.xyz (see ./index).
export const NEXT_PUBLIC_PASSPORT_EMBED_ENABLED = process.env.NEXT_PUBLIC_PASSPORT_EMBED_ENABLED ?? ''
export const NEXT_PUBLIC_PASSPORT_SCORER_ID = process.env.NEXT_PUBLIC_PASSPORT_SCORER_ID ?? ''

// ─── Sanctions screening (server) ───────────────────────────────────

export const SANCTIONS_IO_API_KEY = process.env.SANCTIONS_IO_API_KEY ?? ''
export const SANCTIONS_IO_API_URL = process.env.SANCTIONS_IO_API_URL ?? 'https://api.sanctions.io/search/'
export const SANCTIONS_IO_API_VERSION = process.env.SANCTIONS_IO_API_VERSION ?? '2.3'
export const SANCTIONS_IO_MIN_SCORE = process.env.SANCTIONS_IO_MIN_SCORE ?? '0.88'
// Ops kill switch — flip to 'false' to bypass screening during a vendor outage.
export const SANCTIONS_SCREENING_ENABLED = (process.env.SANCTIONS_SCREENING_ENABLED ?? 'true') !== 'false'

// ─── Auth (server) ──────────────────────────────────────────────────

/**
 * Extra SIWE/app host(s) this deployment answers on, single or comma-separated.
 * Additive only, and never another environment's host: the deployment's own
 * host already comes from the network it serves, and the signed domain is all
 * a user sees before approving, so it has to denote one environment.
 */
export const AUTH_EXPECTED_DOMAIN = process.env.AUTH_EXPECTED_DOMAIN ?? ''

// ─── PostHog (client) ───────────────────────────────────────────────

export const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? ''
export const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://eu.i.posthog.com'

// ─── Datadog (client) ───────────────────────────────────────────────

export const DATADOG_SITE = process.env.NEXT_PUBLIC_DATADOG_SITE ?? ''
export const DATADOG_SERVICE = process.env.NEXT_PUBLIC_DATADOG_SERVICE ?? ''
export const DATADOG_ENV = process.env.NEXT_PUBLIC_DATADOG_ENV ?? process.env.NODE_ENV ?? 'production'
export const DATADOG_LOGS_CLIENT_TOKEN = process.env.NEXT_PUBLIC_DATADOG_LOGS_CLIENT_TOKEN ?? ''

// ─── Misc (client) ──────────────────────────────────────────────────

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0'
