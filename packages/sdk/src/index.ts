// Main client
export { HumanTechBridge } from './client'

// Status info
export { BRIDGE_STATUS_INFO } from './types'

// Event-discriminator constants — use these instead of string literals at
// emit sites and in `case` clauses to get IDE go-to-definition + refactor
// support, and to avoid silent typos in untyped contexts.
export { BridgeEventType, BridgePhase, AttestationMethod } from './types'
export type { BridgeEventTypeValue, BridgePhaseValue, AttestationMethodValue } from './types'

// Types
export type {
  HumanTechBridgeConfig,
  ResolvedConfig,
  TokenConfig,
  StepStatus,
  BridgeOperationStatus,
  BridgeOperation,
  BridgeL1ToL2Params,
  WithdrawL2ToL1Params,
  ResumeParams,
  BridgeResult,
  BridgeActivityData,
  BridgeEvent,
  BridgeEventCallback,
  FuelQuote,
  PoolKeyParam,
  BridgeDirection,
  RecoveryClaimData,
  RecoveryWithdrawalData,
  CleanHandsStruct,
  PassportStruct,
  L2CleanHandsStruct,
  L2PassportStruct,
  PochAttestationData,
  PassportAttestationData,
  WalletAdapterInterface,
  AttestationStatus,
  PochCheckResult,
  PassportCheckResult,
  L1TokenBalance,
  MintTokensResult,
  SessionStatus,
} from './types'

// Config (deployments.json is the single source of truth)
export {
  ALL_DEPLOYMENTS,
  ACTIVE_DEPLOYMENT_ID,
  getDeployment,
  createConfig,
  resolveToken,
  getAztecscanUrl,
  getEtherscanUrl,
} from './config'
export type { DeploymentData } from './config'

// Encryption
export {
  createSigningMessage,
  deriveEncryptionKey,
  decryptData,
  decryptOperationPayload,
  ENCRYPTION_VERSION,
} from './encryption'

// Auth
export { L2_RESOURCE_PREFIX } from './auth'

// API
export { BridgeApiError } from './api'

// Attestation
export {
  buildEmptyCleanHands,
  buildEmptyPassport,
  buildEmptyL2CleanHands,
  buildEmptyL2Passport,
} from './attestation'

// Operations
export { retryFailedPatches } from './operations'

// Storage
export {
  STORAGE_KEYS,
  getDeposits,
  getWithdrawals,
  getPendingDeposits,
  getPendingWithdrawals,
  getDepositById,
  getWithdrawalById,
  buildDepositExport,
  buildWithdrawalExport,
} from './storage'

// Fuel — slippage wrapper
export { getUniswapFuelQuote } from './fuel'

// Fuel — gas estimation and sufficiency check
export {
  buildClaimGasSettings,
  estimateClaimFeeLimit,
  checkFuelSufficiency,
} from './fuelGasEstimate'

// Fuel — V4 Quoter, route discovery, USD pricing helpers
export {
  FEE_JUICE_DECIMALS,
  getTokenPriceUsd,
  getFeeJuicePriceUsd,
  formatFjAmount,
  formatFuelDisplay,
  usdToTokenAmount,
  buildSwapCandidates,
  buildSwapRoute,
  getV4Quote,
  getBestRoute,
} from './fuelPricing'
export type { CandidateRoute, RouteResult } from './fuelPricing'
