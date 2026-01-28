/**
 * Wallet Adapter Pattern
 * 
 * This module provides a clean abstraction layer for wallet operations,
 * separating Obsidion SDK and Azguard wallet logic for better maintainability.
 */

import { AzguardClient } from '@azguardwallet/client'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { ADDRESS } from '@/config'
// Obsidion SDK imports are disabled (not yet on Devnet 6)
// import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
// import { TokenContract } from '@aztec/noir-contracts.js/Token'
// import { Contract } from 'raven-house-wallet-sdk/eip1193'
// Package removed from package.json:
// "raven-house-wallet-sdk": "3.0.1-devnet.3",
import {
  executeAzguardCall,
  executeAzguardCallWithAuthWit,
  simulateAzguardView,
  registerAzguardToken,
} from './azguardHelpers'

// Contract classes for Obsidion SDK (disabled on Devnet 6)
// class L2Token extends Contract.fromAztec(TokenContract as any) {}
// class L2TokenBridge extends Contract.fromAztec(TokenBridgeContract as any) {}

// ============================================================================
// TYPES
// ============================================================================

export interface WalletContext {
  loginMethod: 'azguard' | 'obsidion'
  azguardClient?: AzguardClient | null
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
// AZGUARD WALLET ADAPTER
// ============================================================================

class AzguardWalletAdapter {
  // Expose contract addresses as properties for direct access
  readonly tokenAddress: string = ADDRESS[1674512022].L2.TOKEN_CONTRACT
  readonly bridgeAddress: string = ADDRESS[1674512022].L2.TOKEN_BRIDGE_CONTRACT

  constructor(
    private azguardClient: AzguardClient,
    private account: string
  ) {}

  // Initialize contracts - no-op since artifacts are in public registry
  // Azguard will automatically fetch artifacts from the public registry when needed
  async initializeContracts(): Promise<void> {
    // Contracts are publicly deployed and artifacts are in the public registry
    // Azguard will fetch them automatically, so no registration needed
    
    // NOTE: Contract registration is commented out per recommendation to upload artifacts
    // to public registry (https://devnet.aztec-registry.xyz/) instead of triggering 
    // registration on each wallet request.
    // If artifacts are not in public registry, uncomment the code below:
    /*
    const chain = 'aztec:1674512022'
    
    // Register Token contract with artifact
    // Note: instance is optional - Azguard will fetch it from PXE/node if not provided
    try {
      await this.azguardClient.execute([
        {
          kind: 'register_contract',
          chain,
          address: this.tokenAddress,
          artifact: TokenContract.artifact,
          // instance is optional - Azguard will fetch it from PXE/node automatically
        },
      ])
    } catch (error) {
      // Contract might already be registered, or registration failed
      console.warn('Token contract registration warning:', error)
    }
    
    // Register Bridge contract with artifact
    // Note: instance is optional - Azguard will fetch it from PXE/node if not provided
    try {
      await this.azguardClient.execute([
        {
          kind: 'register_contract',
          chain,
          address: this.bridgeAddress,
          artifact: TokenBridgeContract.artifact,
          // instance is optional - Azguard will fetch it from PXE/node automatically
        },
      ])
    } catch (error) {
      // Contract might already be registered, or registration failed
      console.warn('Bridge contract registration warning:', error)
    }
    */
  }

  async simulateView(
    contract: AztecAddress | string,
    method: string,
    args: any[]
  ): Promise<SimulateViewResult> {
    const result = await simulateAzguardView(
      this.azguardClient,
      this.account,
      contract,
      method,
      args
    )
    return { result }
  }

  async executeCall(
    contract: AztecAddress | string,
    method: string,
    args: any[],
    options?: { contractType?: 'token' | 'bridge'; autoRegister?: boolean }
  ): Promise<ExecuteCallResult> {
    const txHash = await executeAzguardCall(
      this.azguardClient,
      this.account,
      contract,
      method,
      args,
      options
    )
    return { txHash }
  }

  async executeCallWithAuthWit(
    caller: AztecAddress | string,
    bridgeContract: AztecAddress | string,
    tokenContract: AztecAddress | string,
    method: string,
    args: any[]
  ): Promise<void> {
    // For Azguard authwit: caller is bridge, contract is token
    await executeAzguardCallWithAuthWit(
      this.azguardClient,
      this.account,
      bridgeContract, // caller
      tokenContract, // contract
      method,
      args
    )
  }

  async registerToken(tokenAddress: AztecAddress | string): Promise<void> {
    await registerAzguardToken(this.azguardClient, this.account, tokenAddress)
  }
}

// ============================================================================
// OBSIDION SDK WALLET ADAPTER
// ============================================================================

// Obsidion SDK wallet adapter is disabled (SDK not yet on Devnet 6)
/*
class ObsidionWalletAdapter {
  // Expose contract addresses as properties for direct access
  readonly tokenAddress: string = ADDRESS[1674512022].L2.TOKEN_CONTRACT
  readonly bridgeAddress: string = ADDRESS[1674512022].L2.TOKEN_BRIDGE_CONTRACT

  // Cache contract lookup map for O(1) access
  private readonly contractMap: Map<string, any>
  private l2TokenContract: any
  private l2BridgeContract: any

  constructor(private aztecAccount: any) {
    // Contracts will be initialized lazily when needed
    this.l2TokenContract = null
    this.l2BridgeContract = null
    this.contractMap = new Map()
  }

  // Initialize contract instances (called by factory)
  async initializeContracts(): Promise<void> {
    if (this.l2TokenContract && this.l2BridgeContract) {
      return // Already initialized
    }

    const token = await L2Token.at(
      AztecAddress.fromString(this.tokenAddress) as any,
      this.aztecAccount
    )

    const bridge = await L2TokenBridge.at(
      AztecAddress.fromString(this.bridgeAddress) as any,
      this.aztecAccount
    )

    this.l2TokenContract = token
    this.l2BridgeContract = bridge

    // Build contract lookup map
    this.contractMap.set(this.tokenAddress, token)
    this.contractMap.set(this.bridgeAddress, bridge)
  }

  async simulateView(
    contract: AztecAddress | string,
    method: string,
    args: any[]
  ): Promise<SimulateViewResult> {
    const contractInstance = this.getContractInstance(contract)
    if (!contractInstance) {
      throw new Error(`Contract instance not found for ${contract}`)
    }

    const methodCall = contractInstance.methods[method](...args)
    const result = await methodCall.simulate()
    return { result }
  }

  async executeCall(
    contract: AztecAddress | string,
    method: string,
    args: any[],
    options?: { contractType?: 'token' | 'bridge'; autoRegister?: boolean }
  ): Promise<ExecuteCallResult> {
    const contractInstance = this.getContractInstance(contract)
    if (!contractInstance) {
      throw new Error(`Contract instance not found for ${contract}`)
    }

    const methodCall = contractInstance.methods[method](...args)
    const txReceipt = await methodCall.send().wait({ timeout: 200000 })

    return {
      txHash: txReceipt.txHash.toString(),
      blockNumber: txReceipt.blockNumber,
    }
  }

  async executeCallWithAuthWit(
    caller: AztecAddress | string,
    bridgeContract: AztecAddress | string,
    tokenContract: AztecAddress | string,
    method: string,
    args: any[]
  ): Promise<void> {
    if (!this.l2TokenContract || !this.l2BridgeContract) {
      throw new Error('L2 contracts not initialized')
    }

    const authwitRequests = await this.aztecAccount.setPublicAuthWit(
      {
        caller: this.l2BridgeContract.address,
        action: await this.l2TokenContract.methods[method](...args).request(),
      },
      true
    )

    await authwitRequests.send().wait({ timeout: 120000 })
  }

  async registerToken(tokenAddress: AztecAddress | string): Promise<void> {
    // For Obsidion, use SDK's watchAssets
    const { getSdk } = await import('../aztec')
    await getSdk().watchAssets([
      {
        type: 'ARC20' as const,
        options: {
          chainId: '1674512022',
          address: typeof tokenAddress === 'string' ? tokenAddress : tokenAddress.toString(),
          name: 'Test USDC',
          symbol: 'USDC',
          decimals: 6,
          image: '',
        },
      },
    // ])
  }

  private getContractInstance(contract: AztecAddress | string): any {
    const contractStr = contract instanceof AztecAddress ? contract.toString() : contract
    return this.contractMap.get(contractStr) || null
  }
}
*/

// ============================================================================
// WALLET ADAPTER FACTORY
// ============================================================================

export async function createWalletAdapter(context: WalletContext) {
  if (context.loginMethod === 'azguard') {
    if (!context.azguardClient || !context.azguardClient.accounts.length) {
      throw new Error('Azguard client not available or no accounts')
    }
    const adapter = new AzguardWalletAdapter(
      context.azguardClient,
      context.azguardClient.accounts[0]
    )
    // No need to initialize contracts - artifacts are in public registry
    // (https://devnet.aztec-registry.xyz/) - Azguard will fetch them automatically when needed
    return adapter
  }

  // else {
  //   if (!context.aztecAccount) {
  //     throw new Error('Obsidion SDK account not available')
  //   }
  //   const adapter = new ObsidionWalletAdapter(context.aztecAccount)
  //   // Initialize contracts (create SDK instances)
  //   await adapter.initializeContracts()
  //   return adapter
  // }

  throw new Error('Obsidion wallet support is disabled (SDK not yet on Devnet 6)')
}


