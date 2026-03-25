// @ts-nocheck
/**
 * Set the SwapBridgeRouter as a trusted forwarder on all token portals
 * from the active deployment.
 *
 * Usage:
 *   pnpm set-trusted-forwarders
 *
 * Environment Variables:
 *   - L1_PRIVATE_KEY (required): Portal owner's private key
 *   - L1_URL (optional): L1 RPC URL
 *   - TRUSTED_FORWARDER (optional): Override forwarder address (defaults to deployment's swapBridgeRouterAddress)
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { getContract } from 'viem'
import 'dotenv/config'

// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'

import { loadActiveDeployment } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const TokenPortalAbi = CustomTokenPortalJson.abi

async function main() {
  const logger = createLogger('aztec:set-forwarders')

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
    logger.error('No active deployment found. Run pnpm start-devnet first.')
    process.exit(1)
  }

  const forwarder = (process.env.TRUSTED_FORWARDER || deployment.swapBridgeRouterAddress) as `0x${string}`
  if (!forwarder) {
    logger.error('No SwapBridgeRouter address found. Set TRUSTED_FORWARDER env var or deploy swap infra first.')
    process.exit(1)
  }

  const tokens = deployment.tokens || []
  logger.info(`Setting trusted forwarder ${forwarder} on ${tokens.length} portals`)

  for (const token of tokens) {
    const portalAddr = token.l1PortalContract as `0x${string}`
    try {
      const portal = getContract({ address: portalAddr, abi: TokenPortalAbi, client: l1Client as any }) as any
      const tx = await portal.write.setTrustedForwarder([forwarder, true])
      await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
      logger.info(`✅ ${token.symbol} portal (${portalAddr.slice(0, 10)}...) — forwarder set`)
    } catch (error) {
      logger.error(`❌ ${token.symbol} portal (${portalAddr}): ${error}`)
    }
  }

  logger.info('\n✅ Done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
