/**
 * HumanTechBridge — Main SDK entry point.
 */

import { createAztecNodeClient } from '@aztec/aztec.js/node'

import { BridgeApiClient, BridgeApiError } from './api'
import { createConfig, ACTIVE_DEPLOYMENT_ID } from './config'
import { authenticate } from './auth'
import { getOperations, getOperation, retryFailedPatches } from './operations'
import { bridgeL1ToL2 } from './bridge/l1ToL2'
import { withdrawL2ToL1 } from './bridge/l2ToL1'
import { resume as resumeBridge } from './bridge/resume'
import type {
  HumanTechBridgeConfig,
  ResolvedConfig,
  BridgeL1ToL2Params,
  WithdrawL2ToL1Params,
  ResumeParams,
  BridgeResult,
  BridgeOperation,
  PochCheckResult,
  PassportCheckResult,
  L1TokenBalance,
  AttestationStatus,
  MintTokensResult,
  SessionStatus,
} from './types'

const DEFAULT_API_URL = 'https://bridge.human.tech'

function resolveDomain(domain?: string): string {
  const raw =
    domain ??
    (typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : undefined)
  if (!raw) {
    throw new Error('domain is required when not running in a browser')
  }
  return raw.endsWith('/') ? raw : `${raw}/`
}

export class HumanTechBridge {
  private config: ResolvedConfig
  private apiClient: BridgeApiClient
  private aztecNode: any
  readonly domain: string

  constructor(options: HumanTechBridgeConfig) {
    if (!options.l1RpcUrl) {
      throw new Error(
        'l1RpcUrl is required. Provide an Ethereum JSON-RPC URL (e.g. Alchemy, Infura).',
      )
    }
    this.config = createConfig(options.deployment ?? ACTIVE_DEPLOYMENT_ID, {
      l1RpcUrl: options.l1RpcUrl,
      l2NodeUrl: options.l2NodeUrl,
    })
    this.domain = resolveDomain(options.domain)
    this.apiClient = new BridgeApiClient(options.apiUrl ?? DEFAULT_API_URL)
    this.aztecNode = createAztecNodeClient(this.config.l2NodeUrl)
  }

  /**
   * Authenticate with the bridge backend using SIWE (EIP-4361).
   *
   * BREAKING CHANGE from v1: requires domain, uri, and chainId.
   */
  async authenticate(params: {
    l1Address: string
    l2Address: string
    domain: string
    uri: string
    chainId: number
    signMessage: (msg: string) => Promise<string>
    nonce?: string
    l1LoginMethod?: string
    l1WalletProvider?: string
    l2LoginMethod?: string
    l2WalletProvider?: string
  }): ReturnType<typeof authenticate> {
    return authenticate(this.apiClient, params)
  }

  /**
   * Bridge tokens from L1 (Ethereum) to L2 (Aztec).
   */
  async bridgeL1ToL2(params: BridgeL1ToL2Params): Promise<BridgeResult> {
    return bridgeL1ToL2(this.config, this.apiClient, this.aztecNode, this.domain, params)
  }

  /**
   * Withdraw tokens from L2 (Aztec) to L1 (Ethereum).
   */
  async withdrawL2ToL1(params: WithdrawL2ToL1Params): Promise<BridgeResult> {
    return withdrawL2ToL1(this.config, this.apiClient, this.aztecNode, this.domain, params)
  }

  /**
   * Resume an incomplete bridge operation.
   */
  async resume(
    operationId: number | string,
    params: ResumeParams,
  ): Promise<BridgeResult> {
    return resumeBridge(
      this.config,
      this.apiClient,
      this.aztecNode,
      this.domain,
      operationId,
      params,
    )
  }

  /**
   * Get all bridge operations for the authenticated user.
   */
  async getOperations(): Promise<BridgeOperation[]> {
    return getOperations(this.apiClient)
  }

  /**
   * Get a single bridge operation by ID.
   */
  async getOperation(operationId: number): Promise<BridgeOperation> {
    return getOperation(this.apiClient, operationId)
  }

  /**
   * Check attestation eligibility before starting a private bridge operation.
   * Returns binding status, nonce counts, and attester config.
   */
  async getAttestationStatus(): Promise<AttestationStatus> {
    return this.apiClient.getAttestationStatus()
  }

  /**
   * Lightweight pre-check: does the current user have Proof of Clean Hands (POCH)?
   * Does not issue an attestation or increment nonces.
   */
  async checkPochEligibility(): Promise<PochCheckResult> {
    return this.apiClient.checkPochEligibility()
  }

  /**
   * Lightweight pre-check: does the current user meet the Passport score threshold?
   * Does not issue an attestation or increment nonces.
   */
  async checkPassportEligibility(): Promise<PassportCheckResult> {
    return this.apiClient.checkPassportEligibility()
  }

  /**
   * Fetch L1 token balances for an address via the Alchemy proxy endpoint.
   */
  async getL1TokenBalances(address: string, chains: number[]): Promise<L1TokenBalance[]> {
    return this.apiClient.getL1TokenBalances(address, chains)
  }

  /**
   * Get Aztec L2 node info (version, L1 contract addresses, etc.).
   */
  async getAztecNodeInfo(): Promise<Record<string, unknown>> {
    return this.aztecNode.getNodeInfo()
  }

  /**
   * Check whether the Aztec L2 node is ready to accept requests.
   */
  async isAztecNodeReady(): Promise<boolean> {
    return this.aztecNode.isReady()
  }

  /**
   * Get the number of pending transactions in the Aztec L2 mempool.
   */
  async getAztecPendingTxCount(): Promise<number> {
    return this.aztecNode.getPendingTxCount()
  }

  /**
   * Get an Aztec L2 block header by number or tag ('latest').
   */
  async getAztecBlockHeader(numberOrTag: number | 'latest'): Promise<any> {
    return this.aztecNode.getBlockHeader(numberOrTag)
  }

  /**
   * Mint test tokens via the backend faucet (devnet only).
   */
  async mintTestTokens(address: string, tokenAddress: string): Promise<MintTokensResult> {
    return this.apiClient.mintTestTokens(address, tokenAddress)
  }

  /**
   * Set the auth token on the API client (e.g. to restore a persisted JWT on page reload).
   */
  setAuthToken(token: string): void {
    this.apiClient.setAuthToken(token)
  }

  /**
   * Verify the current session is still valid.
   *
   * Unlike other SDK methods, this NEVER throws. It returns a structured
   * result so callers can branch on the reason without try/catch.
   *
   * Call this on page load to detect stale JWTs before starting operations.
   */
  async verifySession(): Promise<SessionStatus> {
    if (!this.apiClient.hasAuthToken()) {
      return { valid: false, reason: 'no_token' }
    }

    try {
      const res = await this.apiClient.get<Extract<SessionStatus, { valid: true }>>('/api/auth/verify')
      return res
    } catch (err) {
      if (err instanceof BridgeApiError) {
        if (err.status === 401) {
          try {
            const parsed = JSON.parse(err.body)
            const reason = parsed?.reason
            if (reason === 'user_not_found' || reason === 'token_expired' || reason === 'no_token') {
              return { valid: false, reason }
            }
          } catch {
            // JSON parse failed — fall through to default
          }
          return { valid: false, reason: 'token_expired' }
        }
        return { valid: false, reason: 'network_error' }
      }
      return { valid: false, reason: 'network_error' }
    }
  }

  /**
   * Retry all queued failed PATCHes from previous sessions.
   * Call this after authentication to drain the failed-PATCH queue.
   */
  async retryFailedPatches(): Promise<{ succeeded: number; failed: number; total: number }> {
    return retryFailedPatches(this.apiClient)
  }
}
