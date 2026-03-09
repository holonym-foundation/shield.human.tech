import axios from 'axios'
import { NextRequest, NextResponse } from 'next/server'

import { AlchemyTokenResponse, T_AlchemyTokenBalanceResponse } from '@/types/token.balances.types'
import {
  getChainIdFromNetwork,
  getSupportedNetworks
} from '@/utils/alchemy.utils'

const apiKey = process.env.ALCHEMY_API_KEY

if (!apiKey) {
  throw new Error('No ALCHEMY_API_KEY found in .env')
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { chains, address } = body

    if (!chains || !Array.isArray(chains) || chains.length === 0 || !address) {
      return NextResponse.json(
        { error: 'Missing required parameters: chains array and address' },
        { status: 400 }
      )
    }

    if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return NextResponse.json(
        { error: 'Invalid Ethereum address format' },
        { status: 400 }
      )
    }

    const supportedNetworks = getSupportedNetworks(chains)

    if (supportedNetworks.length === 0) {
      return NextResponse.json([])
    }

    const response = await axios.post<AlchemyTokenResponse>(
      `https://api.g.alchemy.com/data/v1/${apiKey}/assets/tokens/by-address`,
      {
        addresses: [
          {
            address,
            networks: supportedNetworks
          }
        ],
        includeNativeTokens: true,
        withPrices: true,
        withMetadata: true
      },
      {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        }
      }
    )

    // Transform the response to include chain IDs
    const balances = response.data.data.tokens.map((token: any) => ({
      ...token,
      chainId: getChainIdFromNetwork(token.network)
    })) as T_AlchemyTokenBalanceResponse[]

    return NextResponse.json(balances)
  } catch (error: any) {
    console.error(
      'Error processing token balances:',
      error.response?.data || error
    )

    return NextResponse.json(
      {
        error: 'Failed to process token balances',
        details: error.response?.data || error.message
      },
      { status: 500 }
    )
  }
} 