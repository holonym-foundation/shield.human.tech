import axios from 'axios'
import { NextRequest, NextResponse } from 'next/server'

import { NFT } from '@/types/nft.types'
import { getChainIdFromNetwork, getSupportedNetworks } from '@/utils/alchemy.utils'

import { ALCHEMY_API_KEY } from '@/config/env.config'
const apiKey = ALCHEMY_API_KEY

if (!apiKey) {
  throw new Error('No ALCHEMY_API_KEY found in .env')
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { chains, address } = body

    if (!chains || !Array.isArray(chains) || chains.length === 0 || !address) {
      return NextResponse.json({ error: 'Missing required parameters: chains array and address' }, { status: 400 })
    }

    const supportedNetworks = getSupportedNetworks(chains)

    if (supportedNetworks.length === 0) {
      return NextResponse.json([])
    }

    const response = await axios.post(
      `https://api.g.alchemy.com/data/v1/${apiKey}/assets/nfts/by-address`,
      {
        addresses: [
          {
            address,
            networks: supportedNetworks,
          },
        ],
        withMetadata: true,
      },
      {
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
      },
    )

    // Transform the response to include chain IDs
    const nfts: NFT[] = response.data.data.ownedNfts.map((nft: any) => {
      // Try to parse raw metadata if it's a string
      let parsedMetadata = nft.raw?.metadata

      if (typeof nft.raw?.metadata === 'string') {
        const cleaned = parsedMetadata.replace(/\\r\\n/g, '').replace(/,\s*}/, '}')

        try {
          parsedMetadata = JSON.parse(cleaned)
        } catch (err) {
          parsedMetadata = {}
          console.error('Failed to parse metadata:', err)
        }
      }

      return {
        name: nft.name || parsedMetadata?.name,
        tokenAddress: nft.address,
        contract: nft.contract,
        chainId: getChainIdFromNetwork(nft.network),
        tokenId: nft.tokenId,
        tokenType: nft.tokenType,
        description: nft.description || parsedMetadata?.description || null,
        balance: nft.balance,
        tokenUri: nft.tokenUri || nft.raw?.tokenUri || null,
        image: nft.image?.cachedUrl || nft.image?.originalUrl || parsedMetadata?.image || null,
        metadata: parsedMetadata || {},
        collection: nft.collection,
      }
    })

    return NextResponse.json(nfts)
  } catch (error: any) {
    console.error('Error processing NFTs:', error.response?.data || error)

    return NextResponse.json(
      {
        error: 'Failed to process NFTs',
        details: error.response?.data || error.message,
      },
      { status: 500 },
    )
  }
}
