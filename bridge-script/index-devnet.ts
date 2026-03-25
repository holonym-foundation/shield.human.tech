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
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon'
import { computeSecretHash } from '@aztec/aztec.js/crypto'
import { Gas, GasFees } from '@aztec/stdlib/gas'
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
import {
  registerBridgedContract,
  BridgedMintAndPayFeePaymentMethod,
  REASONABLE_GAS_LIMITS,
  maxFeesPerGasFromBaseFees,
  maxGasCostFor,
} from '@defi-wonderland/aztec-fee-payment'

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

import { createPublicClient, encodeFunctionData, encodeAbiParameters, getContract, http, toFunctionSelector, keccak256, decodeEventLog } from 'viem'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Decode a fuel swap / bridge revert into a human-readable diagnostic.
 * Covers UniswapFuelSwap, SwapBridgeRouter, PoolManager, and ERC-20 errors.
 */
function decodeFuelSwapError(error: unknown): { summary: string; detail: string; fix?: string } {
  const msg = String(error)

  // ── UniswapFuelSwap contract errors ──
  if (msg.includes('partial fill') || msg.includes('insufficient liquidity')) {
    return {
      summary: 'Partial fill — pool liquidity insufficient for the exact input amount',
      detail: 'UniswapFuelSwap could not fill the entire swap. The V4 pool partially filled the order.',
      fix: 'Reduce fuelAmount or add more liquidity: FORCE_SEED=true SKIP_TO_FUEL_TESTS=true pn start-devnet',
    }
  }
  if (msg.includes('insufficient output')) {
    return {
      summary: 'Slippage protection triggered — swap output below minFuelOutput',
      detail: 'The swap produced less FeeJuice than the minFuelOutput threshold.',
      fix: 'Lower minFuelOutput or add more liquidity to reduce price impact.',
    }
  }
  if (msg.includes('non-positive output')) {
    return {
      summary: 'Swap produced zero output — pool may be empty or tick range exhausted',
      detail: 'UniswapFuelSwap got a non-positive output delta from the pool.',
      fix: 'Check pool liquidity and tick range. Re-seed pools with FORCE_SEED=true.',
    }
  }
  if (msg.includes('first hop input mismatch')) {
    return {
      summary: 'Route misconfiguration — first pool does not accept the input token',
      detail: 'The first PoolKey\'s currency doesn\'t match the bridgeToken being swapped.',
      fix: 'Check that the swap route (poolKeys + zeroForOnes) matches the token address.',
    }
  }
  if (msg.includes('last hop must output feeJuice')) {
    return {
      summary: 'Route misconfiguration — last pool does not output FeeJuice',
      detail: 'The final PoolKey\'s output currency is not the FeeJuice token.',
      fix: 'Ensure the swap route ends with a pool that outputs FeeJuice (AZTEC token).',
    }
  }
  if (msg.includes('native route requires WETH input')) {
    return {
      summary: 'Route misconfiguration — native ETH pool requires WETH as inputToken',
      detail: 'Single-hop native ETH pool expects inputToken to be WETH (auto-unwrapped).',
      fix: 'Set inputToken to WETH address for native ETH pool routes.',
    }
  }
  if (msg.includes('path/direction mismatch')) {
    return {
      summary: 'Route misconfiguration — path and zeroForOnes arrays have different lengths',
      detail: 'The poolKeys and zeroForOnes arrays must be the same length.',
      fix: 'Check the swap route construction — each pool needs a corresponding direction.',
    }
  }
  if (msg.includes('empty path')) {
    return {
      summary: 'Route misconfiguration — empty swap path provided',
      detail: 'At least one PoolKey is required for the swap route.',
      fix: 'Provide a valid swap route with at least one pool.',
    }
  }

  // ── SwapBridgeRouter contract errors ──
  if (msg.includes('invalid fuelAmount')) {
    return {
      summary: 'Invalid fuelAmount — must be > 0 and < totalAmount',
      detail: 'SwapBridgeRouter requires 0 < fuelAmount < totalAmount.',
      fix: 'Adjust fuelAmount to be between 1 and totalAmount - 1.',
    }
  }
  if (msg.includes('balance mismatch')) {
    return {
      summary: 'Balance mismatch — swap output doesn\'t match actual balance change',
      detail: 'SwapBridgeRouter defense-in-depth check failed: reported swap output differs from actual FeeJuice balance delta.',
      fix: 'This indicates a bug in UniswapFuelSwap. Check contract state.',
    }
  }
  if (msg.includes('zero tokenPortal')) {
    return {
      summary: 'Missing tokenPortal — address(0) passed as portal',
      detail: 'SwapBridgeRouter requires a non-zero tokenPortal address.',
      fix: 'Check deployment — the TokenPortal address may not be set.',
    }
  }

  // ── PoolManager / ERC-20 errors (by selector) ──
  if (msg.includes('0x5212cba1') || msg.includes('CurrencyNotSettled')) {
    return {
      summary: 'CurrencyNotSettled — V4 PoolManager settlement failed',
      detail: 'A currency was not fully settled within the PoolManager unlock context. This usually means the pool lacks liquidity for one or more hops in the route.',
      fix: 'Re-seed pools: SKIP_ETH_AZTEC=true FORCE_SEED=true SKIP_TO_FUEL_TESTS=true pn start-devnet',
    }
  }
  if (msg.includes('0xe450d38c')) {
    return {
      summary: 'ERC20InsufficientBalance — a token transfer exceeded available balance',
      detail: 'An ERC-20 transferFrom failed because the sender lacks sufficient tokens.',
      fix: 'Ensure the deployer has enough tokens. Check Permit2 approval and token minting.',
    }
  }

  // ── Permit2 errors ──
  if (msg.includes('InvalidSigner') || msg.includes('InvalidSignature')) {
    return {
      summary: 'Permit2 signature invalid — witness hash may not match on-chain expectation',
      detail: 'The Permit2 SignatureTransfer witness didn\'t verify. This means the signed data doesn\'t match what the contract reconstructed.',
      fix: 'Check that the witness fields (tokenPortal, amounts, recipients, secretHashes, routeHash, isPrivate) exactly match the bridgeWithFuel call.',
    }
  }

  // ── Fallback ──
  return {
    summary: `Unexpected error`,
    detail: msg.slice(0, 500),
  }
}

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
// SKIP_ETH_AZTEC=true         — skip ETH/AZTEC pool seeding
const FORCE_REDEPLOY_TOKENS = process.env.FORCE_REDEPLOY_TOKENS === 'true'
const FORCE_REDEPLOY_SWAPS = process.env.FORCE_REDEPLOY_SWAPS === 'true'
const SKIP_ETH_AZTEC = process.env.SKIP_ETH_AZTEC === 'true'
// const SKIP_TO_FUEL_TESTS = process.env.SKIP_TO_FUEL_TESTS === 'true'
const SKIP_TO_FUEL_TESTS = true

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
  const deployer = l1Client.account.address
  return await deployL1Contract(
    l1Client,
    CustomTokenPortalAbi,
    CustomTokenPortalBytecode,
    [
      deployer,        // initialOwner
      deployer,        // feeRecipient (deployer collects fees on devnet)
      0n,              // feeBasisPoints (0% — no fees on devnet)
      deployer,        // humanIdAttester (unused on devnet, but must be non-zero)
      0n,              // cleanHandsCircuitId
      deployer,        // passportSigner (unused on devnet, but must be non-zero)
    ],
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

// Pool seed amounts — minimized for devnet ETH budget (~0.07 ETH total):
//   Pool 1 (ETH/AZTEC): L=1e18 consumes 0.00684 ETH + 68.4 FJ. ETH_SEED=0.05 (excess swept).
//   Pool 2 (USDC/WETH): L=1e12 consumes 35.59 USDC + 0.017 WETH. WETH_SEED=0.02.
//   Pools are ALWAYS seeded (no skip logic). PoolSeeder.setup() is idempotent.

// ETH/AZTEC pool params (~10,000 FeeJuice per ETH)
const ETH_AZTEC_SQRT_PRICE = 7922816251426433759354395033600n
const ETH_AZTEC_TICK_LOWER = 69060
const ETH_AZTEC_TICK_UPPER = 115140
const ETH_AZTEC_FEE = 3000
const ETH_AZTEC_TICK_SPACING = 60
const ETH_AZTEC_LIQUIDITY = 1n * 10n ** 18n // 1e18 — consumes 0.00684 ETH + 68.4 FJ
const ETH_SEED = 50000000000000000n // 0.05 ETH (covers price drift on re-seed; excess swept back)
const FEE_MINT_COUNT = 1 // 1 x 1000 FJ (1e18 liquidity only needs 68.4 FJ; excess swept back)

// ERC20/WETH pool params (~2,100 USDC per WETH)
const ERC20_WETH_SQRT_PRICE = 1728916962386276374966316084832192n
const ERC20_WETH_TICK_LOWER = 169800
const ERC20_WETH_TICK_UPPER = 229800
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60
const ERC20_WETH_LIQUIDITY = 1000000000000n // 1e12 — consumes 35.59 USDC + 0.017 WETH
const WETH_SEED = 20000000000000000n // 0.02 ETH

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

// ── Permit2 + SwapBridgeRouter constants for fuel tests ────────────
const PERMIT2_CANONICAL = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`

const APPROVE_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

// Inline SwapBridgeRouter ABI (matches frontend/src/constants/abis/SwapBridgeRouterAbi.ts)
const SwapBridgeRouterAbiLocal = [
  {
    type: 'function', name: 'bridgeWithFuel', inputs: [{
      name: 'p', type: 'tuple', components: [
        { name: 'tokenPortal', type: 'address' },
        { name: 'bridgeToken', type: 'address' },
        { name: 'totalAmount', type: 'uint256' },
        { name: 'fuelAmount', type: 'uint256' },
        { name: 'aztecRecipient', type: 'bytes32' },
        { name: 'fuelRecipient', type: 'bytes32' },
        { name: 'tokenSecretHash', type: 'bytes32' },
        { name: 'fuelSecretHash', type: 'bytes32' },
        { name: 'minFuelOutput', type: 'uint256' },
        { name: 'path', type: 'tuple[]', components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ] },
        { name: 'zeroForOnes', type: 'bool[]' },
        { name: 'isPrivate', type: 'bool' },
        { name: 'cleanHands', type: 'tuple', components: [
          { name: 'nonce', type: 'uint256' },
          { name: 'actionId', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ] },
        { name: 'passport', type: 'tuple', components: [
          { name: 'maxAmount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'signature', type: 'bytes' },
        ] },
      ],
    }, {
      name: 'permit', type: 'tuple', components: [
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'signature', type: 'bytes' },
      ],
    }], outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'event', name: 'BridgeWithFuel', inputs: [
      { name: 'aztecRecipient', type: 'bytes32', indexed: true },
      { name: 'tokenKey', type: 'bytes32', indexed: false },
      { name: 'tokenIndex', type: 'uint256', indexed: false },
      { name: 'tokenAmount', type: 'uint256', indexed: false },
      { name: 'tokenSecretHash', type: 'bytes32', indexed: false },
      { name: 'fuelKey', type: 'bytes32', indexed: false },
      { name: 'fuelIndex', type: 'uint256', indexed: false },
      { name: 'fuelAmount', type: 'uint256', indexed: false },
      { name: 'fuelSecretHash', type: 'bytes32', indexed: false },
    ], anonymous: false,
  },
] as const

// Permit2 witness type definitions (matches frontend bridgeL1ToL2.ts)
const BRIDGE_WITNESS_TYPE = {
  BridgeWitness: [
    { name: 'tokenPortal', type: 'address' },
    { name: 'bridgeToken', type: 'address' },
    { name: 'totalAmount', type: 'uint256' },
    { name: 'fuelAmount', type: 'uint256' },
    { name: 'aztecRecipient', type: 'bytes32' },
    { name: 'fuelRecipient', type: 'bytes32' },
    { name: 'tokenSecretHash', type: 'bytes32' },
    { name: 'fuelSecretHash', type: 'bytes32' },
    { name: 'minFuelOutput', type: 'uint256' },
    { name: 'routeHash', type: 'bytes32' },
    { name: 'isPrivate', type: 'bool' },
  ],
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'BridgeWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const

/** Helper: sign Permit2 witness-bound transfer for SwapBridgeRouter */
async function signPermit2Witness(
  l1Client: ExtendedViemWalletClient,
  params: {
    tokenPortal: `0x${string}`
    bridgeToken: `0x${string}`
    totalAmount: bigint
    fuelAmount: bigint
    aztecRecipient: `0x${string}`
    fuelRecipient: `0x${string}`
    tokenSecretHash: `0x${string}`
    fuelSecretHash: `0x${string}`
    minFuelOutput: bigint
    poolKeys: { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` }[]
    zeroForOnes: boolean[]
    isPrivate: boolean
    swapBridgeRouter: `0x${string}`
    l1ChainId: number
  },
): Promise<{ nonce: bigint; deadline: bigint; signature: `0x${string}` }> {
  // Random unordered nonce
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = BigInt('0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join(''))

  // 30-minute deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)

  // Compute routeHash (keccak256 of poolKeys + zeroForOnes)
  const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
  const routeHash = params.poolKeys.length > 0
    ? keccak256(encodeAbiParameters(
      [
        { name: 'path', type: 'tuple[]', components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ] },
        { name: 'zeroForOnes', type: 'bool[]' },
      ],
      [params.poolKeys, params.zeroForOnes],
    ))
    : zeroBytes32

  const signature = await l1Client.signTypedData({
    domain: {
      name: 'Permit2',
      chainId: params.l1ChainId,
      verifyingContract: PERMIT2_CANONICAL,
    },
    types: BRIDGE_WITNESS_TYPE,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: params.bridgeToken, amount: params.totalAmount },
      spender: params.swapBridgeRouter,
      nonce,
      deadline,
      witness: {
        tokenPortal: params.tokenPortal,
        bridgeToken: params.bridgeToken,
        totalAmount: params.totalAmount,
        fuelAmount: params.fuelAmount,
        aztecRecipient: params.aztecRecipient,
        fuelRecipient: params.fuelRecipient,
        tokenSecretHash: params.tokenSecretHash,
        fuelSecretHash: params.fuelSecretHash,
        minFuelOutput: params.minFuelOutput,
        routeHash,
        isPrivate: params.isPrivate,
      },
    },
  })

  return { nonce, deadline, signature }
}

/** Helper: log L2 balances for fuel test diagnostics */
const FEE_JUICE_L2_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000005'

async function logFuelTestBalances(
  label: string,
  l2TokenContract: any,
  ownerAztecAddress: any,
  l1Client: ExtendedViemWalletClient,
  logger: Logger,
  wallet?: any,
) {
  logger.info(`\n--- Fuel Test Balances (${label}) ---`)
  // L2 token balance
  try {
    const l2TokenBal = await l2TokenContract.methods
      .balance_of_public(ownerAztecAddress)
      .simulate({ from: ownerAztecAddress })
    logger.info(`  L2 token balance: ${l2TokenBal}`)
  } catch (e) {
    logger.info(`  L2 token balance: (failed to read)`)
  }
  // L2 FeeJuice balance
  if (wallet) {
    try {
      const fjContract = await TokenContract.at(
        AztecAddress.fromString(FEE_JUICE_L2_ADDRESS),
        wallet,
      )
      const fjBal = await fjContract.methods
        .balance_of_public(ownerAztecAddress)
        .simulate({ from: ownerAztecAddress })
      logger.info(`  L2 FeeJuice:      ${(Number(fjBal) / 1e18).toFixed(6)} FJ`)
    } catch (e) {
      logger.info(`  L2 FeeJuice:      (failed to read)`)
    }
  }
  // L1 deployer ETH
  const ethBal = await l1Client.getBalance({ address: l1Client.account.address })
  logger.info(`  L1 deployer ETH:  ${(Number(ethBal) / 1e18).toFixed(4)} ETH`)
}

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

  // PoolManager ETH balance (shared across ALL V4 pools on Sepolia, not just ours)
  const pmEthBalance = await l1Public.getBalance({ address: POOL_MANAGER })
  logger.info(`  PoolManager ETH:    ${(Number(pmEthBalance) / 1e18).toFixed(4)} ETH (shared across all V4 pools)`)

  // PoolManager FeeJuice balance (our ETH/AZTEC pool)
  const aztecToken = getContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmFjBalance = await aztecToken.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager FJ:     ${(Number(pmFjBalance) / 1e18).toFixed(2)} FeeJuice ${pmFjBalance > 0n ? '✅' : '❌ (ETH/AZTEC pool not seeded)'}`)

  // PoolManager WETH balance (shared across all V4 pools that use WETH)
  const weth = getContract({ address: WETH_ADDRESS, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmWethBalance = await weth.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager WETH:   ${(Number(pmWethBalance) / 1e18).toFixed(4)} WETH (shared across all V4 pools)`)

  // Each ERC20 token balance in PoolManager (our token-specific pools)
  for (const token of deployedContracts) {
    const tokenAddr = token.l1TokenContract as `0x${string}`
    if (tokenAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) continue
    try {
      const erc20 = getContract({ address: tokenAddr, abi: ERC20_ABI, client: l1Public as any }) as any
      const decimals = await erc20.read.decimals() as number
      const balance = await erc20.read.balanceOf([POOL_MANAGER]) as bigint
      const humanBalance = Number(balance) / (10 ** Number(decimals))
      logger.info(`  PoolManager ${token.symbol.padEnd(6)}: ${humanBalance.toFixed(2)} ${balance > 0n ? '✅' : '❌ (pool not seeded)'}`)
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

  const erc20Tokens = deployedContracts.filter(
    (t) => t.l1TokenContract.toLowerCase() !== WETH_ADDRESS.toLowerCase(),
  )

  // ── 1. Seed ETH/AZTEC pool ───────────────────────────────────────
  // Always seed this pool — PoolManager FJ balance is shared across ALL V4 pools
  // on the network, so checking it is unreliable. PoolSeeder.setup() is idempotent
  // (initializes pool if new, adds liquidity if it already exists).
  if (SKIP_ETH_AZTEC) {
    logger.info('\n--- ETH/AZTEC pool — skipping (SKIP_ETH_AZTEC=true) ---')
  } else try {
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

    // Mint FeeJuice to seeder
    logger.info(`  Minting FeeJuice: ${FEE_MINT_COUNT} x 1000 FJ`)
    for (let i = 0; i < FEE_MINT_COUNT; i++) {
      const tx = await feeHandler.write.mint([seederAddr])
      await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
      if ((i + 1) % 10 === 0 || i === FEE_MINT_COUNT - 1) logger.info(`  ... minted ${i + 1}/${FEE_MINT_COUNT}`)
    }

    // Transfer any deployer FJ to seeder
    const deployerFj = await aztecToken.read.balanceOf([deployer]) as bigint
    if (deployerFj > 0n) {
      const tx = await aztecToken.write.transfer([seederAddr, deployerFj])
      await sendAndWait(l1Client, tx, `Transferred ${deployerFj} FJ to seeder`, logger)
    }

    // Seed pool — dry-run first via eth_call to catch errors without spending gas
    const [c0, c1] = sortCurrencies(ZERO_ADDRESS, AZTEC_TOKEN)
    const poolKey = { currency0: c0, currency1: c1, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS }
    const setupArgs = [poolKey, ETH_AZTEC_SQRT_PRICE, ETH_AZTEC_TICK_LOWER, ETH_AZTEC_TICK_UPPER, ETH_AZTEC_LIQUIDITY] as const
    try {
      await seeder.simulate.setup(setupArgs, { value: ETH_SEED })
      logger.info('  Dry-run passed — sending seed tx...')
    } catch (simError) {
      logger.error(`  ❌ Dry-run failed: ${simError}`)
      throw simError
    }
    const tx = await seeder.write.setup(setupArgs, { value: ETH_SEED })
    await sendAndWait(l1Client, tx, 'ETH/AZTEC pool seeded', logger)

    // Sweep leftovers
    await sendAndWait(l1Client, await seeder.write.sweep([ZERO_ADDRESS]), 'Swept ETH', logger)
    await sendAndWait(l1Client, await seeder.write.sweep([AZTEC_TOKEN]), 'Swept AZTEC', logger)

    logger.info('✅ ETH/AZTEC pool done')
  } catch (error) {
    const errMsg = String(error)
    if (errMsg.includes('0xe450d38c')) {
      logger.error('❌ ETH/AZTEC pool seeding failed: ERC20InsufficientBalance — not enough FeeJuice for the liquidity delta.')
      logger.error(`   Minted ${FEE_MINT_COUNT} x 1000 FJ but liquidity ${ETH_AZTEC_LIQUIDITY} needs more. Increase FEE_MINT_COUNT or reduce ETH_AZTEC_LIQUIDITY.`)
    } else {
      logger.error(`❌ ETH/AZTEC pool seeding failed: ${error}`)
    }
  }

  // ── 2. Seed ERC20/WETH pool for each non-WETH token ─────────────
  for (let i = 0; i < erc20Tokens.length; i++) {
    const token = erc20Tokens[i]
    const tokenAddr = token.l1TokenContract as `0x${string}`

    // Always seed — each deployment creates a fresh ERC20, so the pool is always new.
    // PoolSeeder.setup() is idempotent (initializes if new, adds liquidity if exists).
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
      const erc20Amount = BigInt(100) * (10n ** BigInt(decimals)) // 100 tokens — 1e12 liquidity needs ~36 USDC

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

      // Seed pool — dry-run first via eth_call to catch errors without spending gas
      const [c0, c1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
      const poolKey = { currency0: c0, currency1: c1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS }
      const setupArgs = [poolKey, ERC20_WETH_SQRT_PRICE, ERC20_WETH_TICK_LOWER, ERC20_WETH_TICK_UPPER, ERC20_WETH_LIQUIDITY] as const
      try {
        await seeder.simulate.setup(setupArgs)
        logger.info(`  Dry-run passed — sending seed tx...`)
      } catch (simError) {
        const simMsg = String(simError)
        if (simMsg.includes('0xe450d38c')) {
          logger.error(`  ❌ Dry-run failed: ERC20InsufficientBalance — seeder doesn't have enough tokens for liquidity delta ${ERC20_WETH_LIQUIDITY}.`)
          logger.error(`     Seeder has ${erc20Amount} ${token.symbol} + ${WETH_SEED} wei WETH. Increase ERC20 mint or reduce liquidity.`)
        } else {
          logger.error(`  ❌ Dry-run failed: ${simError}`)
        }
        throw simError
      }
      const seedTx = await seeder.write.setup(setupArgs)
      await sendAndWait(l1Client, seedTx, `${token.symbol}/WETH pool seeded`, logger)

      // Sweep leftovers
      await sendAndWait(l1Client, await seeder.write.sweep([tokenAddr]), `Swept ${token.symbol}`, logger)
      await sendAndWait(l1Client, await seeder.write.sweep([WETH_ADDRESS]), 'Swept WETH', logger)

      logger.info(`✅ ${token.symbol}/WETH pool done`)
    } catch (error) {
      const errMsg = String(error)
      if (errMsg.includes('0xe450d38c')) {
        logger.error(`❌ ${token.symbol}/WETH pool seeding failed: ERC20InsufficientBalance — seeder doesn't have enough tokens for liquidity delta ${ERC20_WETH_LIQUIDITY}.`)
        logger.error(`   Increase ERC20 mint amount or reduce ERC20_WETH_LIQUIDITY.`)
      } else {
        logger.error(`❌ ${token.symbol}/WETH pool seeding failed: ${error}`)
      }
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
    logger.info(`   Wonderland BridgedFPC: ${existingDeployment.bridgedFpcAddress}`)
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

      // 3. Register BridgedFPC (L2) — Wonderland's fee payment contract, no deploy tx needed
      logger.info('Registering Wonderland BridgedFPC contract...')
      const bridgedFpc = await registerBridgedContract(wallet)
      logger.info(`✅ Wonderland BridgedFPC registered at ${bridgedFpc.address.toString()}`)

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
    logger.info(`  SwapBridgeRouter: ${swapRouterAddr}`)
    logger.info(`  Portals to configure: ${deployedContracts.length}`)
    for (const token of deployedContracts) {
      const portalAddr = token.l1PortalContract as `0x${string}`
      try {
        logger.info(`\n  --- ${token.symbol} portal (${portalAddr}) ---`)
        const portal = getContract({ address: portalAddr, abi: CustomTokenPortalAbi, client: l1Client as any }) as any
        // Check if already set before sending a tx
        const alreadySet = await portal.read.trustedForwarders([swapRouterAddr]) as boolean
        logger.info(`    Current trustedForwarders[${swapRouterAddr.slice(0, 10)}...] = ${alreadySet}`)
        if (alreadySet) {
          logger.info(`    ✅ Already set — skipping`)
          continue
        }
        logger.info(`    Sending setTrustedForwarder(${swapRouterAddr.slice(0, 10)}..., true)...`)
        const tx = await portal.write.setTrustedForwarder([swapRouterAddr, true])
        await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        logger.info(`    ✅ Trusted forwarder set (tx: ${tx.slice(0, 10)}...)`)
      } catch (error: any) {
        logger.error(`    ❌ Failed to set forwarder: ${error}`)
      }
    }
    logger.info('\n✅ Trusted forwarder setup complete')
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

    if (SKIP_TO_FUEL_TESTS) {
      logger.info('⏭️  SKIP_TO_FUEL_TESTS=true — skipping bridge + withdrawal tests')
    } else {
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

    // Manual bridgeTokensPublic using CustomTokenPortalAbi (the SDK's L1TokenPortalManager
    // uses the upstream ABI which lacks the `fee` field in DepositToAztecPublic event)
    const [claimSecret, claimSecretHash] = await generateClaimSecret()
    const portalContract = getContract({ address: l1PortalContractAddress.toString() as `0x${string}`, abi: CustomTokenPortalAbi, client: l1Client as any }) as any
    const tokenContract = getContract({ address: l1TokenContract.toString() as `0x${string}`, abi: [...ERC20_ABI, ...APPROVE_ABI], client: l1Client as any }) as any

    // Mint tokens
    logger.info(`Minting ${MINT_AMOUNT} tokens for ${l1Client.account.address}`)
    const mintTx = await tokenContract.write.mint([l1Client.account.address, MINT_AMOUNT])
    await sendAndWait(l1Client, mintTx, 'Minted tokens', logger)

    // Approve portal
    logger.info(`Approving ${MINT_AMOUNT} tokens for TokenPortal (${l1PortalContractAddress})`)
    const approveTx = await tokenContract.write.approve([l1PortalContractAddress.toString(), MINT_AMOUNT])
    await sendAndWait(l1Client, approveTx, 'Approved portal', logger)

    // Call depositToAztecPublic (3 args — no attestation needed for public deposits)
    logger.info('Sending L1 tokens to L2 to be claimed publicly')
    const depositTx = await portalContract.write.depositToAztecPublic([
      ownerAztecAddress.toString() as `0x${string}`,
      MINT_AMOUNT,
      claimSecretHash.toString() as `0x${string}`,
    ])
    const depositReceipt = await sendAndWait(l1Client, depositTx, 'L1 deposit', logger)

    // Parse DepositToAztecPublic event from our custom portal
    let claimAmount = MINT_AMOUNT
    let messageKey: `0x${string}` = '0x0' as `0x${string}`
    let messageLeafIndex = 0n
    for (const log of depositReceipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: CustomTokenPortalAbi, data: log.data, topics: log.topics })
        if (decoded.eventName === 'DepositToAztecPublic') {
          const a = decoded.args as any
          claimAmount = a.amount as bigint
          messageKey = a.key as `0x${string}`
          messageLeafIndex = a.index as bigint
          logger.info(`  DepositToAztecPublic: amount=${claimAmount}, fee=${a.fee}, index=${messageLeafIndex}`)
          break
        }
      } catch { /* not our event */ }
    }
    const claim = { claimSecret, claimSecretHash, messageLeafIndex, messageHash: messageKey, claimAmount }

    // Poll for L1→L2 message sync (same pattern as frontend), then final wait before claim
    const messageHash = claim.messageHash
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
    logger.info(`  - 💰 claimAmount: ${claim.claimAmount} (after fee deduction)`)
    logger.info(`  - 🔐 claimSecret: ${claim.claimSecret}`)
    logger.info(`  - 📍 messageLeafIndex: ${claim.messageLeafIndex}`)

    await l2BridgeContract.methods
      .claim_public(
        ownerAztecAddress,
        claim.claimAmount,
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
    } // end SKIP_TO_FUEL_TESTS else block

    // ══════════════════════════════════════════════════════════════════
    // FUEL SWAP TESTS — both public and private fuel via SwapBridgeRouter
    // Uses the same flow as the frontend (Permit2 + bridgeWithFuel)
    // ══════════════════════════════════════════════════════════════════

    const finalDeployment = loadActiveDeployment()
    const swapRouterAddress = finalDeployment?.swapBridgeRouterAddress as `0x${string}` | undefined
    const bridgedFpcAddress = finalDeployment?.bridgedFpcAddress
    const tokenAddr = firstToken.l1TokenContract as `0x${string}`
    const portalAddr = firstToken.l1PortalContract as `0x${string}`
    const l1ChainId = nodeInfo.l1ChainId

    if (!swapRouterAddress) {
      logger.warn('⚠️  No SwapBridgeRouter address. Skipping fuel tests.')
    } else {
      // Build the swap route: token → WETH (pool 1) → ETH → FeeJuice (pool 2)
      // Use dynamic feeJuiceAddress from nodeInfo (same as frontend's FEE_JUICE_ADDRESS)
      const feeJuiceAddr = ((l1ContractAddresses as any).feeJuiceAddress?.toString() || AZTEC_TOKEN) as `0x${string}`
      const [c0Pool1, c1Pool1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
      const [c0Pool2, c1Pool2] = sortCurrencies(ZERO_ADDRESS, feeJuiceAddr)
      const poolKeys = [
        { currency0: c0Pool1, currency1: c1Pool1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS },
        { currency0: c0Pool2, currency1: c1Pool2, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS },
      ]
      // zeroForOne = true when we're selling currency0 (matches frontend's isZeroForOne)
      const zeroForOnes = [
        BigInt(tokenAddr) < BigInt(WETH_ADDRESS), // true if token is currency0 (selling token for WETH)
        BigInt(ZERO_ADDRESS) < BigInt(feeJuiceAddr), // true = selling ETH(0x0) for FeeJuice (always true)
      ]
      logger.info(`\n🔀 Swap route: ${firstToken.symbol} → WETH → FeeJuice`)
      logger.info(`   Pool 1: ${c0Pool1.slice(0, 10)}.../${c1Pool1.slice(0, 10)}... (zeroForOne=${zeroForOnes[0]})`)
      logger.info(`   Pool 2: ${c0Pool2.slice(0, 10)}.../${c1Pool2.slice(0, 10)}... (zeroForOne=${zeroForOnes[1]})`)

      // ── Pool health check — verify both pools have liquidity before spending gas ──
      {
        const l1Public = createPublicClient({ transport: http(L1_URL) })
        const tokenContract = getContract({ address: tokenAddr, abi: ERC20_ABI, client: l1Public as any }) as any
        const wethContract = getContract({ address: WETH_ADDRESS, abi: ERC20_ABI, client: l1Public as any }) as any
        const fjContract = getContract({ address: feeJuiceAddr, abi: ERC20_ABI, client: l1Public as any }) as any

        const pmToken = await tokenContract.read.balanceOf([POOL_MANAGER]) as bigint
        const pmWeth = await wethContract.read.balanceOf([POOL_MANAGER]) as bigint
        const pmFj = await fjContract.read.balanceOf([POOL_MANAGER]) as bigint
        const pmEth = await l1Public.getBalance({ address: POOL_MANAGER })

        logger.info(`\n🔍 Pool health check:`)
        logger.info(`   PoolManager ${firstToken.symbol}: ${pmToken} (raw)`)
        logger.info(`   PoolManager WETH:  ${(Number(pmWeth) / 1e18).toFixed(6)}`)
        logger.info(`   PoolManager FJ:    ${(Number(pmFj) / 1e18).toFixed(4)}`)
        logger.info(`   PoolManager ETH:   ${(Number(pmEth) / 1e18).toFixed(4)}`)

        const issues: string[] = []
        if (pmToken === 0n) issues.push(`${firstToken.symbol}/WETH pool has no ${firstToken.symbol} liquidity`)
        if (pmWeth === 0n) issues.push(`${firstToken.symbol}/WETH pool has no WETH liquidity`)
        if (pmFj === 0n && pmEth === 0n) issues.push('ETH/FeeJuice pool has no liquidity (both FJ and ETH are 0)')

        if (issues.length > 0) {
          logger.error('❌ Pool health check FAILED — fuel tests will fail:')
          for (const issue of issues) logger.error(`   - ${issue}`)
          logger.error('   Fix: run `SKIP_ETH_AZTEC=true FORCE_SEED=true pn seed-pools` to add liquidity.')
          logger.warn('⚠️  Continuing with fuel tests anyway (they will dry-run and fail safely)...')
        } else {
          logger.info('   ✅ All pools have liquidity')
        }
      }

      // Approve ERC20 → Permit2 (one-time, max approval)
      const erc20 = getContract({ address: tokenAddr, abi: [...ERC20_ABI, ...APPROVE_ABI], client: l1Client as any }) as any
      const currentAllowance = await erc20.read.allowance([l1Client.account.address, PERMIT2_CANONICAL]) as bigint
      if (currentAllowance < BigInt(1e30)) {
        const approveTx = await erc20.write.approve([PERMIT2_CANONICAL, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')])
        await sendAndWait(l1Client, approveTx, `Approved ${firstToken.symbol} for Permit2`, logger)
      } else {
        logger.info(`  Permit2 allowance already sufficient`)
      }

      // ── Test 1: Public fuel (FeeJuicePaymentMethodWithClaim) via SwapBridgeRouter ──
      logger.info('\n🧪 Testing public fuel via SwapBridgeRouter.bridgeWithFuel...')
      await logFuelTestBalances('BEFORE public fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
      try {
        const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')

        // Generate claim + fuel secrets
        const [pfClaimSecret, pfClaimSecretHash] = await generateClaimSecret()
        const pfFuelSecret = Fr.random()
        const pfFuelSecretHash = await computeSecretHash(pfFuelSecret)

        const pfTotalAmount = BigInt(1e5)  // 0.1 USDC total
        const pfFuelAmount = BigInt(2e4)   // 0.02 USDC swapped to FeeJuice (~0.095 FJ output)
        const pfMinFuelOutput = 0n // testnet — accept any output

        // Mint ERC20 for this test
        const mintTx = await erc20.write.mint([l1Client.account.address, pfTotalAmount])
        await sendAndWait(l1Client, mintTx, `Minted ${pfTotalAmount} ${firstToken.symbol} for public fuel test`, logger)

        // Sign Permit2 witness
        const pfPermit = await signPermit2Witness(l1Client, {
          tokenPortal: portalAddr,
          bridgeToken: tokenAddr,
          totalAmount: pfTotalAmount,
          fuelAmount: pfFuelAmount,
          aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
          fuelRecipient: ownerAztecAddress.toString() as `0x${string}`, // public fuel → user
          tokenSecretHash: pfClaimSecretHash.toString() as `0x${string}`,
          fuelSecretHash: pfFuelSecretHash.toString() as `0x${string}`,
          minFuelOutput: pfMinFuelOutput,
          poolKeys,
          zeroForOnes,
          isPrivate: false,
          swapBridgeRouter: swapRouterAddress,
          l1ChainId,
        })
        logger.info('✅ Permit2 witness signed')

        // Call SwapBridgeRouter.bridgeWithFuel — dry-run first to catch errors without spending ETH
        const router = getContract({ address: swapRouterAddress, abi: SwapBridgeRouterAbiLocal, client: l1Client as any }) as any
        const pfBridgeArgs = [
          {
            tokenPortal: portalAddr,
            bridgeToken: tokenAddr,
            totalAmount: pfTotalAmount,
            fuelAmount: pfFuelAmount,
            aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
            fuelRecipient: ownerAztecAddress.toString() as `0x${string}`,
            tokenSecretHash: pfClaimSecretHash.toString() as `0x${string}`,
            fuelSecretHash: pfFuelSecretHash.toString() as `0x${string}`,
            minFuelOutput: pfMinFuelOutput,
            path: poolKeys,
            zeroForOnes,
            isPrivate: false,
            cleanHands: { nonce: 0n, actionId: 0n, signature: '0x' as `0x${string}` },
            passport: { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` },
          },
          { nonce: pfPermit.nonce, deadline: pfPermit.deadline, signature: pfPermit.signature },
        ] as const
        try {
          await router.simulate.bridgeWithFuel(pfBridgeArgs, { account: l1Client.account })
          logger.info('✅ Dry-run passed — sending bridgeWithFuel tx...')
        } catch (simError) {
          const { summary, detail, fix } = decodeFuelSwapError(simError)
          logger.error(`❌ Dry-run failed (no ETH spent): ${summary}`)
          logger.error(`   ${detail}`)
          if (fix) logger.error(`   Fix: ${fix}`)
          throw simError
        }
        const bridgeTx = await router.write.bridgeWithFuel(pfBridgeArgs)
        const bridgeReceipt = await sendAndWait(l1Client, bridgeTx, 'SwapBridgeRouter.bridgeWithFuel (public fuel)', logger)

        // Parse BridgeWithFuel event
        let pfTokenKey: `0x${string}` = '0x0' as `0x${string}`, pfTokenIndex = 0n, pfTokenAmount = 0n
        let pfFuelKey: `0x${string}` = '0x0' as `0x${string}`, pfFuelIndex = 0n, pfFuelAmountReceived = 0n
        for (const log of bridgeReceipt.logs) {
          if (log.address.toLowerCase() !== swapRouterAddress.toLowerCase()) continue
          try {
            const decoded = decodeEventLog({ abi: SwapBridgeRouterAbiLocal, data: log.data, topics: log.topics })
            if (decoded.eventName === 'BridgeWithFuel') {
              const a = decoded.args as any
              pfTokenKey = a.tokenKey; pfTokenIndex = a.tokenIndex; pfTokenAmount = a.tokenAmount
              pfFuelKey = a.fuelKey; pfFuelIndex = a.fuelIndex; pfFuelAmountReceived = a.fuelAmount
              break
            }
          } catch { /* not our event */ }
        }
        logger.info(`  BridgeWithFuel event: tokenAmount=${pfTokenAmount}, fuelAmount=${pfFuelAmountReceived}`)
        logger.info(`  tokenIndex=${pfTokenIndex}, fuelIndex=${pfFuelIndex}`)

        // Wait for BOTH L1→L2 messages to sync
        for (const [label, msgHash] of [['token', pfTokenKey], ['fuel', pfFuelKey]] as const) {
          if (!msgHash || msgHash === '0x0') continue
          const msgFr = Fr.fromString(msgHash)
          logger.info(`⏳ Polling for ${label} L1→L2 message sync...`)
          const start = Date.now()
          while (Date.now() - start < 20 * 60 * 1000) {
            try {
              const blk = await node.getL1ToL2MessageBlock(msgFr)
              if (blk !== undefined) { logger.info(`✅ ${label} message ready (block=${blk})`); break }
              logger.info(`   ${label} message not yet synced. Waiting 2 min...`)
            } catch (e) { logger.warn(`   Poll failed: ${e}`) }
            await wait(120_000)
          }
        }
        logger.info('⏳ Waiting 2 min before claiming on L2...')
        await wait(120_000)

        // Create FeeJuicePaymentMethodWithClaim (same as frontend public fuel path)
        const publicFuelPayment = new FeeJuicePaymentMethodWithClaim(ownerAztecAddress, {
          claimAmount: pfFuelAmountReceived,
          claimSecret: pfFuelSecret,
          messageLeafIndex: pfFuelIndex,
        })
        logger.info('✅ FeeJuicePaymentMethodWithClaim created')

        // Claim tokens on L2 using public fuel
        logger.info('📥 Claiming tokens on L2 with public fuel...')
        await l2BridgeContract.methods
          .claim_public(ownerAztecAddress, pfTokenAmount, pfClaimSecret, pfTokenIndex)
          .send({
            from: ownerAztecAddress,
            fee: { paymentMethod: publicFuelPayment },
            wait: { timeout: getTimeouts().txTimeout },
          })

        await logFuelTestBalances('AFTER public fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
        logger.info('✅ Public fuel (FeeJuicePaymentMethodWithClaim) test PASSED')
      } catch (error) {
        const { summary, detail, fix } = decodeFuelSwapError(error)
        logger.error(`❌ Public fuel test failed: ${summary}`)
        logger.error(`   ${detail}`)
        if (fix) logger.error(`   Fix: ${fix}`)
      }

      // ── Test 2: Private fuel (Wonderland BridgedMintAndPayFeePaymentMethod) via SwapBridgeRouter ──
      logger.info('\n🧪 Testing private fuel (Wonderland BridgedFPC) via SwapBridgeRouter.bridgeWithFuel...')
      if (!bridgedFpcAddress) {
        logger.warn('⚠️  No Wonderland BridgedFPC address. Skipping private fuel test.')
      } else {
        await logFuelTestBalances('BEFORE private fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
        try {
          const bridgedFpcAztecAddr = AztecAddress.fromString(bridgedFpcAddress)

          // Register BridgedFPC
          const bridgedFpcInstance = await registerBridgedContract(wallet)
          logger.info(`✅ Wonderland BridgedFPC registered at ${bridgedFpcInstance.address.toString()}`)

          // 1. Generate private fuel secret (poseidon2 derivation — same as frontend)
          const DOM_SEP_FPC_BRIDGE_SECRET = 3952304070
          const privateFuelSalt = Fr.random()
          const claimerFr = Fr.fromString(ownerAztecAddress.toString())
          const privateFuelSecret = await poseidon2HashWithSeparator(
            [privateFuelSalt, claimerFr],
            DOM_SEP_FPC_BRIDGE_SECRET,
          )
          const privateFuelSecretHash = await computeSecretHash(privateFuelSecret)
          logger.info(`  Private fuel salt: ${privateFuelSalt.toString().slice(0, 18)}...`)
          logger.info(`  Private fuel secret hash: ${privateFuelSecretHash.toString().slice(0, 18)}...`)

          // 2. Generate token claim secret
          const [pvClaimSecret, pvClaimSecretHash] = await generateClaimSecret()

          const pvTotalAmount = BigInt(1e5)  // 0.1 USDC total
          const pvFuelAmount = BigInt(2e4)   // 0.02 USDC swapped to FeeJuice (pool depth ~0.19 FJ)
          const pvMinFuelOutput = 0n

          // Mint ERC20
          const mintTx = await erc20.write.mint([l1Client.account.address, pvTotalAmount])
          await sendAndWait(l1Client, mintTx, `Minted ${pvTotalAmount} ${firstToken.symbol} for private fuel test`, logger)

          // Sign Permit2 witness — fuelRecipient is BridgedFPC (not user)
          const pvPermit = await signPermit2Witness(l1Client, {
            tokenPortal: portalAddr,
            bridgeToken: tokenAddr,
            totalAmount: pvTotalAmount,
            fuelAmount: pvFuelAmount,
            aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
            fuelRecipient: bridgedFpcAztecAddr.toString() as `0x${string}`, // private fuel → BridgedFPC
            tokenSecretHash: pvClaimSecretHash.toString() as `0x${string}`,
            fuelSecretHash: privateFuelSecretHash.toString() as `0x${string}`,
            minFuelOutput: pvMinFuelOutput,
            poolKeys,
            zeroForOnes,
            isPrivate: false,
            swapBridgeRouter: swapRouterAddress,
            l1ChainId,
          })
          logger.info('✅ Permit2 witness signed (private fuel)')

          // Call SwapBridgeRouter.bridgeWithFuel — dry-run first to catch errors without spending ETH
          const router = getContract({ address: swapRouterAddress, abi: SwapBridgeRouterAbiLocal, client: l1Client as any }) as any
          const pvBridgeArgs = [
            {
              tokenPortal: portalAddr,
              bridgeToken: tokenAddr,
              totalAmount: pvTotalAmount,
              fuelAmount: pvFuelAmount,
              aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
              fuelRecipient: bridgedFpcAztecAddr.toString() as `0x${string}`,
              tokenSecretHash: pvClaimSecretHash.toString() as `0x${string}`,
              fuelSecretHash: privateFuelSecretHash.toString() as `0x${string}`,
              minFuelOutput: pvMinFuelOutput,
              path: poolKeys,
              zeroForOnes,
              isPrivate: false,
              cleanHands: { nonce: 0n, actionId: 0n, signature: '0x' as `0x${string}` },
              passport: { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` },
            },
            { nonce: pvPermit.nonce, deadline: pvPermit.deadline, signature: pvPermit.signature },
          ] as const
          try {
            await router.simulate.bridgeWithFuel(pvBridgeArgs, { account: l1Client.account })
            logger.info('✅ Dry-run passed — sending bridgeWithFuel tx (private fuel)...')
          } catch (simError) {
            const { summary, detail, fix } = decodeFuelSwapError(simError)
            logger.error(`❌ Dry-run failed (no ETH spent): ${summary}`)
            logger.error(`   ${detail}`)
            if (fix) logger.error(`   Fix: ${fix}`)
            throw simError
          }
          const bridgeTx = await router.write.bridgeWithFuel(pvBridgeArgs)
          const bridgeReceipt = await sendAndWait(l1Client, bridgeTx, 'SwapBridgeRouter.bridgeWithFuel (private fuel)', logger)

          // Parse BridgeWithFuel event
          let pvTokenKey: `0x${string}` = '0x0' as `0x${string}`, pvTokenIndex = 0n, pvTokenAmount = 0n
          let pvFuelKey: `0x${string}` = '0x0' as `0x${string}`, pvFuelIndex = 0n, pvFuelAmountReceived = 0n
          for (const log of bridgeReceipt.logs) {
            if (log.address.toLowerCase() !== swapRouterAddress.toLowerCase()) continue
            try {
              const decoded = decodeEventLog({ abi: SwapBridgeRouterAbiLocal, data: log.data, topics: log.topics })
              if (decoded.eventName === 'BridgeWithFuel') {
                const a = decoded.args as any
                pvTokenKey = a.tokenKey; pvTokenIndex = a.tokenIndex; pvTokenAmount = a.tokenAmount
                pvFuelKey = a.fuelKey; pvFuelIndex = a.fuelIndex; pvFuelAmountReceived = a.fuelAmount
                break
              }
            } catch { /* not our event */ }
          }
          logger.info(`  BridgeWithFuel event: tokenAmount=${pvTokenAmount}, fuelAmount=${pvFuelAmountReceived}`)
          logger.info(`  tokenIndex=${pvTokenIndex}, fuelIndex=${pvFuelIndex}`)

          // Wait for BOTH L1→L2 messages
          for (const [label, msgHash] of [['token', pvTokenKey], ['fuel', pvFuelKey]] as const) {
            if (!msgHash || msgHash === '0x0') continue
            const msgFr = Fr.fromString(msgHash)
            logger.info(`⏳ Polling for ${label} L1→L2 message sync...`)
            const start = Date.now()
            while (Date.now() - start < 20 * 60 * 1000) {
              try {
                const blk = await node.getL1ToL2MessageBlock(msgFr)
                if (blk !== undefined) { logger.info(`✅ ${label} message ready (block=${blk})`); break }
                logger.info(`   ${label} message not yet synced. Waiting 2 min...`)
              } catch (e) { logger.warn(`   Poll failed: ${e}`) }
              await wait(120_000)
            }
          }
          logger.info('⏳ Waiting 2 min before claiming on L2...')
          await wait(120_000)

          // 3. Query base fees → build explicit gasSettings (same as frontend)
          const baseFees = await node.getCurrentMinFees()
          const maxFeesPerGas = maxFeesPerGasFromBaseFees(baseFees)
          const gasLimits = REASONABLE_GAS_LIMITS
          const teardownGasLimits = Gas.from({ l2Gas: 0, daGas: 0 })
          const estimatedMaxGasCost = maxGasCostFor(maxFeesPerGas, gasLimits)
          logger.info(`  Gas diagnostics:`)
          logger.info(`    baseFees: feePerDaGas=${baseFees.feePerDaGas}, feePerL2Gas=${baseFees.feePerL2Gas}`)
          logger.info(`    estimatedMaxGasCost: ${estimatedMaxGasCost}`)
          logger.info(`    fuelAmount: ${pvFuelAmountReceived}, sufficient: ${pvFuelAmountReceived >= estimatedMaxGasCost}`)

          // 4. Create BridgedMintAndPayFeePaymentMethod
          const bridgedFeeMethod = new BridgedMintAndPayFeePaymentMethod(
            bridgedFpcAztecAddr,
            pvFuelAmountReceived,
            privateFuelSecret,
            privateFuelSalt,
            new Fr(pvFuelIndex),
          )
          const feeOption = {
            fee: {
              paymentMethod: bridgedFeeMethod,
              gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas, maxPriorityFeesPerGas: GasFees.empty() },
            },
          }
          logger.info('✅ Wonderland BridgedMintAndPayFeePaymentMethod created with gasSettings')

          // 5. Claim tokens on L2 with BridgedFPC fees
          logger.info('📥 Claiming tokens on L2 with Wonderland BridgedFPC (private fuel)...')
          await l2BridgeContract.methods
            .claim_public(ownerAztecAddress, pvTokenAmount, pvClaimSecret, pvTokenIndex)
            .send({
              from: ownerAztecAddress,
              ...feeOption,
              wait: { timeout: getTimeouts().txTimeout },
            })

          await logFuelTestBalances('AFTER private fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
          logger.info('✅ Wonderland BridgedFPC (private fuel) test PASSED')
        } catch (error) {
          const { summary, detail, fix } = decodeFuelSwapError(error)
          logger.error(`❌ Private fuel test failed: ${summary}`)
          logger.error(`   ${detail}`)
          if (fix) logger.error(`   Fix: ${fix}`)
        }
      }
    }
  } else {
    logger.warn(
      '⚠️  No tokens were deployed successfully. Skipping bridge test.',
    )
  }
}

main()