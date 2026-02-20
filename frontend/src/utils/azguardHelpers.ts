import { AzguardClient } from '@azguardwallet/client'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { L2_CHAIN_KEY } from '@/config'
import { showToast } from '@/hooks/useToast'
import type {
  Operation,
  OperationResult,
  RegisterContractOperation,
  RegisterTokenOperation,
  SendTransactionOperation,
  SimulateViewsOperation,
  CallAction,
  CallAuthwitContent,
  Action,
  FeeOptions,
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
  content: CallAuthwitContent
}

/** Public authwit (for public functions like burn_public) - content must include caller */
export interface AzguardPublicAuthWitOperation {
  kind: 'add_public_authwit'
  content: CallAuthwitContent
}

export interface AzguardSendTransactionOperation
  extends Omit<SendTransactionOperation, 'actions'> {
  kind: 'send_transaction'
  account: string
  actions: (
    | AzguardCallOperation
    | AzguardAuthWitOperation
    | AzguardPublicAuthWitOperation
  )[]
}

export interface AzguardSimulateViewsOperation
  extends Omit<SimulateViewsOperation, 'calls'> {
  kind: 'simulate_views'
  account: string
  calls: AzguardCallOperation[]
}

export interface AzguardRegisterContractOperation
  extends RegisterContractOperation {
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

/** Log full Azguard execute result (handles bigint for JSON) */
function logAzguardResult(label: string, results: unknown) {
  // console.log(`[Azguard] ${label}`, results)
  try {
    const json = JSON.stringify(
      results,
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    )
    // console.log(`[Azguard] ${label} (JSON)`, json)
  } catch {
    // skip if not serializable (e.g. circular)
  }
}

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
 * Create an Azguard private authwit operation (for private function calls).
 * Content does not include caller in the base CallAction; use add_public_authwit for public calls.
 */
export function createAzguardAuthWit(
  caller: AztecAddress | string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): AzguardAuthWitOperation {
  return {
    kind: 'add_private_authwit',
    content: {
      kind: 'call',
      caller: addressToString(caller),
      contract: addressToString(contract),
      method,
      args: convertArgs(args),
    },
  }
}

/**
 * Create an Azguard public authwit operation (for public function calls like burn_public).
 * Per Azguard/Aztec: the content MUST include "caller" - the contract address authorized
 * to make the call (e.g. the bridge that will call token.burn_public on behalf of the user).
 * @see https://github.com/AzguardWallet/azguard-wallet-types/blob/main/src/authwit-content.ts
 */
export function createAzguardPublicAuthWit(
  caller: AztecAddress | string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): AzguardPublicAuthWitOperation {
  return {
    kind: 'add_public_authwit',
    content: {
      kind: 'call',
      caller: addressToString(caller),
      contract: addressToString(contract),
      method,
      args: convertArgs(args),
    },
  }
}

/** Private authwit (for private functions like burn_private) - same content shape as public */
export function createAzguardPrivateAuthWit(
  caller: AztecAddress | string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): AzguardAuthWitOperation {
  return {
    kind: 'add_private_authwit',
    content: {
      kind: 'call',
      caller: addressToString(caller),
      contract: addressToString(contract),
      method,
      args: convertArgs(args),
    },
  }
}

/** Default fee options: gas padding so maxFeesPerGas stays above current gasFees (avoids "maxFeesPerGas must be >= gasFees" errors) */
const DEFAULT_FEE_OPTIONS: FeeOptions = {
  gasPadding: 2,
}

/**
 * Create an Azguard send transaction operation
 * @param fee - Optional fee options; defaults to gasPadding 1.2 so maxFeesPerGas has headroom above current gasFees
 */
export function createAzguardSendTransaction(
  account: string,
  actions: (
    | AzguardCallOperation
    | AzguardAuthWitOperation
    | AzguardPublicAuthWitOperation
  )[],
  fee?: FeeOptions
): AzguardSendTransactionOperation {
  return {
    kind: 'send_transaction',
    account,
    actions,
    fee: fee ?? DEFAULT_FEE_OPTIONS,
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
  const chain = options?.chain || L2_CHAIN_KEY
  // console.log('[Azguard] executeAzguardCall called', {
  //   contract: addressToString(contract),
  //   method,
  //   args,
  //   chain,
  //   autoRegister: options?.autoRegister,
  // })

  // Try to execute the call first (fee options give headroom so maxFeesPerGas >= gasFees)
  const callOp = createAzguardCall(contract, method, args)
  const txOp = createAzguardSendTransaction(account, [callOp], DEFAULT_FEE_OPTIONS)
  // console.log('[Azguard] executeAzguardCall sending send_transaction', { account, actions: txOp.actions, fee: txOp.fee })

  try {
    const results = await azguardClient.execute([txOp])
    logAzguardResult('executeAzguardCall response (full)', results)

    const txResult = results[0]
    if (!txResult || txResult.status !== 'ok') {
      // Check if error is about contract not registered
      const errorMsg = txResult?.error || 'Unknown error'
      if (
        (errorMsg.includes('artifact') ||
          errorMsg.includes('not found') ||
          errorMsg.includes('not registered') ||
          errorMsg.includes('Contract artifact')) &&
        options?.autoRegister !== false
      ) {
        // Register contract without instance/artifact - Azguard will fetch them from PXE/node
        // console.log('[Azguard] executeAzguardCall retrying with register_contract', { contract: addressToString(contract) })
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
          logAzguardResult('executeAzguardCall register + tx response (full)', regResults)

          if (regResults[0].status !== 'ok') {
            const regError = regResults[0]?.error || 'Unknown error'
            throw new Error(`Azguard contract registration failed: ${regError}`)
          }

          const retryTxResult = regResults[1]
          if (!retryTxResult || retryTxResult.status !== 'ok') {
            const retryError = retryTxResult?.error || 'Unknown error'
            throw new Error(
              `Azguard transaction failed after registration: ${retryError}`
            )
          }

          // console.log('[Azguard] executeAzguardCall success after registration', { txHash: retryTxResult.result })
          return retryTxResult.result as string
        } catch (regError) {
          throw regError
        }
      } else {
        console.log('[Azguard] executeAzguardCall failed', { error: errorMsg })
        throw new Error(`Azguard transaction failed: ${errorMsg}`)
      }
    }

    // console.log('[Azguard] executeAzguardCall success', { txHash: txResult.result })
    return txResult.result as string
  } catch (error) {
    console.log('[Azguard] executeAzguardCall error', { error: String(error) })
    // If it's already an Error with our message, rethrow it
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard transaction failed: ${String(error)}`)
  }
}

/**
 * Execute "add public authwit" only (no contract call).
 * Used for withdrawal: authorize the bridge to call token.burn_public on behalf of the user.
 * The actual burn is done by the bridge when the user later calls exit_to_l1_public.
 *
 * Per Azguard docs and azguard-wallet-types:
 * - Use add_public_authwit for public functions (e.g. burn_public).
 * - Authwit content must include "caller" = the contract authorized to make the call (the bridge).
 * @see https://github.com/AzguardWallet/azguard-wallet-client
 * @see https://github.com/AzguardWallet/azguard-wallet-types/blob/main/src/authwit-content.ts
 */
export async function executeAzguardCallWithAuthWit(
  azguardClient: AzguardClient,
  account: string,
  caller: AztecAddress | string,
  contract: AztecAddress | string,
  method: string,
  args: any[]
): Promise<string> {
  // console.log('[Azguard] executeAzguardCallWithAuthWit called', {
  //   caller: addressToString(caller),
  //   contract: addressToString(contract),
  //   method,
  //   args,
  // })
  try {
    // caller = bridge address (authorized to call token.burn_public)
    // contract = token contract, method = burn_public, args = [userAddress, amount, nonce]
    const publicAuthWitOp = createAzguardPublicAuthWit(
      caller,
      contract,
      method,
      args
    )
    // Only send the authwit - do NOT call burn_public here; the bridge will call it in exit_to_l1_public
    const txOp = createAzguardSendTransaction(account, [publicAuthWitOp], DEFAULT_FEE_OPTIONS)
    // console.log('[Azguard] executeAzguardCallWithAuthWit sending add_public_authwit', { account, content: publicAuthWitOp.content })

    const results = await azguardClient.execute([txOp])
    logAzguardResult('executeAzguardCallWithAuthWit response (full)', results)
    if (results.length === 0 || results[0].status !== 'ok') {
      const errorMsg = results[0]?.error || 'Unknown error'

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

      // console.log('[Azguard] executeAzguardCallWithAuthWit failed', { error: errorMsg })
      throw new Error(`Azguard transaction failed: ${errorMsg}`)
    }

    // console.log('[Azguard] executeAzguardCallWithAuthWit success', { txHash: results[0].result })
    return results[0].result as string
  } catch (error) {
    console.log('[Azguard] executeAzguardCallWithAuthWit error', { error: String(error) })
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard transaction failed: ${String(error)}`)
  }
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
  // console.log('[Azguard] simulateAzguardView called', { contract: addressToString(contract), method, args })
  try {
    const callOp = createAzguardCall(contract, method, args)
    const simulateOp: AzguardSimulateViewsOperation = {
      kind: 'simulate_views',
      account,
      calls: [callOp],
    }

    const results = await azguardClient.execute([simulateOp])
    logAzguardResult('simulateAzguardView response (full)', results)

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
    // console.log('[Azguard] simulateAzguardView success', { hasDecoded: !!result?.decoded?.length, result })
    if (result.decoded && result.decoded.length > 0) {
      return result.decoded[0]
    }
    return result
  } catch (error) {
    console.log('[Azguard] simulateAzguardView error', { error: String(error) })
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard simulation failed: ${String(error)}`)
  }
}

/** Single call spec for simulateAzguardViews */
export interface SimulateViewCall {
  contract: AztecAddress | string
  method: string
  args: any[]
}

/**
 * Simulate multiple view functions in one Azguard simulate_views call.
 * Returns an array of decoded results in the same order as the calls.
 */
export async function simulateAzguardViews(
  azguardClient: AzguardClient,
  account: string,
  calls: SimulateViewCall[]
): Promise<any[]> {
  if (calls.length === 0) return []
  // console.log('[Azguard] simulateAzguardViews called', { callCount: calls.length, calls: calls.map((c) => ({ contract: addressToString(c.contract), method: c.method })) })
  try {
    const callOps = calls.map((c) => createAzguardCall(c.contract, c.method, c.args))
    const simulateOp: AzguardSimulateViewsOperation = {
      kind: 'simulate_views',
      account,
      calls: callOps,
    }

    const results = await azguardClient.execute([simulateOp])
    logAzguardResult('simulateAzguardViews response (full)', results)

    if (results.length === 0 || results[0].status !== 'ok') {
      const errorMsg = results[0]?.error || 'Unknown error'
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

    const result = results[0].result as any
    // console.log('[Azguard] simulateAzguardViews success', { hasDecoded: !!result?.decoded?.length, result })
    if (result?.decoded && Array.isArray(result.decoded)) {
      return result.decoded
    }
    return result && Array.isArray(result) ? result : [result]
  } catch (error) {
    console.log('[Azguard] simulateAzguardViews error', { error: String(error) })
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard simulation failed: ${String(error)}`)
  }
}

/**
 * Execute L2 withdrawal to L1 in a single transaction via Azguard client:
 * send_transaction with actions [add_public_authwit (auth to burn + exit), call exit_to_l1_public].
 * Mirrors the Azguard example: authwit and the call must be in the same tx
 * so the token contract sees the authwit when the bridge calls burn_public.
 * @see https://github.com/AzguardWallet/azguard-wallet-types/blob/main/src/operation.ts
 */
export async function executeAzguardWithdrawToL1Batch(
  azguardClient: AzguardClient,
  account: string,
  userAddress: AztecAddress | string,
  l1Address: string,
  amount: bigint,
  nonce: Fr,
  bridgeAddress: AztecAddress | string,
  tokenAddress: AztecAddress | string,
  options?: { chain?: string; autoRegister?: boolean }
): Promise<string> {
  const chain = options?.chain || L2_CHAIN_KEY
  // console.log('[Azguard] executeAzguardWithdrawToL1Batch called', {
  //   account,
  //   l1Address,
  //   amount: amount.toString(),
  //   bridge: addressToString(bridgeAddress),
  //   token: addressToString(tokenAddress),
  //   chain,
  // })

  const publicAuthWitOp = createAzguardPublicAuthWit(
    bridgeAddress,
    tokenAddress,
    'burn_public',
    [userAddress, amount, nonce]
  )
  const exitCallOp = createAzguardCall(
    bridgeAddress,
    'exit_to_l1_public',
    [EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce]
  )
  const txOp = createAzguardSendTransaction(
    account,
    [publicAuthWitOp, exitCallOp],
    DEFAULT_FEE_OPTIONS
  )
  // console.log('[Azguard] executeAzguardWithdrawToL1Batch sending send_transaction (auth to burn + exit)', {
    // account,
  //   actions: txOp.actions,
  //   fee: txOp.fee,
  // })

  try {
    const results = await azguardClient.execute([txOp])
    logAzguardResult('executeAzguardWithdrawToL1Batch response (full)', results)

    const txResult = results[0]
    if (!txResult || txResult.status !== 'ok') {
      const errorMsg = txResult?.error || 'Unknown error'
      if (
        (errorMsg.includes('artifact') ||
          errorMsg.includes('not found') ||
          errorMsg.includes('not registered') ||
          errorMsg.includes('Contract artifact')) &&
        options?.autoRegister !== false
      ) {
        // console.log('[Azguard] executeAzguardWithdrawToL1Batch retrying with register_contract (bridge + token)')
        const operations: AzguardOperation[] = [
          {
            kind: 'register_contract',
            chain,
            address: addressToString(bridgeAddress),
          },
          {
            kind: 'register_contract',
            chain,
            address: addressToString(tokenAddress),
          },
          txOp,
        ]
        const regResults = await azguardClient.execute(operations)
        logAzguardResult('executeAzguardWithdrawToL1Batch register + tx response (full)', regResults)
        const retryTxResult = regResults[2]
        if (!retryTxResult || retryTxResult.status !== 'ok') {
          const retryError = retryTxResult?.error || 'Unknown error'
          throw new Error(
            `Azguard withdraw batch failed after registration: ${retryError}`
          )
        }
        return retryTxResult.result as string
      }
      throw new Error(`Azguard transaction failed: ${errorMsg}`)
    }

    return txResult.result as string
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard transaction failed: ${String(error)}`)
  }
}

/**
 * Execute L2 private withdrawal to L1 in a single transaction via Azguard client:
 * send_transaction with actions [add_private_authwit (auth to burn_private + exit), call exit_to_l1_private].
 * Same flow as public but uses private authwit and burn_private/exit_to_l1_private.
 * L1 message leaf and withdraw() call are identical (get_withdraw_content_hash is shared).
 */
export async function executeAzguardWithdrawToL1BatchPrivate(
  azguardClient: AzguardClient,
  account: string,
  userAddress: AztecAddress | string,
  l1Address: string,
  amount: bigint,
  nonce: Fr,
  bridgeAddress: AztecAddress | string,
  tokenAddress: AztecAddress | string,
  options?: { chain?: string; autoRegister?: boolean }
): Promise<string> {
  const chain = options?.chain || L2_CHAIN_KEY
    // console.log('[Azguard] executeAzguardWithdrawToL1BatchPrivate called', {
  //   account,
  //   l1Address,
  //   amount: amount.toString(),
  //   bridge: addressToString(bridgeAddress),
  //   token: addressToString(tokenAddress),
  //   chain,
  // })

  const privateAuthWitOp = createAzguardPrivateAuthWit(
    bridgeAddress,
    tokenAddress,
    'burn_private',
    [userAddress, amount, nonce]
  )
  const exitCallOp = createAzguardCall(
    bridgeAddress,
    'exit_to_l1_private',
    [EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce]
  )
  const txOp = createAzguardSendTransaction(
    account,
    [privateAuthWitOp, exitCallOp],
    DEFAULT_FEE_OPTIONS
  )
  // console.log('[Azguard] executeAzguardWithdrawToL1BatchPrivate sending send_transaction (private auth to burn + exit)', {
  //   account,
  //   actions: txOp.actions,
  //   fee: txOp.fee,
  // })

  try {
    const results = await azguardClient.execute([txOp])
    logAzguardResult('executeAzguardWithdrawToL1BatchPrivate response (full)', results)

    const txResult = results[0]
    if (!txResult || txResult.status !== 'ok') {
      const errorMsg = txResult?.error || 'Unknown error'
      if (
        (errorMsg.includes('artifact') ||
          errorMsg.includes('not found') ||
          errorMsg.includes('not registered') ||
          errorMsg.includes('Contract artifact')) &&
        options?.autoRegister !== false
      ) {
        // console.log('[Azguard] executeAzguardWithdrawToL1BatchPrivate retrying with register_contract (bridge + token)')
        const operations: AzguardOperation[] = [
          {
            kind: 'register_contract',
            chain,
            address: addressToString(bridgeAddress),
          },
          {
            kind: 'register_contract',
            chain,
            address: addressToString(tokenAddress),
          },
          txOp,
        ]
        const regResults = await azguardClient.execute(operations)
        logAzguardResult('executeAzguardWithdrawToL1BatchPrivate register + tx response (full)', regResults)
        const retryTxResult = regResults[2]
        if (!retryTxResult || retryTxResult.status !== 'ok') {
          const retryError = retryTxResult?.error || 'Unknown error'
          throw new Error(
            `Azguard private withdraw batch failed after registration: ${retryError}`
          )
        }
        return retryTxResult.result as string
      }
      throw new Error(`Azguard transaction failed: ${errorMsg}`)
    }

    return txResult.result as string
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard transaction failed: ${String(error)}`)
  }
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
  // console.log('[Azguard] registerAzguardToken called', { account, tokenAddress: addressToString(tokenAddress) })
  try {
    const registerTokenOp: AzguardRegisterTokenOperation = {
      kind: 'register_token',
      account,
      address: addressToString(tokenAddress),
    }

    const results = await azguardClient.execute([registerTokenOp])
    logAzguardResult('registerAzguardToken response (full)', results)

    if (results.length === 0 || results[0].status !== 'ok') {
      const error = results[0]?.error || 'Unknown error'
      const errorMsg = String(error)
      const isSimulationInvalid =
        errorMsg.includes('simulated transaction') &&
        errorMsg.includes('unable to be added to state') &&
        errorMsg.includes('invalid')
      if (isSimulationInvalid) {
        console.log(
          'Azguard token registration simulation failed. tokenAddress:',
          addressToString(tokenAddress)
        )
        console.warn(
          'Azguard token registration simulation failed; continuing without token registration.',
          errorMsg
        )
        showToast(
          'warn',
          'Azguard token registration failed in simulation. Check token address and node; continuing without registration.'
        )
        return
      }
      throw new Error(`Azguard token registration failed: ${errorMsg}`)
    }
    // console.log('[Azguard] registerAzguardToken success')
  } catch (error) {
    console.log('[Azguard] registerAzguardToken error', { error: String(error) })
    if (error instanceof Error) {
      throw error
    }
    throw new Error(`Azguard token registration failed: ${String(error)}`)
  }
}
