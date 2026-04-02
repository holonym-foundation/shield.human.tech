/**
 * Portal Migration Pause Script
 *
 * Pauses deposits on all token portals in a given deployment.
 * Use this during an Aztec rollup upgrade delay window:
 *   - New deposits are blocked on old portals
 *   - Existing L2→L1 withdrawals remain fully functional
 *
 * After running, deploy fresh portals pointing to the new rollup
 * using index-testnet-compliant.ts with the new Aztec version.
 *
 * Usage:
 *   node --import tsx pause-portals.ts [deployment-id]
 *   (omit deployment-id to target the currently active deployment)
 *
 * Environment Variables:
 *   L1_PRIVATE_KEY  — L1 wallet private key (preferred)
 *   MNEMONIC        — L1 wallet mnemonic (fallback)
 *   L1_URL          — L1 RPC URL (optional, uses config default)
 */

import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { getContract, createPublicClient, http } from 'viem'
import 'dotenv/config'

// Custom L1 TokenPortal ABI (from forge build output)
// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
const CustomTokenPortalAbi = CustomTokenPortalJson.abi

import {
  loadRegistry,
  loadDeploymentById,
  loadActiveDeployment,
  copyToFrontend,
  type DeployedToken,
} from './utils/save_contracts.js'
import {
  getAztecNodeUrl,
  getL1RpcUrl,
} from './config/config.js'
import { join } from 'path'
import { writeFileSync, readFileSync, existsSync } from 'fs'

// ─── Config ─────────────────────────────────────────────────────────────────

const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
const MNEMONIC = process.env.MNEMONIC || 'test test test test test test test test test test test junk'
const L1_CREDENTIAL = L1_PRIVATE_KEY || MNEMONIC
const L1_URL = process.env.L1_URL || getL1RpcUrl()

// ─── Helpers ─────────────────────────────────────────────────────────────────

function updateDeploymentFile(deploymentId: string, tokens: DeployedToken[]): void {
  const registry = loadRegistry()
  if (!registry) throw new Error('No registry found')
  const entry = registry.deployments.find(d => d.id === deploymentId)
  if (!entry) throw new Error(`Deployment ${deploymentId} not found in registry`)

  const filePath = join('deployments', entry.file)
  const raw = JSON.parse(readFileSync(filePath, 'utf8'))
  raw.tokens = tokens
  writeFileSync(filePath, JSON.stringify(raw, null, 2), 'utf8')
  console.log(`📄 Updated deployment file: ${filePath}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const deploymentIdArg = process.argv[2]

  // Load target deployment
  const deployment = deploymentIdArg
    ? loadDeploymentById(deploymentIdArg)
    : loadActiveDeployment()

  if (!deployment) {
    const hint = deploymentIdArg
      ? `Deployment '${deploymentIdArg}' not found. Check deployments/registry.json.`
      : 'No active deployment found. Run the main deploy script first.'
    throw new Error(hint)
  }

  console.log(`\n🎯 Target deployment: ${deployment.id}`)
  console.log(`   Network: ${deployment.network.name} (Aztec ${deployment.network.aztecVersion})`)
  console.log(`   Tokens: ${deployment.tokens.map(t => t.symbol).join(', ')}\n`)

  if (deployment.tokens.length === 0) {
    console.log('⚠️  No tokens in this deployment — nothing to pause.')
    return
  }

  // Setup L1 client
  const nodeUrl = getAztecNodeUrl()
  const node = createAztecNodeClient(nodeUrl)
  const nodeInfo = await node.getNodeInfo()
  const chain = createEthereumChain([L1_URL], nodeInfo.l1ChainId)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_CREDENTIAL, chain.chainInfo)
  const l1Public = createPublicClient({ transport: http(L1_URL) })

  console.log(`🔑 Operator: ${l1Client.account.address}\n`)

  // Pause each portal
  const updatedTokens: DeployedToken[] = []

  for (const token of deployment.tokens) {
    console.log(`\n── ${token.symbol} (portal: ${token.l1PortalContract}) ──`)

    const portal = getContract({
      address: token.l1PortalContract as `0x${string}`,
      abi: CustomTokenPortalAbi,
      client: l1Client as any,
    }) as any

    // Check current state
    const isActive: boolean = await l1Public.readContract({
      address: token.l1PortalContract as `0x${string}`,
      abi: CustomTokenPortalAbi,
      functionName: 'depositsActive',
    }) as boolean

    if (!isActive) {
      console.log(`  ⏭️  Already paused — skipping`)
      updatedTokens.push({ ...token, depositsPaused: true })
      continue
    }

    // Check we are the owner
    const portalOwner: string = await l1Public.readContract({
      address: token.l1PortalContract as `0x${string}`,
      abi: CustomTokenPortalAbi,
      functionName: 'owner',
    }) as string

    if (portalOwner.toLowerCase() !== l1Client.account.address.toLowerCase()) {
      console.error(`  ❌ Not the owner of this portal (owner=${portalOwner}) — cannot pause. Skipping.`)
      updatedTokens.push(token)
      continue
    }

    // Pause deposits
    console.log(`  ⏸️  Calling pauseDeposits()...`)
    const txHash = await portal.write.pauseDeposits([], {})
    console.log(`  📝 TX: ${txHash}`)

    const receipt = await l1Client.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      throw new Error(`pauseDeposits() failed for ${token.symbol} (tx: ${txHash})`)
    }

    console.log(`  ✅ Deposits paused for ${token.symbol}`)
    updatedTokens.push({ ...token, depositsPaused: true })
  }

  // Persist updated state to deployment JSON
  console.log('\n📝 Saving migration state to deployment file...')
  updateDeploymentFile(deployment.id, updatedTokens)

  // Sync to frontend
  console.log('📦 Syncing to frontend...')
  copyToFrontend()

  console.log('\n🏁 Done.')
  console.log('   Next steps:')
  console.log('   1. Deploy fresh portals on the new rollup:')
  console.log('      node --import tsx index-testnet-compliant.ts')
  console.log('   2. Users with L2 balances on the old rollup must exit_to_l1 before shutdown.')
  console.log('   3. Sweep collected fees from old portals via withdrawFees() when retiring them.\n')
}

main().catch(err => {
  console.error('\n❌ Script failed:', err)
  process.exit(1)
})
