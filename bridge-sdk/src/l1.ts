import { computeSecretHash } from '@aztec/aztec.js/crypto'
import { Fr } from '@aztec/aztec.js/fields'
import { extractEvent } from '@aztec/ethereum/utils'
import { TokenPortalAbi } from '@aztec/l1-artifacts'
import { encodeFunctionData, type Address } from 'viem'
import { ERC20_ABI } from './constants'
import type { L1Clients, L1ToL2DepositResult } from './types'

interface EnsureAllowanceParams {
  clients: L1Clients
  tokenAddress: Address
  owner: Address
  spender: Address
  amount: bigint
}

export const ensureAllowance = async ({
  clients,
  tokenAddress,
  owner,
  spender,
  amount,
}: EnsureAllowanceParams): Promise<void> => {
  const currentAllowance = await clients.publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  })

  if (BigInt(currentAllowance) >= amount) {
    return
  }

  const approveHash = await clients.walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
    account: owner,
  })

  await clients.publicClient.waitForTransactionReceipt({
    hash: approveHash,
  })
}

interface DepositParams {
  clients: L1Clients
  portalAddress: Address
  tokenAddress: Address
  owner: Address
  amount: bigint
  recipient?: Address
  isPrivate?: boolean
  claimSecret?: Fr
}

export const depositToL2 = async ({
  clients,
  portalAddress,
  tokenAddress,
  owner,
  amount,
  recipient,
  isPrivate = false,
  claimSecret,
}: DepositParams): Promise<L1ToL2DepositResult> => {
  const secret = claimSecret ?? Fr.random()
  const secretHash = await computeSecretHash(secret)

  await ensureAllowance({
    clients,
    tokenAddress,
    owner,
    spender: portalAddress,
    amount,
  })

  const functionName = isPrivate ? 'depositToAztecPrivate' : 'depositToAztecPublic'
  const args = isPrivate
    ? ([amount, secretHash.toString()] as const)
    : ([recipient as Address, amount, secretHash.toString()] as const)

  if (!isPrivate && !recipient) {
    throw new Error('Recipient is required for public deposits')
  }

  const txHash = await clients.walletClient.writeContract({
    address: portalAddress,
    abi: TokenPortalAbi,
    functionName,
    args,
    account: owner,
  })

  const receipt = await clients.publicClient.waitForTransactionReceipt({
    hash: txHash,
  })

  const eventName = isPrivate ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'
  const log = extractEvent(
    receipt.logs,
    portalAddress,
    TokenPortalAbi,
    eventName,
    (eventLog) => {
      if (isPrivate) {
        return (
          eventLog.args.amount === amount &&
          eventLog.args.secretHashForL2MessageConsumption === secretHash.toString()
        )
      }
      return (
        eventLog.args.amount === amount &&
        eventLog.args.to === recipient &&
        eventLog.args.secretHash === secretHash.toString()
      )
    }
  )

  const messageHash = log.args.key
  const messageLeafIndex = log.args.index

  return {
    claimSecret: secret.toString(),
    claimSecretHash: secretHash.toString(),
    messageHash: messageHash.toString(),
    messageLeafIndex: BigInt(messageLeafIndex),
    l1TxHash: receipt.transactionHash,
  }
}

export const encodeL1Withdrawal = ({
  recipient,
  amount,
  l2BlockNumber,
  messageIndex,
  siblingPath,
}: {
  recipient: Address
  amount: bigint
  l2BlockNumber: bigint
  messageIndex: bigint
  siblingPath: string[]
}): `0x${string}` => {
  return encodeFunctionData({
    abi: TokenPortalAbi,
    functionName: 'withdraw',
    args: [recipient, amount, false, l2BlockNumber, messageIndex, siblingPath],
  })
}
