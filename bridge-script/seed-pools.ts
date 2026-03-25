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

// ── Sepolia constants for pool seeding ──────────────────────────────
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
const FEE_ASSET_HANDLER = '0xED9c5557d2E0abCc7c7FCA958eE4292199413494' as `0x${string}`
const AZTEC_TOKEN = '0x35d0186d1FD53b72996475D965C5Ed171D52b986' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// Pool seed amounts — minimized for devnet ETH budget (~0.03 ETH total):
//
//   Pool 1 (ETH/AZTEC): L=1e18 consumes 0.00684 ETH + 68.4 FJ.
//     Tradeable depth: ~0.022 ETH / ~68.4 FJ — plenty for 0.02 USDC fuel swaps.
//     ETH_SEED=0.05 ETH (covers liquidity + price drift on re-seed; excess swept back).
//     FEE_MINT_COUNT=1 (1000 FJ >> 68.4 needed).
//
//   Pool 2 (USDC/WETH): L=1e12 consumes 35.59 USDC + 0.017 WETH.
//     Tradeable depth: ~159 USDC / ~0.017 WETH — 100x headroom for fuel swaps.
//     WETH_SEED=0.02 ETH. ERC20 minted free.
//
//   Liquidity CANNOT be withdrawn — PoolSeeder has no remove-liquidity function.
//   Pools are ALWAYS seeded (no skip logic). PoolSeeder.setup() is idempotent.

// ETH/AZTEC pool params (~10,000 FeeJuice per ETH)
const ETH_AZTEC_SQRT_PRICE = 7922816251426433759354395033600n
const ETH_AZTEC_TICK_LOWER = 69060
const ETH_AZTEC_TICK_UPPER = 115140
const ETH_AZTEC_FEE = 3000
const ETH_AZTEC_TICK_SPACING = 60
const ETH_AZTEC_LIQUIDITY = 1n * 10n ** 18n // 1e18 — consumes 0.00684 ETH + 68.4 FJ

// ERC20/WETH pool params (~2,100 USDC per WETH)
const ERC20_WETH_SQRT_PRICE = 1728916962386276374966316084832192n
const ERC20_WETH_TICK_LOWER = 169800
const ERC20_WETH_TICK_UPPER = 229800
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60
const ERC20_WETH_LIQUIDITY = 1000000000000n // 1e12 — consumes 35.59 USDC + 0.017 WETH

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

async function logPoolBalances(l1Url: string, erc20Tokens: any[], label: string, logger: any) {
  const l1Public = createPublicClient({ transport: http(l1Url) })

  logger.info(`\n--- Pool & Wallet Balances (${label}) ---`)

  // PoolManager ETH balance (shared across ALL V4 pools on Sepolia)
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
  const feeMintCount = Number(process.env.FEE_MINT_COUNT || '1')
  const ethSeed = BigInt(process.env.ETH_SEED || '50000000000000000') // 0.05 ETH (covers price drift; excess swept back)
  const wethSeed = BigInt(process.env.WETH_SEED || '20000000000000000') // 0.02 ETH
  const skipEthAztec = process.env.SKIP_ETH_AZTEC === 'true'
  const specificToken = process.env.ERC20_TOKEN?.toLowerCase()

  // Load tokens from active deployment
  const deployment = loadActiveDeployment()
  if (!deployment) {
    logger.error('No active deployment found. Run pnpm start-devnet first.')
    process.exit(1)
  }

  let tokens = deployment.tokens || []
  logger.info(`Active deployment: ${deployment.id} (${tokens.length} tokens)`)

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
  await logPoolBalances(L1_URL, erc20Tokens, 'BEFORE seeding', logger)

  // ── 1. Seed ETH/AZTEC pool ─────────────────────────────────────────
  // Always seed — PoolManager FJ balance is shared across ALL V4 pools on the
  // network, so checking it is unreliable. PoolSeeder.setup() is idempotent
  // (initializes pool if new, adds liquidity if it already exists).
  if (skipEthAztec) {
    logger.info('Skipping ETH/AZTEC pool (SKIP_ETH_AZTEC=true)')
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

  // ── 2. Seed ERC20/WETH pool for each token ────────────────────────
  for (let i = 0; i < erc20Tokens.length; i++) {
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
        : BigInt(100) * (10n ** BigInt(decimals)) // 100 tokens — 1e12 liquidity needs ~36 USDC

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

  // Log balances AFTER seeding
  await logPoolBalances(L1_URL, erc20Tokens, 'AFTER seeding', logger)

  logger.info(`\n✅ Pool seeding complete — ${erc20Tokens.length} ERC20/WETH pools${skipEthAztec ? '' : ' + 1 ETH/AZTEC pool'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
