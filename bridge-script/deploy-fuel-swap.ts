// @ts-nocheck
/**
 * Deploy the UniswapFuelSwap contract on L1.
 *
 * Usage:
 *   pnpm deploy-fuel-swap
 *
 * Environment Variables:
 *   - L1_PRIVATE_KEY (required): Deployer private key
 *   - L1_URL (optional): L1 RPC URL
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import 'dotenv/config'

// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'

import { loadActiveDeployment, saveFuelSwapInfraToDeployment, copyToFrontend } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'

async function main() {
  const logger = createLogger('aztec:deploy-fuel-swap')

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
  if (!L1_PRIVATE_KEY) {
    logger.error('L1_PRIVATE_KEY is required')
    process.exit(1)
  }

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)

  const deployment = loadActiveDeployment()
  const feeJuiceAddress = deployment?.nodeInfo?.l1ContractAddresses?.feeJuiceAddress
    || ''
  if (!feeJuiceAddress) {
    logger.error('feeJuiceAddress missing from deployment nodeInfo')
    process.exit(1)
  }

  logger.info('Deploying UniswapFuelSwap...')
  logger.info(`  PoolManager: ${POOL_MANAGER}`)
  logger.info(`  FeeJuice: ${feeJuiceAddress}`)
  logger.info(`  WETH: ${WETH}`)

  const { address } = await deployL1Contract(
    l1Client,
    UniswapFuelSwapJson.abi,
    UniswapFuelSwapJson.bytecode.object as `0x${string}`,
    [POOL_MANAGER, feeJuiceAddress, WETH],
  )

  logger.info(`✅ UniswapFuelSwap deployed at ${address.toString()}`)

  saveFuelSwapInfraToDeployment({
    uniswapFuelSwapAddress: address.toString(),
  })
  copyToFrontend()
  logger.info('✅ Saved to deployment and synced to frontend')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
