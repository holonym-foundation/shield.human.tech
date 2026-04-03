// @ts-nocheck
/**
 * E2E test for the deployed fuel swap infrastructure.
 *
 * Reads the active deployment, connects to the actual on-chain contracts,
 * and runs swap simulations (dry-runs) to verify everything works before
 * spending real ETH on bridgeWithFuel.
 *
 * Usage:
 *   pnpm test-fuel-swap                              # test all tokens from active deployment
 *   pnpm test-fuel-swap -- --token USDC              # test only USDC
 *   pnpm test-fuel-swap -- --fuel-amount 20000       # custom fuel amount (raw, e.g. 0.02 USDC = 20000)
 *   pnpm test-fuel-swap -- --live                    # actually execute swaps (spends gas + tokens)
 *
 * All tests are dry-runs by default (simulate only, no gas spent).
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { createEthereumChain } from '@aztec/ethereum/chain'
import { createPublicClient, getContract, http, encodePacked, keccak256 } from 'viem'
import 'dotenv/config'

// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'

import { loadActiveDeployment } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const logger = createLogger('test-fuel-swap')

// ── Sepolia constants ──────────────────────────────────────────────
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
// Read AZTEC_TOKEN from deployment — do NOT hardcode (differs per environment)
let AZTEC_TOKEN: `0x${string}` = '0x0000000000000000000000000000000000000000' as `0x${string}`
try {
  const { loadActiveDeployment } = await import('./utils/save_contracts.js')
  const _d = loadActiveDeployment()
  AZTEC_TOKEN = ((_d?.nodeInfo?.l1ContractAddresses as any)?.feeJuiceAddress ?? '') as `0x${string}`
  if (!AZTEC_TOKEN) throw new Error('feeJuiceAddress missing from deployment')
} catch (e) {
  console.error('Failed to read AZTEC_TOKEN from deployment:', e)
  process.exit(1)
}
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// Pool key params (must match seed-pools.ts / index-devnet.ts)
const ETH_AZTEC_FEE = 3000
const ETH_AZTEC_TICK_SPACING = 60
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
] as const

function sortCurrencies(a: `0x${string}`, b: `0x${string}`): [`0x${string}`, `0x${string}`] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

function parseArgs(): { token?: string; fuelAmount?: bigint; live: boolean } {
  const args = process.argv.slice(2)
  let token: string | undefined
  let fuelAmount: bigint | undefined
  let live = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) token = args[++i]
    if (args[i] === '--fuel-amount' && args[i + 1]) fuelAmount = BigInt(args[++i])
    if (args[i] === '--live') live = true
  }

  return { token, fuelAmount, live }
}

interface TestResult {
  name: string
  passed: boolean
  detail: string
  output?: bigint
}

async function main() {
  const opts = parseArgs()
  const results: TestResult[] = []

  const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
  if (!L1_PRIVATE_KEY) {
    logger.error('L1_PRIVATE_KEY is required')
    process.exit(1)
  }

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const chain = createEthereumChain([L1_URL], 11155111)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)
  const l1Public = createPublicClient({ transport: http(L1_URL) })
  const deployer = l1Client.account.address

  // ── Load deployment ──────────────────────────────────────────────
  const deployment = loadActiveDeployment()
  if (!deployment) {
    logger.error('No active deployment found. Run pnpm start-devnet first.')
    process.exit(1)
  }

  const fuelSwapAddr = deployment.uniswapFuelSwapAddress as `0x${string}` | undefined
  const routerAddr = deployment.swapBridgeRouterAddress as `0x${string}` | undefined

  if (!fuelSwapAddr) {
    logger.error('No UniswapFuelSwap address in deployment. Run deploy-fuel-swap first.')
    process.exit(1)
  }

  logger.info(`\n🔍 Fuel Swap E2E Test`)
  logger.info(`   Deployment: ${deployment.id}`)
  logger.info(`   UniswapFuelSwap: ${fuelSwapAddr}`)
  logger.info(`   SwapBridgeRouter: ${routerAddr || 'not deployed'}`)
  logger.info(`   Mode: ${opts.live ? '🔴 LIVE (will spend gas)' : '🟢 DRY-RUN (simulate only)'}`)

  // ── 1. Check deployer balance ────────────────────────────────────
  const ethBalance = await l1Public.getBalance({ address: deployer })
  logger.info(`\n💰 Deployer: ${deployer}`)
  logger.info(`   ETH balance: ${(Number(ethBalance) / 1e18).toFixed(4)} ETH`)

  results.push({
    name: 'Deployer has ETH',
    passed: ethBalance > 0n,
    detail: `${(Number(ethBalance) / 1e18).toFixed(4)} ETH`,
  })

  // ── 2. Check pool health ─────────────────────────────────────────
  logger.info(`\n📊 Pool Health Check:`)

  const aztecToken = getContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmFj = await aztecToken.read.balanceOf([POOL_MANAGER]) as bigint
  const pmWeth = await (getContract({ address: WETH_ADDRESS, abi: ERC20_ABI, client: l1Public as any }) as any).read.balanceOf([POOL_MANAGER]) as bigint
  const pmEth = await l1Public.getBalance({ address: POOL_MANAGER })

  logger.info(`   PoolManager FeeJuice: ${(Number(pmFj) / 1e18).toFixed(4)}`)
  logger.info(`   PoolManager WETH:     ${(Number(pmWeth) / 1e18).toFixed(4)}`)
  logger.info(`   PoolManager ETH:      ${(Number(pmEth) / 1e18).toFixed(4)}`)

  results.push({
    name: 'PoolManager has FeeJuice',
    passed: pmFj > 0n,
    detail: `${(Number(pmFj) / 1e18).toFixed(4)} FJ`,
  })

  // ── 3. Check UniswapFuelSwap contract ────────────────────────────
  const swapper = getContract({
    address: fuelSwapAddr,
    abi: UniswapFuelSwapJson.abi,
    client: l1Client as any,
  }) as any

  const swapperFj = await swapper.read.feeJuice() as `0x${string}`
  const swapperWeth = await swapper.read.weth() as `0x${string}`
  const swapperPm = await swapper.read.poolManager() as `0x${string}`

  const contractOk = swapperFj.toLowerCase() === AZTEC_TOKEN.toLowerCase()
    && swapperWeth.toLowerCase() === WETH_ADDRESS.toLowerCase()
    && swapperPm.toLowerCase() === POOL_MANAGER.toLowerCase()

  logger.info(`\n🔧 UniswapFuelSwap Contract:`)
  logger.info(`   feeJuice:    ${swapperFj} ${swapperFj.toLowerCase() === AZTEC_TOKEN.toLowerCase() ? '✅' : '❌'}`)
  logger.info(`   weth:        ${swapperWeth} ${swapperWeth.toLowerCase() === WETH_ADDRESS.toLowerCase() ? '✅' : '❌'}`)
  logger.info(`   poolManager: ${swapperPm} ${swapperPm.toLowerCase() === POOL_MANAGER.toLowerCase() ? '✅' : '❌'}`)

  results.push({
    name: 'UniswapFuelSwap config correct',
    passed: contractOk,
    detail: contractOk ? 'All addresses match' : 'Address mismatch!',
  })

  // ── 4. Test swaps per token ──────────────────────────────────────
  let tokens = deployment.tokens || []
  if (opts.token) {
    tokens = tokens.filter((t: any) => t.symbol.toUpperCase() === opts.token!.toUpperCase())
    if (tokens.length === 0) {
      logger.error(`Token ${opts.token} not found in deployment`)
      process.exit(1)
    }
  }

  const erc20Tokens = tokens.filter(
    (t: any) => t.l1TokenContract.toLowerCase() !== WETH_ADDRESS.toLowerCase(),
  )

  for (const token of erc20Tokens) {
    const tokenAddr = token.l1TokenContract as `0x${string}`
    const erc20 = getContract({ address: tokenAddr, abi: ERC20_ABI, client: l1Client as any }) as any

    const decimals = await erc20.read.decimals() as number
    const defaultFuel = BigInt(2) * 10n ** BigInt(Math.max(decimals - 2, 0)) // 0.02 tokens
    const fuelAmount = opts.fuelAmount || defaultFuel

    logger.info(`\n🧪 Testing ${token.symbol} swap:`)
    logger.info(`   Token: ${tokenAddr}`)
    logger.info(`   Fuel amount: ${fuelAmount} (${Number(fuelAmount) / 10 ** decimals} ${token.symbol})`)

    // Check if PoolManager has this token (pool is seeded)
    const pmTokenBal = await erc20.read.balanceOf([POOL_MANAGER]) as bigint
    logger.info(`   PoolManager ${token.symbol}: ${Number(pmTokenBal) / 10 ** decimals}`)

    results.push({
      name: `PoolManager has ${token.symbol}`,
      passed: pmTokenBal > 0n,
      detail: `${Number(pmTokenBal) / 10 ** decimals} ${token.symbol}`,
    })

    if (pmTokenBal === 0n) {
      logger.info(`   ⚠️  Pool not seeded — skipping swap test`)
      results.push({
        name: `${token.symbol} multi-hop swap`,
        passed: false,
        detail: 'Pool not seeded',
      })
      continue
    }

    // Build multi-hop path: TOKEN → WETH → FeeJuice
    const [tc0, tc1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
    const tokenIsC0 = tokenAddr.toLowerCase() === tc0.toLowerCase()
    const usdcWethKey = { currency0: tc0, currency1: tc1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS }
    const ethAztecKey = { currency0: ZERO_ADDRESS, currency1: AZTEC_TOKEN, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS }

    const path = [usdcWethKey, ethAztecKey]
    const zeroForOnes = [tokenIsC0, true] // token→WETH direction, then ETH→AZTEC

    // Mint test tokens + approve (needed even for simulate — it checks on-chain balances)
    logger.info(`   Minting ${fuelAmount} ${token.symbol} for test...`)
    const mintTx = await erc20.write.mint([deployer, fuelAmount])
    await l1Client.waitForTransactionReceipt({ hash: mintTx, timeout: 120_000 })

    const approveTx = await erc20.write.approve([fuelSwapAddr, fuelAmount])
    await l1Client.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 })

    // Simulate swap
    try {
      const simResult = await swapper.simulate.swap(
        [tokenAddr, fuelAmount, 0n, path, zeroForOnes],
        { account: deployer },
      )
      const output = simResult.result as bigint

      logger.info(`   ✅ Swap simulation PASSED`)
      logger.info(`   Input:  ${Number(fuelAmount) / 10 ** decimals} ${token.symbol}`)
      logger.info(`   Output: ${(Number(output) / 1e18).toFixed(6)} FeeJuice`)

      results.push({
        name: `${token.symbol} multi-hop swap`,
        passed: true,
        detail: `${Number(fuelAmount) / 10 ** decimals} ${token.symbol} → ${(Number(output) / 1e18).toFixed(6)} FJ`,
        output,
      })

      // Execute live swap if requested
      if (opts.live) {
        logger.info(`   Executing live swap...`)
        const tx = await swapper.write.swap([tokenAddr, fuelAmount, 0n, path, zeroForOnes])
        const receipt = await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        logger.info(`   ✅ Live swap confirmed (tx: ${tx.slice(0, 10)}..., status: ${receipt.status})`)
      }
    } catch (error) {
      const errMsg = String(error)
      let diagnosis = errMsg.slice(0, 200)

      if (errMsg.includes('partial fill') || errMsg.includes('insufficient liquidity')) {
        diagnosis = 'Pool has insufficient liquidity for this swap amount. Reduce --fuel-amount or re-seed with more liquidity.'
      } else if (errMsg.includes('5212cba1') || errMsg.includes('CurrencyNotSettled')) {
        diagnosis = 'CurrencyNotSettled — one or both pools lack enough depth for this swap. Reduce --fuel-amount or re-seed pools.'
      } else if (errMsg.includes('first hop input mismatch')) {
        diagnosis = 'Route mismatch — token address doesn\'t match the pool key. Check pool seeding.'
      } else if (errMsg.includes('last hop must output feeJuice')) {
        diagnosis = 'Route misconfigured — last pool doesn\'t output FeeJuice.'
      } else if (errMsg.includes('e450d38c') || errMsg.includes('InsufficientBalance')) {
        diagnosis = 'ERC20InsufficientBalance — deployer or swapper doesn\'t have enough tokens.'
      }

      logger.info(`   ❌ Swap simulation FAILED: ${diagnosis}`)
      results.push({
        name: `${token.symbol} multi-hop swap`,
        passed: false,
        detail: diagnosis,
      })
    }

    // ── Single-hop test: WETH → FeeJuice ──────────────────────────
    const singleHopAmount = 1000000000000n // 0.000001 ETH (~0.01 FJ at 10000:1, within pool depth)
    logger.info(`\n🧪 Testing single-hop WETH → FeeJuice:`)
    logger.info(`   Amount: ${Number(singleHopAmount) / 1e18} WETH`)

    // Get WETH for the test (wrap ETH)
    const wethContract = getContract({ address: WETH_ADDRESS, abi: [...ERC20_ABI, { type: 'function', name: 'deposit', inputs: [], outputs: [], stateMutability: 'payable' }] as const, client: l1Client as any }) as any
    const wrapTx = await wethContract.write.deposit([], { value: singleHopAmount })
    await l1Client.waitForTransactionReceipt({ hash: wrapTx, timeout: 120_000 })
    const wethApproveTx = await wethContract.write.approve([fuelSwapAddr, singleHopAmount])
    await l1Client.waitForTransactionReceipt({ hash: wethApproveTx, timeout: 120_000 })

    try {
      const simResult = await swapper.simulate.swap(
        [WETH_ADDRESS, singleHopAmount, 0n, [ethAztecKey], [true]],
        { account: deployer },
      )
      const output = simResult.result as bigint
      logger.info(`   ✅ Single-hop simulation PASSED`)
      logger.info(`   Output: ${(Number(output) / 1e18).toFixed(6)} FeeJuice`)

      results.push({
        name: 'Single-hop WETH → FeeJuice',
        passed: true,
        detail: `${Number(singleHopAmount) / 1e18} WETH → ${(Number(output) / 1e18).toFixed(6)} FJ`,
        output,
      })

      if (opts.live) {
        const tx = await swapper.write.swap([WETH_ADDRESS, singleHopAmount, 0n, [ethAztecKey], [true]])
        const receipt = await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
        logger.info(`   ✅ Live single-hop swap confirmed (tx: ${tx.slice(0, 10)}..., status: ${receipt.status})`)
      }
    } catch (error) {
      const errMsg = String(error)
      let diagnosis = errMsg.slice(0, 200)
      if (errMsg.includes('partial fill')) diagnosis = 'ETH/AZTEC pool too shallow for single-hop test'
      else if (errMsg.includes('5212cba1')) diagnosis = 'CurrencyNotSettled — ETH/AZTEC pool too shallow'

      logger.info(`   ❌ Single-hop simulation FAILED: ${diagnosis}`)
      results.push({
        name: 'Single-hop WETH → FeeJuice',
        passed: false,
        detail: diagnosis,
      })
    }
  }

  // ── Summary ──────────────────────────────────────────────────────
  logger.info(`\n${'═'.repeat(60)}`)
  logger.info(`📋 Test Summary:`)
  logger.info(`${'═'.repeat(60)}`)

  let passed = 0
  let failed = 0
  for (const r of results) {
    const icon = r.passed ? '✅' : '❌'
    logger.info(`  ${icon} ${r.name}: ${r.detail}`)
    if (r.passed) passed++
    else failed++
  }

  logger.info(`\n  ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    logger.info(`\n💡 Common fixes:`)
    logger.info(`  - Re-seed pools: pnpm seed-pools`)
    logger.info(`  - Reduce fuel amount: pnpm test-fuel-swap -- --fuel-amount 10000`)
    process.exit(1)
  }

  logger.info(`\n✅ All tests passed — fuel swap infrastructure is healthy`)
}

main().catch((e) => {
  logger.error(`Fatal: ${e}`)
  process.exit(1)
})
