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
 *   - FEE_MINT_COUNT (optional): Number of FeeJuice mints, each 1000 FJ (default: 15)
 *   - ETH_SEED (optional): ETH for ETH/AZTEC pool in wei (default: 0.05 ETH)
 *   - WETH_SEED (optional): ETH to wrap for ERC20/WETH pool in wei (default: 0.15 ETH)
 *   - ERC20_AMOUNT (optional): Raw ERC20 amount to seed (default: 500 * 10^decimals)
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { getContract } from 'viem'
import 'dotenv/config'

// @ts-ignore
import PoolSeederJson from '../l1-contracts/out/SeedUniswapPools.s.sol/PoolSeeder.json'

import { loadActiveDeployment } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const PoolSeederAbi = PoolSeederJson.abi
const PoolSeederBytecode = PoolSeederJson.bytecode.object as `0x${string}`

// ── Sepolia constants ───────────────────────────────────────────────
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
const FEE_ASSET_HANDLER = '0xED9c5557d2E0abCc7c7FCA958eE4292199413494' as `0x${string}`
const AZTEC_TOKEN = '0x35d0186d1FD53b72996475D965C5Ed171D52b986' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// ETH/AZTEC pool params
const ETH_AZTEC_SQRT_PRICE = 7922816251426433759354395033600n
const ETH_AZTEC_TICK_LOWER = 69060
const ETH_AZTEC_TICK_UPPER = 115140
const ETH_AZTEC_FEE = 3000
const ETH_AZTEC_TICK_SPACING = 60
const ETH_AZTEC_LIQUIDITY = 10n ** 18n

// ERC20/WETH pool params
const ERC20_WETH_SQRT_PRICE = 1728916962386276374966316084832192n
const ERC20_WETH_TICK_LOWER = 169800
const ERC20_WETH_TICK_UPPER = 229800
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60
const ERC20_WETH_LIQUIDITY = 6000000000000n // 6e12 (scaled down for 500 USDC + 0.15 WETH seed)

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
  const feeMintCount = Number(process.env.FEE_MINT_COUNT || '15')
  const ethSeed = BigInt(process.env.ETH_SEED || '50000000000000000') // 0.05 ETH
  const wethSeed = BigInt(process.env.WETH_SEED || '150000000000000000') // 0.15 ETH
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

  // ── 1. Seed ETH/AZTEC pool ─────────────────────────────────────────
  if (!skipEthAztec) {
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
        if ((i + 1) % 20 === 0) logger.info(`  ... minted ${i + 1}/${feeMintCount}`)
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
        { value: ethSeed },
      )
      await sendAndWait(l1Client, tx, 'ETH/AZTEC pool seeded', logger)

      // Sweep
      await sendAndWait(l1Client, await seeder.write.sweep([ZERO_ADDRESS]), 'Swept ETH', logger)
      await sendAndWait(l1Client, await seeder.write.sweep([AZTEC_TOKEN]), 'Swept AZTEC', logger)
      logger.info('✅ ETH/AZTEC pool done')
    } catch (error) {
      logger.error(`Failed to seed ETH/AZTEC pool: ${error}`)
    }
  } else {
    logger.info('Skipping ETH/AZTEC pool (SKIP_ETH_AZTEC=true)')
  }

  // ── 2. Seed ERC20/WETH pool for each token ────────────────────────
  for (let i = 0; i < erc20Tokens.length; i++) {
    const token = erc20Tokens[i]
    const tokenAddr = token.l1TokenContract as `0x${string}`
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
        : BigInt(500) * (10n ** BigInt(decimals))

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

      // Seed pool
      const [c0, c1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
      const poolKey = { currency0: c0, currency1: c1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS }
      const seedTx = await seeder.write.setup(
        [poolKey, ERC20_WETH_SQRT_PRICE, ERC20_WETH_TICK_LOWER, ERC20_WETH_TICK_UPPER, ERC20_WETH_LIQUIDITY],
      )
      await sendAndWait(l1Client, seedTx, `${token.symbol}/WETH pool seeded`, logger)

      // Sweep
      await sendAndWait(l1Client, await seeder.write.sweep([tokenAddr]), `Swept ${token.symbol}`, logger)
      await sendAndWait(l1Client, await seeder.write.sweep([WETH_ADDRESS]), 'Swept WETH', logger)
      logger.info(`✅ ${token.symbol}/WETH pool done`)
    } catch (error) {
      logger.error(`Failed to seed ${token.symbol}/WETH pool: ${error}`)
    }
  }

  logger.info(`\n✅ Pool seeding complete — ${erc20Tokens.length} ERC20/WETH pools${skipEthAztec ? '' : ' + 1 ETH/AZTEC pool'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
