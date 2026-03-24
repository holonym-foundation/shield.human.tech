// @ts-nocheck
/**
 * Aztec Token Bridge Deployment Script
 *
 * Environment Variables:
 * - AZTEC_ENV: Set to 'devnet' for devnet, or 'sandbox' for local (default: sandbox)
 * - L1_URL: L1 RPC URL (optional, uses config if not set)
 * - L1_PRIVATE_KEY: Wallet private key (0x-prefixed hex string, preferred for devnet)
 * - MNEMONIC: Wallet mnemonic (fallback if L1_PRIVATE_KEY is not set)
 *
 * Examples:
 * Local sandbox: npm run start-testnet
 * Devnet (private key): AZTEC_ENV=devnet L1_PRIVATE_KEY="0x..." npm run start-testnet
 * Devnet (mnemonic): AZTEC_ENV=devnet MNEMONIC="your mnemonic" npm run start-testnet
 */

import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { Logger, createLogger } from '@aztec/aztec.js/log'
import {
  generateClaimSecret,
  L1TokenManager,
  L1TokenPortalManager,
} from '@aztec/aztec.js/ethereum'
import {
  getContractInstanceFromInstantiationParams,
  type ContractInstanceWithAddress,
} from '@aztec/aztec.js/contracts'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { RollupContract } from '@aztec/ethereum/contracts'
import { CheckpointNumber } from '@aztec/foundation/branded-types'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { createEthereumChain } from '@aztec/ethereum/chain'
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types'
import {
  FeeAssetHandlerAbi,
  FeeAssetHandlerBytecode,
  RollupAbi,
  TokenPortalAbi,
  TokenPortalBytecode,
} from '@aztec/l1-artifacts'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
// import { TokenContract } from '@defi-wonderland/aztec-standards/artifacts/Token.js'
// import { TokenContract } from './constants/aztec/artifacts/Token.ts'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
// import { TokenBridgeContract } from './constants/aztec/artifacts/TokenBridge.ts'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing'
import { SetPublicAuthwitContractInteraction } from '@aztec/aztec.js/authorization'
import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging'
import { sha256ToField } from '@aztec/foundation/crypto/sha256'
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash'
import 'dotenv/config'
// @ts-ignore
import TestERC20Json from './constants/TestERC20.json'
// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'
// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'
import { registerBridgedContract } from '@defi-wonderland/aztec-fee-payment'

// Fix the bytecode format
const TestERC20Abi = TestERC20Json.abi
const TestERC20Bytecode = TestERC20Json.bytecode.object as `0x${string}`
const UniswapFuelSwapAbi = UniswapFuelSwapJson.abi
const UniswapFuelSwapBytecode = UniswapFuelSwapJson.bytecode.object as `0x${string}`
const SwapBridgeRouterAbi = SwapBridgeRouterJson.abi
const SwapBridgeRouterBytecode = SwapBridgeRouterJson.bytecode.object as `0x${string}`

import { createPublicClient, encodeFunctionData, getContract, http, toFunctionSelector } from 'viem'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

import {
  SponsoredFPCContract,
  SponsoredFPCContractArtifact,
} from '@aztec/noir-contracts.js/SponsoredFPC'
import { setupWallet } from './utils/setup_wallet.js'
import { deploySchnorrAccount } from './utils/deploy_account.js'
import { getSponsoredFPCInstance } from './utils/sponsored_fpc.js'
import { TOKEN_CONFIGS, TokenConfig } from './constants/tokens.js'
import {
  createDeployment,
  saveTokenToDeployment,
  saveFuelSwapInfraToDeployment,
  loadExistingTokens,
  copyToFrontend,
  type DeployedToken,
  type L1ContractAddresses,
} from './utils/save_contracts.js'
import {
  getAztecNodeUrl,
  getL1RpcUrl,
  getTimeouts,
  isDevnet,
} from './config/config.js'
import configManager from './config/config.js'

// Get environment configuration — prefer private key over mnemonic
const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
const MNEMONIC =
  process.env.MNEMONIC ||
  'test test test test test test test test test test test junk'
const L1_CREDENTIAL = L1_PRIVATE_KEY || MNEMONIC
const L1_URL = process.env.L1_URL || getL1RpcUrl()

const MINT_AMOUNT = BigInt(1e15)

async function deployTestERC20(
  l1Client: ExtendedViemWalletClient,
  name: string,
  symbol: string,
  decimals: number,
): Promise<EthAddress> {
  const constructorArgs = [name, symbol, decimals, l1Client.account.address]

  return await deployL1Contract(
    l1Client,
    TestERC20Abi,
    TestERC20Bytecode,
    constructorArgs,
  ).then(({ address }) => address)
}

async function deployFeeAssetHandler(
  l1Client: ExtendedViemWalletClient,
  l1TokenContract: EthAddress,
): Promise<EthAddress> {
  const constructorArgs = [
    l1Client.account.address,
    l1TokenContract.toString(),
    MINT_AMOUNT,
  ]
  return await deployL1Contract(
    l1Client,
    FeeAssetHandlerAbi,
    FeeAssetHandlerBytecode,
    constructorArgs,
  ).then(({ address }) => address)
}

async function deployTokenPortal(
  l1Client: ExtendedViemWalletClient,
): Promise<EthAddress> {
  return await deployL1Contract(
    l1Client,
    TokenPortalAbi,
    TokenPortalBytecode,
    [],
  ).then(({ address }) => address)
}

async function addMinter(
  l1Client: ExtendedViemWalletClient,
  l1TokenContract: EthAddress,
  l1TokenHandler: EthAddress,
) {
  const contract = getContract({
    address: l1TokenContract.toString(),
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any
  const tx = await contract.write.addMinter([l1TokenHandler.toString()])
  await l1Client.waitForTransactionReceipt({
    hash: tx,
    timeout: getTimeouts().txTimeout,
  })
}

// *************************************
// Generate unique salts for each token deployment
function generateTokenSalts(symbol: string) {
  // Use Fr.random() with a seed based on symbol for deterministic but unique salts
  const timestamp = Date.now()
  const symbolHash = symbol
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0)

  return {
    tokenSalt: new Fr(BigInt(timestamp + symbolHash)),
    bridgeSalt: new Fr(BigInt(timestamp + symbolHash + 1000)),
  }
}

export async function getL2TokenContractInstance(
  deployerAddress: any,
  ownerAztecAddress: AztecAddress,
  tokenName: string,
  tokenSymbol: string,
  decimals: number,
  salt: Fr,
): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(
    TokenContract.artifact,
    {
      salt: salt,
      deployer: deployerAddress,
      constructorArgs: [ownerAztecAddress, tokenName, tokenSymbol, decimals],
    },
  )
}
export async function getL2BridgeContractInstance(
  deployerAddress: any,
  ownerAztecAddress: AztecAddress,
  l2TokenContract: AztecAddress,
  l1PortalContractAddress: EthAddress,
  salt: Fr,
): Promise<ContractInstanceWithAddress> {
  return await getContractInstanceFromInstantiationParams(
    TokenBridgeContract.artifact,
    {
      salt: salt,
      deployer: deployerAddress,
      constructorArgs: [
        ownerAztecAddress,
        l2TokenContract,
        l1PortalContractAddress,
      ],
    },
  )
}

async function mintL1Tokens(
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1TokenContract: EthAddress,
  amount: bigint,
  logger: Logger,
  symbol: string,
) {
  try {
    logger.info(`🪙 Minting ${amount.toString()} ${symbol} tokens to owner`)
    const contract = getContract({
      address: l1TokenContract.toString(),
      abi: TestERC20Abi,
      client: l1Client as any,
    }) as any

    const tx = await contract.write.mint([ownerEthAddress, amount])
    logger.info(`📤 Mint transaction sent: ${tx}`)
    await l1Client.waitForTransactionReceipt({
      hash: tx,
      timeout: getTimeouts().txTimeout,
    })
    logger.info(`✅ Successfully minted ${amount.toString()} ${symbol} tokens`)
  } catch (error) {
    logger.error(`❌ Failed to mint ${symbol} tokens: ${error}`)
    throw error
  }
}

async function deployCompleteTokenSetup(
  tokenConfig: TokenConfig,
  wallet: EmbeddedWallet,
  ownerWallet: any,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  logger: Logger,
): Promise<DeployedToken> {
  logger.info(`\n=== Deploying ${tokenConfig.symbol} Token Setup ===`)

  // Generate unique salts for this token
  const { tokenSalt, bridgeSalt } = generateTokenSalts(tokenConfig.symbol)

  // Deploy or resolve L1 token contract
  let l1TokenContract: EthAddress

  if (tokenConfig.l1TokenAddress) {
    // Pre-existing L1 token (e.g. real WETH on Sepolia)
    l1TokenContract = EthAddress.fromString(tokenConfig.l1TokenAddress)
    logger.info(
      `Using pre-existing L1 ${tokenConfig.symbol} at ${l1TokenContract.toString()}`,
    )
  } else {
    // Deploy mock TestERC20
    logger.info(
      `🏗️  Deploying L1 ${tokenConfig.symbol} with decimals ${tokenConfig.decimals} token contract`,
    )
    l1TokenContract = await deployTestERC20(
      l1Client,
      tokenConfig.l1Name,
      tokenConfig.l1Symbol,
      tokenConfig.decimals,
    )
    logger.info(
      `✅ L1 ${tokenConfig.symbol} token contract deployed at ${l1TokenContract.toString()}`,
    )

    // Mint tokens to owner (only for TestERC20)
    const mintAmount = BigInt(1000000000000000000)
    await mintL1Tokens(
      l1Client,
      ownerEthAddress,
      l1TokenContract,
      mintAmount,
      logger,
      tokenConfig.symbol,
    )
  }

  // Deploy fee asset handler
  logger.info(`🔧 Deploying fee asset handler for ${tokenConfig.symbol}`)
  const feeAssetHandler = await deployFeeAssetHandler(l1Client, l1TokenContract)
  logger.info(
    `✅ Fee asset handler for ${
      tokenConfig.symbol
    } deployed at ${feeAssetHandler.toString()}`,
  )

  // Add minter — only for TestERC20 tokens (real tokens don't support addMinter)
  if (!tokenConfig.l1TokenAddress) {
    logger.info(`🔑 Adding minter for ${tokenConfig.symbol}`)
    await addMinter(l1Client, l1TokenContract, feeAssetHandler)
  }

  // Deploy L1 portal contract
  logger.info(`🌉 Deploying L1 portal contract for ${tokenConfig.symbol}`)
  const l1PortalContractAddress = await deployTokenPortal(l1Client)
  logger.info(
    `✅ L1 portal contract for ${
      tokenConfig.symbol
    } deployed at ${l1PortalContractAddress.toString()}`,
  )

  // Deploy L2 token contract
  logger.info(`🏗️  Deploying L2 ${tokenConfig.symbol} token contract`)
  const l2TokenContract = await TokenContract.deploy(
    ownerWallet,
    ownerAztecAddress,
    tokenConfig.l2Name,
    tokenConfig.l2Symbol,
    tokenConfig.decimals,
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: tokenSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })

  logger.info(
    `✅ L2 ${tokenConfig.symbol} token contract deployed at ${l2TokenContract.address}`,
  )

  // Deploy L2 bridge contract
  logger.info(`🌉 Deploying L2 bridge contract for ${tokenConfig.symbol}`)
  const l2BridgeContract = await TokenBridgeContract.deploy(
    ownerWallet,
    l2TokenContract.address,
    l1PortalContractAddress,
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: bridgeSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })

  logger.info(
    `✅ L2 ${tokenConfig.symbol} bridge contract deployed at ${l2BridgeContract.address}`,
  )

  // Set Bridge as a minter
  logger.info(`🔑 Setting bridge as minter for ${tokenConfig.symbol}`)
  await l2TokenContract.methods
    .set_minter(l2BridgeContract.address, true)
    .send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    })

  // Initialize L1 portal contract
  logger.info(`🔧 Initializing L1 portal contract for ${tokenConfig.symbol}`)
  const l1Portal = getContract({
    address: l1PortalContractAddress.toString(),
    abi: TokenPortalAbi,
    client: l1Client as any,
  }) as any

  const initTx = await l1Portal.write.initialize(
    [
      l1ContractAddresses.registryAddress.toString(),
      l1TokenContract.toString(),
      l2BridgeContract.address.toString(),
    ],
    {},
  )
  // Wait for the transaction to be confirmed
  logger.info(`⏳ Waiting for L1 portal initialization transaction: ${initTx}`)
  await l1Client.waitForTransactionReceipt({ hash: initTx, timeout: 120000 })

  logger.info(`✅ L1 portal contract for ${tokenConfig.symbol} initialized`)

  const deployedContract: DeployedToken = {
    symbol: tokenConfig.symbol,
    decimals: tokenConfig.decimals,
    logo: tokenConfig.logo,
    // L1 contracts
    l1TokenContract: l1TokenContract.toString(),
    l1PortalContract: l1PortalContractAddress.toString(),
    // L2 contracts
    l2TokenContract: l2TokenContract.address.toString(),
    l2BridgeContract: l2BridgeContract.address.toString(),
    // Fee infrastructure
    feeAssetHandler: feeAssetHandler.toString(),
    sponsoredFee: '', // Will be set later
  }

  return deployedContract
}

// *************************************

async function main() {
  let wallet: EmbeddedWallet
  let logger: Logger

  logger = createLogger('aztec:bridge')

  // Setup wallet
  wallet = await setupWallet()

  // Setup L1 client
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
  logger.info('📋 L1 Contract Addresses:')
  logger.info(`📝 Registry Address: ${l1ContractAddresses.registryAddress}`)
  logger.info(`📥 Inbox Address: ${l1ContractAddresses.inboxAddress}`)
  logger.info(`📤 Outbox Address: ${l1ContractAddresses.outboxAddress}`)
  logger.info(`🔄 Rollup Address: ${l1ContractAddresses.rollupAddress}`)

  logger.info('\n💰 Wallet Information:')
  logger.info(`👛 L1 Wallet Address: ${ownerEthAddress}`)
  logger.info(
    `⛓️  L1 Chain: ${chain.chainInfo.name || 'Unknown'} (ID: ${
      chain.chainInfo.id || 'Unknown'
    })`,
  )
  logger.info(`🌐 Using ${isDevnet() ? 'devnet' : 'local sandbox'} environment`)
  logger.info(`🔗 L1 RPC URL: ${L1_URL}`)
  logger.info(`🌐 Node URL: ${nodeUrl}`)

  // Check L1 wallet balance
  try {
    const balance = await l1Client.getBalance({
      address: ownerEthAddress as `0x${string}`,
    })
    const balanceInEth = Number(balance) / 1e18
    logger.info(`💰 L1 Wallet Balance: ${balanceInEth.toFixed(4)} ETH`)

    if (balanceInEth < 0.01) {
      logger.warn(
        '⚠️  Low L1 wallet balance! You may need more ETH for gas fees.',
      )
    }
  } catch (error) {
    logger.warn(`❌ Could not fetch L1 wallet balance: ${error}`)
    throw error
  }

  logger.info(' ')
  logger.info('🔧 Setting up sponsored fee payment contract...')
  const sponsoredFPC = await getSponsoredFPCInstance()
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact)
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
    sponsoredFPC.address,
  )
  logger.info('✅ Sponsored fee payment method configured')

  logger.info('👤 Deploying Schnorr account...')
  let accountManager = await deploySchnorrAccount(wallet)
  const ownerAztecAddress = accountManager.address
  await wallet.registerSender(ownerAztecAddress)
  logger.info(`📍 Owner Aztec Address: ${ownerAztecAddress}`)

  // Create versioned deployment file with network + L1 infra info
  const rollupVersion =
    (nodeInfo as { rollupVersion?: number }).rollupVersion ?? 0
  const l2ChainId = nodeInfo.l1ChainId ^ rollupVersion
  logger.info('\n🔧 Creating versioned deployment...')
  // Serialize nodeInfo for storage (convert EthAddress/AztecAddress objects to strings)
  const serializedNodeInfo: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(nodeInfo)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Nested object (e.g. l1ContractAddresses, protocolContractAddresses)
      const nested: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        nested[k] =
          v != null &&
          typeof (v as any).toString === 'function' &&
          typeof v !== 'string' &&
          typeof v !== 'number' &&
          typeof v !== 'boolean'
            ? (v as any).toString()
            : v
      }
      serializedNodeInfo[key] = nested
    } else {
      serializedNodeInfo[key] =
        value != null &&
        typeof (value as any).toString === 'function' &&
        typeof value !== 'string' &&
        typeof value !== 'number' &&
        typeof value !== 'boolean'
          ? (value as any).toString()
          : value
    }
  }

  createDeployment({
    nodeUrl,
    l1RpcUrl: L1_URL,
    l1ChainId: nodeInfo.l1ChainId,
    l2ChainId,
    aztecVersion: nodeInfo.nodeVersion ?? configManager.getConfig().settings.version,
    rollupVersion,
    networkName: configManager.getConfig().name,
    l1ContractAddresses: {
      rollupAddress: l1ContractAddresses.rollupAddress.toString(),
      registryAddress: l1ContractAddresses.registryAddress.toString(),
      inboxAddress: l1ContractAddresses.inboxAddress.toString(),
      outboxAddress: l1ContractAddresses.outboxAddress.toString(),
    },
    nodeInfo: serializedNodeInfo,
    sponsoredFeeAddress: sponsoredFPC.address.toString(),
  })

  // Check for existing token deployments (for skip-if-deployed checks)
  logger.info('\n📋 Checking for existing token deployments...')
  const existingTokens = loadExistingTokens()
  if (existingTokens.length > 0) {
    logger.info(`✅ Found ${existingTokens.length} existing tokens`)
    logger.info(
      `🪙 Deployed tokens: ${existingTokens.map((t) => t.symbol).join(', ')}`,
    )
  }

  // Deploy all tokens and their related contracts
  logger.info('\n🚀 Starting deployment of all tokens...')
  const deployedContracts: DeployedToken[] = []

  for (const tokenConfig of TOKEN_CONFIGS) {
    // Check if token is already deployed
    const existingToken = existingTokens.find(
      (t) => t.symbol === tokenConfig.symbol,
    )
    if (existingToken && !tokenConfig.forceDeploy) {
      logger.info(`⏭️  ${tokenConfig.symbol} already deployed, skipping...`)
      deployedContracts.push(existingToken)
      continue
    }
    if (existingToken && tokenConfig.forceDeploy) {
      logger.info(
        `🔄 ${tokenConfig.symbol} already deployed but forceDeploy is set, redeploying...`,
      )
    }

    try {
      logger.info(`\n🔄 Deploying ${tokenConfig.symbol}...`)
      const deployedContract = await deployCompleteTokenSetup(
        tokenConfig,
        wallet,
        wallet,
        ownerAztecAddress,
        l1Client,
        ownerEthAddress,
        l1ContractAddresses,
        sponsoredPaymentMethod,
        logger,
      )
      deployedContract.sponsoredFee = sponsoredFPC.address.toString()

      // Save incrementally to active deployment (survives partial failures)
      saveTokenToDeployment(deployedContract)
      deployedContracts.push(deployedContract)
      logger.info(
        `✅ Successfully deployed and saved ${tokenConfig.symbol} token setup`,
      )
    } catch (error) {
      logger.error(`❌ Failed to deploy ${tokenConfig.symbol}: ${error}`)
      // Continue with other tokens even if one fails
    }
  }

  // Deploy fuel swap infrastructure (UniswapFuelSwap + SwapBridgeRouter + BridgedFPC)
  try {
    logger.info('\n=== Deploying Fuel Swap Infrastructure ===')

    // Known Sepolia constants
    const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
    const V4_POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'
    const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'

    const feeJuiceAddress = (l1ContractAddresses as any).feeJuiceAddress?.toString()
    const feeJuicePortalAddress = (l1ContractAddresses as any).feeJuicePortalAddress?.toString()
    if (!feeJuiceAddress || !feeJuicePortalAddress) {
      throw new Error('Missing feeJuiceAddress or feeJuicePortalAddress from node info')
    }

    // 1. Deploy UniswapFuelSwap (L1)
    logger.info('Deploying UniswapFuelSwap contract...')
    const uniswapFuelSwapAddress = await deployL1Contract(
      l1Client,
      UniswapFuelSwapAbi,
      UniswapFuelSwapBytecode,
      [V4_POOL_MANAGER, feeJuiceAddress, WETH_ADDRESS],
    ).then(({ address }) => address)
    logger.info(`✅ UniswapFuelSwap deployed at ${uniswapFuelSwapAddress.toString()}`)

    // 2. Deploy SwapBridgeRouter (L1)
    logger.info('Deploying SwapBridgeRouter contract...')
    const swapBridgeRouterAddress = await deployL1Contract(
      l1Client,
      SwapBridgeRouterAbi,
      SwapBridgeRouterBytecode,
      [PERMIT2_ADDRESS, feeJuicePortalAddress, uniswapFuelSwapAddress.toString()],
    ).then(({ address }) => address)
    logger.info(`✅ SwapBridgeRouter deployed at ${swapBridgeRouterAddress.toString()}`)

    // 3. Register BridgedFPC (L2) — fully private contract, no deploy tx needed
    logger.info('Registering BridgedFPC contract...')
    const bridgedFpc = await registerBridgedContract(wallet)
    logger.info(`✅ BridgedFPC registered at ${bridgedFpc.address.toString()}`)

    saveFuelSwapInfraToDeployment({
      uniswapFuelSwapAddress: uniswapFuelSwapAddress.toString(),
      swapBridgeRouterAddress: swapBridgeRouterAddress.toString(),
      bridgedFpcAddress: bridgedFpc.address.toString(),
    })
  } catch (error) {
    logger.error(`Failed to deploy fuel swap infrastructure: ${error}`)
  }

  // Sync active deployment to frontend
  copyToFrontend()
  logger.info('✅ Deployment finalized and synced to frontend')

  // Example: Test with the first deployed token (USDC)
  if (deployedContracts.length > 0) {
    const firstToken = deployedContracts[0]
    logger.info(
      `\n🧪 Testing bridge functionality with ${firstToken.symbol}...`,
    )

    const l1TokenContract = EthAddress.fromString(firstToken.l1TokenContract)
    const feeAssetHandler = EthAddress.fromString(firstToken.feeAssetHandler)
    const l1PortalContractAddress = EthAddress.fromString(
      firstToken.l1PortalContract,
    )

    const l1TokenManager = new L1TokenManager(
      l1TokenContract,
      feeAssetHandler,
      l1Client,
      logger,
    )

    const l1PortalManager = new L1TokenPortalManager(
      l1PortalContractAddress,
      l1TokenContract,
      feeAssetHandler,
      l1ContractAddresses.outboxAddress,
      l1Client,
      logger,
    )

    logger.info('getting l1 contracts...')
    // Get the deployed L2 contracts for testing
    const l2TokenContract = await TokenContract.at(
      AztecAddress.fromString(firstToken.l2TokenContract),
      wallet,
    )
    const l2BridgeContract = await TokenBridgeContract.at(
      AztecAddress.fromString(firstToken.l2BridgeContract),
      wallet,
    )

    // Registering here is optional; contract instances already carry artifacts.
    logger.info('📝 Skipping extra L2 contract registration for testing')

    logger.info('🌉 Bridge tokens publicly')
    logger.info(`📤 Step 1: Send tokens publicly on L1`)

    // Log current L1 block BEFORE network call so we have a starting point if tx fails or script exits before receipt
    let l1BlockNumberBeforeTx: bigint | undefined
    try {
      const l1Public = createPublicClient({ transport: http(L1_URL) })
      l1BlockNumberBeforeTx = await l1Public.getBlockNumber()
      logger.info(
        `[L1→L2] Current L1 block before tx: ${l1BlockNumberBeforeTx}`,
      )
    } catch (e) {
      logger.warn(
        `[L1→L2] Could not get current L1 block number before tx: ${e}`,
      )
    }

    const claim = await l1PortalManager.bridgeTokensPublic(
      ownerAztecAddress,
      MINT_AMOUNT,
      true,
    )

    // Poll for L1→L2 message sync (same pattern as frontend), then final wait before claim
    const messageHash =
      (claim as { messageHash?: string }).messageHash ??
      (claim as { key?: string }).key
    if (messageHash) {
      const pollIntervalMs = 120_000 // 2 minutes
      const maxWaitMs = 20 * 60 * 1000 // 20 min max
      const startWait = Date.now()
      let messageSynced = false
      const messageHashFr = Fr.fromString(messageHash)
      logger.info(
        `⏳ Polling for L1→L2 message sync (messageHash=${messageHash.slice(0, 18)}...)...`,
      )
      while (Date.now() - startWait < maxWaitMs) {
        try {
          const messageBlock = await node.getL1ToL2MessageBlock(messageHashFr)
          messageSynced = messageBlock !== undefined
          if (messageSynced) {
            logger.info(
              `✅ L1→L2 message ready (block=${messageBlock}), proceeding to claim.`,
            )
            break
          }
          logger.info(
            `   L1→L2 message not yet synced. Waiting ${pollIntervalMs / 1000}s...`,
          )
        } catch (e) {
          logger.warn(`   Poll check failed, retrying: ${e}`)
        }
        await wait(pollIntervalMs)
      }
      if (!messageSynced) {
        const elapsedMin = (Date.now() - startWait) / 1000 / 60
        logger.warn(
          `⚠️ L1→L2 message sync timeout after ${elapsedMin.toFixed(1)} min; attempting claim anyway.`,
        )
      }
      const finalWaitMs = 120_000 // 2 minutes
      logger.info(`⏳ Final wait before claiming (${finalWaitMs / 1000}s)...`)
      await wait(finalWaitMs)
    } else {
      logger.info(
        `⚠️ No messageHash on claim; claiming immediately (polling skipped).`,
      )
    }

    // Claim tokens publicly on L2
    logger.info(`📥 Step 2: Claim tokens publicly on L2`)
    logger.info(`📋 Claim parameters:`)
    logger.info(`  - 👤 ownerAztecAddress: ${ownerAztecAddress}`)
    logger.info(`  - 💰 MINT_AMOUNT: ${MINT_AMOUNT}`)
    logger.info(`  - 🔐 claimSecret: ${claim.claimSecret}`)
    logger.info(`  - 📍 messageLeafIndex: ${claim.messageLeafIndex}`)

    await l2BridgeContract.methods
      .claim_public(
        ownerAztecAddress,
        MINT_AMOUNT,
        claim.claimSecret,
        claim.messageLeafIndex,
      )
      .send({
        from: ownerAztecAddress,
        fee: { paymentMethod: sponsoredPaymentMethod },
        wait: { timeout: getTimeouts().txTimeout },
      })
    const balance = await l2TokenContract.methods
      .balance_of_public(ownerAztecAddress)
      .simulate({ from: ownerAztecAddress })
    logger.info(`💰 Public L2 balance of ${ownerAztecAddress} is ${balance}`)

    logger.info('💸 Withdrawing funds from L2')
    const withdrawAmount = 9n
    const nonce = Fr.random()

    // Give approval to bridge to burn owner's funds:
    const authwit = await SetPublicAuthwitContractInteraction.create(
      wallet,
      ownerAztecAddress,
      {
        caller: l2BridgeContract.address,
        action: l2TokenContract.methods.burn_public(
          ownerAztecAddress,
          withdrawAmount,
          nonce,
        ),
      },
      true,
    )
    await authwit.send({
      fee: { paymentMethod: sponsoredPaymentMethod as any },
      wait: { timeout: getTimeouts().txTimeout },
    })

    const selectorBuf = Buffer.from(
      toFunctionSelector('withdraw(address,uint256,address)').slice(2),
      'hex',
    )
    const recipient = EthAddress.fromString(ownerEthAddress)
    const callerOnL1 = EthAddress.ZERO
    const content = sha256ToField([
      selectorBuf,
      recipient.toBuffer32(),
      new Fr(withdrawAmount).toBuffer(),
      callerOnL1.toBuffer32(),
    ])
    const msgLeaf = computeL2ToL1MessageHash({
      l2Sender: l2BridgeContract.address,
      l1Recipient: EthAddress.fromString(firstToken.l1PortalContract),
      content,
      rollupVersion: new Fr(rollupVersion),
      chainId: new Fr(nodeInfo.l1ChainId),
    })

    // Log current L2 block BEFORE network call so we have a starting point if tx fails or script exits before receipt
    let l2BlockNumberBeforeTx: number | undefined
    try {
      l2BlockNumberBeforeTx = await node.getBlockNumber()
      logger.info(
        `[L2→L1] Current L2 block before tx: ${l2BlockNumberBeforeTx}`,
      )
    } catch (e) {
      logger.warn(
        `[L2→L1] Could not get current L2 block number before tx: ${e}`,
      )
    }

    const l2TxReceipt = await l2BridgeContract.methods
      .exit_to_l1_public(
        EthAddress.fromString(ownerEthAddress),
        withdrawAmount,
        EthAddress.ZERO,
        nonce,
      )
      .send({
        from: ownerAztecAddress,
        fee: { paymentMethod: sponsoredPaymentMethod },
        wait: { timeout: getTimeouts().txTimeout, returnReceipt: true },
      })

    const newL2Balance = await l2TokenContract.methods
      .balance_of_public(ownerAztecAddress)
      .simulate({ from: ownerAztecAddress })
    logger.info(`💰 New L2 balance of ${ownerAztecAddress} is ${newL2Balance}`)

    const finalWaitMs = 120_000 // 2 minutes
    logger.info(`⏳ Final wait before proof (${finalWaitMs / 1000}s)...`)
    await wait(finalWaitMs)

    const blockNumber = l2TxReceipt.blockNumber! // L2 block where the L2→L1 message was emitted

    // Poll L1 Rollup for proven block (same pattern as frontend), then fallback to fixed wait if needed
    const rollupAddress =
      l1ContractAddresses?.rollupAddress != null
        ? l1ContractAddresses.rollupAddress.toString()
        : undefined
    const pollIntervalMs = 120_000 // 2 minutes
    const maxWaitMs = 50 * 60 * 1000 // 50 min max
    const startWait = Date.now()
    let blockProven = false
    let usedPoll = false
    if (rollupAddress) {
      try {
        logger.info(
          `⏳ Polling L1 Rollup for proven block (blockNumber=${blockNumber})...`,
        )
        usedPoll = true
        while (Date.now() - startWait < maxWaitMs) {
          const proven = await l1Client.readContract({
            address: rollupAddress as `0x${string}`,
            abi: RollupAbi,
            functionName: 'getProvenCheckpointNumber',
          })
          const provenBlock =
            typeof proven === 'bigint' ? Number(proven) : proven
          if (provenBlock >= blockNumber) {
            logger.info(
              `✅ L2 block ${blockNumber} is proven on L1 (proven=${provenBlock}), proceeding.`,
            )
            blockProven = true
            break
          }
          logger.info(
            `   L2 block not yet proven (proven=${provenBlock}, need ${blockNumber}). Waiting ${pollIntervalMs / 1000}s...`,
          )
          await wait(pollIntervalMs)
        }
        if (!blockProven) {
          logger.warn(
            `⚠️ Max wait reached; proceeding with L1 withdraw (may revert if block not proven).`,
          )
        }
      } catch (e) {
        logger.warn(`⚠️ L1 Rollup poll failed, using fixed 40 min wait: ${e}`)
        usedPoll = false
      }
    }
    if (!blockProven && !usedPoll) {
      logger.info(
        '⏳ Waiting 40 minutes for L2→L1 message to be processable on L1...',
      )
      await wait(40 * 60 * 1000)
    }
    // Convert block number → checkpoint → epoch
    const rollup = new RollupContract(l1Client, rollupAddress as any)
    const epoch = await rollup.getEpochNumberForCheckpoint(
      CheckpointNumber.fromBlockNumber(blockNumber),
    )
    logger.info(`📦 Block ${blockNumber} → Epoch ${epoch}`)

    const witness = await computeL2ToL1MembershipWitness(node, epoch, msgLeaf)
    if (!witness) {
      throw new Error(
        `L2→L1 message not found in epoch ${epoch} (block ${blockNumber})`,
      )
    }
    const siblingPathHex = witness!.siblingPath
      .toBufferArray()
      .map((buf: Buffer) => `0x${buf.toString('hex')}` as `0x${string}`)
    // Withdraw on L1 (same pattern as Aztec NFT example: direct contract call with siblingPathHex)
    const l1Portal = getContract({
      address: firstToken.l1PortalContract as `0x${string}`,
      abi: TokenPortalAbi,
      client: l1Client as any,
    }) as any
    const withdrawTx = await l1Portal.write.withdraw([
      ownerEthAddress,
      withdrawAmount,
      false,
      BigInt(epoch),
      BigInt(witness!.leafIndex),
      siblingPathHex,
    ])
    await l1Client.waitForTransactionReceipt({
      hash: withdrawTx,
      timeout: getTimeouts().txTimeout,
    })
    const newL1Balance = await l1TokenManager.getL1TokenBalance(ownerEthAddress)
    logger.info(`💰 New L1 balance of ${ownerEthAddress} is ${newL1Balance}`)
  } else {
    logger.warn(
      '⚠️  No tokens were deployed successfully. Skipping bridge test.',
    )
  }
}

main()