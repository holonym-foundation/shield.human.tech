// @ts-nocheck
/**
 * Seed Uniswap V4 liquidity pools for all deployed tokens.
 *
 * Seeds:
 *   1) ETH/AZTEC (FeeJuice) pool — once
 *   2) ERC20/WETH pool — for each non-WETH token in the active deployment
 *
 * Usage:
 *   pnpm seed-pools                          # seed all tokens from active deployment
 *   ERC20_TOKEN=0x... pnpm seed-pools        # seed only this specific token
 *   SKIP_ETH_AZTEC=true pnpm seed-pools      # skip the ETH/AZTEC pool
 *
 * Environment Variables:
 *   - L1_PRIVATE_KEY (required): Deployer private key (0x-prefixed)
 *   - L1_URL (optional): L1 RPC URL (uses config default if not set)
 *   - ERC20_TOKEN (optional): Seed only this token's ERC20/WETH pool
 *   - SKIP_ETH_AZTEC (optional): Set to "true" to skip the ETH/AZTEC pool
 *   - FEE_MINT_COUNT (optional): Number of FeeJuice mints, each 1000 FJ (default: 1)
 *   - ETH_SEED (optional): ETH for ETH/AZTEC pool in wei (default: 0.05 ETH)
 *   - WETH_SEED (optional): ETH to wrap for ERC20/WETH pool in wei (default: 0.02 ETH)
 *   - ERC20_AMOUNT (optional): Raw ERC20 amount to seed (default: 100 * 10^decimals)
 *   - FORCE_SEED: Removed — pools are now always seeded (PoolSeeder.setup is idempotent)
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { createPublicClient, getContract, http } from 'viem'
import 'dotenv/config'

// @ts-ignore
import PoolSeederJson from '../l1-contracts/out/SeedUniswapPools.s.sol/PoolSeeder.json'

import { loadActiveDeployment } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const PoolSeederAbi = PoolSeederJson.abi
const PoolSeederBytecode = PoolSeederJson.bytecode.object as `0x${string}`

// ── Sepolia constants ──────────────────────────────────────────────
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// FeeJuice (AZTEC) and FeeAssetHandler addresses are read from the active deployment
// at runtime — see main(). DO NOT hardcode them; they differ between environments.

// Pool seed amounts — matched to alejo's Solidity script for production-grade depth:
//
//   Pool 1 (ETH/AZTEC): L=1e18, full-range ticks, 100x1000 FJ minted.
//     Full-range liquidity ensures swaps work at any price (less capital-efficient
//     but never runs dry from price movement — critical for fuel swaps).
//     ETH_SEED=0.3 ETH. FEE_MINT_COUNT=100 (100,000 FJ).
//
//   Pool 2 (USDC/WETH): L=6e13, full-range ticks, 5000 USDC + 1.5 WETH.
//     Full-range provides deep liquidity for multi-hop fuel swaps.
//     WETH_SEED=1.5 ETH. ERC20 minted free (5000 per token).
//
//   Liquidity CANNOT be withdrawn — PoolSeeder has no remove-liquidity function.
//   Pools are ALWAYS seeded (no skip logic). PoolSeeder.setup() is idempotent.

// ETH/AZTEC pool params (~10,000 FeeJuice per ETH)
const ETH_AZTEC_SQRT_PRICE = 7922816251426433759354395033600n
const ETH_AZTEC_TICK_LOWER = -887220 // full range (tick spacing = 60)
const ETH_AZTEC_TICK_UPPER = 887220  // full range
const ETH_AZTEC_FEE = 3000
const ETH_AZTEC_TICK_SPACING = 60
const ETH_AZTEC_LIQUIDITY = 60n * 10n ** 18n // 60e18 — deposits ~0.6 ETH + ~6,000 FJ at full range

// ERC20/AZTEC direct pool params (~10 FeeJuice per USDC)
// NOTE: sqrtPriceX96 depends on currency ordering (lower address = currency0).
// Computed at runtime in main() based on actual token addresses.
const DIRECT_FEE = 3000
const DIRECT_TICK_SPACING = 60
const DIRECT_TICK_LOWER = -887220 // full range
const DIRECT_TICK_UPPER = 887220  // full range
const DIRECT_LIQUIDITY = 1000000000000000n // 1e15

// ERC20/WETH pool params (~2,100 USDC per WETH)
const ERC20_WETH_SQRT_PRICE = 1728916962386276374966316084832192n
const ERC20_WETH_TICK_LOWER = -887220 // full range (tick spacing = 60)
const ERC20_WETH_TICK_UPPER = 887220  // full range
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60
const ERC20_WETH_LIQUIDITY = 60000000000000n // 6e13

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

function sortCurrencies(a: `0x${string}`, b: `0x${string}`): [`0x${string}`, `0x${string}`] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

async function sendAndWait(l1Client: any, txHash: `0x${string}`, label: string, logger: any) {
  const receipt = await l1Client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
  if (receipt.status === 'reverted') throw new Error(`${label} reverted (tx: ${txHash})`)
  logger.info(`  ${label} (tx: ${txHash.slice(0, 10)}...)`)
  return receipt
}

async function logPoolBalances(l1Url: string, erc20Tokens: any[], label: string, logger: any, aztecTokenAddr: `0x${string}`) {
  const l1Public = createPublicClient({ transport: http(l1Url) })

  logger.info(`\n--- Pool & Wallet Balances (${label}) ---`)

  // PoolManager ETH balance (shared across ALL V4 pools on Sepolia)
  const pmEthBalance = await l1Public.getBalance({ address: POOL_MANAGER })
  logger.info(`  PoolManager ETH:    ${(Number(pmEthBalance) / 1e18).toFixed(4)} ETH (shared across all V4 pools)`)

  // PoolManager FeeJuice balance (our ETH/AZTEC pool)
  const aztecToken = getContract({ address: aztecTokenAddr, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmFjBalance = await aztecToken.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager FJ:     ${(Number(pmFjBalance) / 1e18).toFixed(2)} FeeJuice ${pmFjBalance > 0n ? '✅' : '❌ (ETH/AZTEC pool not seeded)'}`)

  // PoolManager WETH balance (shared across all V4 pools that use WETH)
  const weth = getContract({ address: WETH_ADDRESS, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmWethBalance = await weth.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager WETH:   ${(Number(pmWethBalance) / 1e18).toFixed(4)} WETH (shared across all V4 pools)`)

  // Each ERC20 token balance in PoolManager
  for (const token of erc20Tokens) {
    const tokenAddr = token.l1TokenContract as `0x${string}`
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

async function main() {
  const logger = createLogger('aztec:seed-pools')

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
  if (!L1_PRIVATE_KEY) {
    logger.error('L1_PRIVATE_KEY is required')
    process.exit(1)
  }

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)
  const deployer = l1Client.account.address

  // Config from env
  const feeMintCount = Number(process.env.FEE_MINT_COUNT || '100')
  const ethSeed = BigInt(process.env.ETH_SEED || '300000000000000000') // 0.3 ETH
  const wethSeed = BigInt(process.env.WETH_SEED || '1500000000000000000') // 1.5 ETH
  const skipEthAztec = process.env.SKIP_ETH_AZTEC !== 'false' // default: skip (direct pool is primary)
  const skipErc20Weth = process.env.SKIP_ERC20_WETH !== 'false' // default: skip (direct pool is primary)
  const specificToken = process.env.ERC20_TOKEN?.toLowerCase()

  // Load tokens from active deployment
  const deployment = loadActiveDeployment()
  if (!deployment) {
    logger.error('No active deployment found. Run pnpm start-devnet first.')
    process.exit(1)
  }

  // Read FeeJuice addresses from deployment (not hardcoded — they differ per environment)
  const l1Addrs = deployment.nodeInfo?.l1ContractAddresses
  const AZTEC_TOKEN = (l1Addrs?.feeJuiceAddress ?? '') as `0x${string}`
  const FEE_ASSET_HANDLER = (l1Addrs?.feeAssetHandlerAddress ?? '') as `0x${string}`
  if (!AZTEC_TOKEN || !FEE_ASSET_HANDLER) {
    logger.error('Missing feeJuiceAddress or feeAssetHandlerAddress in deployment nodeInfo')
    process.exit(1)
  }
  logger.info(`FeeJuice (AZTEC): ${AZTEC_TOKEN}`)
  logger.info(`FeeAssetHandler:  ${FEE_ASSET_HANDLER}`)
  logger.info(`Active deployment: ${deployment.id} (${(deployment.tokens || []).length} tokens)`)

  // ── Cross-check: verify bridge-script deployment matches frontend deployment ──
  // The frontend reads from frontend/src/constants/deployments.json (a static copy).
  // If it's out of sync with bridge-script/deployments/, pools get seeded with wrong addresses.
  try {
    const fs = await import('fs')
    const path = await import('path')
    const frontendDeployPath = path.resolve(process.cwd(), '..', 'frontend', 'src', 'constants', 'deployments.json')
    if (fs.existsSync(frontendDeployPath)) {
      const frontendData = JSON.parse(fs.readFileSync(frontendDeployPath, 'utf-8'))
      const frontendActive = frontendData.deployments?.find((d: any) => d.id === frontendData.activeDeploymentId)
      if (frontendActive) {
        const frontendFj = frontendActive.nodeInfo?.l1ContractAddresses?.feeJuiceAddress
        const frontendUsdc = frontendActive.tokens?.[0]?.l1TokenContract
        const scriptUsdc = deployment.tokens?.[0]?.l1TokenContract

        const fjMatch = frontendFj?.toLowerCase() === AZTEC_TOKEN.toLowerCase()
        const usdcMatch = !scriptUsdc || !frontendUsdc || frontendUsdc.toLowerCase() === scriptUsdc.toLowerCase()

        if (!fjMatch || !usdcMatch) {
          logger.error('⛔ DEPLOYMENT MISMATCH between bridge-script and frontend!')
          logger.error(`   bridge-script active: ${deployment.id}`)
          logger.error(`   frontend active:      ${frontendData.activeDeploymentId}`)
          if (!fjMatch) logger.error(`   FeeJuice: script=${AZTEC_TOKEN} vs frontend=${frontendFj}`)
          if (!usdcMatch) logger.error(`   USDC: script=${scriptUsdc} vs frontend=${frontendUsdc}`)
          logger.error('   Fix: sync frontend/src/constants/deployments.json with bridge-script/deployments/')
          if (process.env.FORCE_SEED !== 'true') {
            logger.error('   Set FORCE_SEED=true to override this check.')
            process.exit(1)
          }
          logger.warn('   FORCE_SEED=true — proceeding despite mismatch')
        } else {
          logger.info('✅ Frontend deployment matches bridge-script deployment')
        }
      }
    }
  } catch (e) {
    logger.warn('Could not cross-check frontend deployment (non-fatal):', e)
  }

  let tokens = deployment.tokens || []

  // Filter tokens
  if (specificToken) {
    tokens = tokens.filter((t: any) => t.l1TokenContract.toLowerCase() === specificToken)
    if (tokens.length === 0) {
      logger.error(`Token ${specificToken} not found in deployment`)
      process.exit(1)
    }
  }

  const erc20Tokens = tokens.filter(
    (t: any) => t.l1TokenContract.toLowerCase() !== WETH_ADDRESS.toLowerCase(),
  )

  // Log balances BEFORE seeding
  await logPoolBalances(L1_URL, erc20Tokens, 'BEFORE seeding', logger, AZTEC_TOKEN)

  // ── 1. Seed ETH/AZTEC pool ─────────────────────────────────────────
  // Always seed — PoolManager FJ balance is shared across ALL V4 pools on the
  // network, so checking it is unreliable. PoolSeeder.setup() is idempotent
  // (initializes pool if new, adds liquidity if it already exists).
  if (skipEthAztec) {
    logger.info('Skipping ETH/AZTEC pool (SKIP_ETH_AZTEC≠false, direct pool is primary)')
  } else {
    try {
      logger.info('\n--- ETH/AZTEC pool ---')

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
      logger.info(`  Minting FeeJuice: ${feeMintCount} x 1000 FJ`)
      for (let i = 0; i < feeMintCount; i++) {
        const tx = await feeHandler.write.mint([seederAddr])
        await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        if ((i + 1) % 10 === 0) logger.info(`  ... minted ${i + 1}/${feeMintCount}`)
      }

      // Transfer any deployer FJ to seeder
      const deployerFj = await aztecToken.read.balanceOf([deployer]) as bigint
      if (deployerFj > 0n) {
        const tx = await aztecToken.write.transfer([seederAddr, deployerFj])
        await sendAndWait(l1Client, tx, `Transferred ${deployerFj} FJ to seeder`, logger)
      }

      // Seed pool — dry-run first to catch errors without spending gas
      const [c0, c1] = sortCurrencies(ZERO_ADDRESS, AZTEC_TOKEN)
      const poolKey = { currency0: c0, currency1: c1, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS }
      const setupArgs = [poolKey, ETH_AZTEC_SQRT_PRICE, ETH_AZTEC_TICK_LOWER, ETH_AZTEC_TICK_UPPER, ETH_AZTEC_LIQUIDITY] as const
      try {
        await seeder.simulate.setup(setupArgs, { value: ethSeed })
        logger.info('  Dry-run passed — sending seed tx...')
      } catch (simError) {
        const simMsg = String(simError)
        if (simMsg.includes('0xe450d38c')) {
          logger.error('  ❌ Dry-run failed: ERC20InsufficientBalance — seeder doesn\'t have enough FeeJuice for liquidity.')
          logger.error(`     Minted ${feeMintCount} x 1000 FJ but liquidity ${ETH_AZTEC_LIQUIDITY} needs more. Increase FEE_MINT_COUNT.`)
        } else {
          logger.error(`  ❌ Dry-run failed: ${simError}`)
        }
        throw simError
      }
      const tx = await seeder.write.setup(setupArgs, { value: ethSeed })
      await sendAndWait(l1Client, tx, 'ETH/AZTEC pool seeded', logger)

      // Sweep
      await sendAndWait(l1Client, await seeder.write.sweep([ZERO_ADDRESS]), 'Swept ETH', logger)
      await sendAndWait(l1Client, await seeder.write.sweep([AZTEC_TOKEN]), 'Swept AZTEC', logger)
      logger.info('✅ ETH/AZTEC pool done')
    } catch (error) {
      const errMsg = String(error)
      if (errMsg.includes('0xe450d38c')) {
        logger.error('❌ ETH/AZTEC pool seeding failed: ERC20InsufficientBalance — not enough FeeJuice for the liquidity delta.')
        logger.error(`   Minted ${feeMintCount} x 1000 FJ but liquidity ${ETH_AZTEC_LIQUIDITY} needs more. Increase FEE_MINT_COUNT or reduce ETH_AZTEC_LIQUIDITY.`)
      } else {
        logger.error(`❌ ETH/AZTEC pool seeding failed: ${error}`)
      }
    }
  }

  // ── 2. Seed ERC20/WETH pool for each token (multi-hop fallback) ────
  if (skipErc20Weth) {
    logger.info('\nSkipping ERC20/WETH pools (SKIP_ERC20_WETH≠false, direct pool is primary)')
  }
  for (let i = 0; i < (skipErc20Weth ? 0 : erc20Tokens.length); i++) {
    const token = erc20Tokens[i]
    const tokenAddr = token.l1TokenContract as `0x${string}`

    // Always seed — each deployment creates a fresh ERC20, so the pool is always new.
    // PoolSeeder.setup() is idempotent (initializes if new, adds liquidity if exists).
    try {
      logger.info(`\n--- [${i + 1}/${erc20Tokens.length}] ${token.symbol}/WETH pool ---`)

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

      const decimals = await erc20.read.decimals() as number
      const erc20Amount = process.env.ERC20_AMOUNT
        ? BigInt(process.env.ERC20_AMOUNT)
        : BigInt(5000) * (10n ** BigInt(decimals)) // 5000 tokens (matches alejo's defaults for 6e13 liquidity)

      // Mint ERC20
      const mintTx = await erc20.write.mint([deployer, erc20Amount])
      await sendAndWait(l1Client, mintTx, `Minted ${erc20Amount} ${token.symbol}`, logger)

      // Wrap ETH -> WETH
      const wrapTx = await weth.write.deposit([], { value: wethSeed })
      await sendAndWait(l1Client, wrapTx, `Wrapped ${wethSeed} wei to WETH`, logger)

      // Transfer to seeder
      const txErc20 = await erc20.write.transfer([seederAddr, erc20Amount])
      await sendAndWait(l1Client, txErc20, `Transferred ${token.symbol} to seeder`, logger)

      const txWeth = await weth.write.transfer([seederAddr, wethSeed])
      await sendAndWait(l1Client, txWeth, 'Transferred WETH to seeder', logger)

      // Seed pool — dry-run first to catch errors without spending gas
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
          logger.error(`     Seeder has ${erc20Amount} ${token.symbol} + ${wethSeed} wei WETH. Increase ERC20 mint or reduce liquidity.`)
        } else {
          logger.error(`  ❌ Dry-run failed: ${simError}`)
        }
        throw simError
      }
      const seedTx = await seeder.write.setup(setupArgs)
      await sendAndWait(l1Client, seedTx, `${token.symbol}/WETH pool seeded`, logger)

      // Sweep
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
    }
  }

  // ── 3. Seed ERC20/AZTEC direct pool (for efficient fuel swaps) ───────
  const seedDirectPool = process.env.SEED_DIRECT_POOL !== 'false' // default: true
  if (seedDirectPool && erc20Tokens.length > 0) {
    const token = erc20Tokens[0] // Use the first ERC20 token (typically USDC)
    const tokenAddr = token.l1TokenContract as `0x${string}`
    try {
      logger.info(`\n--- ${token.symbol}/AZTEC direct pool ---`)

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
      const aztecToken = getContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, client: l1Client as any }) as any

      const decimals = await erc20.read.decimals() as number
      const directErc20Amount = process.env.DIRECT_ERC20_AMOUNT
        ? BigInt(process.env.DIRECT_ERC20_AMOUNT)
        : BigInt(50000) * (10n ** BigInt(decimals)) // 50,000 tokens

      // Mint ERC20 for direct pool
      const mintTx = await erc20.write.mint([seederAddr, directErc20Amount])
      await sendAndWait(l1Client, mintTx, `Minted ${directErc20Amount} ${token.symbol}`, logger)

      // Mint FeeJuice for direct pool (or transfer deployer's existing FJ)
      // Default 200 mints (200,000 FJ) — provides ample liquidity for the direct pool.
      // Previously defaulted to 0, which only worked if the deployer wallet had residual
      // FJ from a prior ETH/AZTEC seed run (broken when SKIP_ETH_AZTEC=true, the default).
      const directFjMintCount = Number(process.env.DIRECT_FJ_MINT_COUNT || '200')
      if (directFjMintCount > 0) {
        const feeHandler = getContract({ address: FEE_ASSET_HANDLER, abi: FEE_HANDLER_ABI, client: l1Client as any }) as any
        logger.info(`  Minting FeeJuice: ${directFjMintCount} x 1000 FJ`)
        for (let i = 0; i < directFjMintCount; i++) {
          const tx = await feeHandler.write.mint([seederAddr])
          await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
          if ((i + 1) % 10 === 0) logger.info(`  ... minted ${i + 1}/${directFjMintCount}`)
        }
      }

      // Transfer deployer's FJ to seeder
      const deployerFj = await aztecToken.read.balanceOf([deployer]) as bigint
      if (deployerFj > 0n) {
        const tx = await aztecToken.write.transfer([seederAddr, deployerFj])
        await sendAndWait(l1Client, tx, `Transferred ${deployerFj} FJ to seeder`, logger)
      }

      // Compute sqrtPriceX96 based on currency ordering
      // Target: 10 FJ (18 dec) per 1 USDC (6 dec)
      const [c0, c1] = sortCurrencies(tokenAddr, AZTEC_TOKEN)
      let directSqrtPrice: bigint
      if (BigInt(tokenAddr) < BigInt(AZTEC_TOKEN)) {
        // ERC20 is currency0, AZTEC is currency1 → price = AZTEC/ERC20 = high
        directSqrtPrice = 250541396071120286692299382636675072n
      } else {
        // AZTEC is currency0, ERC20 is currency1 → price = ERC20/AZTEC = low
        directSqrtPrice = 25054144837504792002560n
      }

      const poolKey = { currency0: c0, currency1: c1, fee: DIRECT_FEE, tickSpacing: DIRECT_TICK_SPACING, hooks: ZERO_ADDRESS }
      const setupArgs = [poolKey, directSqrtPrice, DIRECT_TICK_LOWER, DIRECT_TICK_UPPER, DIRECT_LIQUIDITY] as const
      try {
        await seeder.simulate.setup(setupArgs)
        logger.info('  Dry-run passed — sending seed tx...')
      } catch (simError) {
        const simMsg = String(simError)
        if (simMsg.includes('0xe450d38c')) {
          logger.error('  ❌ Dry-run failed: ERC20InsufficientBalance — need more FJ or ERC20 for direct pool liquidity.')
        } else {
          logger.error(`  ❌ Dry-run failed: ${simError}`)
        }
        throw simError
      }
      const tx = await seeder.write.setup(setupArgs)
      await sendAndWait(l1Client, tx, `${token.symbol}/AZTEC direct pool seeded`, logger)

      // Sweep leftovers
      await sendAndWait(l1Client, await seeder.write.sweep([tokenAddr]), `Swept ${token.symbol}`, logger)
      await sendAndWait(l1Client, await seeder.write.sweep([AZTEC_TOKEN]), 'Swept AZTEC', logger)
      logger.info(`✅ ${token.symbol}/AZTEC direct pool done`)
    } catch (error) {
      logger.error(`❌ ${token.symbol}/AZTEC direct pool seeding failed: ${error}`)
    }
  } else if (!seedDirectPool) {
    logger.info('\nSkipping direct ERC20/AZTEC pool (SEED_DIRECT_POOL=false)')
  }

  // Log balances AFTER seeding
  await logPoolBalances(L1_URL, erc20Tokens, 'AFTER seeding', logger, AZTEC_TOKEN)

  const poolsSummary = [
    skipEthAztec ? '' : '1 ETH/AZTEC pool',
    `${erc20Tokens.length} ERC20/WETH pools`,
    seedDirectPool && erc20Tokens.length > 0 ? '1 ERC20/AZTEC direct pool' : '',
  ].filter(Boolean).join(' + ')
  logger.info(`\n✅ Pool seeding complete — ${poolsSummary}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
