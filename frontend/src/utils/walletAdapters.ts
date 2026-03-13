import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { Contract } from '@aztec/aztec.js/contracts'
import type { Wallet } from '@aztec/aztec.js/wallet'
import { L1_TOKENS } from '@/config'
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

async function getContractArtifact(type: 'token' | 'bridge' | 'proxy') {
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi')
  if (type === 'bridge') {
    // Custom compliant bridge — artifact from local build output
    const bridgeJson = await import('../../../aztec-contracts/token_bridge/target/token_bridge_contract-TokenBridge.json')
    // @ts-ignore — JSON import from local build output
    return loadContractArtifact(bridgeJson.default ?? bridgeJson)
  }
  if (type === 'proxy') {
    // TokenMinterProxy — needed for private claim simulation (bridge → proxy → token)
    const proxyJson = await import('../../../aztec-contracts/token_minter_proxy/target/token_minter_proxy-TokenMinterProxy.json')
    // @ts-ignore — JSON import from local build output
    return loadContractArtifact(proxyJson.default ?? proxyJson)
  }
  // Wonderland Token (constructor_with_minter) — matches deployed token
  // @ts-ignore — JSON import from package target directory
  const tokenJson = await import('@defi-wonderland/aztec-standards/target/token_contract-Token.json')
  // @ts-ignore
  return loadContractArtifact(tokenJson.default ?? tokenJson)
}

function resolveArtifactType(
  contractAddress: string,
  bridgeAddress: string
): 'token' | 'bridge' {
  return contractAddress.toLowerCase() === bridgeAddress.toLowerCase()
    ? 'bridge'
    : 'token'
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
    const addresses = [
      { addr: this.tokenAddress, type: 'token' as const },
      { addr: this.bridgeAddress, type: 'bridge' as const },
      { addr: this.proxyAddress, type: 'proxy' as const },
    ].filter(({ addr }) => !!addr)

    await Promise.all(
      addresses.map(async ({ addr, type }) => {
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
    const results = await Promise.all(
      calls.map((c) => this.simulateView(c.contract, c.method, c.args))
    )
    return results
  }

  async executeCall(
    contract: AztecAddress | string,
    method: string,
    args: any[],
    options?: { contractType?: 'token' | 'bridge'; fee?: { paymentMethod: any } }
  ): Promise<ExecuteCallResult> {
    const addr = typeof contract === 'string' ? AztecAddress.fromString(contract) : contract
    const type = options?.contractType ?? resolveArtifactType(addr.toString(), this.bridgeAddress)
    const artifact = await getContractArtifact(type)
    const instance = await Contract.at(addr, artifact, this.wallet)
    const sendOpts: any = { from: this.account }
    if (options?.fee) sendOpts.fee = options.fee
    const receipt = await instance.methods[method](...args)
      .send(sendOpts)
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
