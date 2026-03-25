// @ts-nocheck
/**
 * Deploy the SwapBridgeRouter contract on L1.
 *
 * Usage:
 *   pnpm deploy-swap-router
 *
 * Environment Variables:
 *   - L1_PRIVATE_KEY (required): Deployer private key
 *   - L1_URL (optional): L1 RPC URL
 *   - UNISWAP_FUEL_SWAP (optional): Override UniswapFuelSwap address (defaults to deployment)
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import 'dotenv/config'

// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'

import { loadActiveDeployment, saveFuelSwapInfraToDeployment, copyToFrontend } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

async function main() {
  const logger = createLogger('aztec:deploy-swap-router')

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
  if (!L1_PRIVATE_KEY) {
    logger.error('L1_PRIVATE_KEY is required')
    process.exit(1)
  }

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)

  const deployment = loadActiveDeployment()
  if (!deployment) {
    logger.error('No active deployment found.')
    process.exit(1)
  }

  const feeJuicePortal = deployment.nodeInfo?.l1ContractAddresses?.feeJuicePortalAddress
  if (!feeJuicePortal) {
    logger.error('Missing feeJuicePortalAddress in deployment nodeInfo')
    process.exit(1)
  }

  const uniswapFuelSwap = process.env.UNISWAP_FUEL_SWAP || deployment.uniswapFuelSwapAddress
  if (!uniswapFuelSwap) {
    logger.error('Missing UniswapFuelSwap address. Deploy it first or set UNISWAP_FUEL_SWAP env var.')
    process.exit(1)
  }

  logger.info('Deploying SwapBridgeRouter...')
  logger.info(`  Permit2: ${PERMIT2}`)
  logger.info(`  FeeJuicePortal: ${feeJuicePortal}`)
  logger.info(`  UniswapFuelSwap: ${uniswapFuelSwap}`)

  const { address } = await deployL1Contract(
    l1Client,
    SwapBridgeRouterJson.abi,
    SwapBridgeRouterJson.bytecode.object as `0x${string}`,
    [PERMIT2, feeJuicePortal, uniswapFuelSwap],
  )

  logger.info(`✅ SwapBridgeRouter deployed at ${address.toString()}`)

  saveFuelSwapInfraToDeployment({
    swapBridgeRouterAddress: address.toString(),
  })
  copyToFrontend()
  logger.info('✅ Saved to deployment and synced to frontend')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
