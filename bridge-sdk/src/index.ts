import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Fr } from '@aztec/aztec.js/fields'
import type {
  BridgeConfig,
  L1Clients,
  L1ToL2DepositResult,
  L2Executor,
  L2ClaimResult,
  L2WithdrawalInitiationResult,
  L1WithdrawalResult,
  L2ToL1Witness,
} from './types'
import { depositToL2, encodeL1Withdrawal } from './l1'
import { claimOnL2, initiateWithdrawal, getL2ToL1Witness } from './l2'
import { getSafeString, toBigInt, toFr } from './utils'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class BridgeSdk {
  constructor(
    private readonly config: BridgeConfig,
    private readonly l1Clients: L1Clients
  ) {}

  async depositToL2Public(params: {
    owner: `0x${string}`
    recipient: `0x${string}`
    amount: bigint
    claimSecret?: Fr | string
  }): Promise<L1ToL2DepositResult> {
    return depositToL2({
      clients: this.l1Clients,
      portalAddress: this.config.l1.portalAddress,
      tokenAddress: this.config.l1.tokenAddress,
      owner: params.owner,
      recipient: params.recipient,
      amount: params.amount,
      claimSecret: params.claimSecret ? toFr(params.claimSecret) : undefined,
    })
  }

  async depositToL2Private(params: {
    owner: `0x${string}`
    amount: bigint
    claimSecret?: Fr | string
  }): Promise<L1ToL2DepositResult> {
    return depositToL2({
      clients: this.l1Clients,
      portalAddress: this.config.l1.portalAddress,
      tokenAddress: this.config.l1.tokenAddress,
      owner: params.owner,
      amount: params.amount,
      isPrivate: true,
      claimSecret: params.claimSecret ? toFr(params.claimSecret) : undefined,
    })
  }

  async waitForL1ToL2MessageSync(params: {
    messageHash: string
    aztecNodeUrl?: string
    pollIntervalMs?: number
    maxAttempts?: number
  }): Promise<void> {
    const {
      messageHash,
      aztecNodeUrl = this.config.aztecNodeUrl,
      pollIntervalMs = 120000,
      maxAttempts = 10,
    } = params

    if (!aztecNodeUrl) {
      throw new Error('aztecNodeUrl is required to check message sync')
    }

    const node = createAztecNodeClient(aztecNodeUrl)
    let attempts = 0

    while (attempts < maxAttempts) {
      const isSynced = await node.isL1ToL2MessageSynced(Fr.fromString(messageHash))
      if (isSynced) return

      attempts += 1
      if (attempts < maxAttempts) {
        await wait(pollIntervalMs)
      }
    }

    throw new Error(
      `L1 to L2 message sync timeout after ${maxAttempts} attempts`
    )
  }

  async claimOnL2Public(params: {
    executor: L2Executor
    recipient: string
    amount: bigint
    claimSecret: Fr | string
    messageLeafIndex: bigint
  }): Promise<L2ClaimResult> {
    return claimOnL2({
      executor: params.executor,
      bridgeAddress: this.config.l2.bridgeAddress,
      recipient: params.recipient,
      amount: params.amount,
      claimSecret: params.claimSecret,
      messageLeafIndex: params.messageLeafIndex,
      isPrivate: false,
    })
  }

  async claimOnL2Private(params: {
    executor: L2Executor
    recipient: string
    amount: bigint
    claimSecret: Fr | string
    messageLeafIndex: bigint
  }): Promise<L2ClaimResult> {
    return claimOnL2({
      executor: params.executor,
      bridgeAddress: this.config.l2.bridgeAddress,
      recipient: params.recipient,
      amount: params.amount,
      claimSecret: params.claimSecret,
      messageLeafIndex: params.messageLeafIndex,
      isPrivate: true,
    })
  }

  async initiateWithdrawal(params: {
    executor: L2Executor
    owner: string
    l1Recipient: string
    amount: bigint
  }): Promise<L2WithdrawalInitiationResult> {
    return initiateWithdrawal({
      executor: params.executor,
      bridgeAddress: this.config.l2.bridgeAddress,
      tokenAddress: this.config.l2.tokenAddress,
      owner: params.owner,
      l1Recipient: params.l1Recipient,
      amount: params.amount,
    })
  }

  async getL2ToL1Witness(params: {
    l2BlockNumber: number
    aztecNodeUrl?: string
  }): Promise<L2ToL1Witness> {
    const aztecNodeUrl = params.aztecNodeUrl ?? this.config.aztecNodeUrl
    if (!aztecNodeUrl) {
      throw new Error('aztecNodeUrl is required to get L2 to L1 witness')
    }

    return getL2ToL1Witness({
      aztecNodeUrl,
      l2BlockNumber: params.l2BlockNumber,
      l2BridgeAddress: this.config.l2.bridgeAddress,
    })
  }

  async finalizeWithdrawal(params: {
    owner: `0x${string}`
    recipient: `0x${string}`
    amount: bigint
    l2BlockNumber: bigint | number | string
    witness?: L2ToL1Witness
    aztecNodeUrl?: string
    confirmationDelayMs?: number
  }): Promise<L1WithdrawalResult> {
    const confirmationDelayMs = params.confirmationDelayMs ?? 40 * 60 * 1000
    if (confirmationDelayMs > 0) {
      await wait(confirmationDelayMs)
    }

    const witness =
      params.witness ??
      (await this.getL2ToL1Witness({
        l2BlockNumber: Number(params.l2BlockNumber),
        aztecNodeUrl: params.aztecNodeUrl,
      }))

    const data = encodeL1Withdrawal({
      recipient: params.recipient,
      amount: params.amount,
      l2BlockNumber: toBigInt(params.l2BlockNumber),
      messageIndex: witness.messageIndex,
      siblingPath: witness.siblingPath,
    })

    const txHash = await this.l1Clients.walletClient.sendTransaction({
      account: params.owner,
      to: this.config.l1.portalAddress,
      data,
    })

    const receipt = await this.l1Clients.publicClient.waitForTransactionReceipt({
      hash: txHash,
    })

    return { l1TxHash: getSafeString(receipt.transactionHash) }
  }
}

export * from './types'
export * from './l1'
export * from './l2'
