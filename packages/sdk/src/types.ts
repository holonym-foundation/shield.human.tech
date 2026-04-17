/**
 * Core type definitions for @holonym/aztec-bridge-sdk
 *
 * Types are organized into:
 * 1. SDK configuration types (HumanTechBridgeConfig, etc.)
 * 2. Bridge operation types (BridgeOperation, params, results)
 * 3. Recovery types (RecoveryClaimData, RecoveryWithdrawalData)
 * 4. Internal step result types (used by bridge modules)
 */

// ─── SDK Configuration ──────────────────────────────────────────────

export interface HumanTechBridgeConfig {
  /** Deployment ID from deployments.json. Defaults to the active deployment. */
  deployment?: string
  /** The dapp's domain used for encryption key derivation. Auto-detected from window.location.origin in browsers. Required in Node.js. */
  domain?: string
  /** Backend API URL. Defaults to "https://bridge.human.tech". Use "" for same-origin. */
  apiUrl?: string
  /** L1 (Ethereum) JSON-RPC URL. Required — the SDK does not bundle a default RPC endpoint. */
  l1RpcUrl: string
  /** Override the L2 node URL from deployment config */
  l2NodeUrl?: string
}

/** Resolved configuration after loading deployment data */
export interface ResolvedConfig {
  deploymentId: string
  l1ChainId: number
  l2ChainId: number
  l1RpcUrl: string
  l2NodeUrl: string
  rollupVersion: number
  aztecVersion: string
  tokens: TokenConfig[]
  l1ContractAddresses: L1ContractAddresses
  swapBridgeRouterAddress: string
  uniswapFuelSwapAddress: string
  bridgedFpcAddress: string
  permit2Address: string
  wethAddress: string
  feeJuicePortalAddress: string
  feeJuiceAddress: string
  sponsoredFeeAddress: string
}

export interface TokenConfig {
  symbol: string
  decimals: number
  logo: string
  l1TokenContract: string
  l2TokenContract: string
  l1PortalContract: string
  l2BridgeContract: string
  feeAssetHandler: string
  sponsoredFee: string
  /** Human-readable name (e.g. "Clean USDC"). Used for tokenNameL2 in API payloads. */
  title?: string
  /** L1 token symbol when different from L2 symbol (e.g. "USDC" vs "cUSDC"). Used for tokenSymbolL1/tokenNameL1 in API payloads. */
  pairedSymbol?: string
  /** L2 proxy contract address (e.g. TokenMinterProxy). */
  l2ProxyContract?: string
  /** Address of the HumanID attester for attestation-gated deposits. */
  humanIdAttester?: string
  /** Address of the passport signer for attestation verification. */
  passportSigner?: string
}

export interface L1ContractAddresses {
  rollupAddress: string
  registryAddress: string
  inboxAddress: string
  outboxAddress: string
  [key: string]: string
}

// ─── Step Status ────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'active' | 'completed' | 'error'

// ─── Bridge Events ─────────────────────────────────────────────────

/**
 * Events emitted during bridge operations.
 * The frontend can subscribe via `onEvent` to update localStorage, toasts, etc.
 */
export type BridgeEvent =
  // Lifecycle
  | { type: 'operation_created'; operationId: number | string; data: Record<string, unknown> }
  | { type: 'operation_completed'; operationId: number | string; l1TxHash?: string; l2TxHash?: string; alreadyCompleted?: boolean }
  // L1→L2 deposit
  | { type: 'deposit_sent'; l1TxHash: string; l1TxUrl: string }
  | { type: 'deposit_confirmed'; l1TxHash: string; l1TxUrl: string; messageHash: string; messageLeafIndex: string; fuelMessageHash?: string; fuelMessageLeafIndex?: string; fuelAmount?: string }
  | { type: 'claim_attempt'; attempt: number; maxAttempts: number }
  | { type: 'claim_retry'; attempt: number; maxAttempts: number; delayMs: number }
  // L2→L1 withdrawal
  | { type: 'burn_sent'; l2TxHash: string }
  | { type: 'burn_confirmed'; l2TxHash: string; l2TxUrl: string; l2BlockNumber?: number }
  | { type: 'witness_computed'; leafIndex: string; siblingPath: string[]; epoch: number }
  | { type: 'l1_withdraw_sent'; l1TxHash: string; l1TxUrl: string }
  // Polling progress
  | { type: 'sync_poll'; elapsedMinutes: number; synced: boolean }
  | { type: 'proven_poll'; provenBlock: number; neededBlock: number; elapsedMs: number }
  | { type: 'proven_fallback'; fixedWaitMs: number }
  // Recovery / resume
  | { type: 'recovery_from_receipt'; l1TxHash: string }
  | { type: 'recovery_from_block_scan'; l1BlockNumberBeforeTx: string }
  | { type: 'recovery_l2_block'; l2TxHash: string; l2BlockNumber: number }
  // Server backup warnings
  | { type: 'patch_failed'; operationId: number | string; label: string; data: Record<string, unknown> }
  // Errors (with context for depositConfirmed/burnConfirmed guard)
  | { type: 'error'; error: Error; fundsAtRisk: boolean; operationId?: number }
  // Attestation
  | { type: 'attestation_fetch'; method: 'poch' | 'passport' }
  | { type: 'attestation_fallback'; from: 'poch'; to: 'passport'; reason: string }
  // Secrets (only hashes + encrypted payload — never plaintext secrets)
  | { type: 'secrets_generated'; claimSecretHash: string; fuelSecretHash?: string; encryptedPayload: { ciphertext: string; iv: string; tag: string }; l1BlockNumberBeforeTx: string; l2BlockNumberBeforeTx: string; nodeInfo: Record<string, unknown> }
  | { type: 'nonce_generated'; l2BridgeAddress: string; encryptedPayload: { ciphertext: string; iv: string; tag: string }; l1BlockNumberBeforeTx: string; l2BlockNumberBeforeTx: string; nodeInfo: Record<string, unknown> }

export type BridgeEventCallback = (event: BridgeEvent) => void

// ─── Bridge Operation (from backend) ────────────────────────────────

export type BridgeDirection = 'L1_TO_L2' | 'L2_TO_L1'

/**
 * All possible bridge operation statuses.
 *
 * Status transitions:
 *   L1→L2: pending → deposited → claimed → completed
 *   L2→L1: pending → submitted → ready → pending_finalize → completed
 *
 * "failed" = error before any tx was sent. No funds moved, no recovery needed,
 * safe to retry. If funds ARE at risk (tx sent or confirmed), the status stays
 * at the last successful step (e.g. deposited, submitted) so the user can
 * resume from the Activity page.
 */
export type BridgeOperationStatus =
  | 'pending'
  | 'deposited'
  | 'claimed'
  | 'submitted'
  | 'ready'
  | 'pending_finalize'
  | 'completed'
  | 'failed'

export const BRIDGE_STATUS_INFO: Record<BridgeOperationStatus, { label: string; description: string }> = {
  pending: { label: 'Pending', description: 'Operation created, waiting for transaction' },
  deposited: { label: 'Deposited', description: 'L1 deposit confirmed — waiting for L2 claim' },
  claimed: { label: 'Claimed', description: 'L2 claim submitted — waiting for confirmation' },
  submitted: { label: 'Submitted', description: 'L2 burn confirmed — waiting for L1 proof' },
  ready: { label: 'Ready', description: 'L2 block proven on L1 — ready to finalize withdrawal' },
  pending_finalize: { label: 'Finalizing', description: 'Waiting for L1 block finalization' },
  completed: { label: 'Completed', description: 'Bridge operation completed successfully' },
  failed: { label: 'Failed', description: 'No funds moved, no recovery needed — safe to retry' },
}

/** Shape returned by GET /api/bridge/operations */
export interface BridgeOperation {
  id: string
  direction: BridgeDirection
  status: string
  amountL1: string | null
  amountL2: string | null
  amountDisplayL1: string | null
  amountDisplayL2: string | null
  tokenSymbolL1: string | null
  tokenSymbolL2: string | null
  l1TxHash: string | null
  l1TxUrl: string | null
  l2TxHash: string | null
  l2TxUrl: string | null
  // Confirmed block numbers
  l1BlockNumber: string | null
  // L1→L2 recovery fields
  messageHash: string | null
  messageLeafIndex: string | null
  l1BlockNumberBeforeTx: string | null
  // L1→L2 post-fee amount (custom portal deducts fees before L2 message)
  amountAfterFee: string | null
  // L1→L2 fuel recovery fields
  fuelMessageHash: string | null
  fuelMessageLeafIndex: string | null
  fuelAmount: string | null
  // L2→L1 recovery fields
  l2BlockNumber: string | null
  l2BlockNumberBeforeTx: string | null
  l2ToL1MessageIndex: string | null
  siblingPath: string[] | null
  epoch: number | null
  recipientL1Address: string | null
  // Recovery-critical contract & version snapshot
  rollupVersion: number | null
  chainIdL1: number | null
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  l1RollupAddress: string | null
  l1OutboxAddress: string | null
  // Token info
  tokenSymbol: string | null
  tokenAddressL1: string | null
  tokenAddressL2: string | null
  tokenDecimalsL1: number | null
  tokenDecimalsL2: number | null
  // Progress tracking
  currentStep: number | null
  // Common
  isPrivacyModeEnabled: boolean | null
  lastErrorMessage: string | null
  nodeInfo: Record<string, unknown> | null
  createdAt: string
  completedAt: string | null
  // Encrypted fields
  encryptedCiphertext: string | null
  encryptedIv: string | null
  encryptedTag: string | null
  keyDerivationMessage: string | null
  keyDerivationDomain: string | null
}

// ─── Bridge Params (SDK public API) ─────────────────────────────────

export interface BridgeL1ToL2Params {
  /** Token symbol (e.g. "USDC") or L1 token contract address */
  token: string
  /** Human-readable amount (e.g. "100") */
  amount: string
  /** L1 (Ethereum) wallet address */
  l1Address: string
  /** L2 (Aztec) wallet address */
  l2Address: string
  /** Whether to use private claiming on L2 */
  isPrivate: boolean
  /**
   * Optional fuel (gas funding) parameters.
   *
   * `fuelType` selects between:
   *   - 'public' (default): L2 recipient is claimer's aztecAddress (public fuel note).
   *     MUST NOT be used in private mode — leaks the L2 recipient on-chain.
   *   - 'private': swap into FeeJuice held by BridgedFPC; claim + mint + pay_fee
   *     happen privately on L2 via PrivateMintAndPayFeePaymentMethod.
   *
   * `slippageBps` tolerates swap slippage in basis points (default 300 = 3%).
   *
   * When `fuel.enabled` is true and no `fuelQuote` is supplied alongside, the SDK
   * auto-builds the V4 quote internally via buildSwapCandidates + getBestRoute.
   */
  fuel?: { enabled: boolean; amount: string; fuelType?: 'public' | 'private'; slippageBps?: number }
  /** Pre-computed fuel quote (required when fuel.enabled is true) */
  fuelQuote?: FuelQuote
  /** Callback to send an L1 transaction (e.g. via wallet provider) */
  sendTransaction: (tx: TransactionRequest) => Promise<string>
  /** Aztec wallet adapter (from @aztec/wallet-sdk) */
  walletAdapter: WalletAdapterInterface
  /** Callback to sign a message with the L1 wallet */
  signMessage: (msg: string) => Promise<string>
  /** Callback to sign EIP-712 typed data with the L1 wallet (for Permit2) */
  signTypedData: (address: string, typedDataJson: string) => Promise<string>
  /** Called when a bridge step changes status */
  onStep?: (step: number, status: StepStatus) => void
  /** Called when a lifecycle event occurs (for localStorage, toasts, telemetry) */
  onEvent?: BridgeEventCallback
}

export interface WithdrawL2ToL1Params {
  /** Token symbol (e.g. "cUSDC") or L2 token contract address */
  token: string
  /** Human-readable amount */
  amount: string
  /** L1 (Ethereum) recipient address */
  l1Address: string
  /** L2 (Aztec) wallet address */
  l2Address: string
  /** Whether to use private withdrawal on L2 */
  isPrivate: boolean
  /** Callback to send an L1 transaction */
  sendTransaction: (tx: TransactionRequest) => Promise<string>
  /** Aztec wallet adapter */
  walletAdapter: WalletAdapterInterface
  /** Callback to sign a message with the L1 wallet */
  signMessage: (msg: string) => Promise<string>
  /** Called when a withdrawal step changes status */
  onStep?: (step: number, status: StepStatus) => void
  /** Called when a lifecycle event occurs (for localStorage, toasts, telemetry) */
  onEvent?: BridgeEventCallback
}

export interface ResumeParams {
  /** Callback to send an L1 transaction (needed for L2→L1 resume) */
  sendTransaction?: (tx: TransactionRequest) => Promise<string>
  /** Aztec wallet adapter (needed for L1→L2 resume) */
  walletAdapter?: WalletAdapterInterface
  /** L1 (Ethereum) wallet address (used for encryption key derivation; avoids fragile regex parsing) */
  l1Address?: string
  /** L2 (Aztec) wallet address */
  l2Address?: string
  /** Callback to sign a message with the L1 wallet */
  signMessage: (msg: string) => Promise<string>
  /** Called when a resume step changes status */
  onStep?: (step: number, status: StepStatus) => void
  /** Called when a lifecycle event occurs (for localStorage, toasts, telemetry) */
  onEvent?: BridgeEventCallback
}

export interface TransactionRequest {
  from?: string
  to: string
  data: string
  value?: string
  /**
   * Optional gas limit as a hex-prefixed uint (e.g. '0xF42400' = 16M).
   * Used for complex calls where wallet estimation is unreliable.
   */
  gas?: string
}

// ─── Bridge Results ─────────────────────────────────────────────────

export interface BridgeResult {
  operationId: number | string
  l1TxHash?: string
  l2TxHash?: string
  l1TxUrl?: string
  l2TxUrl?: string
}

// ─── Recovery Types ─────────────────────────────────────────────────

/** Data needed to resume an incomplete L1→L2 bridge operation */
export interface RecoveryClaimData {
  operationId: string
  claimSecret: string
  claimSecretHash: string
  messageHash: string | null
  messageLeafIndex: string | null
  amount: string
  claimAmount: string | null
  l1Address: string
  l2Address: string
  l1TxHash: string | null
  l1TxUrl: string | null
  l1BlockNumberBeforeTx: string | null
  isPrivacyModeEnabled: boolean
  nodeInfo: Record<string, unknown> | null
  status: string
  currentStep: number | null
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  tokenAddressL1: string | null
  tokenAddressL2: string | null
  // Fuel recovery fields
  fuelSecret: string | null
  privateFuelSalt: string | null
  privateFuelSecret: string | null
  fuelMessageHash: string | null
  fuelMessageLeafIndex: string | null
  fuelAmount: string | null
}

/** Data needed to resume an incomplete L2→L1 withdrawal */
export interface RecoveryWithdrawalData {
  operationId: string
  amount: string
  l1Address: string
  l2Address: string
  l2TxHash: string | null
  l2TxUrl: string | null
  l2BlockNumber: string | null
  l2BlockNumberBeforeTx: string | null
  l2ToL1MessageIndex: string | null
  siblingPath: string[] | null
  recipientL1Address: string | null
  rollupVersion: number | null
  chainIdL1: number | null
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  l1RollupAddress: string | null
  l1OutboxAddress: string | null
  isPrivacyModeEnabled: boolean
  nodeInfo: Record<string, unknown> | null
  status: string
  currentStep: number | null
}

// ─── Encrypted Activity Data ────────────────────────────────────────

export interface EncryptedData {
  ciphertext: string
  iv: string
  tag: string
}

export interface BridgeActivityData {
  // For L1→L2
  claimSecret?: string
  claimSecretHash?: string
  messageHash?: string
  messageLeafIndex?: string
  // For L1→L2 fuel
  fuelSecret?: string
  fuelSecretHash?: string
  fuelAmount?: string
  fuelDecimals?: number
  // For L1→L2 private fuel
  privateFuelSalt?: string
  privateFuelSecret?: string
  privateFuelSecretHash?: string
  // Portal address snapshot (for resume/recovery)
  portalAddressL1?: string
  // For L2→L1
  nonce?: string
  l2BlockNumber?: string
  l2ToL1MessageIndex?: string
  siblingPath?: string[]
  l2BridgeAddress?: string
  // Common
  amount?: string
  l1Address?: string
  l2Address?: string
  isPrivacyModeEnabled?: boolean
  l1BlockNumberBeforeTx?: string
  nodeInfo?: Record<string, unknown>
}

// ─── Network Health ─────────────────────────────────────────────────

export interface NetworkHealth {
  isHealthy: boolean
  blockAge: number
  latestBlock: number
}

// ─── Internal Step Result Types ─────────────────────────────────────

/** Minimal interface for Aztec wallet adapters (e.g. from @aztec/wallet-sdk). */
export interface WalletAdapterInterface {
  bridgeAddress: string
  executeCall(
    contractAddress: string,
    method: string,
    args: unknown[],
    options?: Record<string, unknown>,
  ): Promise<{ txHash: string }>
  executeWithdrawToL1Private(
    l1Address: string,
    amount: bigint,
    nonce: unknown,
    cleanHands: L2CleanHandsStruct,
    passport: L2PassportStruct,
    l2Address: string,
  ): Promise<{ txHash: string; l2BlockNumber?: number }>
  executeWithdrawToL1Public(
    l1Address: string,
    amount: bigint,
    nonce: unknown,
    userAddress: unknown,
  ): Promise<{ txHash: string; l2BlockNumber?: number }>
  registerToken?(tokenAddress: string): Promise<void>
}

/** Dependencies injected from the caller for L2 claim execution */
export interface L2ClaimDeps {
  walletAdapter: WalletAdapterInterface
  aztecAddress: string
  isPrivacyModeEnabled: boolean
}

export interface MessageSyncResult {
  synced: boolean
  elapsedMinutes: number
}

export interface L2ClaimResult {
  l2TxHash: string
  usedBruteForce: boolean
  bruteForceLeafIndex?: number
}

export interface CaptureBlocksResult {
  nodeInfo: any
  l1Addresses: any
  l1BlockNumberBeforeTx: string
  l2BlockNumberBeforeTx: string
}

export interface BackupResult {
  operationId: number | string
  claimSecret: any // Fr
  claimSecretHash: any // Fr
  nodeInfoSnapshot: any
  fuelSecret?: any // Fr
  fuelSecretHash?: any // Fr
}

export interface DepositTxResult {
  txHash: any
  l1TxHash: string
  l1TxUrl: string
}

export interface ReceiptResult {
  l1TxHash: string
  l1TxUrl: string
  messageHashStr: string
  messageLeafIndexStr: string
  messageHash: any
  messageLeafIndex: any
  fuelMessageHashStr?: string
  fuelMessageLeafIndexStr?: string
  fuelMessageHash?: any
  fuelMessageLeafIndex?: any
  fuelAmount?: bigint
}

export interface WitnessResult {
  leafIndex: string
  siblingPath: string[]
  epoch: bigint
}

export interface L1WithdrawResult {
  l1TxHash: string
  l1TxUrl: string
  l1BlockNumber?: string
}

export interface CaptureBlocksL2Result {
  l1BlockNumberBeforeTx: string
  l2BlockNumberBeforeTx: number
  nodeInfoSnapshot: Record<string, unknown>
}

export interface WithdrawalBackupResult {
  operationId: number | string
  nonce: any // Fr
  l2BridgeAddress: string
}

export interface BurnExitResult {
  l2TxHash: string
  l2BlockNumber: number | undefined
}

export interface BurnReceiptResult {
  blockNumberForProof: number
  l2TxUrl: string
  l2TxHashPatchOk: boolean
}

export interface WitnessComputeResult {
  leafIndex: string
  siblingPath: string[]
  rollupAddress: string | undefined
  epoch: bigint
  witnessPatchOk: boolean
}

/** Common wallet metadata for logging context */
export interface BridgeLogContext {
  walletType: string
  loginMethod: string | null
  walletProvider: string | null
  address: string
  chainId: number | null
  aztecLoginMethod: string | null
  aztecAddress: string
}

/** Pool key for Uniswap V4 routing */
export interface PoolKeyParam {
  currency0: `0x${string}`
  currency1: `0x${string}`
  fee: number
  tickSpacing: number
  hooks: `0x${string}`
}

/** Fuel quote from Uniswap V4 quoter */
export interface FuelQuote {
  expectedOutput: bigint
  minOutput: bigint
  poolKeys?: PoolKeyParam[]
  zeroForOnes?: boolean[]
}

/** Optional fuel parameters threaded through deposit steps */
export interface FuelParams {
  fuelAmount: bigint
  fuelQuote: FuelQuote
}

// ─── Attestation Eligibility Check Types ─────────────────────────────

/** POCH eligibility pre-check result from GET /api/attestation/poch/check */
export interface PochCheckResult {
  eligible: boolean
  reason?: string
}

/** Passport eligibility pre-check result from GET /api/attestation/passport/check */
export interface PassportCheckResult {
  eligible: boolean
  score: number
  threshold: number
  maxAmount: string
  reason?: string
}

// ─── L1 Token Balance Types ──────────────────────────────────────────

/** Token balance response from Alchemy token balances API */
export interface L1TokenBalance {
  address: string
  network: string
  tokenAddress: string | null
  tokenBalance: string
  chainId: number
  tokenMetadata: {
    name: string
    symbol: string
    decimals: number
    logo: string | null
  }
  tokenPrices: Array<{ currency: string; value: string; lastUpdatedAt: string }>
}

// ─── Faucet Types ────────────────────────────────────────────────────

/** Faucet mint response from POST /api/mint-tokens */
export interface MintTokensResult {
  success: boolean
  txHash?: string
  message?: string
}

// ─── Attestation Types ──────────────────────────────────────────────

/** POCH attestation response from POST /api/attestation/poch */
export interface PochAttestationData {
  l1Signature: string
  l2Signature: number[]
  nonce: number
  circuitId: string
  actionId: string
}

/** Passport attestation response from POST /api/attestation/passport */
export interface PassportAttestationData {
  l1Signature: string
  l2Signature: number[] | null
  nonce: number
  maxAmount: string
  deadline: string
  score: number
  threshold: number
}

/** Attestation status response from GET /api/attestation/status */
export interface AttestationStatus {
  binding: {
    status: 'unbound' | 'bound' | 'conflict'
    l1Address: string | null
    l2Address: string | null
  }
  poch: { noncesUsed: number }
  passport: { noncesUsed: number }
  config: {
    attesterAddress: string
    passportSignerAddress: string
  }
}

/** L1 clean-hands struct for depositToAztecPrivate (matches TokenPortal/SwapBridgeRouter Solidity struct) */
export interface CleanHandsStruct {
  nonce: bigint
  signature: string
}

/** L1 passport struct for depositToAztecPrivate */
export interface PassportStruct {
  maxAmount: bigint
  nonce: bigint
  deadline: bigint
  signature: string
}

/** L2 clean-hands struct for executeWithdrawToL1Private (snake_case matches Noir ABI) */
export interface L2CleanHandsStruct {
  nonce: bigint
  signature: number[]
}

/** L2 passport struct for executeWithdrawToL1Private (snake_case matches Noir ABI) */
export interface L2PassportStruct {
  max_amount: bigint
  nonce: bigint
  deadline: bigint
  signature: number[]
}

// ─── Session Validation ────────────────────────────────────────────

export type SessionStatus =
  | {
      valid: true
      user: {
        id: number
        l1Address: string
        l2Address: string
        l1LoginMethod: string | null
        l1WalletProvider: string | null
        l2LoginMethod: string | null
        l2WalletProvider: string | null
      }
    }
  | {
      valid: false
      reason: 'token_expired' | 'user_not_found' | 'no_token' | 'network_error'
    }
