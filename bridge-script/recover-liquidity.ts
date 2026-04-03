// @ts-nocheck
/**
 * Recover ETH/WETH/tokens from old PoolSeeder positions.
 *
 * Calls setup() with NEGATIVE liquidityDelta on each seeder to remove liquidity,
 * then sweep() to pull tokens back to the deployer wallet.
 *
 * Usage:
 *   pnpm recover-liquidity
 *   DRY_RUN=true pnpm recover-liquidity   # simulate only, don't send txs
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { getContract, getAddress, createPublicClient, http } from 'viem'
import 'dotenv/config'

// @ts-ignore
import PoolSeederJson from '../l1-contracts/out/SeedUniswapPools.s.sol/PoolSeeder.json'

import { getL1RpcUrl } from './config/config.js'

const PoolSeederAbi = PoolSeederJson.abi
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`
const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const FJ_CORRECT = getAddress('0x762c132040fda6183066fa3b14d985ee55aa3c18')
const FJ_WRONG = getAddress('0x35d0186d1FD53b72996475D965C5Ed171D52b986')
const USDC = getAddress('0xC08907012963bC60e90DD231c25C9a6aB5A1dC03')

const WETH_ABI = [
  { type: 'function', name: 'withdraw', inputs: [{ name: 'wad', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'balanceOf', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

interface Position {
  seeder: `0x${string}`
  label: string
  currency0: `0x${string}`
  currency1: `0x${string}`
  fee: number
  tickSpacing: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  keep?: boolean // if true, don't remove — we want this position
}

// ── All positions created during this session ──────────────────────
const positions: Position[] = [
  {
    seeder: '0x3adcf1f718416363e2c854b41a57dfe860e3e9ae',
    label: 'ETH/AZTEC #1 (wrong FJ, narrow) — SKIP (dry-run failed)',
    currency0: ZERO, currency1: FJ_WRONG,
    fee: 3000, tickSpacing: 60,
    tickLower: 69060, tickUpper: 115140,
    liquidity: 1n * 10n ** 18n,
    keep: true, // dry-run failed — skip
  },
  {
    seeder: '0x75f894b9dfb64b7bf6ae872654d53e24f865d8e5',
    label: 'ETH/AZTEC #2 (correct FJ, L=1e18, full)',
    currency0: ZERO, currency1: FJ_CORRECT,
    fee: 3000, tickSpacing: 60,
    tickLower: -887220, tickUpper: 887220,
    liquidity: 1n * 10n ** 18n,
  },
  {
    seeder: '0x1efd161bd0103abd8a9949203915645b85c4f828',
    label: 'USDC/WETH #2 (narrow, L=6e13) — SKIP (dry-run failed)',
    currency0: BigInt(USDC) < BigInt(WETH) ? USDC : WETH,
    currency1: BigInt(USDC) < BigInt(WETH) ? WETH : USDC,
    fee: 3000, tickSpacing: 60,
    tickLower: 169800, tickUpper: 229800,
    liquidity: 6n * 10n ** 13n,
    keep: true, // dry-run failed — skip
  },
  {
    seeder: '0x55d638b52a30602ffb924f73d2afaa3428ecb09b',
    label: 'USDC/WETH #3 (full range, L=6e13) — SKIP (dry-run failed)',
    currency0: BigInt(USDC) < BigInt(WETH) ? USDC : WETH,
    currency1: BigInt(USDC) < BigInt(WETH) ? WETH : USDC,
    fee: 3000, tickSpacing: 60,
    tickLower: -887220, tickUpper: 887220,
    liquidity: 6n * 10n ** 13n,
    keep: true, // dry-run failed — skip
  },
  {
    // The Forge-deployed seeder — this is the ACTIVE fuel swap pool, KEEP IT
    seeder: '0xF4C2B985f63D00B681f68C48eb8ad72e78607f4d',
    label: 'Forge ETH/AZTEC (correct FJ, L=10e18) — KEEP',
    currency0: ZERO, currency1: FJ_CORRECT,
    fee: 3000, tickSpacing: 60,
    tickLower: -887220, tickUpper: 887220,
    liquidity: 10n * 10n ** 18n,
    keep: true, // ← DO NOT REMOVE — this powers the fuel swap
  },
]

async function main() {
  const logger = createLogger('aztec:recover-liquidity')

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
  if (!L1_PRIVATE_KEY) { logger.error('L1_PRIVATE_KEY required'); process.exit(1) }

  const dryRun = process.env.DRY_RUN === 'true'
  if (dryRun) logger.info('🔍 DRY RUN — no transactions will be sent')

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)
  const deployer = l1Client.account.address
  const l1Public = createPublicClient({ transport: http(L1_URL) })

  // ── Log deployer balances BEFORE ──
  const ethBefore = await l1Public.getBalance({ address: deployer })
  const wethBefore = await getContract({ address: WETH, abi: ERC20_ABI, client: l1Public as any }).read.balanceOf([deployer]) as bigint
  logger.info(`\n--- Deployer Balances (BEFORE) ---`)
  logger.info(`  ETH:  ${(Number(ethBefore) / 1e18).toFixed(6)}`)
  logger.info(`  WETH: ${(Number(wethBefore) / 1e18).toFixed(6)}`)

  // ── 1. Sweep stuck tokens from seeders ──
  logger.info('\n--- Sweeping stuck tokens from seeders ---')
  for (const p of positions) {
    const seeder = getContract({ address: p.seeder as `0x${string}`, abi: PoolSeederAbi, client: l1Client as any }) as any
    for (const [token, label] of [[ZERO, 'ETH'], [FJ_CORRECT, 'FJ'], [FJ_WRONG, 'FJ(wrong)'], [WETH, 'WETH'], [USDC, 'USDC']] as const) {
      try {
        let bal: bigint
        if (token === ZERO) {
          bal = await l1Public.getBalance({ address: p.seeder as `0x${string}` })
        } else {
          bal = await getContract({ address: token as `0x${string}`, abi: ERC20_ABI, client: l1Public as any }).read.balanceOf([p.seeder]) as bigint
        }
        if (bal > 0n) {
          logger.info(`  ${p.seeder.slice(0, 10)}: sweeping ${label} (${(Number(bal) / (label === 'USDC' ? 1e6 : 1e18)).toFixed(4)})`)
          if (!dryRun) {
            const tx = await seeder.write.sweep([token])
            await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })
          }
        }
      } catch { /* seeder may not have sweep for this token */ }
    }
  }

  // ── 2. Remove liquidity from positions we don't need ──
  logger.info('\n--- Removing liquidity from old positions ---')
  for (const p of positions) {
    if (p.keep) {
      logger.info(`  ⏭️  SKIPPING ${p.label} (marked as keep)`)
      continue
    }

    const seeder = getContract({ address: p.seeder as `0x${string}`, abi: PoolSeederAbi, client: l1Client as any }) as any
    const poolKey = {
      currency0: p.currency0,
      currency1: p.currency1,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: ZERO,
    }
    const negativeLiquidity = -p.liquidity

    logger.info(`  📤 ${p.label}`)
    logger.info(`     seeder: ${p.seeder}`)
    logger.info(`     removing L=${p.liquidity.toString()}`)

    if (dryRun) {
      // Simulate
      try {
        await seeder.simulate.setup(
          [poolKey, 7922816251426433759354395033600n, p.tickLower, p.tickUpper, negativeLiquidity],
          { value: 0n },
        )
        logger.info(`     ✅ dry-run passed`)
      } catch (e: any) {
        logger.warn(`     ❌ dry-run failed: ${e.shortMessage?.slice(0, 100) || e.message?.slice(0, 100)}`)
      }
    } else {
      try {
        const tx = await seeder.write.setup(
          [poolKey, 7922816251426433759354395033600n, p.tickLower, p.tickUpper, negativeLiquidity],
          { value: 0n },
        )
        await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        logger.info(`     ✅ liquidity removed (tx: ${tx.slice(0, 14)}...)`)

        // Sweep all tokens back
        for (const token of [ZERO, p.currency0, p.currency1]) {
          try {
            const sweepTx = await seeder.write.sweep([token])
            await l1Client.waitForTransactionReceipt({ hash: sweepTx, timeout: 60_000 })
          } catch { /* ignore if nothing to sweep */ }
        }
        logger.info(`     ✅ swept`)
      } catch (e: any) {
        logger.error(`     ❌ failed: ${e.shortMessage?.slice(0, 150) || e.message?.slice(0, 150)}`)
      }
    }
  }

  // ── 3. Unwrap WETH to ETH ──
  logger.info('\n--- Unwrapping WETH to ETH ---')
  const wethContract = getContract({ address: WETH, abi: WETH_ABI, client: l1Client as any }) as any
  const wethBal = await wethContract.read.balanceOf([deployer]) as bigint
  if (wethBal > 0n) {
    logger.info(`  Unwrapping ${(Number(wethBal) / 1e18).toFixed(6)} WETH`)
    if (!dryRun) {
      const tx = await wethContract.write.withdraw([wethBal])
      await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })
      logger.info(`  ✅ Unwrapped`)
    }
  } else {
    logger.info('  No WETH to unwrap')
  }

  // ── Log deployer balances AFTER ──
  const ethAfter = await l1Public.getBalance({ address: deployer })
  const wethAfter = await getContract({ address: WETH, abi: ERC20_ABI, client: l1Public as any }).read.balanceOf([deployer]) as bigint
  logger.info(`\n--- Deployer Balances (AFTER) ---`)
  logger.info(`  ETH:  ${(Number(ethAfter) / 1e18).toFixed(6)}`)
  logger.info(`  WETH: ${(Number(wethAfter) / 1e18).toFixed(6)}`)
  logger.info(`  Recovered: ${((Number(ethAfter) - Number(ethBefore)) / 1e18).toFixed(6)} ETH`)
}

main().catch((e) => { console.error(e); process.exit(1) })
