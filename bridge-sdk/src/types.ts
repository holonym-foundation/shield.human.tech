import type { Address, PublicClient, WalletClient } from 'viem'

export interface L1BridgeConfig {
  chainId: number
  portalAddress: Address
  tokenAddress: Address
}

export interface L2BridgeConfig {
  chainId: number
  bridgeAddress: string
  tokenAddress: string
}

export interface BridgeConfig {
  l1: L1BridgeConfig
  l2: L2BridgeConfig
  aztecNodeUrl?: string
}

export interface L1Clients {
  publicClient: PublicClient
  walletClient: WalletClient
}

export interface ExecuteCallResult {
  txHash: string
  blockNumber?: number
}

export interface L2Executor {
  executeCall: (
    contract: string,
    method: string,
    args: any[],
    options?: { contractType?: 'token' | 'bridge'; autoRegister?: boolean }
  ) => Promise<ExecuteCallResult>
  executeCallWithAuthWit?: (
    caller: string,
    tokenContract: string,
    method: string,
    args: any[]
  ) => Promise<void>
  registerToken?: (tokenAddress: string) => Promise<void>
}

export interface L1ToL2DepositResult {
  claimSecret: string
  claimSecretHash: string
  messageHash: string
  messageLeafIndex: bigint
  l1TxHash: string
}

export interface L2ClaimResult {
  l2TxHash: string
}

export interface L2WithdrawalInitiationResult {
  l2TxHash: string
  l2BlockNumber?: number
  nonce: string
}

export interface L2ToL1Witness {
  messageIndex: bigint
  siblingPath: string[]
}

export interface L1WithdrawalResult {
  l1TxHash: string
}
