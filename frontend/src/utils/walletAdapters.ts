/**
 * Wallet Adapter Pattern
 *
 * This module provides a clean abstraction layer for wallet operations,
 * using the Aztec wallet-sdk (Contract.at + .methods.fn().send/simulate).
 */

import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { Contract } from '@aztec/aztec.js/contracts'
import type { Wallet } from '@aztec/aztec.js/wallet'
import { L1_TOKENS } from '@/config'

// ============================================================================
// TYPES
// ============================================================================

export interface WalletContext {
  loginMethod: 'wallet-sdk'
  sdkWallet?: Wallet | null
  aztecAccount?: any | null
}

export interface SimulateViewResult {
  result: any
}

export interface ExecuteCallResult {
  txHash: string
  blockNumber?: number
}

// ============================================================================
// ARTIFACT HELPERS
// ============================================================================

async function getContractArtifact(type: 'token' | 'bridge') {
  if (type === 'bridge') {
    const { TokenBridgeContract } = await import('@aztec/noir-contracts.js/TokenBridge')
    return TokenBridgeContract.artifact
  }
  const { TokenContract } = await import('@aztec/noir-contracts.js/Token')
  return TokenContract.artifact
}

function resolveArtifactType(
  contractAddress: string,
  bridgeAddress: string
): 'token' | 'bridge' {
  return contractAddress.toLowerCase() === bridgeAddress.toLowerCase()
    ? 'bridge'
    : 'token'
}

// ============================================================================
// WALLET SDK ADAPTER
// ============================================================================

class WalletAdapter {
  readonly tokenAddress: string
  readonly bridgeAddress: string

  constructor(
    private wallet: Wallet,
    private account: AztecAddress,
    tokenAddress?: string,
    bridgeAddress?: string,
  ) {
    this.tokenAddress = tokenAddress ?? L1_TOKENS[0]?.l2TokenContract ?? ''
    this.bridgeAddress = bridgeAddress ?? L1_TOKENS[0]?.l2BridgeContract ?? ''
  }

  async initializeContracts(): Promise<void> {
    // No-op: artifacts are fetched on demand via Contract.at()
  }

  async simulateView(
    contract: AztecAddress | string,
    method: string,
    args: any[]
  ): Promise<SimulateViewResult> {
    const addr = typeof contract === 'string' ? AztecAddress.fromString(contract) : contract
    const type = resolveArtifactType(addr.toString(), this.bridgeAddress)
    const artifact = await getContractArtifact(type)
    const instance = await Contract.at(addr, artifact, this.wallet)
    const result = await instance.methods[method](...args).simulate({ from: this.account })
    return { result }
  }

  async simulateViews(
    calls: { contract: AztecAddress | string; method: string; args: any[] }[]
  ): Promise<SimulateViewResult[]> {
    // Run all simulations in parallel
    const results = await Promise.all(
      calls.map((c) => this.simulateView(c.contract, c.method, c.args))
    )
    return results
  }

  async executeCall(
    contract: AztecAddress | string,
    method: string,
    args: any[],
    options?: { contractType?: 'token' | 'bridge'; autoRegister?: boolean }
  ): Promise<ExecuteCallResult> {
    const addr = typeof contract === 'string' ? AztecAddress.fromString(contract) : contract
    const type = options?.contractType ?? resolveArtifactType(addr.toString(), this.bridgeAddress)
    const artifact = await getContractArtifact(type)
    const instance = await Contract.at(addr, artifact, this.wallet)
    const receipt = await instance.methods[method](...args)
      .send({ from: this.account })
    return {
      txHash: receipt.txHash.toString(),
      blockNumber: receipt.blockNumber,
    }
  }

  async executeCallWithAuthWit(
    caller: AztecAddress | string,
    bridgeContract: AztecAddress | string,
    tokenContract: AztecAddress | string,
    method: string,
    args: any[]
  ): Promise<void> {
    const tokenAddr = typeof tokenContract === 'string' ? AztecAddress.fromString(tokenContract) : tokenContract
    const callerAddr = typeof caller === 'string' ? AztecAddress.fromString(caller) : caller
    const tokenArtifact = await getContractArtifact('token')
    const token = await Contract.at(tokenAddr, tokenArtifact, this.wallet)

    const functionCall = await token.methods[method](...args).getFunctionCall()
    await this.wallet.createAuthWit(
      this.account,
      {
        caller: callerAddr,
        call: functionCall,
      }
    )
  }

  /**
   * Public withdrawal to L1:
   * 1. Create public authwit for bridge to call token.burn_public
   * 2. Send bridge.exit_to_l1_public
   */
  async executeWithdrawToL1Public(
    l1Address: string,
    amount: bigint,
    nonce: Fr,
    userAddress?: AztecAddress | string
  ): Promise<ExecuteCallResult> {
    const user = userAddress
      ? (typeof userAddress === 'string' ? AztecAddress.fromString(userAddress) : userAddress)
      : this.account

    const bridgeAddr = AztecAddress.fromString(this.bridgeAddress)
    const tokenAddr = AztecAddress.fromString(this.tokenAddress)

    const [tokenArtifact, bridgeArtifact] = await Promise.all([
      getContractArtifact('token'),
      getContractArtifact('bridge'),
    ])

    const token = await Contract.at(tokenAddr, tokenArtifact, this.wallet)
    const bridge = await Contract.at(bridgeAddr, bridgeArtifact, this.wallet)

    // Create auth witness: allow bridge to burn_public on behalf of user
    const burnCall = await token.methods.burn_public(user, amount, nonce).getFunctionCall()
    await this.wallet.createAuthWit(
      this.account,
      {
        caller: bridgeAddr,
        call: burnCall,
      }
    )

    // Send exit transaction
    const receipt = await bridge.methods
      .exit_to_l1_public(EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce)
      .send({ from: this.account })

    return {
      txHash: receipt.txHash.toString(),
      blockNumber: receipt.blockNumber,
    }
  }

  /**
   * Private withdrawal to L1:
   * 1. Create private authwit for bridge to call token.burn_private
   * 2. Send bridge.exit_to_l1_private
   */
  async executeWithdrawToL1Private(
    l1Address: string,
    amount: bigint,
    nonce: Fr,
    userAddress?: AztecAddress | string
  ): Promise<ExecuteCallResult> {
    const user = userAddress
      ? (typeof userAddress === 'string' ? AztecAddress.fromString(userAddress) : userAddress)
      : this.account

    const bridgeAddr = AztecAddress.fromString(this.bridgeAddress)
    const tokenAddr = AztecAddress.fromString(this.tokenAddress)

    const [tokenArtifact, bridgeArtifact] = await Promise.all([
      getContractArtifact('token'),
      getContractArtifact('bridge'),
    ])

    const token = await Contract.at(tokenAddr, tokenArtifact, this.wallet)
    const bridge = await Contract.at(bridgeAddr, bridgeArtifact, this.wallet)

    // Create auth witness: allow bridge to burn_private on behalf of user
    const burnCall = await token.methods.burn_private(user, amount, nonce).getFunctionCall()
    await this.wallet.createAuthWit(
      this.account,
      {
        caller: bridgeAddr,
        call: burnCall,
      }
    )

    // Send exit transaction
    const receipt = await bridge.methods
      .exit_to_l1_private(tokenAddr, EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce)
      .send({ from: this.account })

    return {
      txHash: receipt.txHash.toString(),
      blockNumber: receipt.blockNumber,
    }
  }

  async registerToken(tokenAddress: AztecAddress | string): Promise<void> {
    // With wallet-sdk, contracts are resolved on-demand via Contract.at().
    // The wallet extension manages its own token registry.
    // wallet.registerContract() requires a ContractInstanceWithAddress which
    // is not available from just an address — the extension wallet handles this.
    console.log('[WalletAdapter] registerToken called for', tokenAddress.toString())
  }
}

// ============================================================================
// WALLET ADAPTER FACTORY
// ============================================================================

export async function createWalletAdapter(context: WalletContext) {
  if (!context.sdkWallet) {
    throw new Error('Wallet SDK wallet instance not available')
  }

  const accounts = await context.sdkWallet.getAccounts()
  if (!accounts || accounts.length === 0) {
    throw new Error('No accounts available in wallet')
  }

  // getAccounts() returns Aliased<AztecAddress>[] — unwrap with .item
  const account = 'item' in accounts[0] ? (accounts[0] as any).item : accounts[0]
  const adapter = new WalletAdapter(
    context.sdkWallet,
    account
  )
  return adapter
}
