/**
 * Aztec Token Bridge — Mainnet Deployment
 *
 * Deploys the production bridge on Ethereum mainnet + Aztec mainnet and wires
 * every layer so bridging is usable immediately after this script returns
 * (modulo pool seeding, see below).
 *
 * Contracts deployed:
 *   L1 (shared):   UniswapFuelSwap, SwapBridgeRouter
 *   L1 (per tok):  TokenPortal
 *   L2 (per tok):  TokenMinterProxy, TokenContract (Wonderland), TokenBridge
 *   L2 (shared):   BridgedFPC (registered, no deploy tx — fully private)
 *
 * Wiring performed automatically:
 *   proxy.set_token(l2Token)
 *   proxy.set_minter(l2Bridge, true)
 *   TokenPortal.initialize(registry, l1Token, l2Bridge)
 *   TokenPortal.setTrustedForwarder(SwapBridgeRouter, true)
 *
 * NOT performed (manual mainnet steps):
 *   1. Uniswap V4 pool seeding (ERC20/WETH, ETH/AZTEC, optional direct ERC20/AZTEC).
 *      Use Uniswap PositionManager — PoolSeeder locks liquidity permanently and
 *      is testnet-only.
 *   2. Ownership acceptance by the multisig (if OWNER is set, this script only
 *      *proposes* the transfer; the multisig must call `acceptOwnership()`).
 *
 * Required env:
 *   AZTEC_ENV=mainnet
 *   L1_PRIVATE_KEY=0x…                   deployer EOA (pays L1 gas)
 *   FEE_RECIPIENT=0x…                    portal fee collector (use multisig)
 *   POCH_ATTESTER_PRIVATE_KEY=0x…        L1 ECDSA attester
 *   PASSPORT_SIGNER_PRIVATE_KEY=0x…      L1 ECDSA passport signer
 *   L2_POCH_ATTESTER_PRIVATE_KEY=0x…     L2 Grumpkin attester (derived pubkey -> bridge)
 *   L2_PASSPORT_SIGNER_PRIVATE_KEY=0x…   L2 Grumpkin passport signer
 *
 * Optional env:
 *   OWNER=0x…                   Multisig to transfer L1 ownership to (two-step).
 *   FEE_BASIS_POINTS=500        Portal fee (default 5%, max 10%).
 *   CLEAN_HANDS_CIRCUIT_ID=…    Override default circuit ID.
 *   CLEAN_HANDS_ACTION_ID=…     Override default action ID.
 *   L1_URL=…                    Override L1 RPC.
 *   AZTEC_NODE_URL=…            Override Aztec node.
 *   FORCE_REDEPLOY_SWAPS=true   Redeploy UniswapFuelSwap + SwapBridgeRouter.
 *   DEPLOY_TOKEN=USDC           Only (re)deploy this token.
 *
 * Run: AZTEC_ENV=mainnet node --import tsx deploy-mainnet.ts
 */

import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { createEthereumChain } from '@aztec/ethereum/chain'
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types'
import { TokenContract } from '@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { Schnorr } from '@aztec/foundation/crypto/schnorr'
import { deriveSigningKey } from '@aztec/stdlib/keys'
import { registerPrivateContract } from '@wonderland/aztec-fee-payment'
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC'
import { getContract, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import 'dotenv/config'

import { TokenBridgeContract } from './artifacts/TokenBridge.js'
import { TokenMinterProxyContract } from './artifacts/TokenMinterProxy.js'

// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'
// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'

import { setupWallet } from './utils/setup_wallet.js'
import { deploySchnorrAccount } from './utils/deploy_account.js'
import { getSponsoredFPCInstance } from './utils/sponsored_fpc.js'
import { TOKEN_CONFIGS, TokenConfig } from './constants/tokens.js'
import {
  createDeployment,
  saveTokenToDeployment,
  saveFuelSwapInfraToDeployment,
  loadActiveDeployment,
  loadExistingTokens,
  copyToFrontend,
  type DeployedToken,
} from './utils/save_contracts.js'
import {
  getAztecNodeUrl,
  getL1RpcUrl,
  getTimeouts,
  isMainnet,
} from './config/config.js'
import configManager from './config/config.js'

// ─── Mainnet constants ──────────────────────────────────────────────
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as const
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as const
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

// ─── Env ────────────────────────────────────────────────────────────
const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY as Hex | undefined
const OWNER = process.env.OWNER as Hex | undefined
const FEE_RECIPIENT = process.env.FEE_RECIPIENT as Hex | undefined
const FEE_BASIS_POINTS = BigInt(process.env.FEE_BASIS_POINTS || '500')
const CLEAN_HANDS_CIRCUIT_ID = BigInt(
  process.env.CLEAN_HANDS_CIRCUIT_ID ||
    '0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19',
)
const CLEAN_HANDS_ACTION_ID = BigInt(process.env.CLEAN_HANDS_ACTION_ID || '123456789')
const FORCE_REDEPLOY_SWAPS = process.env.FORCE_REDEPLOY_SWAPS === 'true'
const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || ''

// ─── Helpers ────────────────────────────────────────────────────────
function asHex(pk: string): Hex {
  return (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required in .env`)
  return v
}

const schnorr = new Schnorr()

async function deriveL2Pubkey(hex: string): Promise<{ x: Fr; y: Fr }> {
  const secretKey = Fr.fromString(asHex(hex))
  const signingKey = deriveSigningKey(secretKey)
  const pubkey = await schnorr.computePublicKey(signingKey)
  return { x: pubkey.x, y: pubkey.y }
}

function generateTokenSalts(symbol: string) {
  const t = Date.now()
  const s = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return {
    tokenSalt: new Fr(BigInt(t + s)),
    bridgeSalt: new Fr(BigInt(t + s + 1000)),
    proxySalt: new Fr(BigInt(t + s + 2000)),
  }
}

// ─── L1 deploy helpers ──────────────────────────────────────────────
async function deployUniswapFuelSwap(
  l1Client: ExtendedViemWalletClient,
  feeJuice: Hex,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    UniswapFuelSwapJson.abi,
    UniswapFuelSwapJson.bytecode.object as Hex,
    [POOL_MANAGER, feeJuice, WETH],
  )
  return address
}

async function deploySwapBridgeRouter(
  l1Client: ExtendedViemWalletClient,
  feeJuicePortal: Hex,
  uniswapFuelSwap: Hex,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    SwapBridgeRouterJson.abi,
    SwapBridgeRouterJson.bytecode.object as Hex,
    [PERMIT2, feeJuicePortal, uniswapFuelSwap],
  )
  return address
}

async function deployTokenPortal(
  l1Client: ExtendedViemWalletClient,
  initialOwner: Hex,
  feeRecipient: Hex,
  humanIdAttester: Hex,
  passportSigner: Hex,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    CustomTokenPortalJson.abi,
    CustomTokenPortalJson.bytecode.object as Hex,
    [
      initialOwner,
      feeRecipient,
      FEE_BASIS_POINTS,
      humanIdAttester,
      CLEAN_HANDS_CIRCUIT_ID,
      CLEAN_HANDS_ACTION_ID,
      passportSigner,
    ],
  )
  return address
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const logger = createLogger('aztec:deploy-mainnet')

  // ── Validate env ──
  if (!isMainnet()) {
    throw new Error(
      `AZTEC_ENV must be 'mainnet' (got '${process.env.AZTEC_ENV}'). This script refuses to run on any other network.`,
    )
  }
  if (!L1_PRIVATE_KEY) throw new Error('L1_PRIVATE_KEY is required')
  if (!FEE_RECIPIENT) throw new Error('FEE_RECIPIENT is required (multisig recommended)')

  requireEnv('POCH_ATTESTER_PRIVATE_KEY')
  requireEnv('PASSPORT_SIGNER_PRIVATE_KEY')
  requireEnv('L2_POCH_ATTESTER_PRIVATE_KEY')
  requireEnv('L2_PASSPORT_SIGNER_PRIVATE_KEY')

  const pochAttester = privateKeyToAccount(asHex(process.env.POCH_ATTESTER_PRIVATE_KEY!))
  const passportSigner = privateKeyToAccount(asHex(process.env.PASSPORT_SIGNER_PRIVATE_KEY!))
  const l2PochPubkey = await deriveL2Pubkey(process.env.L2_POCH_ATTESTER_PRIVATE_KEY!)
  const l2PassportPubkey = await deriveL2Pubkey(process.env.L2_PASSPORT_SIGNER_PRIVATE_KEY!)

  // Pre-existing L1 tokens required for every config entry on mainnet
  const tokensToProcess: TokenConfig[] = DEPLOY_TOKEN
    ? TOKEN_CONFIGS.filter((t) => t.symbol.toUpperCase() === DEPLOY_TOKEN.toUpperCase())
    : TOKEN_CONFIGS
  if (DEPLOY_TOKEN && tokensToProcess.length === 0) {
    throw new Error(`DEPLOY_TOKEN=${DEPLOY_TOKEN} not found in TOKEN_CONFIGS`)
  }
  const missing = tokensToProcess.filter((t) => !t.l1TokenAddress)
  if (missing.length > 0) {
    throw new Error(
      `Mainnet deploy requires l1TokenAddress on every TOKEN_CONFIGS entry. Missing: ${missing
        .map((t) => t.symbol)
        .join(', ')}`,
    )
  }

  // ── L1 client / node info ──
  const nodeUrl = getAztecNodeUrl()
  const L1_URL = getL1RpcUrl()
  const node = createAztecNodeClient(nodeUrl)
  const nodeInfo = await node.getNodeInfo()

  if (nodeInfo.l1ChainId !== 1) {
    throw new Error(`Expected L1 chain ID 1 (mainnet), got ${nodeInfo.l1ChainId}`)
  }

  const chain = createEthereumChain([L1_URL], nodeInfo.l1ChainId)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)
  const deployerEth = l1Client.account.address as Hex

  const l1Addrs = nodeInfo.l1ContractAddresses
  const registryAddr = l1Addrs.registryAddress.toString() as Hex
  const feeJuiceAddr = (l1Addrs as any).feeJuiceAddress?.toString() as Hex | undefined
  const feeJuicePortalAddr = (l1Addrs as any).feeJuicePortalAddress?.toString() as Hex | undefined
  if (!feeJuiceAddr || !feeJuicePortalAddr) {
    throw new Error('Missing feeJuiceAddress / feeJuicePortalAddress from node info')
  }

  logger.info('=== Aztec Bridge Mainnet Deployment ===')
  logger.info(`Deployer (L1):       ${deployerEth}`)
  logger.info(`FeeRecipient:        ${FEE_RECIPIENT}`)
  logger.info(`Multisig OWNER:      ${OWNER ?? '(none — ownership stays with deployer)'}`)
  logger.info(`L1 Registry:         ${registryAddr}`)
  logger.info(`L1 Rollup:           ${l1Addrs.rollupAddress}`)
  logger.info(`FeeJuice:            ${feeJuiceAddr}`)
  logger.info(`FeeJuicePortal:      ${feeJuicePortalAddr}`)
  logger.info(`PoolManager:         ${POOL_MANAGER}`)
  logger.info(`WETH:                ${WETH}`)
  logger.info(`Permit2:             ${PERMIT2}`)
  logger.info(`Fee basis points:    ${FEE_BASIS_POINTS} (max 1000 = 10%)`)
  logger.info(`POCH attester (L1):  ${pochAttester.address}`)
  logger.info(`Passport signer (L1):${passportSigner.address}`)
  logger.info(`Tokens:              ${tokensToProcess.map((t) => t.symbol).join(', ')}`)

  const bal = await l1Client.getBalance({ address: deployerEth })
  logger.info(`Deployer L1 balance: ${(Number(bal) / 1e18).toFixed(4)} ETH`)
  if (bal === 0n) throw new Error('Deployer has 0 ETH on L1')

  // ── L2 wallet + sponsored FPC ──
  const wallet = await setupWallet()
  const sponsoredFPC = await getSponsoredFPCInstance()
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact)
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address)

  const accountManager = await deploySchnorrAccount(wallet)
  const ownerAztecAddress = accountManager.address
  await wallet.registerSender(ownerAztecAddress, 'owner')
  logger.info(`Deployer (L2):       ${ownerAztecAddress}`)

  // ── Deployment record ──
  const rollupVersion = (nodeInfo as { rollupVersion?: number }).rollupVersion ?? 0
  const l2ChainId = nodeInfo.l1ChainId ^ rollupVersion
  const serializedNodeInfo: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nodeInfo)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested: Record<string, unknown> = {}
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        nested[nk] =
          nv != null &&
          typeof (nv as any).toString === 'function' &&
          typeof nv !== 'string' &&
          typeof nv !== 'number' &&
          typeof nv !== 'boolean'
            ? (nv as any).toString()
            : nv
      }
      serializedNodeInfo[k] = nested
    } else {
      serializedNodeInfo[k] =
        v != null &&
        typeof (v as any).toString === 'function' &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
          ? (v as any).toString()
          : v
    }
  }

  createDeployment({
    nodeUrl,
    l1RpcUrl: L1_URL,
    l1ChainId: nodeInfo.l1ChainId,
    l2ChainId,
    aztecVersion:
      (nodeInfo as any).nodeVersion ?? configManager.getConfig().settings.version,
    rollupVersion,
    networkName: 'mainnet',
    l1ContractAddresses: {
      rollupAddress: l1Addrs.rollupAddress.toString(),
      registryAddress: registryAddr,
      inboxAddress: l1Addrs.inboxAddress.toString(),
      outboxAddress: l1Addrs.outboxAddress.toString(),
    },
    nodeInfo: serializedNodeInfo,
    sponsoredFeeAddress: sponsoredFPC.address.toString(),
  })

  // ── Shared L1 infra (idempotent across re-runs) ──
  logger.info('\n── Shared L1 infrastructure ──')
  const prior = loadActiveDeployment()

  let uniswapFuelSwap: Hex
  if (!FORCE_REDEPLOY_SWAPS && prior?.uniswapFuelSwapAddress) {
    uniswapFuelSwap = prior.uniswapFuelSwapAddress as Hex
    logger.info(`UniswapFuelSwap (existing): ${uniswapFuelSwap}`)
  } else {
    logger.info('Deploying UniswapFuelSwap…')
    uniswapFuelSwap = (await deployUniswapFuelSwap(l1Client, feeJuiceAddr)).toString() as Hex
    logger.info(`UniswapFuelSwap: ${uniswapFuelSwap}`)
    saveFuelSwapInfraToDeployment({ uniswapFuelSwapAddress: uniswapFuelSwap })
  }

  let swapBridgeRouter: Hex
  if (!FORCE_REDEPLOY_SWAPS && prior?.swapBridgeRouterAddress) {
    swapBridgeRouter = prior.swapBridgeRouterAddress as Hex
    logger.info(`SwapBridgeRouter (existing): ${swapBridgeRouter}`)
  } else {
    logger.info('Deploying SwapBridgeRouter…')
    swapBridgeRouter = (
      await deploySwapBridgeRouter(l1Client, feeJuicePortalAddr, uniswapFuelSwap)
    ).toString() as Hex
    logger.info(`SwapBridgeRouter: ${swapBridgeRouter}`)
    saveFuelSwapInfraToDeployment({ swapBridgeRouterAddress: swapBridgeRouter })
  }

  let bridgedFpcAddress: string
  if (prior?.bridgedFpcAddress) {
    bridgedFpcAddress = prior.bridgedFpcAddress
    logger.info(`BridgedFPC (existing): ${bridgedFpcAddress}`)
  } else {
    logger.info('Registering BridgedFPC on L2…')
    const bridgedFpc = await registerPrivateContract(wallet, new Fr(0n))
    bridgedFpcAddress = bridgedFpc.address.toString()
    logger.info(`BridgedFPC: ${bridgedFpcAddress}`)
    saveFuelSwapInfraToDeployment({ bridgedFpcAddress })
  }

  // ── Per-token deploy + wire ──
  const existingTokens = loadExistingTokens()
  const deployed: DeployedToken[] = []

  for (const tc of tokensToProcess) {
    logger.info(`\n── ${tc.symbol} ──`)

    if (existingTokens.find((e) => e.symbol === tc.symbol && !tc.forceDeploy)) {
      logger.info(`  Already deployed — skipping. Set forceDeploy=true to redeploy.`)
      deployed.push(existingTokens.find((e) => e.symbol === tc.symbol)!)
      continue
    }

    const l1TokenContract = EthAddress.fromString(tc.l1TokenAddress!)
    logger.info(`  L1 token (existing): ${l1TokenContract}`)

    // L1 TokenPortal — deployer = initialOwner (transferred to OWNER at the end)
    logger.info('  Deploying TokenPortal…')
    const portal = await deployTokenPortal(
      l1Client,
      deployerEth,
      FEE_RECIPIENT,
      pochAttester.address as Hex,
      passportSigner.address as Hex,
    )
    logger.info(`  TokenPortal: ${portal}`)

    const salts = generateTokenSalts(tc.symbol)

    // L2 TokenMinterProxy (owner is immutable — set at deploy)
    logger.info('  Deploying L2 TokenMinterProxy…')
    const { contract: l2Proxy } = await TokenMinterProxyContract.deploy(wallet).send({
      from: ownerAztecAddress,
      contractAddressSalt: salts.proxySalt,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info(`  TokenMinterProxy: ${l2Proxy.address}`)

    // L2 Token (Wonderland, constructor_with_minter)
    logger.info('  Deploying L2 Token (Wonderland)…')
    const { contract: l2Token } = await TokenContract.deployWithOpts(
      { wallet, method: 'constructor_with_minter' },
      tc.l2Name,
      tc.l2Symbol,
      tc.decimals,
      l2Proxy.address,
    ).send({
      from: ownerAztecAddress,
      contractAddressSalt: salts.tokenSalt,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info(`  L2 Token: ${l2Token.address}`)

    // L2 TokenBridge (with attestation config + Grumpkin pubkeys)
    logger.info('  Deploying L2 TokenBridge…')
    const { contract: l2Bridge } = await TokenBridgeContract.deploy(
      wallet,
      l2Proxy.address,
      portal,
      l2PochPubkey.x,
      l2PochPubkey.y,
      CLEAN_HANDS_CIRCUIT_ID,
      CLEAN_HANDS_ACTION_ID,
      l2PassportPubkey.x,
      l2PassportPubkey.y,
    ).send({
      from: ownerAztecAddress,
      contractAddressSalt: salts.bridgeSalt,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info(`  TokenBridge: ${l2Bridge.address}`)

    // Wire proxy: set_token (immutable), set_minter(bridge, true)
    logger.info('  Wiring proxy.set_token…')
    await l2Proxy.methods.set_token(l2Token.address).send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    })
    logger.info('  Wiring proxy.set_minter(bridge, true)…')
    await l2Proxy.methods.set_minter(l2Bridge.address, true).send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    })

    // Initialize L1 portal
    logger.info('  Initializing TokenPortal…')
    const portalCtr = getContract({
      address: portal.toString() as Hex,
      abi: CustomTokenPortalJson.abi,
      client: l1Client as any,
    }) as any
    const initTx = await portalCtr.write.initialize([
      registryAddr,
      l1TokenContract.toString() as Hex,
      l2Bridge.address.toString() as Hex,
    ])
    await l1Client.waitForTransactionReceipt({
      hash: initTx,
      timeout: getTimeouts().txTimeout,
    })

    // Trust SwapBridgeRouter for relayed private deposits
    logger.info('  Setting trusted forwarder (SwapBridgeRouter)…')
    const fwTx = await portalCtr.write.setTrustedForwarder([swapBridgeRouter, true])
    await l1Client.waitForTransactionReceipt({
      hash: fwTx,
      timeout: getTimeouts().txTimeout,
    })

    const record: DeployedToken = {
      symbol: tc.symbol,
      decimals: tc.decimals,
      logo: tc.logo,
      l1TokenContract: l1TokenContract.toString(),
      l1PortalContract: portal.toString(),
      l2TokenContract: l2Token.address.toString(),
      l2BridgeContract: l2Bridge.address.toString(),
      feeAssetHandler: '',
      sponsoredFee: sponsoredFPC.address.toString(),
    }
    saveTokenToDeployment(record)
    deployed.push(record)
    logger.info(`  ${tc.symbol} deployed + wired`)
  }

  // ── Optional: propose ownership transfer to multisig ──
  if (OWNER) {
    logger.info(`\n── Proposing L1 ownership transfer → ${OWNER} ──`)
    const transfer = async (addr: Hex, label: string, abi: any) => {
      const c = getContract({ address: addr, abi, client: l1Client as any }) as any
      const tx = await c.write.transferOwnership([OWNER])
      await l1Client.waitForTransactionReceipt({
        hash: tx,
        timeout: getTimeouts().txTimeout,
      })
      logger.info(`  ${label}: pending acceptOwnership from ${OWNER}`)
    }
    await transfer(uniswapFuelSwap, 'UniswapFuelSwap', UniswapFuelSwapJson.abi)
    await transfer(swapBridgeRouter, 'SwapBridgeRouter', SwapBridgeRouterJson.abi)
    for (const d of deployed) {
      await transfer(
        d.l1PortalContract as Hex,
        `TokenPortal(${d.symbol})`,
        CustomTokenPortalJson.abi,
      )
    }
    logger.info(`  Multisig ${OWNER} must call acceptOwnership() on each contract to complete.`)
  }

  copyToFrontend()

  // ── Summary ──
  logger.info('\n=== Mainnet Deployment Summary ===')
  logger.info(`UniswapFuelSwap:   ${uniswapFuelSwap}`)
  logger.info(`SwapBridgeRouter:  ${swapBridgeRouter}`)
  logger.info(`BridgedFPC (L2):   ${bridgedFpcAddress}`)
  for (const d of deployed) {
    logger.info(`\n${d.symbol}`)
    logger.info(`  L1 Token:   ${d.l1TokenContract}`)
    logger.info(`  L1 Portal:  ${d.l1PortalContract}`)
    logger.info(`  L2 Token:   ${d.l2TokenContract}`)
    logger.info(`  L2 Bridge:  ${d.l2BridgeContract}`)
  }

  logger.info('\nNext steps (manual):')
  logger.info(
    '  1. Seed Uniswap V4 pools via Uniswap PositionManager (do NOT use PoolSeeder on mainnet).',
  )
  logger.info('     Required: ETH/AZTEC (terminal fuel leg) and one of:')
  logger.info('       - ERC20/WETH pool for each bridged token (multi-hop route), or')
  logger.info('       - Direct ERC20/AZTEC pool (single-hop route)')
  if (OWNER) {
    logger.info(`  2. From multisig ${OWNER}, call acceptOwnership() on:`)
    logger.info(`     - UniswapFuelSwap   (${uniswapFuelSwap})`)
    logger.info(`     - SwapBridgeRouter  (${swapBridgeRouter})`)
    for (const d of deployed) {
      logger.info(`     - TokenPortal ${d.symbol.padEnd(6)} (${d.l1PortalContract})`)
    }
  } else {
    logger.info(
      '  2. Consider transferring L1 ownership to a multisig+timelock (set OWNER on re-run).',
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
