// Main client
export { HumanTechBridge } from './client'

// Types
export type {
  HumanTechBridgeConfig,
  ResolvedConfig,
  TokenConfig,
  StepStatus,
  BridgeOperation,
  BridgeL1ToL2Params,
  WithdrawL2ToL1Params,
  ResumeParams,
  BridgeResult,
  BridgeActivityData,
  BridgeEvent,
  BridgeEventCallback,
  FuelQuote,
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
} from './storage'

// Fuel
export { getMockFuelQuote, computeSwapOutput } from './fuel'
