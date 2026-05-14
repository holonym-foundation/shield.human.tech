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
    const result = await authenticate(this.apiClient, params)
    // Drain queued failed PATCHes now that we have a fresh JWT.
    this.drainFailedPatches()
    return result
  }

  /**
   * Bridge tokens from L1 (Ethereum) to L2 (Aztec).
   */
  async bridgeL1ToL2(params: BridgeL1ToL2Params): Promise<BridgeResult> {
    return bridgeL1ToL2(this.config, this.apiClient, this.aztecNode, this.domain, params)
  }

  /**
   * Build a V4 fuel quote for a given token and fuel amount.
   *
   * Intended for UI previews (showing the user the expected FJ output before
   * they commit to the bridge). For bridging, prefer passing `fuel` to
   * `bridgeL1ToL2` without a pre-built quote — the SDK builds it internally
   * and guarantees the same routing the contract call will use.
   */
  async getFuelQuote(params: {
    /** Token symbol (e.g. "USDC") or L1 contract address. */
    token: string
    /** Human-readable fuel amount in the token's native decimals (e.g. "5"). */
    fuelAmount: string
    /** Slippage tolerance in basis points (default 300 = 3%). */
    slippageBps?: number
  }) {
    const { parseUnits } = await import('viem')
    const { buildSwapCandidates, getBestRoute } = await import('./fuelPricing')
    const { getUniswapFuelQuote } = await import('./fuel')
    const { resolveToken } = await import('./config')

    if (!this.config.feeJuiceAddress) {
      throw new Error('getFuelQuote requires feeJuiceAddress in the active deployment config.')
    }
    if (!this.config.l1RpcUrl) {
      throw new Error('getFuelQuote requires l1RpcUrl on the SDK config.')
    }

    const tokenConfig = resolveToken(this.config, params.token)
    const fuelAmountTokenUnits = parseUnits(params.fuelAmount, tokenConfig.decimals)

    const candidates = buildSwapCandidates(
      tokenConfig.l1TokenContract as `0x${string}`,
      this.config.feeJuiceAddress as `0x${string}`,
    )
    const best = await getBestRoute({
      candidates,
      inputAmount: fuelAmountTokenUnits,
      l1RpcUrl: this.config.l1RpcUrl,
    })
    return getUniswapFuelQuote({
      expectedOutput: best.expectedOutput,
      slippageBps: params.slippageBps ?? 300,
      poolKeys: best.route.poolKeys,
      zeroForOnes: best.route.zeroForOnes,
    })
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
   * Also drains any queued failed PATCHes left over from a prior session.
   */
  setAuthToken(token: string): void {
    this.apiClient.setAuthToken(token)
    this.drainFailedPatches()
  }

  /**
   * Fire-and-forget drain of the queued failed-PATCH queue. Called automatically
   * after authenticate() / setAuthToken() so operations from a prior session
   * (that lost their PATCH on a network blip) catch up as soon as auth returns.
   */
  private drainFailedPatches(): void {
    retryFailedPatches(this.apiClient).catch((err) => {
      console.warn('[Bridge SDK] drainFailedPatches failed:', err)
    })
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

  /**
   * Verify the connected Aztec L2 node is compatible with the SDK's bundled
   * deployment metadata. Returns a structured result — does NOT throw.
   *
   * Recommended usage: call once at app startup, log/surface warnings.
   * A mismatch doesn't necessarily break things (e.g. nightly node can be
   * ahead of the SDK build), but the contract/ABI assumptions the SDK
   * makes are tied to `rollupVersion` — a mismatch there is a red flag
   * for the resume / witness paths.
   */
  async verifyNodeCompatibility(): Promise<{
    compatible: boolean
    expectedRollupVersion: number
    actualRollupVersion: number | null
    expectedAztecVersion: string
    actualNodeVersion: string | null
    warnings: string[]
  }> {
    const expectedRollupVersion = this.config.rollupVersion
    const expectedAztecVersion = this.config.aztecVersion
    const warnings: string[] = []

    let nodeInfo: any
    try {
      nodeInfo = await this.aztecNode.getNodeInfo()
    } catch (err) {
      warnings.push(
        `Could not fetch nodeInfo from L2 node: ${err instanceof Error ? err.message : String(err)}`,
      )
      return {
        compatible: false,
        expectedRollupVersion,
        actualRollupVersion: null,
        expectedAztecVersion,
        actualNodeVersion: null,
        warnings,
      }
    }

    const actualRollupVersion = nodeInfo?.rollupVersion != null ? Number(nodeInfo.rollupVersion) : null
    const actualNodeVersion = nodeInfo?.nodeVersion != null ? String(nodeInfo.nodeVersion) : null

    if (actualRollupVersion == null) {
      warnings.push('Node did not report a rollupVersion — cannot verify compatibility.')
    } else if (actualRollupVersion !== expectedRollupVersion) {
      warnings.push(
        `Rollup version mismatch: SDK expects ${expectedRollupVersion}, node reports ${actualRollupVersion}. ` +
        `Contract ABIs and L1→L2 content hashes may differ — recovery paths are at risk.`,
      )
    }

    if (actualNodeVersion && actualNodeVersion !== expectedAztecVersion) {
      warnings.push(
        `Aztec version mismatch: SDK built against ${expectedAztecVersion}, node reports ${actualNodeVersion}. ` +
        `Usually benign across patch versions; review if behavior is unexpected.`,
      )
    }

    const compatible = actualRollupVersion === expectedRollupVersion
    return {
      compatible,
      expectedRollupVersion,
      actualRollupVersion,
      expectedAztecVersion,
      actualNodeVersion,
      warnings,
    }
  }
}
