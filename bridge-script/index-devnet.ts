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
  L1FeeJuicePortalManager,
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
// @ts-ignore
import PoolSeederJson from '../l1-contracts/out/SeedUniswapPools.s.sol/PoolSeeder.json'
// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
import { registerBridgedContract, BridgedMintAndPayFeePaymentMethod, BridgedFPCContract } from '@defi-wonderland/aztec-fee-payment'

// Fix the bytecode format
const TestERC20Abi = TestERC20Json.abi
const TestERC20Bytecode = TestERC20Json.bytecode.object as `0x${string}`
const CustomTokenPortalAbi = CustomTokenPortalJson.abi
const CustomTokenPortalBytecode = CustomTokenPortalJson.bytecode.object as `0x${string}`
const UniswapFuelSwapAbi = UniswapFuelSwapJson.abi
const UniswapFuelSwapBytecode = UniswapFuelSwapJson.bytecode.object as `0x${string}`
const SwapBridgeRouterAbi = SwapBridgeRouterJson.abi
const SwapBridgeRouterBytecode = SwapBridgeRouterJson.bytecode.object as `0x${string}`
const PoolSeederAbi = PoolSeederJson.abi
const PoolSeederBytecode = PoolSeederJson.bytecode.object as `0x${string}`

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
  loadActiveDeployment,
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

// Force redeployment flags (set via env vars)
// FORCE_REDEPLOY_TOKENS=true  — redeploy all tokens even if they exist
// FORCE_REDEPLOY_SWAPS=true   — redeploy fuel swap infra even if it exists
const FORCE_REDEPLOY_TOKENS = process.env.FORCE_REDEPLOY_TOKENS === 'true'
const FORCE_REDEPLOY_SWAPS = process.env.FORCE_REDEPLOY_SWAPS === 'true'

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
    CustomTokenPortalAbi,
    CustomTokenPortalBytecode,
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
    abi: CustomTokenPortalAbi,
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

// ── Sepolia constants for pool seeding ──────────────────────────────
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
const FEE_ASSET_HANDLER = '0xED9c5557d2E0abCc7c7FCA958eE4292199413494' as `0x${string}`
const AZTEC_TOKEN = '0x35d0186d1FD53b72996475D965C5Ed171D52b986' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// Pool seed amounts:
//   Pool 1 (ETH/FeeJuice): 0.05 ETH + 15,000 FeeJuice (minted)
//   Pool 2 (USDC/WETH):    500 USDC (minted) + 0.15 WETH (wrapped from ETH)
//   Deployer wallet needs: ~0.2 ETH for seeding + gas ≈ 0.5 ETH minimum on Sepolia
//
//   Note: Liquidity CANNOT be withdrawn — PoolSeeder is a one-shot helper with no
//   remove-liquidity function. V4 withdrawal requires a PositionManager, which we don't use.
//   Keep seed amounts small on testnet.

// ETH/AZTEC pool params (~10,000 FeeJuice per ETH)
const ETH_AZTEC_SQRT_PRICE = 7922816251426433759354395033600n
const ETH_AZTEC_TICK_LOWER = 69060
const ETH_AZTEC_TICK_UPPER = 115140
const ETH_AZTEC_FEE = 3000
const ETH_AZTEC_TICK_SPACING = 60
const ETH_AZTEC_LIQUIDITY = 10n ** 18n
const ETH_SEED = 50000000000000000n // 0.05 ETH
const FEE_MINT_COUNT = 15 // 15 x 1000 FJ = 15k FJ

// ERC20/WETH pool params (~2,100 USDC per WETH)
const ERC20_WETH_SQRT_PRICE = 1728916962386276374966316084832192n
const ERC20_WETH_TICK_LOWER = 169800
const ERC20_WETH_TICK_UPPER = 229800
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60
const ERC20_WETH_LIQUIDITY = 6000000000000n // 6e12 (scaled down for 500 USDC + 0.15 WETH seed)
const WETH_SEED = 150000000000000000n // 0.15 ETH

// Minimal ERC20 ABI for pool seeding interactions
const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const

const WETH_ABI = [
  { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' },
] as const

const FEE_HANDLER_ABI = [
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
] as const

/** Helper: send a tx and wait for receipt */
async function sendAndWait(
  l1Client: ExtendedViemWalletClient,
  txHash: `0x${string}`,
  label: string,
  logger: Logger,
) {
  const receipt = await l1Client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status === 'reverted') throw new Error(`${label} reverted (tx: ${txHash})`)
  logger.info(`  ${label} confirmed (tx: ${txHash.slice(0, 10)}...)`)
  return receipt
}

/** Sort two addresses for V4 pool key (currency0 < currency1) */
function sortCurrencies(a: `0x${string}`, b: `0x${string}`): [`0x${string}`, `0x${string}`] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

/**
 * Log PoolManager balances and deployer wallet balance.
 */
async function logPoolBalances(l1Client: ExtendedViemWalletClient, deployedContracts: DeployedToken[], label: string, logger: Logger) {
  const l1Public = createPublicClient({ transport: http(L1_URL) })
  const deployer = l1Client.account.address

  logger.info(`\n--- Pool & Wallet Balances (${label}) ---`)

  // Deployer ETH balance
  const ethBalance = await l1Public.getBalance({ address: deployer })
  logger.info(`  Deployer ETH:       ${(Number(ethBalance) / 1e18).toFixed(4)} ETH`)

  // PoolManager ETH balance
  const pmEthBalance = await l1Public.getBalance({ address: POOL_MANAGER })
  logger.info(`  PoolManager ETH:    ${(Number(pmEthBalance) / 1e18).toFixed(4)} ETH`)

  // PoolManager FeeJuice balance
  const aztecToken = getContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmFjBalance = await aztecToken.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager FJ:     ${(Number(pmFjBalance) / 1e18).toFixed(2)} FeeJuice`)

  // PoolManager WETH balance
  const weth = getContract({ address: WETH_ADDRESS, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmWethBalance = await weth.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager WETH:   ${(Number(pmWethBalance) / 1e18).toFixed(4)} WETH`)

  // Each token balance in PoolManager
  for (const token of deployedContracts) {
    const tokenAddr = token.l1TokenContract as `0x${string}`
    if (tokenAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) continue
    try {
      const erc20 = getContract({ address: tokenAddr, abi: ERC20_ABI, client: l1Public as any }) as any
      const decimals = await erc20.read.decimals() as number
      const balance = await erc20.read.balanceOf([POOL_MANAGER]) as bigint
      const humanBalance = Number(balance) / (10 ** Number(decimals))
      logger.info(`  PoolManager ${token.symbol.padEnd(6)}: ${humanBalance.toFixed(2)} ${balance > 0n ? '✅' : '❌'}`)
    } catch {
      logger.info(`  PoolManager ${token.symbol.padEnd(6)}: (failed to read)`)
    }
  }
}

/**
 * Seed Uniswap V4 liquidity pools for all deployed tokens using viem.
 *
 * - Seeds the ETH/AZTEC (FeeJuice) pool once
 * - Seeds an ERC20/WETH pool for each non-WETH token
 * - WETH is skipped (it swaps directly through the ETH/AZTEC pool)
 */
async function seedAllTokenPools(
  deployedContracts: DeployedToken[],
  l1Client: ExtendedViemWalletClient,
  logger: Logger,
) {
  logger.info('\n=== Seeding Uniswap V4 Pools (via viem) ===')

  const deployer = l1Client.account.address

  // ── 1. Seed ETH/AZTEC pool ───────────────────────────────────────
  try {
    logger.info('\n--- ETH/AZTEC pool ---')

    // Deploy PoolSeeder
    const deployHash = await l1Client.deployContract({
      abi: PoolSeederAbi,
      bytecode: PoolSeederBytecode,
      args: [POOL_MANAGER],
    })
    const deployReceipt = await l1Client.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 })
    const seederAddr = deployReceipt.contractAddress as `0x${string}`
    logger.info(`  PoolSeeder deployed at ${seederAddr}`)

    const seeder = getContract({ address: seederAddr, abi: PoolSeederAbi, client: l1Client as any }) as any
    const feeHandler = getContract({ address: FEE_ASSET_HANDLER, abi: FEE_HANDLER_ABI, client: l1Client as any }) as any
    const aztecToken = getContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, client: l1Client as any }) as any

    // Mint FeeJuice to seeder (100 x 1000 FJ)
    logger.info(`  Minting FeeJuice: ${FEE_MINT_COUNT} x 1000 FJ`)
    for (let i = 0; i < FEE_MINT_COUNT; i++) {
      const tx = await feeHandler.write.mint([seederAddr])
      await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
      logger.info(`  ... minted ${i + 1}/${FEE_MINT_COUNT}`)
    }

    // Transfer any deployer FJ to seeder
    const deployerFj = await aztecToken.read.balanceOf([deployer]) as bigint
    if (deployerFj > 0n) {
      const tx = await aztecToken.write.transfer([seederAddr, deployerFj])
      await sendAndWait(l1Client, tx, `Transferred ${deployerFj} FJ to seeder`, logger)
    }

    // Seed pool
    const [c0, c1] = sortCurrencies(ZERO_ADDRESS, AZTEC_TOKEN)
    const poolKey = { currency0: c0, currency1: c1, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS }
    const tx = await seeder.write.setup(
      [poolKey, ETH_AZTEC_SQRT_PRICE, ETH_AZTEC_TICK_LOWER, ETH_AZTEC_TICK_UPPER, ETH_AZTEC_LIQUIDITY],
      { value: ETH_SEED },
    )
    await sendAndWait(l1Client, tx, 'ETH/AZTEC pool seeded', logger)

    // Sweep leftovers
    await sendAndWait(l1Client, await seeder.write.sweep([ZERO_ADDRESS]), 'Swept ETH', logger)
    await sendAndWait(l1Client, await seeder.write.sweep([AZTEC_TOKEN]), 'Swept AZTEC', logger)

    logger.info('✅ ETH/AZTEC pool done')
  } catch (error) {
    logger.error(`Failed to seed ETH/AZTEC pool: ${error}`)
  }

  // ── 2. Seed ERC20/WETH pool for each non-WETH token ─────────────
  const erc20Tokens = deployedContracts.filter(
    (t) => t.l1TokenContract.toLowerCase() !== WETH_ADDRESS.toLowerCase(),
  )

  for (let i = 0; i < erc20Tokens.length; i++) {
    const token = erc20Tokens[i]
    const tokenAddr = token.l1TokenContract as `0x${string}`
    try {
      logger.info(`\n--- [${i + 1}/${erc20Tokens.length}] ${token.symbol}/WETH pool ---`)

      // Deploy a fresh PoolSeeder for this token
      const deployHash = await l1Client.deployContract({
        abi: PoolSeederAbi,
        bytecode: PoolSeederBytecode,
        args: [POOL_MANAGER],
      })
      const deployReceipt = await l1Client.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 })
      const seederAddr = deployReceipt.contractAddress as `0x${string}`
      logger.info(`  PoolSeeder deployed at ${seederAddr}`)

      const seeder = getContract({ address: seederAddr, abi: PoolSeederAbi, client: l1Client as any }) as any
      const erc20 = getContract({ address: tokenAddr, abi: ERC20_ABI, client: l1Client as any }) as any
      const weth = getContract({ address: WETH_ADDRESS, abi: [...ERC20_ABI, ...WETH_ABI], client: l1Client as any }) as any

      // Read token decimals
      const decimals = await erc20.read.decimals() as number
      const erc20Amount = BigInt(500) * (10n ** BigInt(decimals))

      // Mint ERC20 tokens to deployer
      const mintTx = await erc20.write.mint([deployer, erc20Amount])
      await sendAndWait(l1Client, mintTx, `Minted ${erc20Amount} ${token.symbol}`, logger)

      // Wrap ETH -> WETH
      const wrapTx = await weth.write.deposit([], { value: WETH_SEED })
      await sendAndWait(l1Client, wrapTx, `Wrapped ${WETH_SEED} wei to WETH`, logger)

      // Transfer ERC20 + WETH to seeder
      const txErc20 = await erc20.write.transfer([seederAddr, erc20Amount])
      await sendAndWait(l1Client, txErc20, `Transferred ${token.symbol} to seeder`, logger)

      const txWeth = await weth.write.transfer([seederAddr, WETH_SEED])
      await sendAndWait(l1Client, txWeth, 'Transferred WETH to seeder', logger)

      // Seed pool
      const [c0, c1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
      const poolKey = { currency0: c0, currency1: c1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS }
      const seedTx = await seeder.write.setup(
        [poolKey, ERC20_WETH_SQRT_PRICE, ERC20_WETH_TICK_LOWER, ERC20_WETH_TICK_UPPER, ERC20_WETH_LIQUIDITY],
      )
      await sendAndWait(l1Client, seedTx, `${token.symbol}/WETH pool seeded`, logger)

      // Sweep leftovers
      await sendAndWait(l1Client, await seeder.write.sweep([tokenAddr]), `Swept ${token.symbol}`, logger)
      await sendAndWait(l1Client, await seeder.write.sweep([WETH_ADDRESS]), 'Swept WETH', logger)

      logger.info(`✅ ${token.symbol}/WETH pool done`)
    } catch (error) {
      logger.error(`Failed to seed ${token.symbol}/WETH pool: ${error}`)
      // Continue with other tokens
    }
  }

  logger.info(`\n✅ Pool seeding complete — ${erc20Tokens.length} ERC20/WETH pools + 1 ETH/AZTEC pool`)
}

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
    if (existingToken && !tokenConfig.forceDeploy && !FORCE_REDEPLOY_TOKENS) {
      logger.info(`⏭️  ${tokenConfig.symbol} already deployed, skipping...`)
      deployedContracts.push(existingToken)
      continue
    }
    if (existingToken && (tokenConfig.forceDeploy || FORCE_REDEPLOY_TOKENS)) {
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
  // Skip if already deployed (addresses exist in deployment file)
  const existingDeployment = loadActiveDeployment()
  const fuelSwapAlreadyDeployed = existingDeployment?.uniswapFuelSwapAddress
    && existingDeployment?.swapBridgeRouterAddress
    && existingDeployment?.bridgedFpcAddress

  if (fuelSwapAlreadyDeployed && !FORCE_REDEPLOY_SWAPS) {
    logger.info('\n=== Fuel Swap Infrastructure ===')
    logger.info(`⏭️  Already deployed, skipping...`)
    logger.info(`   UniswapFuelSwap: ${existingDeployment.uniswapFuelSwapAddress}`)
    logger.info(`   SwapBridgeRouter: ${existingDeployment.swapBridgeRouterAddress}`)
    logger.info(`   BridgedFPC: ${existingDeployment.bridgedFpcAddress}`)
  } else {
    try {
      logger.info('\n=== Deploying Fuel Swap Infrastructure ===')

      // Known Sepolia constants
      const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
      const V4_POOL_MANAGER = POOL_MANAGER

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
  }

  // Check balances BEFORE seeding
  await logPoolBalances(l1Client, deployedContracts, 'BEFORE pool seeding', logger)

  // Seed Uniswap V4 pools for ALL deployed tokens so the fuel swap quoter works
  await seedAllTokenPools(deployedContracts, l1Client, logger)

  // Check balances AFTER seeding
  await logPoolBalances(l1Client, deployedContracts, 'AFTER pool seeding', logger)

  // Set SwapBridgeRouter as trusted forwarder on all token portals
  const deployment = loadActiveDeployment()
  const swapRouterAddr = deployment?.swapBridgeRouterAddress as `0x${string}` | undefined
  if (swapRouterAddr && deployedContracts.length > 0) {
    logger.info('\n=== Setting Trusted Forwarders on All Portals ===')
    for (const token of deployedContracts) {
      const portalAddr = token.l1PortalContract as `0x${string}`
      try {
        const portal = getContract({ address: portalAddr, abi: CustomTokenPortalAbi, client: l1Client as any }) as any
        const tx = await portal.write.setTrustedForwarder([swapRouterAddr, true])
        await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        logger.info(`✅ ${token.symbol} portal (${portalAddr.slice(0, 10)}...) — SwapBridgeRouter set as trusted forwarder`)
      } catch (error: any) {
        // If already set or caller is already owner, log and continue
        if (error?.message?.includes('already') || error?.message?.includes('execution reverted')) {
          logger.warn(`⚠️  ${token.symbol} portal — forwarder may already be set, skipping: ${error.message?.slice(0, 80)}`)
        } else {
          logger.error(`❌ ${token.symbol} portal — failed to set forwarder: ${error}`)
        }
      }
    }
    logger.info('✅ Trusted forwarder setup complete')
  } else {
    logger.warn('⚠️  Skipping trusted forwarder setup — no SwapBridgeRouter address or no deployed tokens')
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
      abi: CustomTokenPortalAbi,
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

    // ── Test BridgedFPC ("top-up") fee payment ───────────────────────
    // Instead of sponsored fees, this bridges FeeJuice from L1→L2 and uses
    // BridgedMintAndPayFeePaymentMethod to pay gas from the bridged amount.
    logger.info('\n🧪 Testing BridgedFPC (top-up) fee payment...')

    const finalDeployment = loadActiveDeployment()
    const bridgedFpcAddress = finalDeployment?.bridgedFpcAddress
    if (!bridgedFpcAddress) {
      logger.warn('⚠️  No BridgedFPC address found in deployment. Skipping BridgedFPC test.')
    } else {
      try {
        // 1. Bridge FeeJuice from L1 → L2 for the BridgedFPC
        logger.info('📤 Step 1: Bridge FeeJuice from L1 → L2')
        const feeJuicePortalManager = await L1FeeJuicePortalManager.new(node, l1Client, logger)
        const FEE_JUICE_AMOUNT = BigInt(1e18) // 1 FeeJuice (enough for several txs)
        const feeJuiceClaim = await feeJuicePortalManager.bridgeTokensPublic(
          ownerAztecAddress,
          FEE_JUICE_AMOUNT,
          true, // mint on testnet
        )
        logger.info(`✅ FeeJuice bridged (amount=${FEE_JUICE_AMOUNT}, leafIndex=${feeJuiceClaim.messageLeafIndex})`)

        // 2. Wait for the L1→L2 FeeJuice message to sync
        const fjMessageHash = feeJuiceClaim.messageHash
        if (fjMessageHash) {
          const fjPollInterval = 120_000
          const fjMaxWait = 20 * 60 * 1000
          const fjStart = Date.now()
          let fjSynced = false
          const fjMessageHashFr = Fr.fromString(fjMessageHash)
          logger.info(`⏳ Polling for FeeJuice L1→L2 message sync (hash=${fjMessageHash.slice(0, 18)}...)...`)
          while (Date.now() - fjStart < fjMaxWait) {
            try {
              const msgBlock = await node.getL1ToL2MessageBlock(fjMessageHashFr)
              fjSynced = msgBlock !== undefined
              if (fjSynced) {
                logger.info(`✅ FeeJuice message ready (block=${msgBlock})`)
                break
              }
              logger.info(`   FeeJuice message not yet synced. Waiting ${fjPollInterval / 1000}s...`)
            } catch (e) {
              logger.warn(`   Poll check failed: ${e}`)
            }
            await wait(fjPollInterval)
          }
          if (!fjSynced) {
            logger.warn('⚠️ FeeJuice message sync timeout; attempting claim anyway.')
          }
          await wait(120_000) // Final buffer for message availability
        }

        // 3. Create BridgedMintAndPayFeePaymentMethod
        const bridgedFpcAztecAddr = AztecAddress.fromString(bridgedFpcAddress)

        // Register BridgedFPC contract instance with the wallet so it can be used
        const bridgedFpcInstance = await registerBridgedContract(wallet)
        logger.info(`✅ BridgedFPC registered at ${bridgedFpcInstance.address.toString()}`)

        const bridgedSalt = Fr.random()
        const bridgedFeeMethod = new BridgedMintAndPayFeePaymentMethod(
          bridgedFpcAztecAddr,
          feeJuiceClaim.claimAmount,
          feeJuiceClaim.claimSecret,
          bridgedSalt,
          new Fr(feeJuiceClaim.messageLeafIndex),
        )
        logger.info('✅ BridgedMintAndPayFeePaymentMethod created')

        // 4. Test: bridge tokens using BridgedFPC fees (top-up gas)
        logger.info('🌉 Bridge tokens using BridgedFPC (top-up) fees')
        const topUpBridgeAmount = BigInt(1e14) // small test amount
        const topUpClaim = await l1PortalManager.bridgeTokensPublic(
          ownerAztecAddress,
          topUpBridgeAmount,
          true,
        )
        logger.info(`✅ L1 bridge tx done (amount=${topUpBridgeAmount})`)

        // Wait for this token bridge message too
        const topUpMsgHash = (topUpClaim as { messageHash?: string }).messageHash ?? (topUpClaim as { key?: string }).key
        if (topUpMsgHash) {
          const topUpMsgFr = Fr.fromString(topUpMsgHash)
          logger.info(`⏳ Polling for token bridge message sync...`)
          const topUpStart = Date.now()
          while (Date.now() - topUpStart < 20 * 60 * 1000) {
            try {
              const msgBlock = await node.getL1ToL2MessageBlock(topUpMsgFr)
              if (msgBlock !== undefined) {
                logger.info(`✅ Token bridge message ready (block=${msgBlock})`)
                break
              }
              logger.info(`   Token message not yet synced. Waiting 120s...`)
            } catch (e) {
              logger.warn(`   Poll check failed: ${e}`)
            }
            await wait(120_000)
          }
          await wait(120_000)
        }

        // Claim tokens on L2 using BridgedFPC fee payment
        logger.info('📥 Claiming tokens on L2 with BridgedFPC fees...')
        await l2BridgeContract.methods
          .claim_public(
            ownerAztecAddress,
            topUpBridgeAmount,
            topUpClaim.claimSecret,
            topUpClaim.messageLeafIndex,
          )
          .send({
            from: ownerAztecAddress,
            fee: { paymentMethod: bridgedFeeMethod },
            wait: { timeout: getTimeouts().txTimeout },
          })

        const topUpBalance = await l2TokenContract.methods
          .balance_of_public(ownerAztecAddress)
          .simulate({ from: ownerAztecAddress })
        logger.info(`💰 L2 balance after BridgedFPC claim: ${topUpBalance}`)
        logger.info('✅ BridgedFPC (top-up) fee payment test PASSED')
      } catch (error) {
        logger.error(`❌ BridgedFPC fee payment test failed: ${error}`)
      }
    }
  } else {
    logger.warn(
      '⚠️  No tokens were deployed successfully. Skipping bridge test.',
    )
  }
}

main()