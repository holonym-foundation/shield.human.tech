// @ts-nocheck
/**
 * Deploy a custom TokenPortal (with fee + attestation) + set SwapBridgeRouter as trusted forwarder.
 *
 * Usage:
 *   pnpm deploy-token-portal
 *
 * Environment Variables:
 *   - L1_PRIVATE_KEY (required): Deployer private key
 *   - L1_URL (optional): L1 RPC URL
 *   - FEE_RECIPIENT (required): Address that collects portal fees
 *   - FEE_BASIS_POINTS (optional): Fee in basis points (default: 500 = 5%)
 *   - HUMAN_ID_ATTESTER (required): Clean-hands attester address
 *   - CLEAN_HANDS_CIRCUIT_ID (optional): Circuit ID (default: 1)
 *   - PASSPORT_SIGNER (required): Passport signer address
 *   - REGISTRY (optional): Override L1 registry address (defaults to deployment)
 *   - TOKEN (optional): Override L1 token address (defaults to first token in deployment)
 *   - L2_BRIDGE (optional): Override L2 bridge address (defaults to first token's bridge)
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { getContract } from 'viem'
import 'dotenv/config'

// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'

import { loadActiveDeployment, copyToFrontend } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

async function main() {
  const logger = createLogger('aztec:deploy-token-portal')

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
  if (!L1_PRIVATE_KEY) {
    logger.error('L1_PRIVATE_KEY is required')
    process.exit(1)
  }

  const feeRecipient = process.env.FEE_RECIPIENT
  const humanIdAttester = process.env.HUMAN_ID_ATTESTER
  const passportSigner = process.env.PASSPORT_SIGNER
  if (!feeRecipient || !humanIdAttester || !passportSigner) {
    logger.error('Required env vars: FEE_RECIPIENT, HUMAN_ID_ATTESTER, PASSPORT_SIGNER')
    process.exit(1)
  }

  const feeBasisPoints = Number(process.env.FEE_BASIS_POINTS || '500')
  const cleanHandsCircuitId = Number(process.env.CLEAN_HANDS_CIRCUIT_ID || '1')

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)

  const deployment = loadActiveDeployment()

  // Resolve addresses
  const registry = process.env.REGISTRY || deployment?.l1ContractAddresses?.registryAddress
  const token = process.env.TOKEN || deployment?.tokens?.[0]?.l1TokenContract
  const l2Bridge = process.env.L2_BRIDGE || deployment?.tokens?.[0]?.l2BridgeContract
  const swapRouter = deployment?.swapBridgeRouterAddress

  if (!registry || !token || !l2Bridge) {
    logger.error('Missing REGISTRY, TOKEN, or L2_BRIDGE. Set env vars or deploy tokens first.')
    process.exit(1)
  }

  logger.info('Deploying custom TokenPortal...')
  logger.info(`  FeeRecipient: ${feeRecipient}`)
  logger.info(`  FeeBasisPoints: ${feeBasisPoints}`)
  logger.info(`  HumanIdAttester: ${humanIdAttester}`)
  logger.info(`  PassportSigner: ${passportSigner}`)

  // 1. Deploy TokenPortal
  const { address: portalAddress } = await deployL1Contract(
    l1Client,
    CustomTokenPortalJson.abi,
    CustomTokenPortalJson.bytecode.object as `0x${string}`,
    [l1Client.account.address, feeRecipient, feeBasisPoints, humanIdAttester, cleanHandsCircuitId, passportSigner],
  )
  logger.info(`✅ TokenPortal deployed at ${portalAddress.toString()}`)

  // 2. Initialize
  const portal = getContract({
    address: portalAddress.toString() as `0x${string}`,
    abi: CustomTokenPortalJson.abi,
    client: l1Client as any,
  }) as any

  const initTx = await portal.write.initialize([registry, token, l2Bridge])
  await l1Client.waitForTransactionReceipt({ hash: initTx, timeout: 120_000 })
  logger.info('✅ TokenPortal initialized')

  // 3. Set trusted forwarder (if SwapBridgeRouter exists)
  if (swapRouter) {
    const forwarderTx = await portal.write.setTrustedForwarder([swapRouter, true])
    await l1Client.waitForTransactionReceipt({ hash: forwarderTx, timeout: 120_000 })
    logger.info(`✅ SwapBridgeRouter (${swapRouter}) set as trusted forwarder`)
  } else {
    logger.warn('No SwapBridgeRouter in deployment — skipping trusted forwarder setup')
  }

  copyToFrontend()
  logger.info('✅ Done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
