import { AzguardClient } from '@azguardwallet/client'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import type {
  Operation,
  OperationResult,
  RegisterContractOperation,
  RegisterTokenOperation,
  SendTransactionOperation,
  SimulateViewsOperation,
  CallAction,
  Action,
} from '@/types/azguardOperations'

/**
 * Helper functions to convert contract method calls to Azguard operations
 * 
 * These helpers create operations compatible with the Azguard Wallet RPC interface.
 * For complete type definitions, see: @/types/azguardOperations
 */

// Local operation types that extend the base types for our use case
export interface AzguardCallOperation extends CallAction {
  kind: 'call'
  contract: string
  method: string
  args: any[]
}

export interface AzguardAuthWitOperation {
  kind: 'add_private_authwit'
  content: AzguardCallOperation
}

export interface AzguardSendTransactionOperation extends Omit<SendTransactionOperation, 'actions'> {
  kind: 'send_transaction'
  account: string
  actions: (AzguardCallOperation | AzguardAuthWitOperation)[]
}

export interface AzguardSimulateViewsOperation extends Omit<SimulateViewsOperation, 'calls'> {
  kind: 'simulate_views'
  account: string
  calls: AzguardCallOperation[]
}

export interface AzguardRegisterContractOperation extends RegisterContractOperation {
  kind: 'register_contract'
  chain: string
  address: string
  instance?: any
  artifact?: any
}

export interface AzguardRegisterTokenOperation extends RegisterTokenOperation {
  kind: 'register_token'
  account: string
  address: string
}

export type AzguardOperation =
  | AzguardCallOperation
  | AzguardAuthWitOperation
  | AzguardSendTransactionOperation
  | AzguardSimulateViewsOperation
  | AzguardRegisterContractOperation
  | AzguardRegisterTokenOperation

/**
 * Convert AztecAddress to string for Azguard operations
 */
function addressToString(address: AztecAddress | EthAddress | string): string {
  if (typeof address === 'string') return address
  return address.toString()
}

/**
 * Convert Fr to bigint or number for Azguard operations
 */
function frToValue(fr: Fr | bigint | number): bigint | number {
  if (fr instanceof Fr) {
    return fr.toBigInt()
  }
  return fr
}

/**
 * Convert contract method arguments to Azguard format
 */
function convertArgs(args: any[]): any[] {
  return args.map((arg) => {
    if (arg instanceof AztecAddress || arg instanceof EthAddress) {
      return addressToString(arg)
    }
    if (arg instanceof Fr) {
      return frToValue(arg)
    }
    if (typeof arg === 'bigint') {
      return arg
    }
    if (typeof arg === 'number') {
      return arg
    }
    if (typeof arg === 'string') {
      return arg
    }
    // For complex types, try to convert
    if (arg && typeof arg === 'object') {
      if ('toString' in arg) {
        return arg.toString()
      }
    }
    return arg
  })
}

/**
 * Create an Azguard call operation
 */
export function createAzguardCall(
  contract: AztecAddress | string,
  method: string,
  args: any[]
): AzguardCallOperation {
  return {
    kind: 'call',
    contract: addressToString(contract),
    method,
    args: convertArgs(args),
  }
}

/**
 * Create an Azguard authwit operation
 */
export function createAzguardAuthWit(
  caller: AztecAddress | string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): AzguardAuthWitOperation {
  return {
    kind: 'add_private_authwit',
    content: createAzguardCall(contract, method, args),
  }
}

/**
 * Create an Azguard send transaction operation
 */
export function createAzguardSendTransaction(
  account: string,
  actions: (AzguardCallOperation | AzguardAuthWitOperation)[]
): AzguardSendTransactionOperation {
  return {
    kind: 'send_transaction',
    account,
    actions,
  }
}


/**
 * Execute a contract method call using Azguard client
 * Automatically registers the contract if needed
 */
export async function executeAzguardCall(
  azguardClient: AzguardClient,
  account: string,
  contract: AztecAddress | string,
  method: string,
  args: any[],
  options?: {
    chain?: string
    contractType?: 'token' | 'bridge'
    autoRegister?: boolean
  }
): Promise<string> {
  const chain = options?.chain || 'aztec:1674512022'
  
  // Try to execute the call first
  const callOp = createAzguardCall(contract, method, args)
  const txOp = createAzguardSendTransaction(account, [callOp])
  
  try {
    const results = await azguardClient.execute([txOp])
    
    const txResult = results[0]
    if (!txResult || txResult.status !== 'ok') {
      // Check if error is about contract not registered
      const errorMsg = txResult?.error || 'Unknown error'
      if ((errorMsg.includes('artifact') || errorMsg.includes('not found') || errorMsg.includes('not registered') || errorMsg.includes('Contract artifact')) 
          && options?.autoRegister !== false) {
        // Register contract without instance/artifact - Azguard will fetch them from PXE/node
        const operations: AzguardOperation[] = [
          {
            kind: 'register_contract',
            chain,
            address: addressToString(contract),
            // instance and artifact are optional - Azguard will fetch them from PXE/node
          },
          txOp,
        ]
        
        try {
          const regResults = await azguardClient.execute(operations)
          
          if (regResults[0].status !== 'ok') {
            const regError = regResults[0]?.error || 'Unknown error'
            throw new Error(`Azguard contract registration failed: ${regError}`)
          }
          
          const retryTxResult = regResults[1]
          if (!retryTxResult || retryTxResult.status !== 'ok') {
            const retryError = retryTxResult?.error || 'Unknown error'
            throw new Error(`Azguard transaction failed after registration: ${retryError}`)
          }
          
          return retryTxResult.result as string
        } catch (regError) {
          throw regError
        }
      } else {
        throw new Error(`Azguard transaction failed: ${errorMsg}`)
      }
    }
    
    return txResult.result as string
  } catch (error) {
    // If it's already an Error with our message, rethrow it
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard transaction failed: ${String(error)}`)
  }
}

/**
 * Execute a contract method call with authwit using Azguard client
 */
export async function executeAzguardCallWithAuthWit(
  azguardClient: AzguardClient,
  account: string,
  caller: AztecAddress | string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): Promise<string> {
  const authWitOp = createAzguardAuthWit(caller, contract, method, args)
  const callOp = createAzguardCall(contract, method, args)
  const txOp = createAzguardSendTransaction(account, [authWitOp, callOp])

  const results = await azguardClient.execute([txOp])
  
  if (results.length === 0 || results[0].status !== 'ok') {
    const errorMsg = results[0]?.error || 'Unknown error'
    
    // Check if error is about contract artifact not found
    const isArtifactError = 
      errorMsg.includes('Contract artifact not found') ||
      errorMsg.includes('artifact not found') ||
      errorMsg.includes('Contract artifact') ||
      (errorMsg.includes('artifact') && errorMsg.includes('not found'))
    
    if (isArtifactError) {
      throw new Error(
        `Azguard transaction failed: Contract artifact not found. ` +
        `Please upload the contract artifact to https://devnet.aztec-registry.xyz/ to make it available for Azguard wallet.`
      )
    }
    
    throw new Error(`Azguard transaction failed: ${errorMsg}`)
  }

  return results[0].result as string
}

/**
 * Simulate a view function using Azguard client
 */
export async function simulateAzguardView(
  azguardClient: AzguardClient,
  account: string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): Promise<any> {
  const callOp = createAzguardCall(contract, method, args)
  const simulateOp: AzguardSimulateViewsOperation = {
    kind: 'simulate_views',
    account,
    calls: [callOp],
  }

  const results = await azguardClient.execute([simulateOp])
  
  if (results.length === 0 || results[0].status !== 'ok') {
    const errorMsg = results[0]?.error || 'Unknown error'
    
    // Check if error is about contract artifact not found
    const isArtifactError = 
      errorMsg.includes('Contract artifact not found') ||
      errorMsg.includes('artifact not found') ||
      errorMsg.includes('Contract artifact') ||
      (errorMsg.includes('artifact') && errorMsg.includes('not found'))
    
    if (isArtifactError) {
      throw new Error(
        `Azguard simulation failed: Contract artifact not found. ` +
        `Please upload the contract artifact to https://devnet.aztec-registry.xyz/ to make it available for Azguard wallet.`
      )
    }
    
    throw new Error(`Azguard simulation failed: ${errorMsg}`)
  }

  // Return decoded result
  const result = results[0].result as any
  if (result.decoded && result.decoded.length > 0) {
    return result.decoded[0]
  }
  return result
}

/**
 * Register a token with Azguard client
 * This adds the token to the user's wallet automatically
 */
export async function registerAzguardToken(
  azguardClient: AzguardClient,
  account: string,
  tokenAddress: AztecAddress | string
): Promise<void> {
  const registerTokenOp: AzguardRegisterTokenOperation = {
    kind: 'register_token',
    account,
    address: addressToString(tokenAddress),
  }

  const results = await azguardClient.execute([registerTokenOp])

  if (results.length === 0 || results[0].status !== 'ok') {
    const error = results[0]?.error || 'Unknown error'
    throw new Error(`Azguard token registration failed: ${error}`)
  }
}

