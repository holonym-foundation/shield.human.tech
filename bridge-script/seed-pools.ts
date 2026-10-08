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
 *   - L1_PRIVATE_KEY (required unless MNEMONIC is set): Deployer private key (0x-prefixed)
 *   - L1_URL (optional): L1 RPC URL (uses config default if not set)
 *   - ERC20_TOKEN (optional): Seed only this token's ERC20/WETH pool
 *   - SKIP_ETH_AZTEC (optional): Set to "true" to skip the ETH/AZTEC pool
 *   - FEE_MINT_COUNT (optional): Number of FeeJuice mints, each 1000 FJ (default: 1)
 *   - ETH_SEED (optional): ETH for ETH/AZTEC pool in wei (default: 0.05 ETH)
 *   - WETH_SEED (optional): ETH to wrap for ERC20/WETH pool in wei (default: 0.02 ETH)
 *   - ERC20_AMOUNT (optional): Raw ERC20 amount to seed (default: 100 * 10^decimals)
 *   - DIRECT_LIQUIDITY (optional): Liquidity L for the ERC20/AZTEC pool (default: 3.8e17)
 *   - SKIP_REPEG (optional): Set to "true" to add liquidity without re-pegging the price
 *   - REPEG_MAX_FJ (optional): Cap on FeeJuice spent re-pegging, whole tokens (default: 50000)
 *   - FORCE_SEED: Removed — pools are now always seeded (PoolSeeder.setup is idempotent)
 */

import { createLogger } from '@aztec-labs/aztec.js/log'
import { createExtendedL1Client } from '@aztec-labs/ethereum/client'
import { createEthereumChain } from '@aztec-labs/ethereum/chain'
import { createPublicClient, encodeAbiParameters, getContract, http, keccak256 } from 'viem'
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
const STATE_VIEW = '0xe1dd9c3fa50edb962e442f60dfbc432e24537e4c' as `0x${string}`
const POOL_SWAP_TEST = '0x9b6b46e2c869aa39918db7f52f5557fe577b6eee' as `0x${string}`

const Q96 = 2n ** 96n

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
//
// L=3.8e17 full-range deposits ~1,201,700 FJ + ~120,170 USDC at the peg.
// Sizing: testnet has no arbitrage, so every fuel swap ratchets the price up
// permanently — depth is the only brake. Price drift from FeeJuice outflow is
// 1/(1-f)^2 where f is the fraction of the FJ side consumed, so this reserve
// holds a year of observed demand (~300 FJ/day) inside ~10% drift.
const DIRECT_FEE = 3000
const DIRECT_TICK_SPACING = 60
const DIRECT_TICK_LOWER = -887220 // full range
const DIRECT_TICK_UPPER = 887220  // full range
const DIRECT_LIQUIDITY = BigInt(process.env.DIRECT_LIQUIDITY || '380000000000000000') // 3.8e17

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
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const

const STATE_VIEW_ABI = [
  { type: 'function', name: 'getSlot0', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' }], stateMutability: 'view' },
  { type: 'function', name: 'getLiquidity', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ name: 'liquidity', type: 'uint128' }], stateMutability: 'view' },
] as const

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const

const POOL_SWAP_TEST_ABI = [
  {
    type: 'function',
    name: 'swap',
    inputs: [
      { name: 'key', type: 'tuple', components: POOL_KEY_COMPONENTS },
      { name: 'params', type: 'tuple', components: [
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountSpecified', type: 'int256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ] },
      { name: 'testSettings', type: 'tuple', components: [
        { name: 'takeClaims', type: 'bool' },
        { name: 'settleUsingBurn', type: 'bool' },
      ] },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
    stateMutability: 'payable',
  },
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

function poolIdOf(key: any): `0x${string}` {
  return keccak256(
    encodeAbiParameters(POOL_KEY_COMPONENTS as any, [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  )
}

/**
 * Token amounts a full-range position of `liquidity` deposits at `sqrtPriceX96`.
 *
 * The exact formula subtracts the range bounds (1/sqrtPriceUpper and sqrtPriceLower),
 * but at ticks ±887220 those terms are ~14 orders of magnitude below the amounts here,
 * so they vanish. Callers add a margin and sweep the remainder, making the
 * approximation safe in the only direction that matters (never under-funding).
 */
function fullRangeAmounts(liquidity: bigint, sqrtPriceX96: bigint): { amount0: bigint; amount1: bigint } {
  return {
    amount0: (liquidity * Q96) / sqrtPriceX96,
    amount1: (liquidity * sqrtPriceX96) / Q96,
  }
}

/** Top up `holder` to at least `required` FeeJuice, minting 1000 FJ per FeeAssetHandler call. */
async function ensureFeeJuice(
  l1Client: any,
  feeJuice: any,
  feeHandler: any,
  holder: `0x${string}`,
  required: bigint,
  logger: any,
): Promise<void> {
  const balance = (await feeJuice.read.balanceOf([holder])) as bigint
  if (balance >= required) return

  const perMint = 1000n * 10n ** 18n
  const mints = Number((required - balance + perMint - 1n) / perMint)
  logger.info(`  Minting FeeJuice: ${mints} x 1000 FJ (have ${balance / 10n ** 18n}, need ${required / 10n ** 18n})`)

  const BATCH_SIZE = 10
  for (let i = 0; i < mints; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, mints)
    const hashes: `0x${string}`[] = []
    for (let j = i; j < batchEnd; j++) hashes.push(await feeHandler.write.mint([holder]))
    await Promise.all(hashes.map((h) => l1Client.waitForTransactionReceipt({ hash: h, timeout: 180_000 })))
    logger.info(`  ... minted ${batchEnd}/${mints}`)
  }
}

/**
 * Push a pool's spot price back to `targetSqrtPriceX96` by swapping through it.
 *
 * Adding liquidity cannot move a pool's price — only a swap can. Testnet has no
 * arbitrage, so fuel swaps ratchet the price away from the peg and it never returns
 * on its own. This MUST run before liquidity is added: the input needed scales
 * linearly with the pool's active liquidity, so re-pegging a thin pool is orders of
 * magnitude cheaper than re-pegging a deep one.
 */
async function repegPool(params: {
  l1Client: any
  publicClient: any
  poolKey: any
  targetSqrtPriceX96: bigint
  feeJuiceAddr: `0x${string}`
  feeHandlerAddr: `0x${string}`
  logger: any
}): Promise<void> {
  const { l1Client, publicClient, poolKey, targetSqrtPriceX96, feeJuiceAddr, feeHandlerAddr, logger } = params
  const deployer = l1Client.account.address
  const poolId = poolIdOf(poolKey)

  const [currentSqrtPrice, currentTick] = (await publicClient.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [poolId],
  })) as [bigint, number, number, number]

  if (currentSqrtPrice === 0n) {
    logger.info('  Pool not initialized yet — setup() will create it at the target price')
    return
  }

  // sqrtPrice drift; the price itself is the square of this, so 1.005 here is ~1% off peg.
  const [lo, hi] = currentSqrtPrice < targetSqrtPriceX96
    ? [currentSqrtPrice, targetSqrtPriceX96]
    : [targetSqrtPriceX96, currentSqrtPrice]
  const driftBps = Number((hi * 10000n) / lo) - 10000
  if (driftBps < 50) {
    logger.info(`  Price is on peg (tick ${currentTick}, ${(driftBps / 100).toFixed(2)}% off) — no re-peg needed`)
    return
  }
  logger.info(`  Price is ${(driftBps / 100).toFixed(1)}% off peg in sqrt terms (tick ${currentTick}) — re-pegging`)

  const liquidity = (await publicClient.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: 'getLiquidity',
    args: [poolId],
  })) as bigint

  if (liquidity === 0n) {
    logger.warn('  Pool has zero active liquidity — cannot swap. Seeding at the current (off-peg) price.')
    return
  }

  const zeroForOne = currentSqrtPrice > targetSqrtPriceX96
  const inputToken = (zeroForOne ? poolKey.currency0 : poolKey.currency1) as `0x${string}`

  // Input to walk the price from current to target across the active range.
  // +2% covers the LP fee; the swap stops at sqrtPriceLimitX96 and leaves the rest unspent.
  const exactIn = zeroForOne
    ? (liquidity * Q96) / targetSqrtPriceX96 - (liquidity * Q96) / currentSqrtPrice
    : (liquidity * (targetSqrtPriceX96 - currentSqrtPrice)) / Q96
  const maxIn = exactIn + exactIn / 50n + 1n

  const isFeeJuiceInput = inputToken.toLowerCase() === feeJuiceAddr.toLowerCase()
  if (isFeeJuiceInput) {
    const cap = BigInt(process.env.REPEG_MAX_FJ || '50000') * 10n ** 18n
    if (maxIn > cap) {
      throw new Error(
        `Re-peg needs ${maxIn / 10n ** 18n} FJ, above the ${cap / 10n ** 18n} FJ cap. ` +
        `Verify the target price constant is right, then raise REPEG_MAX_FJ to override.`,
      )
    }
  }

  const input = getContract({ address: inputToken, abi: ERC20_ABI, client: l1Client as any }) as any
  if (isFeeJuiceInput) {
    const feeHandler = getContract({ address: feeHandlerAddr, abi: FEE_HANDLER_ABI, client: l1Client as any }) as any
    await ensureFeeJuice(l1Client, input, feeHandler, deployer, maxIn, logger)
  } else {
    const balance = (await input.read.balanceOf([deployer])) as bigint
    if (balance < maxIn) {
      await sendAndWait(l1Client, await input.write.mint([deployer, maxIn - balance]), `Minted ${maxIn - balance} input token`, logger)
    }
  }

  await sendAndWait(l1Client, await input.write.approve([POOL_SWAP_TEST, maxIn]), `Approved ${maxIn} to PoolSwapTest`, logger)

  const swapArgs = [
    poolKey,
    { zeroForOne, amountSpecified: -maxIn, sqrtPriceLimitX96: targetSqrtPriceX96 },
    { takeClaims: false, settleUsingBurn: false },
    '0x',
  ] as const

  const swapper = getContract({ address: POOL_SWAP_TEST, abi: POOL_SWAP_TEST_ABI, client: l1Client as any }) as any
  await swapper.simulate.swap(swapArgs, { account: deployer })
  await sendAndWait(l1Client, await swapper.write.swap(swapArgs), 'Re-peg swap executed', logger)

  const [afterSqrtPrice, afterTick] = (await publicClient.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [poolId],
  })) as [bigint, number, number, number]
  logger.info(`  Price now tick ${afterTick} (target sqrtPriceX96 ${targetSqrtPriceX96}, actual ${afterSqrtPrice})`)
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

  const L1_CREDENTIAL = process.env.L1_PRIVATE_KEY || process.env.MNEMONIC
  if (!L1_CREDENTIAL) {
    logger.error('L1_PRIVATE_KEY or MNEMONIC is required')
    process.exit(1)
  }

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_CREDENTIAL, chain.chainInfo)
  const l1Public = createPublicClient({ transport: http(L1_URL) })
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

      // Mint FeeJuice to seeder (batched — send BATCH_SIZE txs, then wait for all)
      const BATCH_SIZE = 10
      logger.info(`  Minting FeeJuice: ${feeMintCount} x 1000 FJ (batches of ${BATCH_SIZE})`)
      for (let i = 0; i < feeMintCount; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, feeMintCount)
        const hashes: `0x${string}`[] = []
        for (let j = i; j < batchEnd; j++) {
          hashes.push(await feeHandler.write.mint([seederAddr]))
        }
        await Promise.all(hashes.map(h => l1Client.waitForTransactionReceipt({ hash: h, timeout: 180_000 })))
        logger.info(`  ... minted ${batchEnd}/${feeMintCount}`)
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

      // Compute sqrtPriceX96 based on currency ordering
      // Target: 10 FJ (18 dec) per 1 USDC (6 dec)
      const [c0, c1] = sortCurrencies(tokenAddr, AZTEC_TOKEN)
      const erc20IsCurrency0 = BigInt(tokenAddr) < BigInt(AZTEC_TOKEN)
      let directSqrtPrice: bigint
      if (erc20IsCurrency0) {
        // ERC20 is currency0, AZTEC is currency1 → price = AZTEC/ERC20 = high
        directSqrtPrice = 250541396071120286692299382636675072n
      } else {
        // AZTEC is currency0, ERC20 is currency1 → price = ERC20/AZTEC = low
        directSqrtPrice = 25054144837504792002560n
      }

      const poolKey = { currency0: c0, currency1: c1, fee: DIRECT_FEE, tickSpacing: DIRECT_TICK_SPACING, hooks: ZERO_ADDRESS }

      // Restore the peg BEFORE deepening — cost scales with the pool's current liquidity.
      if (process.env.SKIP_REPEG === 'true') {
        logger.info('  Skipping re-peg (SKIP_REPEG=true) — liquidity will be added at the current price')
      } else {
        await repegPool({
          l1Client,
          publicClient: l1Public,
          poolKey,
          targetSqrtPriceX96: directSqrtPrice,
          feeJuiceAddr: AZTEC_TOKEN,
          feeHandlerAddr: FEE_ASSET_HANDLER,
          logger,
        })
      }

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
      const feeHandler = getContract({ address: FEE_ASSET_HANDLER, abi: FEE_HANDLER_ABI, client: l1Client as any }) as any

      // Fund the seeder from the liquidity math rather than a fixed guess, so DIRECT_LIQUIDITY
      // is the single knob. +1% absorbs the full-range approximation and rounding; the
      // remainder is swept back at the end.
      const { amount0, amount1 } = fullRangeAmounts(DIRECT_LIQUIDITY, directSqrtPrice)
      const erc20Needed = (erc20IsCurrency0 ? amount0 : amount1) * 101n / 100n
      const fjNeeded = (erc20IsCurrency0 ? amount1 : amount0) * 101n / 100n
      const decimals = await erc20.read.decimals() as number
      const directErc20Amount = process.env.DIRECT_ERC20_AMOUNT ? BigInt(process.env.DIRECT_ERC20_AMOUNT) : erc20Needed
      logger.info(`  Liquidity ${DIRECT_LIQUIDITY} needs ~${directErc20Amount / 10n ** BigInt(decimals)} ${token.symbol} + ~${fjNeeded / 10n ** 18n} FJ`)

      const mintTx = await erc20.write.mint([seederAddr, directErc20Amount])
      await sendAndWait(l1Client, mintTx, `Minted ${directErc20Amount} ${token.symbol}`, logger)

      // The deployer usually holds FJ swept from earlier runs; mint only the shortfall,
      // since FeeAssetHandler caps each mint at 1000 FJ.
      await ensureFeeJuice(l1Client, aztecToken, feeHandler, deployer, fjNeeded, logger)
      const tx0 = await aztecToken.write.transfer([seederAddr, fjNeeded])
      await sendAndWait(l1Client, tx0, `Transferred ${fjNeeded / 10n ** 18n} FJ to seeder`, logger)

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
    skipErc20Weth ? '' : `${erc20Tokens.length} ERC20/WETH pools`,
    seedDirectPool && erc20Tokens.length > 0 ? '1 ERC20/AZTEC direct pool' : '',
  ].filter(Boolean).join(' + ')
  logger.info(`\n✅ Pool seeding complete — ${poolsSummary}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
