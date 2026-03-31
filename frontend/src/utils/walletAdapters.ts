import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { Contract, BatchCall } from '@aztec/aztec.js/contracts'
import { SetPublicAuthwitContractInteraction, computeInnerAuthWitHashFromAction } from '@aztec/aztec.js/authorization'
import type { Wallet } from '@aztec/aztec.js/wallet'
import { BRIDGED_FPC_ADDRESS, L1_TOKENS } from '@/config'
import { aztecNode } from '@/aztec'

export interface WalletContext {
  loginMethod: 'wallet-sdk'
  sdkWallet?: Wallet | null
  aztecAccount?: { address: { toString: () => string }; sdkWallet: Wallet } | null
}

export interface SimulateViewResult {
  result: any
}

export interface ExecuteCallResult {
  txHash: string
  blockNumber?: number
}

type ContractType = 'token' | 'bridge' | 'bridged_fpc' | 'fee_juice'

async function getContractArtifact(type: ContractType) {
  if (type === 'bridge') {
    const bridgeJson = await import('../../../aztec-contracts/token_bridge/target/token_bridge_contract-TokenBridge.json')
    const { loadContractArtifact } = await import('@aztec/aztec.js/abi')
    // @ts-ignore — JSON import from local build output
    return loadContractArtifact(bridgeJson.default ?? bridgeJson)
  }
  if (type === 'bridged_fpc') {
    const { PrivateFPCContractArtifact } = await import('@wonderland/aztec-fee-payment')
    return PrivateFPCContractArtifact
  }
  if (type === 'fee_juice') {
    const { FeeJuiceContractArtifact } = await import('@aztec/noir-contracts.js/FeeJuice')
    return FeeJuiceContractArtifact
  }
  const { TokenContractArtifact } = await import('@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js')
  return TokenContractArtifact
}

const FEE_JUICE_L2_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000005'

function resolveArtifactType(
  contractAddress: string,
  bridgeAddress: string
): ContractType {
  if (contractAddress.toLowerCase() === bridgeAddress.toLowerCase()) return 'bridge'
  if (BRIDGED_FPC_ADDRESS && contractAddress.toLowerCase() === BRIDGED_FPC_ADDRESS.toLowerCase()) return 'bridged_fpc'
  if (contractAddress.toLowerCase() === FEE_JUICE_L2_ADDRESS.toLowerCase()) return 'fee_juice'
  return 'token'
}

class WalletAdapter {
  readonly tokenAddress: string
  readonly bridgeAddress: string
  readonly proxyAddress: string

  constructor(
    private wallet: Wallet,
    private account: AztecAddress,
    tokenAddress?: string,
    bridgeAddress?: string,
    proxyAddress?: string,
  ) {
    this.tokenAddress = tokenAddress ?? L1_TOKENS[0]?.l2TokenContract ?? ''
    this.bridgeAddress = bridgeAddress ?? L1_TOKENS[0]?.l2BridgeContract ?? ''
    this.proxyAddress = proxyAddress ?? L1_TOKENS[0]?.l2ProxyContract ?? ''
  }

  async initializeContracts(): Promise<void> {
    // Register ALL tokens and bridges from config, not just the default
    const deployedContracts: { addr: string; type: 'token' | 'bridge' }[] = L1_TOKENS.flatMap(
      (t) => [
        { addr: t.l2TokenContract ?? '', type: 'token' as const },
        { addr: t.l2BridgeContract ?? '', type: 'bridge' as const },
      ],
    ).filter(({ addr }) => !!addr)

    // Register deployed contracts (token, bridge) via node lookup
    await Promise.all(
      deployedContracts.map(async ({ addr, type }) => {
        try {
          const address = AztecAddress.fromString(addr)
          const [instance, artifact] = await Promise.all([
            aztecNode.getContract(address),
            getContractArtifact(type),
          ])
          if (instance) {
            await this.wallet.registerContract(instance, artifact)
          }
        } catch {
          // Contract may already be registered
        }
      })
    )

    // Register BridgedFPC separately — it's a registered-not-deployed contract,
    // so the node doesn't know about it. We compute the deterministic instance
    // locally and register it with the wallet's PXE.
    if (BRIDGED_FPC_ADDRESS) {
      try {
        const { registerPrivateContract } = await import('@wonderland/aztec-fee-payment')
        const { Fr } = await import('@aztec/aztec.js/fields')
        await registerPrivateContract(this.wallet, Fr.ZERO)
      } catch {
        // May already be registered
      }
    }
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
    const { result } = await instance.methods[method](...args).simulate({ from: this.account })
    return { result }
  }

  async simulateViews(
    calls: { contract: AztecAddress | string; method: string; args: any[] }[]
  ): Promise<SimulateViewResult[]> {
    const results = await Promise.all(
      calls.map((c) => this.simulateView(c.contract, c.method, c.args))
    )
    return results
  }

  /**
   * Pre-simulate a contract call via the wallet's PXE without triggering a popup.
   * Returns true if simulation passes, throws if it fails.
   * Useful for polling until the wallet's node has synced L1→L2 messages.
   */
  async preSimulateCall(
    contract: AztecAddress | string,
    method: string,
    args: any[],
    options?: { contractType?: ContractType; fee?: { paymentMethod: any } }
  ): Promise<void> {
    const addr = typeof contract === 'string' ? AztecAddress.fromString(contract) : contract
    const type = options?.contractType ?? resolveArtifactType(addr.toString(), this.bridgeAddress)
    const artifact = await getContractArtifact(type)
    const instance = await Contract.at(addr, artifact, this.wallet)
    const interaction = instance.methods[method](...args)
    const executionPayload = await interaction.request()
    await this.wallet.simulateTx(executionPayload, {
      from: this.account,
      skipTxValidation: true,
      skipFeeEnforcement: true,
    } as any)
  }

  /**
   * Get chain info from the wallet (chainId + rollup version).
   * Useful for verifying the wallet is on the same network.
   */
  async getWalletChainInfo(): Promise<{ chainId: string; version: string }> {
    const info = await this.wallet.getChainInfo()
    return {
      chainId: info.chainId.toString(),
      version: info.version.toString(),
    }
  }

  async executeCall(
    contract: AztecAddress | string,
    method: string,
    args: any[],
    options?: { contractType?: ContractType; fee?: { paymentMethod: any } }
  ): Promise<ExecuteCallResult> {
    const addr = typeof contract === 'string' ? AztecAddress.fromString(contract) : contract
    const type = options?.contractType ?? resolveArtifactType(addr.toString(), this.bridgeAddress)
    const artifact = await getContractArtifact(type)
    const instance = await Contract.at(addr, artifact, this.wallet)
    const sendOpts: any = { from: this.account }
    if (options?.fee) {
      sendOpts.fee = options.fee
      sendOpts.skipFeeEnforcement = true
    }
    const { receipt } = await instance.methods[method](...args)
      .send(sendOpts)
    return {
      txHash: receipt.txHash.toString(),
      blockNumber: receipt.blockNumber,
    }
  }

  /**
   * Execute multiple contract calls as a single L2 transaction.
   * Each call is built into an interaction, then batched and sent atomically.
   */
  async executeBatch(
    calls: { contract: AztecAddress | string; method: string; args: any[]; contractType?: ContractType }[],
    options?: { fee?: { paymentMethod: any } }
  ): Promise<ExecuteCallResult> {
    const interactions = await Promise.all(
      calls.map(async (call) => {
        const addr = typeof call.contract === 'string' ? AztecAddress.fromString(call.contract) : call.contract
        const type = call.contractType ?? resolveArtifactType(addr.toString(), this.bridgeAddress)
        const artifact = await getContractArtifact(type)
        const instance = await Contract.at(addr, artifact, this.wallet)
        return instance.methods[call.method](...call.args)
      })
    )

    const batch = new BatchCall(this.wallet, interactions)
    const sendOpts: any = { from: this.account }
    if (options?.fee) sendOpts.fee = options.fee
    const { receipt } = await batch.send(sendOpts)
    return {
      txHash: receipt.txHash.toString(),
      blockNumber: receipt.blockNumber,
    }
  }

  /** Expose the underlying SDK wallet (needed for FeeJuicePaymentMethodWithClaim) */
  get sdkWallet(): Wallet {
    return this.wallet
  }

  /**
   * Public withdrawal to L1 — batched into a single transaction:
   * 1. Set public authwit in AuthRegistry (set_authorized)
   * 2. Bridge exit_to_l1_public (which calls token.burn_public)
   *
   * Both are public calls batched via BatchCall, so they execute in enqueue
   * order within one tx — the authwit is visible when burn_public checks it.
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

    // Set public authwit: allow bridge to burn_public on behalf of user
    const authwit = await SetPublicAuthwitContractInteraction.create(
      this.wallet,
      this.account,
      {
        caller: bridgeAddr,
        action: token.methods.burn_public(user, amount, nonce),
      },
      true,
    )

    // Batch authwit + exit into a single tx — public calls execute in enqueue order,
    // so set_authorized runs before burn_public, making the auth visible.
    const exitCall = bridge.methods.exit_to_l1_public(
      EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce,
    )
    const batch = new BatchCall(this.wallet, [authwit, exitCall])
    const { receipt } = await batch.send({ from: this.account })

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

    // Create private auth witness: allow bridge to burn_private on behalf of user
    // Pre-compute the inner hash locally to avoid FunctionCall serialization issues over RPC
    const burnCall = await token.methods.burn_private(user, amount, nonce).getFunctionCall()
    const innerHash = await computeInnerAuthWitHashFromAction(bridgeAddr, burnCall)
    await this.wallet.createAuthWit(
      this.account,
      {
        consumer: tokenAddr,
        innerHash,
      }
    )

    // Send exit transaction
    const { receipt } = await bridge.methods
      .exit_to_l1_private(tokenAddr, EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce)
      .send({ from: this.account })

    return {
      txHash: receipt.txHash.toString(),
      blockNumber: receipt.blockNumber,
    }
  }

  async registerToken(tokenAddress: AztecAddress | string): Promise<void> {
    const addr = typeof tokenAddress === 'string' ? AztecAddress.fromString(tokenAddress) : tokenAddress
    const type = resolveArtifactType(addr.toString(), this.bridgeAddress)
    try {
      const [instance, artifact] = await Promise.all([
        aztecNode.getContract(addr),
        getContractArtifact(type),
      ])
      if (instance) {
        await this.wallet.registerContract(instance, artifact)
      }
    } catch {
      // Contract may already be registered
    }
  }
}

export async function createWalletAdapter(context: WalletContext) {
  if (!context.sdkWallet) {
    throw new Error('Wallet SDK wallet instance not available')
  }

  let account: AztecAddress
  if (context.aztecAccount?.address) {
    const addr = context.aztecAccount.address.toString()
    account = AztecAddress.fromString(addr)
  } else {
    const accounts = await context.sdkWallet.getAccounts()
    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts available in wallet')
    }
    account = 'item' in accounts[0] ? (accounts[0] as any).item : accounts[0]
  }

  const adapter = new WalletAdapter(context.sdkWallet, account)

  // Register token + bridge contracts with the wallet's PXE
  await adapter.initializeContracts()

  return adapter
}
