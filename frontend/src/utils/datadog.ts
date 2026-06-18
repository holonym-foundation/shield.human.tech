import { datadogLogs } from '@datadog/browser-logs'
import { DATADOG_SITE, DATADOG_SERVICE, DATADOG_ENV, DATADOG_LOGS_CLIENT_TOKEN } from '@/config/env.config'

export function init() {
  // Only initialize on client-side
  if (typeof window === 'undefined') {
    return
  }

  if (process.env.NODE_ENV === 'development') {
    return
  }

  datadogLogs.init({
    clientToken: DATADOG_LOGS_CLIENT_TOKEN,
    site: DATADOG_SITE,
    service: DATADOG_SERVICE,
    env: DATADOG_ENV,
    forwardErrorsToLogs: true,
    forwardConsoleLogs: ['error'],
    sessionSampleRate: 100,
  })
}

export function logInfo(message: string, messageContext?: object | undefined, error?: Error | undefined) {
  // Only log on client-side
  if (typeof window === 'undefined') {
    console.log('logInfo (server):', message, messageContext)
    return
  }

  datadogLogs.logger.info(
    message,
    {
      ...messageContext,
      src: 'shield-human-tech',
    },
    error,
  )
}

export function logError(message: string, messageContext?: object | undefined, error?: Error | undefined) {
  // Only log on client-side
  if (typeof window === 'undefined') {
    console.error('logError (server):', message, messageContext, error)
    return
  }

  datadogLogs.logger.error(
    message,
    {
      ...messageContext,
      src: 'shield-human-tech',
    },
    error as Error,
  )
}

/**
 * Single source of truth for `userAction` tags emitted to Datadog. Use
 * `DatadogUserAction.X` instead of inline string literals so renames and
 * find-references work across the codebase. Tag string values must remain
 * stable — dashboards and alerts key off these exact strings.
 */
export const DatadogUserAction = {
  // ── Session ────────────────────────────────────────────────────
  SESSION_START: 'session_start',

  // ── Wallet (WAAP) ──────────────────────────────────────────────
  WAAP_WALLET_CONNECTION_ATTEMPT: 'waap_wallet_connection_attempt',
  WAAP_WALLET_CONNECTION_COMPLETED: 'waap_wallet_connection_completed',
  WAAP_WALLET_CONNECTION_FAILURE: 'waap_wallet_connection_failure',
  WAAP_WALLET_DISCONNECTION_ATTEMPT: 'waap_wallet_disconnection_attempt',
  WAAP_WALLET_DISCONNECTION_FAILURE: 'waap_wallet_disconnection_failure',
  WAAP_WALLET_DISCONNECTION_SUCCESS: 'waap_wallet_disconnection_success',

  // ── Wallet (Aztec) ─────────────────────────────────────────────
  AZTEC_WALLET_CHANNEL_FAILED: 'aztec_wallet_channel_failed',
  AZTEC_WALLET_CONFIRM_FAILED: 'aztec_wallet_confirm_failed',
  AZTEC_WALLET_CONNECTION_ATTEMPT: 'aztec_wallet_connection_attempt',
  AZTEC_WALLET_CONNECTION_FAILURE: 'aztec_wallet_connection_failure',
  AZTEC_WALLET_CONNECTION_SUCCESS: 'aztec_wallet_connection_success',
  AZTEC_WALLET_DISCONNECTION_ATTEMPT: 'aztec_wallet_disconnection_attempt',
  AZTEC_WALLET_DISCONNECTION_FAILURE: 'aztec_wallet_disconnection_failure',
  AZTEC_WALLET_DISCONNECTION_SUCCESS: 'aztec_wallet_disconnection_success',
  AZTEC_WALLET_DISCOVERY_START: 'aztec_wallet_discovery_start',

  // ── Wallet (generic) ──────────────────────────────────────────
  WALLET_CONNECTION_ATTEMPT: 'wallet_connection_attempt',
  WALLET_CONNECTION_FAILURE: 'wallet_connection_failure',

  // ── Faucet ────────────────────────────────────────────────────
  FAUCET_REDIRECT: 'faucet_redirect',
  FAUCET_REQUEST_INITIATED: 'faucet_request_initiated',
  FAUCET_REQUEST_FAILED: 'faucet_request_failed',
  FAUCET_REQUEST_SUCCESSFUL: 'faucet_request_successful',

  // ── Bridge L1→L2 (fresh) ──────────────────────────────────────
  BRIDGE_L1_TO_L2_INITIATED: 'bridge_l1_to_l2_initiated',
  BRIDGE_L1_TO_L2_CREATED: 'bridge_l1_to_l2_created',
  BRIDGE_L1_TO_L2_DEPOSIT_SENT: 'bridge_l1_to_l2_deposit_sent',
  BRIDGE_L1_TO_L2_DEPOSIT_CONFIRMED: 'bridge_l1_to_l2_deposit_confirmed',
  BRIDGE_L1_TO_L2_SEQUENCER_WAIT: 'bridge_l1_to_l2_sequencer_wait',
  BRIDGE_L1_TO_L2_SYNC_POLL: 'bridge_l1_to_l2_sync_poll',
  BRIDGE_L1_TO_L2_CLAIM_ATTEMPT: 'bridge_l1_to_l2_claim_attempt',
  BRIDGE_L1_TO_L2_CLAIM_RETRY: 'bridge_l1_to_l2_claim_retry',
  BRIDGE_L1_TO_L2_COMPLETED: 'bridge_l1_to_l2_completed',
  BRIDGE_PATCH_FAILED: 'bridge_patch_failed',
  BRIDGE_ATTESTATION_FETCH: 'bridge_attestation_fetch',
  BRIDGE_ATTESTATION_FALLBACK: 'bridge_attestation_fallback',

  // ── Bridge L2→L1 (withdrawal) ─────────────────────────────────
  WITHDRAWAL_L2_TO_L1_INITIATED: 'withdrawal_l2_to_l1_initiated',
  WITHDRAWAL_L2_TO_L1_CREATED: 'withdrawal_l2_to_l1_created',
  WITHDRAWAL_L2_TO_L1_BURN_SENT: 'withdrawal_l2_to_l1_burn_sent',
  WITHDRAWAL_L2_TO_L1_BURN_CONFIRMED: 'withdrawal_l2_to_l1_burn_confirmed',
  WITHDRAWAL_L2_TO_L1_RECOVERED_L2_BLOCK: 'withdrawal_l2_to_l1_recovered_l2_block',
  WITHDRAWAL_L2_TO_L1_WITNESS_COMPUTED: 'withdrawal_l2_to_l1_witness_computed',
  BRIDGE_L2_TO_L1_PROVEN_POLL: 'bridge_l2_to_l1_proven_poll',
  BRIDGE_L2_TO_L1_PROVEN_FALLBACK: 'bridge_l2_to_l1_proven_fallback',
  WITHDRAWAL_L2_TO_L1_L1_WITHDRAW_SENT: 'withdrawal_l2_to_l1_l1_withdraw_sent',
  WITHDRAWAL_ATTESTATION_FETCH: 'withdrawal_attestation_fetch',
  WITHDRAWAL_ATTESTATION_FALLBACK: 'withdrawal_attestation_fallback',
  WITHDRAWAL_PATCH_FAILED: 'withdrawal_patch_failed',
  WITHDRAWAL_L2_TO_L1_COMPLETED: 'withdrawal_l2_to_l1_completed',
  WITHDRAWAL_L2_TO_L1_CALLBACK: 'withdrawal_l2_to_l1_callback',

  // ── Resume L1→L2 ──────────────────────────────────────────────
  RESUME_L1_TO_L2_FROM_RECEIPT: 'resume_l1_to_l2_from_receipt',
  RESUME_L1_TO_L2_BLOCK_SCAN: 'resume_l1_to_l2_block_scan',
  RESUME_L1_TO_L2_SEQUENCER_WAIT: 'resume_l1_to_l2_sequencer_wait',
  RESUME_L1_TO_L2_SYNC_POLL: 'resume_l1_to_l2_sync_poll',
  RESUME_L1_TO_L2_CLAIM_ATTEMPT: 'resume_l1_to_l2_claim_attempt',
  RESUME_L1_TO_L2_CLAIM_RETRY: 'resume_l1_to_l2_claim_retry',
  RESUME_L1_TO_L2_COMPLETED: 'resume_l1_to_l2_completed',
  RESUME_L1_TO_L2_PATCH_FAILED: 'resume_l1_to_l2_patch_failed',
  RESUME_L1_TO_L2_ERROR: 'resume_l1_to_l2_error',
  RESUME_ATTESTATION_FETCH: 'resume_attestation_fetch',
  RESUME_ATTESTATION_FALLBACK: 'resume_attestation_fallback',

  // ── Resume L2→L1 ──────────────────────────────────────────────
  RESUME_L2_TO_L1_PROVEN_POLL: 'resume_l2_to_l1_proven_poll',
  RESUME_L2_TO_L1_PROVEN_FALLBACK: 'resume_l2_to_l1_proven_fallback',
  RESUME_L2_TO_L1_L1_WITHDRAW_SENT: 'resume_l2_to_l1_l1_withdraw_sent',
  RESUME_L2_TO_L1_RECOVERED_L2_BLOCK: 'resume_l2_to_l1_recovered_l2_block',
  RESUME_L2_TO_L1_WITNESS_COMPUTED: 'resume_l2_to_l1_witness_computed',
  RESUME_L2_TO_L1_COMPLETED: 'resume_l2_to_l1_completed',
  RESUME_L2_TO_L1_PATCH_FAILED: 'resume_l2_to_l1_patch_failed',
  RESUME_L2_TO_L1_ERROR: 'resume_l2_to_l1_error',

  // ── Token registration in wallet (post-claim/resume) ──────────
  TOKEN_ADDED_TO_WALLET: 'token_added_to_wallet',
  TOKEN_ADD_TO_WALLET_FAILED: 'token_add_to_wallet_failed',
  RESUME_TOKEN_ADDED_TO_WALLET: 'resume_token_added_to_wallet',
  RESUME_TOKEN_ADD_TO_WALLET_FAILED: 'resume_token_add_to_wallet_failed',

  // ── Misc UI ───────────────────────────────────────────────────
  COPY_CLAIM_SECRET: 'copy_claim_secret',
  COPY_NONCE: 'copy_nonce',
  DECRYPT_OPERATION_PAYLOAD: 'decrypt_operation_payload',
} as const

export type DatadogUserActionValue = (typeof DatadogUserAction)[keyof typeof DatadogUserAction]
