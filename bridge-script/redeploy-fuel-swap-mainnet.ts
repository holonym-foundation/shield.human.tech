/**
 * Redeploy UniswapFuelSwap on mainnet and rewire the existing SwapBridgeRouter.
 *
 * Surgical alternative to deploy-mainnet.ts FORCE_REDEPLOY_SWAPS (which would also redeploy
 * the router and change its Permit2 signing domain). This deploys ONLY a fresh UniswapFuelSwap
 * — e.g. after the native-ETH-intermediate settlement fix — and points the live router at it
 * via setSwapTarget. The old swap contract is then unreferenced and can be abandoned.
 *
 * Required env:
 *   L1_PRIVATE_KEY=0x…   deployer EOA (pays L1 gas)
 *   L1_URL=…             mainnet L1 RPC (falls back to getL1RpcUrl())
 *
 * Optional env:
 *   DRY_RUN=true         Print the plan + setSwapTarget calldata; deploy/send nothing.
 *
 * The router's owner must send setSwapTarget. If L1_PRIVATE_KEY is the owner, this script
 * sends it; otherwise it prints the calldata for the owner (e.g. multisig) to submit manually.
 *
 * Run: node --import tsx redeploy-fuel-swap-mainnet.ts
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { getContract, encodeFunctionData, type Hex } from 'viem'
import { writeFileSync } from 'fs'
import { resolve as resolvePath } from 'path'
import 'dotenv/config'

// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'
// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'

import {
  loadActiveDeployment,
  saveFuelSwapInfraToDeployment,
  copyToFrontend,
  copyToSdk,
} from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

// ─── Mainnet constants (must match deploy-mainnet.ts) ───────────────
const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as const
const WETH = '0xc02aaa39b223fe8d0a0e8e4f27ead9083c756cc2' as const

// Crash-safety: a freshly deployed contract address is the one thing we can't recreate cheaply
// (it cost mainnet gas). Everything after deploy writes here first so a later failure/crash never
// strands it — the file holds the address plus the exact calldata to finish setSwapTarget by hand.
const RECOVERY_PATH = resolvePath('deployments', 'redeploy-fuel-swap.recovery.json')
let recovery: Record<string, unknown> = {}
function persistRecovery(patch: Record<string, unknown>) {
  recovery = { ...recovery, ...patch, updatedAt: new Date().toISOString() }
  try {
    writeFileSync(RECOVERY_PATH, JSON.stringify(recovery, null, 2))
  } catch (e) {
    // Last resort: at least dump it to stdout so it's in the run log.
    console.error('Failed to write recovery file:', e)
    console.error('RECOVERY DATA:', JSON.stringify(recovery))
  }
}

async function main() {
  const logger = createLogger('aztec:redeploy-fuel-swap')
  const DRY_RUN = process.env.DRY_RUN === 'true'

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY as Hex | undefined
  if (!L1_PRIVATE_KEY) throw new Error('L1_PRIVATE_KEY is required')

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 1) // mainnet
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)
  const deployer = l1Client.account.address

  // Guard against running against the wrong network.
  const chainId = await l1Client.getChainId()
  if (chainId !== 1) throw new Error(`Expected mainnet (chain 1), got ${chainId}`)

  const deployment = loadActiveDeployment()
  if (!deployment) throw new Error('No active deployment found')
  if (deployment.network?.l1ChainId !== 1) {
    throw new Error(`Active deployment is not mainnet (l1ChainId=${deployment.network?.l1ChainId})`)
  }

  const feeJuice = (deployment.nodeInfo as any)?.l1ContractAddresses?.feeJuiceAddress as Hex | undefined
  const router = deployment.swapBridgeRouterAddress as Hex | undefined
  if (!feeJuice) throw new Error('feeJuiceAddress missing from deployment nodeInfo')
  if (!router) throw new Error('swapBridgeRouterAddress missing from deployment')

  logger.info('── Redeploy UniswapFuelSwap (mainnet) ──')
  logger.info(`  deployer:    ${deployer}`)
  logger.info(`  PoolManager: ${POOL_MANAGER}`)
  logger.info(`  FeeJuice:    ${feeJuice}`)
  logger.info(`  WETH:        ${WETH}`)
  logger.info(`  Router:      ${router}`)
  logger.info(`  old swap:    ${deployment.uniswapFuelSwapAddress ?? '(none)'}`)

  const routerContract = getContract({ address: router, abi: SwapBridgeRouterJson.abi, client: l1Client })
  const owner = (await routerContract.read.owner()) as Hex
  const currentTarget = (await routerContract.read.swapTarget()) as Hex
  logger.info(`  router.owner:      ${owner}`)
  logger.info(`  router.swapTarget: ${currentTarget}`)

  if (DRY_RUN) {
    logger.info('DRY_RUN — not deploying. setSwapTarget(<newAddr>) would be sent to the router by the owner.')
    return
  }

  // Verify deployer ETH balance before sending any tx.
  const bal = await l1Client.getBalance({ address: deployer })
  if (bal === 0n) throw new Error('Deployer has 0 ETH for gas')

  // The exact tx the owner needs, computed up front so it lands in the recovery file
  // regardless of which step (if any) fails after deploy.
  const setSwapTargetCalldata = (newSwap: Hex) =>
    encodeFunctionData({ abi: SwapBridgeRouterJson.abi, functionName: 'setSwapTarget', args: [newSwap] })

  // 1. Deploy the new UniswapFuelSwap.
  logger.info('Deploying new UniswapFuelSwap…')
  const { address } = await deployL1Contract(
    l1Client,
    UniswapFuelSwapJson.abi,
    UniswapFuelSwapJson.bytecode.object as Hex,
    [POOL_MANAGER, feeJuice, WETH],
  )
  const newSwap = address.toString() as Hex
  logger.info(`✅ UniswapFuelSwap deployed at ${newSwap}`)

  // Record the address + manual-completion calldata BEFORE anything else can fail.
  persistRecovery({
    network: 'mainnet',
    deployedBy: deployer,
    poolManager: POOL_MANAGER,
    feeJuice,
    weth: WETH,
    router,
    routerOwner: owner,
    oldUniswapFuelSwap: deployment.uniswapFuelSwapAddress ?? null,
    newUniswapFuelSwap: newSwap,
    setSwapTarget: { to: router, from: owner, calldata: setSwapTargetCalldata(newSwap), status: 'pending' },
    persistedToDeployment: false,
    syncedToFrontendAndSdk: false,
  })
  logger.info(`📝 Recovery written: ${RECOVERY_PATH}`)

  // Persist into the deployment JSON immediately (the address is informational vs. execution,
  // which flows through the router, so recording it early is safe and crash-proof).
  try {
    saveFuelSwapInfraToDeployment({ uniswapFuelSwapAddress: newSwap })
    persistRecovery({ persistedToDeployment: true })
  } catch (e) {
    logger.error(`Persist to deployment JSON failed (address is safe in ${RECOVERY_PATH}): ${e}`)
  }

  // 2. Rewire the router (owner-gated).
  if (owner.toLowerCase() === deployer.toLowerCase()) {
    try {
      logger.info('Calling router.setSwapTarget(newSwap)…')
      const txHash = await routerContract.write.setSwapTarget([newSwap])
      persistRecovery({ setSwapTarget: { to: router, from: owner, calldata: setSwapTargetCalldata(newSwap), status: 'sent', txHash } })
      await l1Client.waitForTransactionReceipt({ hash: txHash })
      const after = (await routerContract.read.swapTarget()) as Hex
      if (after.toLowerCase() !== newSwap.toLowerCase()) {
        throw new Error(`setSwapTarget mismatch: router.swapTarget=${after}, expected ${newSwap}`)
      }
      persistRecovery({ setSwapTarget: { to: router, from: owner, calldata: setSwapTargetCalldata(newSwap), status: 'confirmed', txHash } })
      logger.info(`✅ router.swapTarget is now ${after}`)
    } catch (e) {
      persistRecovery({ setSwapTarget: { to: router, from: owner, calldata: setSwapTargetCalldata(newSwap), status: 'failed', error: String(e) } })
      logger.error(`setSwapTarget failed. Re-send it to ${router} with the calldata in ${RECOVERY_PATH}.`)
      throw e
    }
  } else {
    persistRecovery({ setSwapTarget: { to: router, from: owner, calldata: setSwapTargetCalldata(newSwap), status: 'manual-required' } })
    logger.warn('⚠️  Deployer is NOT the router owner — setSwapTarget must be sent by the owner.')
    logger.warn(`    owner:    ${owner}`)
    logger.warn(`    to:       ${router}`)
    logger.warn(`    calldata: ${setSwapTargetCalldata(newSwap)}`)
    logger.warn(`    (also saved in ${RECOVERY_PATH}) — the router uses the OLD swap until this is submitted.`)
  }

  // 3. Sync the frontend quote bundle AND SDK tx bundle. Isolated so a sync hiccup can't
  //    obscure that the deploy + rewire already succeeded on-chain.
  try {
    copyToFrontend()
    copyToSdk()
    persistRecovery({ syncedToFrontendAndSdk: true })
    logger.info('✅ Synced new address to frontend + SDK.')
  } catch (e) {
    logger.error(`Frontend/SDK sync failed (address persisted; re-run copyToFrontend/copyToSdk): ${e}`)
  }

  logger.info('Next: rebuild the SDK so the frontend picks up the new bundle (e.g. `pnpm --filter @human.tech/shield.human.sdk build`).')
}

main().catch((e) => {
  console.error(e)
  console.error(`\n⚠️  Run did not complete cleanly. Check ${RECOVERY_PATH} for the deployed address and the setSwapTarget calldata before re-running (re-running deploys a NEW contract).`)
  process.exit(1)
})
