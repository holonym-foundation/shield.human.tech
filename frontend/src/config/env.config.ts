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
export const AZTEC_NODE_TESTNET = process.env.NEXT_PUBLIC_AZTEC_NODE_TESTNET ?? 'https://rpc.testnet.aztec-labs.com'
export const AZTEC_NODE_MAINNET = process.env.NEXT_PUBLIC_AZTEC_NODE_MAINNET ?? 'https://aztec-mainnet.drpc.org'

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
export const HOLONYM_API_URL = process.env.HOLONYM_API_URL ?? 'https://api.holonym.io'
export const PASSPORT_API_KEY = process.env.PASSPORT_API_KEY ?? ''
export const PASSPORT_SCORER_ID = process.env.PASSPORT_SCORER_ID ?? ''

// ─── Datadog (client) ───────────────────────────────────────────────

export const DATADOG_APPLICATION_ID = process.env.NEXT_PUBLIC_DATADOG_APPLICATION_ID ?? ''
export const DATADOG_CLIENT_TOKEN = process.env.NEXT_PUBLIC_DATADOG_CLIENT_TOKEN ?? ''
export const DATADOG_SITE = process.env.NEXT_PUBLIC_DATADOG_SITE ?? ''
export const DATADOG_SERVICE = process.env.NEXT_PUBLIC_DATADOG_SERVICE ?? ''
export const DATADOG_ENV = process.env.NEXT_PUBLIC_DATADOG_ENV ?? process.env.NODE_ENV ?? 'production'
export const DATADOG_LOGS_CLIENT_TOKEN = process.env.NEXT_PUBLIC_DATADOG_LOGS_CLIENT_TOKEN ?? ''

// ─── Misc (client) ──────────────────────────────────────────────────

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0'
