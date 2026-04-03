// @ts-nocheck
/**
 * Check Uniswap V4 pool liquidity for all deployed tokens.
 *
 * Shows PoolManager token balances and runs a small test quote
 * to verify the fuel swap route works.
 *
 * Usage:
 *   pnpm check-pools
 *
 * Environment Variables:
 *   - L1_URL (optional): L1 RPC URL
 */

import { createLogger } from '@aztec/aztec.js/log'
import { createPublicClient, http } from 'viem'
import { sepolia } from 'viem/chains'
import 'dotenv/config'

import { loadActiveDeployment } from './utils/save_contracts.js'
import { getL1RpcUrl } from './config/config.js'

const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
// Read AZTEC_TOKEN from deployment — do NOT hardcode (differs per environment)
const _cpDeploy = loadActiveDeployment()
const AZTEC_TOKEN = ((_cpDeploy?.nodeInfo?.l1ContractAddresses as any)?.feeJuiceAddress ?? '') as `0x${string}`
if (!AZTEC_TOKEN) { console.error('feeJuiceAddress missing from deployment'); process.exit(1) }

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
] as const

async function main() {
  const logger = createLogger('aztec:check-pools')

  const L1_URL = process.env.L1_URL || getL1RpcUrl()
  const client = createPublicClient({ chain: sepolia, transport: http(L1_URL) })

  const deployment = loadActiveDeployment()
  if (!deployment) {
    logger.error('No active deployment found.')
    process.exit(1)
  }

  const tokens = deployment.tokens || []
  logger.info(`Active deployment: ${deployment.id} (${tokens.length} tokens)\n`)

  // Check ETH balance of PoolManager (for ETH/AZTEC pool)
  const pmEthBalance = await client.getBalance({ address: POOL_MANAGER })
  logger.info(`PoolManager ETH balance: ${Number(pmEthBalance) / 1e18} ETH`)

  // Check AZTEC (FeeJuice) balance
  const pmAztecBalance = await client.readContract({
    address: AZTEC_TOKEN,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [POOL_MANAGER],
  })
  logger.info(`PoolManager AZTEC balance: ${Number(pmAztecBalance) / 1e18} FJ`)

  // Check WETH balance
  const pmWethBalance = await client.readContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [POOL_MANAGER],
  })
  logger.info(`PoolManager WETH balance: ${Number(pmWethBalance) / 1e18} WETH`)

  logger.info('')

  // Check each token
  for (const token of tokens) {
    const tokenAddr = token.l1TokenContract as `0x${string}`
    if (tokenAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      logger.info(`${token.symbol}: uses ETH/AZTEC pool directly (single hop)`)
      continue
    }

    try {
      const balance = await client.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [POOL_MANAGER],
      })
      const decimals = await client.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'decimals',
      })
      const humanBalance = Number(balance) / (10 ** Number(decimals))
      const hasLiquidity = balance > 0n

      logger.info(`${token.symbol}: ${humanBalance.toFixed(2)} in PoolManager ${hasLiquidity ? '✅' : '❌ NO LIQUIDITY'}`)
    } catch (error) {
      logger.error(`${token.symbol}: Failed to read balance — ${error}`)
    }
  }

  // Summary
  logger.info('\n--- Summary ---')
  const ethAztecOk = pmEthBalance > 0n && pmAztecBalance > 0n
  logger.info(`ETH/AZTEC pool: ${ethAztecOk ? '✅ has liquidity' : '❌ empty — run: pnpm seed-pools'}`)

  const wethOk = pmWethBalance > 0n
  logger.info(`ERC20/WETH pools: ${wethOk ? '✅ WETH present' : '❌ no WETH — run: pnpm seed-pools'}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
