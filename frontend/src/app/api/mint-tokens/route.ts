import { NextRequest, NextResponse } from 'next/server'
import { createPublicClient, createWalletClient, http, custom, parseUnits  } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'
import { L1_TOKENS } from '@/config'
import { TestERC20Abi } from '@aztec/l1-artifacts'

// Configure Vercel function timeout (300 seconds for Pro plan)
export const maxDuration = 300

// Amount of tokens to mint (1000)
const TOKEN_AMOUNT = 1000

// Get environment variables
let privateKey = process.env.FAUCET_PRIVATE_KEY
const rpcUrl = process.env.ETHEREUM_RPC_URL

if (!privateKey) {
  throw new Error('FAUCET_PRIVATE_KEY is not set')
}

if (!rpcUrl) {
  throw new Error('ETHEREUM_RPC_URL is not set')
}

// Make sure it has 0x prefix
if (!privateKey.startsWith('0x')) {
  privateKey = `0x${privateKey}`
}

export async function POST(request: NextRequest) {
  try {
    // Only accept POST requests
    if (request.method !== 'POST') {
      return NextResponse.json({ error: 'Method not allowed' }, { status: 405 })
    }

    // Get the recipient address and token address from the request body
    const { address, tokenAddress } = await request.json()

    // Validate recipient address
    if (!address || typeof address !== 'string' || !address.startsWith('0x')) {
      return NextResponse.json(
        { error: 'Invalid recipient address' },
        { status: 400 }
      )
    }

    // Validate token address — must be explicitly provided
    if (!tokenAddress || typeof tokenAddress !== 'string' || !tokenAddress.startsWith('0x')) {
      return NextResponse.json(
        { error: 'Invalid or missing tokenAddress (must be 0x-prefixed)' },
        { status: 400 }
      )
    }

    // Verify the requested token is a known deployed token
    const isKnownToken = L1_TOKENS.some(
      (t) => t.l1TokenContract?.toLowerCase() === tokenAddress.toLowerCase()
    )
    if (!isKnownToken) {
      return NextResponse.json(
        { error: 'Token address is not a recognized deployed token' },
        { status: 400 }
      )
    }

    const tokenContractAddress = tokenAddress

    try {
      console.log('Creating account from private key...')
      // Create the account
      const account = privateKeyToAccount(privateKey as `0x${string}`)

      // Create public client for reading
      const publicClient = createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl),
      })

      // Get token decimals from contract
      const decimals = await publicClient.readContract({
        address: tokenContractAddress as `0x${string}`,
        abi: TestERC20Abi,
        functionName: 'decimals',
      })

      // Calculate mint amount with proper decimals
      const MINT_AMOUNT = parseUnits(TOKEN_AMOUNT.toString(), decimals)

      // Create wallet with private key - using local signing
      const walletClient = createWalletClient({
        account,
        chain: sepolia,
        transport: custom({
          request: async ({ method, params }) => {
            // Handle method locally
            if (method === 'eth_sendTransaction') {
              // Extract transaction parameters
              const tx = params[0] as any

              // Get nonce for the account
              const nonce = await publicClient.getTransactionCount({
                address: account.address,
              })

              // Sign the transaction locally
              const signedTx = await account.signTransaction({
                to: tx.to as `0x${string}`,
                data: tx.data as `0x${string}`,
                nonce,
                gasPrice: await publicClient.getGasPrice(),
                gas: BigInt(1000000), // Set appropriate gas limit
              })

              // Send the raw transaction
              const hash = await publicClient.sendRawTransaction({
                serializedTransaction: signedTx,
              })

              return hash
            }

            // For other methods, use the publicClient
            return publicClient.request({
              method,
              params,
            })
          },
        }),
      })
      // get native balance
      const nativeBalance = await publicClient.getBalance({
        address: account.address,
      })
      console.log('Native balance:', nativeBalance)
      // Log the minting operation
      console.log(`Minting ${MINT_AMOUNT} tokens to ${address}`)

      // Debug: log account information
      console.log('Using account:', account.address)

      try {
        // Simulate the transaction
        const { request: contractWriteRequest } =
          await publicClient.simulateContract({
            address: tokenContractAddress as `0x${string}`,
            abi: TestERC20Abi,
            functionName: 'mint',
            args: [address as `0x${string}`, MINT_AMOUNT],
            account: account.address,
          })

        console.log('Simulation successful, sending transaction')

        // Send the transaction
        const hash = await walletClient.writeContract(contractWriteRequest)
        console.log(`Token mint transaction sent: ${hash}`)

        // Wait for the transaction to be mined
        const receipt = await publicClient.waitForTransactionReceipt({ 
          hash,
        timeout: 300_000 // 5 minutes timeout
        })
        console.log(`Token mint confirmed: ${hash}`)

        return NextResponse.json({
          success: true,
          txHash: hash,
          message: `${MINT_AMOUNT} tokens minted to ${address}`,
        })
      } catch (err) {
        console.error('Error in contract operation:', err)
        throw err
      }
    } catch (err) {
      console.error('Error minting tokens:', err)
      return NextResponse.json(
        {
          error: `Error minting tokens: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
        { status: 500 }
      )
    }
  } catch (error) {
    console.error('Mint-tokens API error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
