// @ts-nocheck
/**
 * Targeted redeployment script: fresh L1 portal + L2 bridge + L2 token for USDC,
 * wired to the existing SwapBridgeRouter and L1 USDC (TestERC20).
 *
 * Run: AZTEC_ENV=devnet MNEMONIC="..." npm run redeploy-permit2
 */

import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { createLogger } from '@aztec/aztec.js/log'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing'
import {
  SponsoredFPCContractArtifact,
} from '@aztec/noir-contracts.js/SponsoredFPC'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { getContract } from 'viem'
import 'dotenv/config'

// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'

import { setupWallet } from './utils/setup_wallet.js'
import { deploySchnorrAccount } from './utils/deploy_account.js'
import { getSponsoredFPCInstance } from './utils/sponsored_fpc.js'
import {
  loadActiveDeployment,
  loadRegistry,
  saveTokenToDeployment,
  copyToFrontend,
} from './utils/save_contracts.js'
import {
  getAztecNodeUrl,
  getL1RpcUrl,
  getTimeouts,
} from './config/config.js'

const CustomTokenPortalAbi = CustomTokenPortalJson.abi
const CustomTokenPortalBytecode = CustomTokenPortalJson.bytecode.object as `0x${string}`

// ─── Constants ──────────────────────────────────────────────────────────────

const L1_USDC_ADDRESS = '0x47e16bd8702bcef388085c0371ba0b87fa883f5e'
const SWAP_BRIDGE_ROUTER = '0x88e272483B12Bd5A2701EcC1Bd6Ac2a8ca5199FF'

const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
const MNEMONIC =
  process.env.MNEMONIC ||
  'test test test test test test test test test test test junk'
const L1_CREDENTIAL = L1_PRIVATE_KEY || MNEMONIC
const L1_URL = process.env.L1_URL || getL1RpcUrl()

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const logger = createLogger('aztec:redeploy')

  // ── 1. Setup wallet + L1 client ──────────────────────────────────────────
  logger.info('Setting up wallet and L1 client...')
  const wallet = await setupWallet()

  const nodeUrl = getAztecNodeUrl()
  const node = createAztecNodeClient(nodeUrl)
  const nodeInfo = await node.getNodeInfo()
  const chain = createEthereumChain([L1_URL], nodeInfo.l1ChainId)
  const l1Client = createExtendedL1Client(
    chain.rpcUrls,
    L1_CREDENTIAL,
    chain.chainInfo,
  )
  const ownerEthAddress = l1Client.account.address
  const l1ContractAddresses = nodeInfo.l1ContractAddresses

  logger.info(`L1 wallet: ${ownerEthAddress}`)
  logger.info(`Registry: ${l1ContractAddresses.registryAddress}`)

  // Sponsored fee setup
  const sponsoredFPC = await getSponsoredFPCInstance()
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact)
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
    sponsoredFPC.address,
  )

  // Deploy Schnorr account (needed as deployer identity on L2)
  const accountManager = await deploySchnorrAccount(wallet)
  const ownerAztecAddress = accountManager.address
  await wallet.registerSender(ownerAztecAddress)
  logger.info(`Owner Aztec address: ${ownerAztecAddress}`)

  // ── 2. Deploy custom L1 TokenPortal ──────────────────────────────────────
  logger.info('Deploying custom L1 TokenPortal...')
  const portalAddress = await deployL1Contract(
    l1Client,
    CustomTokenPortalAbi,
    CustomTokenPortalBytecode,
    [
      ownerEthAddress,   // _initialOwner
      ownerEthAddress,   // _feeRecipient
      0n,                // _feeBasisPoints (no fees)
      ownerEthAddress,   // _humanIdAttester (dummy)
      0n,                // _cleanHandsCircuitId
      ownerEthAddress,   // _passportSigner (dummy)
    ],
  ).then(({ address }) => address)
  logger.info(`L1 TokenPortal deployed: ${portalAddress}`)

  // ── 3. Deploy L2 Token ───────────────────────────────────────────────────
  const tokenSalt = new Fr(BigInt(Date.now()))
  const bridgeSalt = new Fr(BigInt(Date.now() + 1000))

  logger.info('Deploying L2 Token (Clean USDC)...')
  const l2Token = await TokenContract.deploy(
    wallet,
    ownerAztecAddress,
    'Clean USDC',
    'cUSDC',
    6,
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: tokenSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`L2 Token deployed: ${l2Token.address}`)

  // ── 4. Deploy L2 Bridge ──────────────────────────────────────────────────
  logger.info('Deploying L2 Bridge...')
  const l2Bridge = await TokenBridgeContract.deploy(
    wallet,
    l2Token.address,
    portalAddress,
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: bridgeSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`L2 Bridge deployed: ${l2Bridge.address}`)

  // ── 5. Set bridge as minter on L2 token ──────────────────────────────────
  logger.info('Setting bridge as minter on L2 token...')
  await l2Token.methods
    .set_minter(l2Bridge.address, true)
    .send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    })
  logger.info('Bridge set as minter')

  // ── 6. Initialize L1 portal ──────────────────────────────────────────────
  logger.info('Initializing L1 portal...')
  const l1Portal = getContract({
    address: portalAddress.toString() as `0x${string}`,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any

  const initTx = await l1Portal.write.initialize([
    l1ContractAddresses.registryAddress.toString(),
    L1_USDC_ADDRESS,
    l2Bridge.address.toString(), // bytes32 — Aztec address
  ])
  await l1Client.waitForTransactionReceipt({ hash: initTx, timeout: 120_000 })
  logger.info('L1 portal initialized')

  // ── 7. Set SwapBridgeRouter as trusted forwarder ─────────────────────────
  logger.info(`Setting trusted forwarder: ${SWAP_BRIDGE_ROUTER}`)
  const forwarderTx = await l1Portal.write.setTrustedForwarder([
    SWAP_BRIDGE_ROUTER,
    true,
  ])
  await l1Client.waitForTransactionReceipt({
    hash: forwarderTx,
    timeout: 120_000,
  })
  logger.info('Trusted forwarder set')

  // ── 8. Update deployment JSON ────────────────────────────────────────────
  logger.info('Updating deployment...')

  // Load existing USDC entry from active deployment for feeAssetHandler
  const activeDeployment = loadActiveDeployment()
  const existingUsdc = activeDeployment?.tokens.find(t => t.symbol === 'USDC')

  saveTokenToDeployment({
    symbol: 'USDC',
    decimals: 6,
    logo: '/assets/svg/USDC.svg',
    l1TokenContract: L1_USDC_ADDRESS,
    l1PortalContract: portalAddress.toString(),
    l2TokenContract: l2Token.address.toString(),
    l2BridgeContract: l2Bridge.address.toString(),
    feeAssetHandler: existingUsdc?.feeAssetHandler ?? '',
    sponsoredFee: sponsoredFPC.address.toString(),
  })

  copyToFrontend()
  logger.info('Deployment updated and synced to frontend')

  // ── Summary ──────────────────────────────────────────────────────────────
  logger.info('\n=== Redeployment Complete ===')
  logger.info(`L1 TokenPortal:      ${portalAddress}`)
  logger.info(`L2 Token (cUSDC):    ${l2Token.address}`)
  logger.info(`L2 Bridge:           ${l2Bridge.address}`)
  logger.info(`L1 USDC (reused):    ${L1_USDC_ADDRESS}`)
  logger.info(`SwapBridgeRouter:    ${SWAP_BRIDGE_ROUTER}`)
  logger.info(`Trusted Forwarder:   set`)
  logger.info(`Fee basis points:    0 (disabled)`)
}

main().catch((err) => {
  console.error('Redeployment failed:', err)
  process.exit(1)
})
