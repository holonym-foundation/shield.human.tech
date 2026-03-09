import { NextRequest, NextResponse } from 'next/server'
import {
  createPublicClient,
  createWalletClient,
  http,
  custom,
  parseEther,
  formatEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { ADDRESS } from '@/config'

// Configure Vercel function timeout (300 seconds for Pro plan)
export const maxDuration = 300

// Configure environment variables in a .env.local file
// IMPORTANT: The FAUCET_PRIVATE_KEY must include the '0x' prefix
// Example: FAUCET_PRIVATE_KEY=0x1234...

// Amount of ETH to send for gas (0.05 ETH)
const FAUCET_AMOUNT = parseEther('0.02')

// Note: This API doesn't implement server-side rate limiting
// Rate limiting is handled by the client using localStorage to prevent
// users from requesting tokens more than once in 24 hours

function getPrivateKeyAndRpc() {
  let privateKey = process.env.FAUCET_PRIVATE_KEY
  const rpcUrl = process.env.ETHEREUM_RPC_URL
  if (!privateKey) throw new Error('FAUCET_PRIVATE_KEY is not set')
  if (!rpcUrl) throw new Error('ETHEREUM_RPC_URL is not set')
  if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`
  return { privateKey: privateKey as `0x${string}`, rpcUrl }
}

export async function POST(request: NextRequest) {
  // API is disabled
  return NextResponse.json(
    { error: 'Faucet API is currently disabled' },
    { status: 503 }
  )

  try {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
    }

    // Get the recipient address from the request body
    const { address } = await request.json()

    // Validate recipient address
    if (!address || typeof address !== 'string' || !address.startsWith('0x')) {
      return NextResponse.json(
        { error: 'Invalid recipient address' },
        { status: 400 }
      )
    }

    try {
      const { privateKey, rpcUrl } = getPrivateKeyAndRpc()
      console.log('Creating account from private key...')
      // Create the account
      const account = privateKeyToAccount(privateKey)

      // Create public client for reading
      const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl),
      })

      // Check faucet account balance before transaction
      const faucetBalanceBefore = await publicClient.getBalance({
        address: account.address,
      })
      console.log(
        `Faucet account balance before: ${formatEther(faucetBalanceBefore)} ETH`
      )

      // Check recipient balance before transaction
      const recipientBalanceBefore = await publicClient.getBalance({
        address: address as `0x${string}`,
      })
      console.log(
        `Recipient balance before: ${formatEther(recipientBalanceBefore)} ETH`
      )

      // Send ETH instead of tokens
      console.log(`Sending ${FAUCET_AMOUNT} ETH to ${address}`)
      console.log('Using account:', account.address)

      // Get current nonce for the account
      const nonce = await publicClient.getTransactionCount({
        address: account.address,
      })

      // Get current gas price
      const gasPrice = await publicClient.getGasPrice()

      // Sign the transaction locally
      const signedTx = await account.signTransaction({
        to: address as `0x${string}`,
        value: FAUCET_AMOUNT,
        nonce,
        gasPrice,
        gas: BigInt(21000), // Standard gas limit for ETH transfers
      })

      // Send the raw transaction
      const hash = await publicClient.sendRawTransaction({
        serializedTransaction: signedTx,
      })


      // Wait for transaction to be mined
      console.log('Waiting for transaction to be mined...')
      const receipt = await publicClient.waitForTransactionReceipt({ 
        hash,
        timeout: 300_000 // 5 minutes timeout
      })
      console.log('Transaction mined!')
      const txHash = receipt.transactionHash

      // Check balances after transaction
      const faucetBalanceAfter = await publicClient.getBalance({
        address: account.address,
      })
      console.log(
        `Faucet account balance after: ${formatEther(faucetBalanceAfter)} ETH`
      )

      const recipientBalanceAfter = await publicClient.getBalance({
        address: address as `0x${string}`,
      })
      console.log(
        `Recipient balance after: ${formatEther(recipientBalanceAfter)} ETH`
      )

      return NextResponse.json({
        success: true,
        txHash: txHash,
        message: `${FAUCET_AMOUNT} ETH sent to ${address} for gas`,
        balances: {
          faucet: {
            before: formatEther(faucetBalanceBefore),
            after: formatEther(faucetBalanceAfter),
          },
          recipient: {
            before: formatEther(recipientBalanceBefore),
            after: formatEther(recipientBalanceAfter),
          },
        },
      })
    } catch (err) {
      console.error('Error with transaction:', err)
      return NextResponse.json(
        {
          error: `Error processing transaction: ${
            err instanceof Error ? (err as Error).message : 'Unknown error'
          }`,
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Faucet error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? (error as Error).message : 'Unknown error' },
      { status: 500 }
    )
  }
}
