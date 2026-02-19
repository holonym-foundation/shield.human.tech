import { Fr } from '@aztec/aztec.js/fields'
import { EthAddress } from '@aztec/foundation/eth-address'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { toAztecAddress, toFr } from './utils'
import type {
  L2Executor,
  L2ClaimResult,
  L2WithdrawalInitiationResult,
  L2ToL1Witness,
} from './types'

interface ClaimParams {
  executor: L2Executor
  bridgeAddress: string
  recipient: string
  amount: bigint
  claimSecret: Fr | string
  messageLeafIndex: bigint
  isPrivate?: boolean
}

export const claimOnL2 = async ({
  executor,
  bridgeAddress,
  recipient,
  amount,
  claimSecret,
  messageLeafIndex,
  isPrivate = false,
}: ClaimParams): Promise<L2ClaimResult> => {
  const method = isPrivate ? 'claim_private' : 'claim_public'
  const result = await executor.executeCall(
    bridgeAddress,
    method,
    [toAztecAddress(recipient), amount, toFr(claimSecret), messageLeafIndex],
    { contractType: 'bridge', autoRegister: true }
  )

  return { l2TxHash: result.txHash }
}

interface InitiateWithdrawalParams {
  executor: L2Executor
  bridgeAddress: string
  tokenAddress: string
  owner: string
  l1Recipient: string
  amount: bigint
}

export const initiateWithdrawal = async ({
  executor,
  bridgeAddress,
  tokenAddress,
  owner,
  l1Recipient,
  amount,
}: InitiateWithdrawalParams): Promise<L2WithdrawalInitiationResult> => {
  if (!executor.executeCallWithAuthWit) {
    throw new Error('executeCallWithAuthWit is required for withdrawals')
  }

  const nonce = Fr.random()
  const ownerAddress = toAztecAddress(owner)

  await executor.executeCallWithAuthWit(
    bridgeAddress,
    tokenAddress,
    'burn_public',
    [ownerAddress, amount, nonce]
  )

  const result = await executor.executeCall(
    bridgeAddress,
    'exit_to_l1_public',
    [EthAddress.fromString(l1Recipient), amount, EthAddress.ZERO, nonce],
    { contractType: 'bridge', autoRegister: true }
  )

  return {
    l2TxHash: result.txHash,
    l2BlockNumber: result.blockNumber,
    nonce: nonce.toString(),
  }
}

interface WitnessParams {
  aztecNodeUrl: string
  l2BlockNumber: number
  l2BridgeAddress: string
}

export const getL2ToL1Witness = async ({
  aztecNodeUrl,
  l2BlockNumber,
  l2BridgeAddress,
}: WitnessParams): Promise<L2ToL1Witness> => {
  const node = createAztecNodeClient(aztecNodeUrl)
  const [messageIndex, siblingPath] =
    await node.getL2ToL1MessageMembershipWitness(l2BlockNumber, l2BridgeAddress)

  return {
    messageIndex: BigInt(messageIndex),
    siblingPath: siblingPath as unknown as string[],
  }
}
