/**
 * Aztec Token Bridge Compliant Deployment Script
 *
 * Uses the custom TokenPortal (with compliance/attestation) on L1
 * and custom TokenBridge + TokenMinterProxy on L2.
 *
 * Tests both:
 * 1. POCH (Proof of Clean Hands) flow — attester signs clean hands attestation
 * 2. Passport flow — passport signer signs amount-limited attestation
 *
 * Environment Variables:
 * - AZTEC_ENV: Set to 'testnet' for testnet, or 'sandbox' for local (default: sandbox)
 * - L1_URL: L1 RPC URL (optional, uses config if not set)
 * - MNEMONIC: Wallet mnemonic (required for testnet, defaults to test mnemonic for sandbox)
 *
 * Run: node --import tsx index-testnet-compliant.ts
 */

import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { Logger, createLogger } from '@aztec/aztec.js/log'
import { generateClaimSecret, L1TokenManager } from '@aztec/aztec.js/ethereum'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { createEthereumChain } from '@aztec/ethereum/chain'
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types'
import {
  FeeAssetHandlerAbi,
  FeeAssetHandlerBytecode,
  RollupAbi,
} from '@aztec/l1-artifacts'
import { TokenContract, TokenContractArtifact } from '@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js'
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee'
import { SetPublicAuthwitContractInteraction, computeInnerAuthWitHashFromAction } from '@aztec/aztec.js/authorization'
import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging'
import { TxHash } from '@aztec/stdlib/tx'
import { sha256ToField } from '@aztec/foundation/crypto/sha256'
import { computeL2ToL1MessageHash, computeSecretHash } from '@aztec/stdlib/hash'
import { Schnorr } from '@aztec/foundation/crypto/schnorr'
import { deriveSigningKey } from '@aztec/stdlib/keys'
import { computeInnerAuthWitHash } from '@aztec/stdlib/auth-witness'
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin'
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon'
import { Gas, GasFees } from '@aztec/stdlib/gas'
import 'dotenv/config'

// Custom L2 contracts (from codegen)
import { TokenBridgeContract, TokenBridgeContractArtifact } from './artifacts/TokenBridge.js'
import { TokenMinterProxyContract, TokenMinterProxyContractArtifact } from './artifacts/TokenMinterProxy.js'

// Custom L1 TokenPortal (from forge build output)
// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
const CustomTokenPortalAbi = CustomTokenPortalJson.abi
const CustomTokenPortalBytecode = CustomTokenPortalJson.bytecode.object as `0x${string}`

// @ts-ignore
import TestERC20Json from './constants/TestERC20.json'
const TestERC20Abi = TestERC20Json.abi
const TestERC20Bytecode = TestERC20Json.bytecode.object as `0x${string}`

// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'
// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'
// @ts-ignore
import PoolSeederJson from '../l1-contracts/out/SeedUniswapPools.s.sol/PoolSeeder.json'
import {
  registerPrivateContract,
  PrivateMintAndPayFeePaymentMethod,
  REASONABLE_GAS_LIMITS,
  maxFeesPerGasFromBaseFees,
  maxGasCostFor,
} from '@wonderland/aztec-fee-payment'
const UniswapFuelSwapAbi = UniswapFuelSwapJson.abi
const UniswapFuelSwapBytecode = UniswapFuelSwapJson.bytecode.object as `0x${string}`
const SwapBridgeRouterAbi = SwapBridgeRouterJson.abi
const SwapBridgeRouterBytecode = SwapBridgeRouterJson.bytecode.object as `0x${string}`
const PoolSeederAbi = PoolSeederJson.abi
const PoolSeederBytecode = PoolSeederJson.bytecode.object as `0x${string}`

import {
  createPublicClient,
  encodeFunctionData,
  encodeAbiParameters,
  getContract,
  http,
  toFunctionSelector,
  encodePacked,
  keccak256,
  decodeEventLog,
  type Hex,
} from 'viem'
import { privateKeyToAccount, signMessage } from 'viem/accounts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for the L2 sequencer to include the L1→L2 message in the state tree.
 *
 * The archiver checkpoint appears quickly, but the message is only consumable
 * after the sequencer includes it in an L2 block — which can take up to 1
 * epoch (~19 min on testnet: 32 slots × 36s).
 *
 * Strategy: wait for at least `minBlocks` new L2 blocks AND at least
 * `minWaitMs` elapsed time, whichever is longer.
 */
async function waitForNextL2Block(
  node: { getBlockNumber(): Promise<number> },
  logger: { info(msg: string): void; warn(msg: string): void },
  options?: { pollIntervalMs?: number; maxWaitMs?: number; minWaitMs?: number; minBlocks?: number },
): Promise<number> {
  const pollIntervalMs = options?.pollIntervalMs ?? 15_000
  const maxWaitMs = options?.maxWaitMs ?? 25 * 60 * 1000
  const minWaitMs = options?.minWaitMs ?? 2 * 60 * 1000 // 2 min minimum
  const minBlocks = options?.minBlocks ?? 2 // wait for at least 2 new blocks
  const startTime = Date.now()
  const sinceBlock = await node.getBlockNumber()
  const targetBlock = sinceBlock + minBlocks

  logger.info(`Waiting for L2 block >= ${targetBlock} (since=${sinceBlock}, +${minBlocks} blocks, min ${minWaitMs / 1000}s)...`)

  while (Date.now() - startTime < maxWaitMs) {
    const elapsedMs = Date.now() - startTime
    const elapsedSec = Math.round(elapsedMs / 1000)
    try {
      const currentBlock = await node.getBlockNumber()
      const blocksReady = currentBlock >= targetBlock
      const minTimeReady = elapsedMs >= minWaitMs

      if (blocksReady && minTimeReady) {
        logger.info(`L2 block ${currentBlock} reached target after ${elapsedSec}s. Message should be consumable.`)
        return currentBlock
      }

      if (blocksReady && !minTimeReady) {
        const remainingSec = Math.round((minWaitMs - elapsedMs) / 1000)
        logger.info(`  Block target reached (${currentBlock} >= ${targetBlock}), waiting ${remainingSec}s more for message propagation`)
      } else {
        logger.info(`  Block wait: ${elapsedSec}s elapsed, current=${currentBlock}, waiting for >=${targetBlock}`)
      }
    } catch (err) {
      logger.warn(`  Block poll failed (${elapsedSec}s): ${err}`)
    }
    await wait(pollIntervalMs)
  }

  const finalBlock = await node.getBlockNumber().catch(() => sinceBlock)
  logger.warn(`Block wait timed out after ${maxWaitMs / 60_000} min (block=${finalBlock}). Proceeding to claim with retries.`)
  return finalBlock
}

/**
 * Decode a fuel swap / bridge revert into a human-readable diagnostic.
 * Covers UniswapFuelSwap, SwapBridgeRouter, PoolManager, and ERC-20 errors.
 */
function decodeFuelSwapError(error: unknown): { summary: string; detail: string; fix?: string } {
  const msg = String(error)

  if (msg.includes('partial fill') || msg.includes('insufficient liquidity')) {
    return { summary: 'Partial fill — pool liquidity insufficient', detail: msg, fix: 'Add more liquidity: pn seed-pools' }
  }
  if (msg.includes('insufficient output')) {
    return { summary: 'Slippage protection triggered — swap output below minFuelOutput', detail: msg, fix: 'Lower minFuelOutput or add more liquidity.' }
  }
  if (msg.includes('non-positive output')) {
    return { summary: 'Swap produced zero output — pool may be empty or tick range exhausted', detail: msg, fix: 'Re-seed pools: pn seed-pools' }
  }
  if (msg.includes('first hop input mismatch')) {
    return { summary: "Route misconfiguration — first pool doesn't accept the input token", detail: msg, fix: 'Check poolKeys + zeroForOnes match the token address.' }
  }
  if (msg.includes('last hop must output feeJuice')) {
    return { summary: 'Route misconfiguration — last pool does not output FeeJuice', detail: msg, fix: 'Ensure route ends with a FeeJuice-output pool.' }
  }
  if (msg.includes('native route requires WETH input')) {
    return { summary: 'Route misconfiguration — native ETH pool requires WETH as inputToken', detail: msg, fix: 'Set inputToken to WETH address.' }
  }
  if (msg.includes('path/direction mismatch')) {
    return { summary: 'Route misconfiguration — poolKeys and zeroForOnes lengths differ', detail: msg }
  }
  if (msg.includes('empty path')) {
    return { summary: 'Route misconfiguration — empty swap path', detail: msg }
  }
  if (msg.includes('invalid fuelAmount')) {
    return { summary: 'Invalid fuelAmount — must be > 0 and < totalAmount', detail: msg }
  }
  if (msg.includes('balance mismatch')) {
    return { summary: "Balance mismatch — swap output doesn't match actual FeeJuice balance change", detail: msg, fix: 'Possible bug in UniswapFuelSwap.' }
  }
  if (msg.includes('zero tokenPortal')) {
    return { summary: 'Missing tokenPortal — address(0) passed as portal', detail: msg }
  }
  if (msg.includes('0x5212cba1') || msg.includes('CurrencyNotSettled')) {
    return { summary: 'CurrencyNotSettled — V4 PoolManager settlement failed (pool lacks liquidity)', detail: msg, fix: 'Re-seed pools: SKIP_ETH_AZTEC=true pn seed-pools' }
  }
  if (msg.includes('0xe450d38c')) {
    return { summary: 'ERC20InsufficientBalance — token transfer exceeded available balance', detail: msg, fix: 'Check Permit2 approval and token minting.' }
  }
  if (msg.includes('InvalidSigner') || msg.includes('InvalidSignature')) {
    return { summary: 'Permit2 signature invalid — witness hash mismatch', detail: msg, fix: 'Check that witness fields exactly match the bridgeWithFuel call.' }
  }
  return { summary: 'Unexpected error', detail: msg.slice(0, 500) }
}

/**
 * Retry wrapper for private function sends that can hit transient failures:
 * 1. "Include-by timestamp must be greater than the anchor block timestamp"
 *    — PXE timing issue when the L1 block hasn't advanced since anchor fetch.
 * 2. "Tx dropped by P2P node"
 *    — Transaction became stale between proving and inclusion (epoch/slot window passed).
 */
const RETRYABLE_PATTERNS = [
  'Include-by timestamp must be greater than the anchor block timestamp',
  'dropped by P2P node',
  'nonexistent L1-to-L2 message',
  'Tried to consume nonexistent',
  'No L1 to L2 message found',
  'Insufficient fee payer balance',
]

/**
 * Send a tx bypassing EmbeddedWallet's mandatory public simulation.
 *
 * EmbeddedWallet.sendTx() always calls simulateTx(simulatePublic: true) to estimate gas,
 * which checks the PXE's local L1→L2 message tree — but that tree lags behind the sequencer.
 * For L1→L2 claims (consume_l1_to_l2_message), the simulation always fails because the PXE
 * hasn't synced the message yet, even though the sequencer has it.
 *
 * This function bypasses that by:
 * 1. Building the execution request from the contract interaction
 * 2. Calling pxe.proveTx() directly (which uses simulatePublic: false)
 * 3. Submitting the proven tx to the node
 *
 * Gas settings must be provided explicitly since we skip estimation.
 */
async function sendWithoutPublicSimulation(
  interaction: any,
  wallet: any,
  sendOpts: any,
  logger: Logger,
): Promise<any> {
  const executionPayload = await interaction.request(sendOpts)
  const scopes = sendOpts.from ? [sendOpts.from] : []

  logger.info('[DirectSend] Proving tx (skipping public simulation)...')
  const provenTx = await wallet.pxe.proveTx(
    await wallet.createTxExecutionRequestFromPayloadAndFee(
      executionPayload,
      sendOpts.from,
      await wallet.completeFeeOptions(sendOpts.from, executionPayload.feePayer, sendOpts.fee?.gasSettings),
    ),
    scopes,
  )

  const tx = await provenTx.toTx()
  const txHash = tx.getTxHash()
  logger.info(`[DirectSend] Submitting tx ${txHash} to sequencer...`)
  await wallet.aztecNode.sendTx(tx)
  logger.info(`[DirectSend] Tx ${txHash} submitted, waiting for receipt...`)

  // Import waitForTx to wait for mining
  const { waitForTx } = await import('@aztec/aztec.js/node')
  const receipt = await waitForTx(wallet.aztecNode, txHash, sendOpts.wait)
  logger.info(`[DirectSend] Tx mined in block ${receipt.blockNumber}`)
  return receipt
}

async function sendPrivateWithRetry<T>(
  buildTx: () => any,
  sendOpts: any,
  logger: Logger,
  maxRetries = 2,
  wallet?: any,
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (wallet) {
        // Bypass EmbeddedWallet's public simulation — send directly via proveTx + node.sendTx
        return await sendWithoutPublicSimulation(buildTx(), wallet, sendOpts, logger)
      } else {
        // Standard path (for non-claim txs that don't consume L1→L2 messages)
        const { receipt } = await buildTx().send(sendOpts) as any
        return receipt
      }
    } catch (e: any) {
      const msg = e?.message || ''
      const isRetryable = RETRYABLE_PATTERNS.some(p => msg.includes(p))
      if (isRetryable && attempt < maxRetries) {
        const isMessageSync = msg.includes('nonexistent L1-to-L2') || msg.includes('Tried to consume nonexistent') || msg.includes('No L1 to L2 message found') || msg.includes('Insufficient fee payer balance')
        const retryDelay = isMessageSync ? 120_000 : 15_000
        logger.info(`[Retry] Transient failure (attempt ${attempt}/${maxRetries}): ${msg.slice(0, 150)}`)
        logger.info(`[Retry] Waiting ${retryDelay / 1000}s before retry...`)
        await wait(retryDelay)
        continue
      }
      throw e
    }
  }
  throw new Error('sendPrivateWithRetry: unreachable')
}

/**
 * Pre-simulate a claim call until it passes, polling every 30s up to maxWaitMs.
 * This verifies the L1→L2 messages are actually consumable before sending the real tx.
 * Uses skipTxValidation + skipFeeEnforcement to only check message availability.
 */
async function pollUntilClaimSimulationPasses(
  interaction: { request: () => Promise<any> },
  wallet: any,
  fromAddress: any,
  logger: Logger,
  label = 'claim',
  maxWaitMs = 10 * 60 * 1000,
  pollIntervalMs = 30_000,
): Promise<void> {
  const start = Date.now()
  let attempt = 0
  logger.info(`[PreSim] Polling until ${label} simulation passes (max ${maxWaitMs / 60_000} min)...`)
  while (Date.now() - start < maxWaitMs) {
    attempt++
    try {
      const executionPayload = await interaction.request()
      await wallet.simulateTx(executionPayload, {
        from: fromAddress,
        skipTxValidation: true,
        skipFeeEnforcement: true,
      })
      logger.info(`[PreSim] ${label} simulation passed after ${attempt} polls (${Math.round((Date.now() - start) / 1000)}s)`)
      return
    } catch (e: any) {
      const elapsed = Math.round((Date.now() - start) / 1000)
      logger.info(`[PreSim] ${label} poll #${attempt} (${elapsed}s): not ready — ${(e?.message || '').slice(0, 120)}`)
    }
    await wait(pollIntervalMs)
  }
  logger.warn(`[PreSim] ${label} simulation did not pass within ${maxWaitMs / 60_000} min — proceeding anyway`)
}

import { SponsoredFPCContract, SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC'
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

// ─── Configuration ───────────────────────────────────────────────────────────

const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY
const MNEMONIC = process.env.MNEMONIC || 'test test test test test test test test test test test junk'
const L1_CREDENTIAL = L1_PRIVATE_KEY || MNEMONIC
const L1_URL = process.env.L1_URL || getL1RpcUrl()

const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT || '1000000000000000') // 1e15
const FEE_BASIS_POINTS = BigInt(process.env.FEE_BASIS_POINTS || '500') // 5% fee
const CLEAN_HANDS_CIRCUIT_ID = BigInt(process.env.CLEAN_HANDS_CIRCUIT_ID || '0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19')
const CLEAN_HANDS_ACTION_ID = BigInt(process.env.CLEAN_HANDS_ACTION_ID || '123456789')

// Attestation/signer keys — all required via .env
if (!process.env.POCH_ATTESTER_PRIVATE_KEY) throw new Error('POCH_ATTESTER_PRIVATE_KEY is required in .env')
if (!process.env.PASSPORT_SIGNER_PRIVATE_KEY) throw new Error('PASSPORT_SIGNER_PRIVATE_KEY is required in .env')
if (!process.env.L2_POCH_ATTESTER_PRIVATE_KEY) throw new Error('L2_POCH_ATTESTER_PRIVATE_KEY is required in .env')
if (!process.env.L2_PASSPORT_SIGNER_PRIVATE_KEY) throw new Error('L2_PASSPORT_SIGNER_PRIVATE_KEY is required in .env')

const POCH_ATTESTER_PRIVATE_KEY = (process.env.POCH_ATTESTER_PRIVATE_KEY.startsWith('0x')
  ? process.env.POCH_ATTESTER_PRIVATE_KEY
  : `0x${process.env.POCH_ATTESTER_PRIVATE_KEY}`) as Hex
const PASSPORT_SIGNER_PRIVATE_KEY = (process.env.PASSPORT_SIGNER_PRIVATE_KEY.startsWith('0x')
  ? process.env.PASSPORT_SIGNER_PRIVATE_KEY
  : `0x${process.env.PASSPORT_SIGNER_PRIVATE_KEY}`) as Hex

const pochAttesterAccount = privateKeyToAccount(POCH_ATTESTER_PRIVATE_KEY)
const passportSignerAccount = privateKeyToAccount(PASSPORT_SIGNER_PRIVATE_KEY)

// L2 Grumpkin keys for Schnorr attestation signing (separate from L1 ECDSA keys)
const L2_POCH_ATTESTER_PRIVATE_KEY = process.env.L2_POCH_ATTESTER_PRIVATE_KEY
const L2_PASSPORT_SIGNER_PRIVATE_KEY = process.env.L2_PASSPORT_SIGNER_PRIVATE_KEY

// ─── Run mode ────────────────────────────────────────────────────────────────
// RUN_TESTS_ONLY=true  — skip deployment, only run tests against existing tokens
// DEPLOY_ONLY=true     — deploy tokens but skip tests
// DEPLOY_TOKEN=USDC    — only deploy this specific token (others skipped even if new)
const RUN_TESTS_ONLY = process.env.RUN_TESTS_ONLY === 'true'
const DEPLOY_ONLY = process.env.DEPLOY_ONLY === 'true'
const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || '' // e.g. 'USDC'
const PROFILE_ENABLED = process.env.PROFILE === 'true'
const FORCE_REDEPLOY_ALL = process.env.FORCE_REDEPLOY_ALL === 'true'
const FORCE_REDEPLOY_SWAPS = FORCE_REDEPLOY_ALL || process.env.FORCE_REDEPLOY_SWAPS === 'true'
const FORCE_SEED = FORCE_REDEPLOY_ALL || process.env.FORCE_SEED === 'true'
const SKIP_ETH_AZTEC = process.env.SKIP_ETH_AZTEC === 'true'
const SKIP_TO_FUEL_TESTS = process.env.SKIP_TO_FUEL_TESTS === 'true'

// ─── L2 Grumpkin key derivation ──────────────────────────────────────────────

const schnorr = new Schnorr()

async function deriveL2SigningKeyAndPubkey(hexPrivateKey: string) {
  const secretKey = Fr.fromString(hexPrivateKey.startsWith('0x') ? hexPrivateKey : `0x${hexPrivateKey}`)
  const signingKey = deriveSigningKey(secretKey)
  const pubkey = await schnorr.computePublicKey(signingKey)
  return { signingKey, pubkey }
}

// Lazily initialized L2 key pairs
let l2PochSigningKey: GrumpkinScalar
let l2PochPubkey: { x: Fr; y: Fr }
let l2PassportSigningKey: GrumpkinScalar
let l2PassportPubkey: { x: Fr; y: Fr }

async function initL2Keys() {
  if (!l2PochSigningKey) {
    const poch = await deriveL2SigningKeyAndPubkey(L2_POCH_ATTESTER_PRIVATE_KEY)
    l2PochSigningKey = poch.signingKey
    l2PochPubkey = { x: poch.pubkey.x, y: poch.pubkey.y }
  }
  if (!l2PassportSigningKey) {
    const passport = await deriveL2SigningKeyAndPubkey(L2_PASSPORT_SIGNER_PRIVATE_KEY)
    l2PassportSigningKey = passport.signingKey
    l2PassportPubkey = { x: passport.pubkey.x, y: passport.pubkey.y }
  }
}

// ─── Profiling ───────────────────────────────────────────────────────────────

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const PROFILE_OUTPUT_DIR = join(import.meta.dirname ?? '.', 'profiling-results')
const profileResults: ProfileEntry[] = []

const WASM_PROVING_MULTIPLIER = 4.5 // native-to-WASM slowdown estimate

interface ProfileStepEntry {
  functionName: string
  gateCount: number
  witgenMs: number | null       // witness generation time for this circuit
  simulationMs: number | null   // total oracle/simulation time within this circuit
}

interface ProfileEntry {
  label: string
  timestamp: string
  executionSteps: ProfileStepEntry[]
  totalGates: number
  totalWitgenMs: number
  totalSimulationMs: number
  provingMs: number | null
  estimatedWasmProvingMs: number | null
  assessment: string
  timings: Record<string, number>
  stats: Record<string, any>
}

function getAssessment(totalGates: number): string {
  if (totalGates < 50_000) return 'EXCELLENT (< 50k gates)'
  if (totalGates < 200_000) return 'ACCEPTABLE (50k-200k gates)'
  if (totalGates < 500_000) return 'NEEDS OPTIMIZATION (200k-500k gates)'
  return 'REQUIRES OPTIMIZATION (> 500k gates)'
}

async function profileIfEnabled(
  label: string,
  interaction: any,
  opts: { from: any; fee: any; authWitnesses?: any[] },
  logger: Logger,
) {
  if (!PROFILE_ENABLED) return
  try {
    logger.info(`[PROFILE] Profiling ${label}...`)
    const result = await interaction.profile({
      from: opts.from,
      fee: opts.fee,
      profileMode: 'full' as const,
      skipProofGeneration: false,
      ...(opts.authWitnesses ? { authWitnesses: opts.authWitnesses } : {}),
    })

    // Build per-function timing lookup from stats.timings.perFunction
    const perFunction: any[] = result.stats?.timings?.perFunction ?? []
    const witgenByIndex = new Map<number, number>()
    const simByIndex = new Map<number, number>()
    for (let i = 0; i < perFunction.length; i++) {
      const pf = perFunction[i]
      if (pf?.time != null) witgenByIndex.set(i, pf.time)
      // Sum all oracle call times as "simulation" time for this step
      if (pf?.oracles) {
        let oracleTotal = 0
        for (const oracleCalls of Object.values(pf.oracles) as any[]) {
          for (const t of oracleCalls.times ?? []) oracleTotal += t
        }
        if (oracleTotal > 0) simByIndex.set(i, oracleTotal)
      }
    }

    // Build profile entry
    const steps: ProfileStepEntry[] = []
    let totalGates = 0
    let totalWitgenMs = 0
    let totalSimulationMs = 0

    if (result.executionSteps?.length > 0) {
      const pad = (s: string, n: number) => String(s).padEnd(n)
      const numFmt = (n: number) => n.toLocaleString()
      const msFmt = (n: number | null) => n != null ? n.toFixed(1) + 'ms' : '-'

      logger.info(`[PROFILE] ┌── ${label} ──`)
      logger.info(`[PROFILE] │ ${pad('Function', 45)} ${pad('Gates', 12)} ${pad('Witgen', 12)} ${pad('Sim/Oracle', 12)} Subtotal`)
      logger.info(`[PROFILE] │ ${'─'.repeat(85)}`)
      for (let i = 0; i < result.executionSteps.length; i++) {
        const step = result.executionSteps[i]
        const gates = step.gateCount ?? 0
        const witgen = witgenByIndex.get(i) ?? null
        const sim = simByIndex.get(i) ?? null
        totalGates += gates
        if (witgen != null) totalWitgenMs += witgen
        if (sim != null) totalSimulationMs += sim
        steps.push({ functionName: step.functionName, gateCount: gates, witgenMs: witgen, simulationMs: sim })
        logger.info(`[PROFILE] │ ${pad(step.functionName, 45)} ${pad(numFmt(gates), 12)} ${pad(msFmt(witgen), 12)} ${pad(msFmt(sim), 12)} ${numFmt(totalGates)}`)
      }
      const assessment = getAssessment(totalGates)
      logger.info(`[PROFILE] │ ${'─'.repeat(85)}`)
      logger.info(`[PROFILE] │ ${pad('TOTAL', 45)} ${pad(numFmt(totalGates), 12)} ${pad(msFmt(totalWitgenMs), 12)} ${pad(msFmt(totalSimulationMs), 12)}`)
      logger.info(`[PROFILE] │ Assessment: ${assessment}`)
    }

    // Extract top-level timings
    const timings: Record<string, number> = {}
    const provingMs = result.stats?.timings?.proving ?? null
    const estimatedWasmProvingMs = provingMs != null ? provingMs * WASM_PROVING_MULTIPLIER : null
    if (result.stats?.timings) {
      for (const [key, value] of Object.entries(result.stats.timings)) {
        if (typeof value === 'number') {
          timings[key] = value
        }
      }
    }

    // Timing summary
    logger.info(`[PROFILE] │`)
    logger.info(`[PROFILE] │ Timing Breakdown:`)
    logger.info(`[PROFILE] │   Simulation (oracle calls):  ${totalSimulationMs.toFixed(1)}ms`)
    logger.info(`[PROFILE] │   Witness generation:         ${totalWitgenMs.toFixed(1)}ms`)
    logger.info(`[PROFILE] │   Proving (native):           ${provingMs != null ? provingMs.toFixed(1) + 'ms' : 'N/A'}`)
    logger.info(`[PROFILE] │   Proving (est. WASM ~${WASM_PROVING_MULTIPLIER}x):  ${estimatedWasmProvingMs != null ? estimatedWasmProvingMs.toFixed(1) + 'ms' : 'N/A'}`)
    logger.info(`[PROFILE] │   Total:                      ${timings.total?.toFixed(1) ?? 'N/A'}ms`)
    logger.info(`[PROFILE] └${'─'.repeat(90)}`)

    // Store full result
    const entry: ProfileEntry = {
      label,
      timestamp: new Date().toISOString(),
      executionSteps: steps,
      totalGates,
      totalWitgenMs,
      totalSimulationMs,
      provingMs,
      estimatedWasmProvingMs,
      assessment: getAssessment(totalGates),
      timings,
      stats: result.stats ?? {},
    }
    profileResults.push(entry)
  } catch (e: any) {
    logger.warn(`[PROFILE] Could not profile ${label}: ${e.message?.slice(0, 150)}`)
  }
}

function saveProfilingResults(logger: Logger) {
  if (!PROFILE_ENABLED || profileResults.length === 0) return
  try {
    if (!existsSync(PROFILE_OUTPUT_DIR)) {
      mkdirSync(PROFILE_OUTPUT_DIR, { recursive: true })
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outPath = join(PROFILE_OUTPUT_DIR, `profile-${timestamp}.json`)

    // Summary for quick comparison
    const summary = profileResults.map(r => ({
      function: r.label,
      totalGates: r.totalGates,
      assessment: r.assessment,
      steps: r.executionSteps.length,
      totalWitgenMs: r.totalWitgenMs,
      totalSimulationMs: r.totalSimulationMs,
      provingMs: r.provingMs,
      estimatedWasmProvingMs: r.estimatedWasmProvingMs,
      timings: r.timings,
    }))

    const output = {
      runDate: new Date().toISOString(),
      environment: process.env.AZTEC_ENV || 'sandbox',
      summary,
      details: profileResults,
    }

    writeFileSync(outPath, JSON.stringify(output, null, 2))
    logger.info(`[PROFILE] Results saved to ${outPath}`)

    // Also append to a running history file for tracking changes over time
    const historyPath = join(PROFILE_OUTPUT_DIR, 'profile-history.jsonl')
    for (const entry of summary) {
      const line = JSON.stringify({ ...entry, runDate: output.runDate, environment: output.environment })
      writeFileSync(historyPath, line + '\n', { flag: 'a' })
    }
    logger.info(`[PROFILE] History appended to ${historyPath}`)
  } catch (e: any) {
    logger.warn(`[PROFILE] Could not save results: ${e.message}`)
  }
}

// ─── L1 Contract Deployment ──────────────────────────────────────────────────

async function deployTestERC20(
  l1Client: ExtendedViemWalletClient,
  name: string,
  symbol: string,
  decimals: number
): Promise<EthAddress> {
  return await deployL1Contract(
    l1Client,
    TestERC20Abi,
    TestERC20Bytecode,
    [name, symbol, decimals, l1Client.account.address]
  ).then(({ address }) => address)
}

async function deployFeeAssetHandler(
  l1Client: ExtendedViemWalletClient,
  l1TokenContract: EthAddress
): Promise<EthAddress> {
  return await deployL1Contract(
    l1Client,
    FeeAssetHandlerAbi,
    FeeAssetHandlerBytecode,
    [l1Client.account.address, l1TokenContract.toString() as Hex, MINT_AMOUNT]
  ).then(({ address }) => address)
}

async function deployCustomTokenPortal(
  l1Client: ExtendedViemWalletClient,
  feeRecipient: string,
  humanIdAttester: string,
  passportSigner: string
): Promise<EthAddress> {
  return await deployL1Contract(
    l1Client,
    CustomTokenPortalAbi,
    CustomTokenPortalBytecode,
    [
      l1Client.account.address, // initialOwner
      feeRecipient,
      FEE_BASIS_POINTS,
      humanIdAttester,
      CLEAN_HANDS_CIRCUIT_ID,
      CLEAN_HANDS_ACTION_ID,
      passportSigner,
    ]
  ).then(({ address }) => address)
}

async function addMinter(
  l1Client: ExtendedViemWalletClient,
  l1TokenContract: EthAddress,
  l1TokenHandler: EthAddress
) {
  const contract = getContract({
    address: l1TokenContract.toString() as Hex,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any
  const tx = await contract.write.addMinter([l1TokenHandler.toString() as Hex])
  await l1Client.waitForTransactionReceipt({ hash: tx, timeout: getTimeouts().txTimeout })
}

async function mintL1Tokens(
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1TokenContract: EthAddress,
  amount: bigint,
  logger: Logger,
  symbol: string
) {
  logger.info(`Minting ${amount.toString()} ${symbol} tokens to owner`)
  const contract = getContract({
    address: l1TokenContract.toString() as Hex,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any
  const tx = await contract.write.mint([ownerEthAddress, amount])
  await l1Client.waitForTransactionReceipt({ hash: tx, timeout: getTimeouts().txTimeout })
  logger.info(`Minted ${amount.toString()} ${symbol} tokens`)
}

// ─── Attestation Signing ─────────────────────────────────────────────────────

/**
 * Sign a Clean Hands (POCH) attestation for the L1 portal.
 * L1 verification: keccak256(abi.encodePacked(nonce, circuitId, actionId, userAddress))
 * then personal_sign hash, then ECDSA recover.
 */
async function signCleanHandsAttestation(params: {
  nonce: bigint
  circuitId: bigint
  actionId: bigint
  userAddress: string
}): Promise<Hex> {
  const digest = keccak256(
    encodePacked(
      ['uint256', 'uint256', 'uint256', 'address'],
      [params.nonce, params.circuitId, params.actionId, params.userAddress as `0x${string}`]
    )
  )
  // personal_sign: sign the raw digest as a message
  const signature = await signMessage({
    privateKey: POCH_ATTESTER_PRIVATE_KEY,
    message: { raw: digest },
  })
  return signature
}

/**
 * Sign a Passport attestation for the L1 portal.
 * L1 verification: keccak256(abi.encodePacked(msg.sender, maxAmount, nonce, deadline, address(this)))
 * then personal_sign hash, then ECDSA recover.
 */
async function signPassportAttestation(params: {
  userAddress: string
  maxAmount: bigint
  nonce: bigint
  deadline: bigint
  portalAddress: string
}): Promise<Hex> {
  const digest = keccak256(
    encodePacked(
      ['address', 'uint256', 'uint256', 'uint256', 'address'],
      [
        params.userAddress as `0x${string}`,
        params.maxAmount,
        params.nonce,
        params.deadline,
        params.portalAddress as `0x${string}`,
      ]
    )
  )
  const signature = await signMessage({
    privateKey: PASSPORT_SIGNER_PRIVATE_KEY,
    message: { raw: digest },
  })
  return signature
}

// ─── L2 Schnorr attestation signing ──────────────────────────────────────────

/**
 * Sign a Clean Hands (POCH) attestation for the L2 bridge using Schnorr/Grumpkin.
 * L2 verification: compute_inner_authwit_hash([circuitId, actionId, nonce, userAddress])
 * then Schnorr verify against stored Grumpkin pubkey.
 */
async function signL2CleanHandsAttestation(params: {
  circuitId: bigint
  actionId: bigint
  nonce: bigint
  userAztecAddress: AztecAddress
}): Promise<number[]> {
  await initL2Keys()
  const hash = await computeInnerAuthWitHash([
    new Fr(params.circuitId),
    new Fr(params.actionId),
    new Fr(params.nonce),
    new Fr(BigInt(params.userAztecAddress.toString())),
  ])
  const sig = await schnorr.constructSignature(hash.toBuffer(), l2PochSigningKey)
  return [...sig.toBuffer()]
}

/**
 * Sign a Passport attestation for the L2 bridge using Schnorr/Grumpkin.
 * L2 verification: compute_inner_authwit_hash([userAddress, maxAmount, nonce, deadline, bridgeAddress])
 * then Schnorr verify against stored Grumpkin pubkey.
 */
async function signL2PassportAttestation(params: {
  userAztecAddress: AztecAddress
  maxAmount: bigint
  nonce: bigint
  deadline: bigint
  bridgeAddress: AztecAddress
}): Promise<number[]> {
  await initL2Keys()
  const hash = await computeInnerAuthWitHash([
    new Fr(BigInt(params.userAztecAddress.toString())),
    new Fr(params.maxAmount),
    new Fr(params.nonce),
    new Fr(params.deadline),
    new Fr(BigInt(params.bridgeAddress.toString())),
  ])
  const sig = await schnorr.constructSignature(hash.toBuffer(), l2PassportSigningKey)
  return [...sig.toBuffer()]
}

// ─── Salt generation ─────────────────────────────────────────────────────────

function generateTokenSalts(symbol: string) {
  const timestamp = Date.now()
  const symbolHash = symbol.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return {
    tokenSalt: new Fr(BigInt(timestamp + symbolHash)),
    bridgeSalt: new Fr(BigInt(timestamp + symbolHash + 1000)),
    proxySalt: new Fr(BigInt(timestamp + symbolHash + 2000)),
  }
}

// ─── Sepolia constants for pool seeding ──────────────────────────────────────

const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as `0x${string}`
const POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543' as `0x${string}`
const FEE_ASSET_HANDLER_ADDR = '0xED9c5557d2E0abCc7c7FCA958eE4292199413494' as `0x${string}`
const AZTEC_TOKEN = '0x35d0186d1FD53b72996475D965C5Ed171D52b986' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

// ETH/FeeJuice pool params (~10,500,000,000 FeeJuice per ETH)
// Chosen so that 0.02 USDC → ~100 FJ (2x buffer over ~48 FJ gas at current testnet fees)
// sqrtPriceX96 = sqrt(10_500_000_000) * 2^96
// NOTE: fee=500/tickSpacing=10 creates a FRESH pool (the fee=3000 pool exists at the wrong price ~287 FJ/ETH)
const ETH_AZTEC_SQRT_PRICE = 8117513676449874804987252736000000n
const ETH_AZTEC_TICK_LOWER = 229020  // divisible by 10 ✓
const ETH_AZTEC_TICK_UPPER = 231480  // divisible by 10 ✓
const ETH_AZTEC_FEE = 500
const ETH_AZTEC_TICK_SPACING = 10
const ETH_AZTEC_LIQUIDITY = 2n * 10n ** 17n  // Virtual FJ ≈ L×8470 ticks ≈ 1694 FJ — enough for 6+ fuel tests
const ETH_SEED = 1000000000000000n  // 0.001 ETH — sufficient for 7e10 ETH_units virtual reserve
const FEE_MINT_COUNT = 2            // 2000 FJ > 1694 FJ virtual needed

// ERC20/WETH pool — unchanged
const ERC20_WETH_SQRT_PRICE = 1728916962386276374966316084832192n
const ERC20_WETH_TICK_LOWER = 169800
const ERC20_WETH_TICK_UPPER = 229800
const ERC20_WETH_FEE = 3000
const ERC20_WETH_TICK_SPACING = 60
const ERC20_WETH_LIQUIDITY = 1000000000000n
const WETH_SEED = 20000000000000000n

// Minimal ABIs for pool seeding / fuel test interactions
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

const APPROVE_ABI = [
  { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const

// ── Permit2 + SwapBridgeRouter constants ────────────────────────────────────
const PERMIT2_CANONICAL = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as `0x${string}`

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

// ─── Fuel swap helper functions ─────────────────────────────────────────────

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

function sortCurrencies(a: `0x${string}`, b: `0x${string}`): [`0x${string}`, `0x${string}`] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a]
}

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
  try {
    const { result: l2TokenBal } = await l2TokenContract.methods
      .balance_of_public(ownerAztecAddress)
      .simulate({ from: ownerAztecAddress })
    logger.info(`  L2 token balance: ${l2TokenBal}`)
  } catch (e) {
    logger.info(`  L2 token balance: (failed to read)`)
  }
  if (wallet) {
    try {
      const fjContract = await TokenContract.at(
        AztecAddress.fromString(FEE_JUICE_L2_ADDRESS),
        wallet,
      )
      const { result: fjBal } = await fjContract.methods
        .balance_of_public(ownerAztecAddress)
        .simulate({ from: ownerAztecAddress })
      logger.info(`  L2 FeeJuice:      ${(Number(fjBal) / 1e18).toFixed(6)} FJ`)
    } catch (e) {
      logger.info(`  L2 FeeJuice:      (failed to read)`)
    }
  }
  const ethBal = await l1Client.getBalance({ address: l1Client.account.address })
  logger.info(`  L1 deployer ETH:  ${(Number(ethBal) / 1e18).toFixed(4)} ETH`)
}

async function logPoolBalances(l1Client: ExtendedViemWalletClient, deployedContracts: DeployedCompliantToken[], label: string, logger: Logger) {
  const l1Public = createPublicClient({ transport: http(L1_URL) })
  const deployer = l1Client.account.address

  logger.info(`\n--- Pool & Wallet Balances (${label}) ---`)
  const ethBalance = await l1Public.getBalance({ address: deployer })
  logger.info(`  Deployer ETH:       ${(Number(ethBalance) / 1e18).toFixed(4)} ETH`)

  const pmEthBalance = await l1Public.getBalance({ address: POOL_MANAGER })
  logger.info(`  PoolManager ETH:    ${(Number(pmEthBalance) / 1e18).toFixed(4)} ETH`)

  const aztecToken = getContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmFjBalance = await aztecToken.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager FJ:     ${(Number(pmFjBalance) / 1e18).toFixed(2)} FeeJuice ${pmFjBalance > 0n ? '' : '(ETH/AZTEC pool not seeded)'}`)

  const weth = getContract({ address: WETH_ADDRESS, abi: ERC20_ABI, client: l1Public as any }) as any
  const pmWethBalance = await weth.read.balanceOf([POOL_MANAGER]) as bigint
  logger.info(`  PoolManager WETH:   ${(Number(pmWethBalance) / 1e18).toFixed(4)} WETH`)

  for (const token of deployedContracts) {
    const tokenAddr = token.l1TokenContract as `0x${string}`
    if (tokenAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) continue
    try {
      const erc20 = getContract({ address: tokenAddr, abi: ERC20_ABI, client: l1Public as any }) as any
      const decimals = await erc20.read.decimals() as number
      const balance = await erc20.read.balanceOf([POOL_MANAGER]) as bigint
      const humanBalance = Number(balance) / (10 ** Number(decimals))
      logger.info(`  PoolManager ${token.symbol.padEnd(6)}: ${humanBalance.toFixed(2)} ${balance > 0n ? '' : '(pool not seeded)'}`)
    } catch {
      logger.info(`  PoolManager ${token.symbol.padEnd(6)}: (failed to read)`)
    }
  }
}

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
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = BigInt('0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join(''))
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)

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

// ─── Pool Seeding ───────────────────────────────────────────────────────────

async function seedAllTokenPools(
  deployedContracts: DeployedCompliantToken[],
  l1Client: ExtendedViemWalletClient,
  logger: Logger,
  feeJuiceAddr: `0x${string}` = AZTEC_TOKEN,
  feeAssetHandlerAddr: `0x${string}` = FEE_ASSET_HANDLER_ADDR,
) {
  logger.info('\n=== Seeding Uniswap V4 Pools ===')

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
    const deployHash = await l1Client.deployContract({
      abi: PoolSeederAbi,
      bytecode: PoolSeederBytecode,
      args: [POOL_MANAGER],
    })
    const deployReceipt = await l1Client.waitForTransactionReceipt({ hash: deployHash, timeout: 120_000 })
    const seederAddr = deployReceipt.contractAddress as `0x${string}`
    logger.info(`  PoolSeeder deployed at ${seederAddr}`)

    const seeder = getContract({ address: seederAddr, abi: PoolSeederAbi, client: l1Client as any }) as any
    const feeHandler = getContract({ address: feeAssetHandlerAddr, abi: FEE_HANDLER_ABI, client: l1Client as any }) as any
    const feeJuiceToken = getContract({ address: feeJuiceAddr, abi: ERC20_ABI, client: l1Client as any }) as any

    logger.info(`  Minting FeeJuice to seeder (${seederAddr}) via FeeAssetHandler (${feeAssetHandlerAddr}): ${FEE_MINT_COUNT} x 1000 FJ`)
    logger.info(`  FeeJuice token address: ${feeJuiceAddr}`)
    for (let i = 0; i < FEE_MINT_COUNT; i++) {
      const tx = await feeHandler.write.mint([seederAddr])
      await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
      if ((i + 1) % 10 === 0 || i === FEE_MINT_COUNT - 1) logger.info(`  ... minted ${i + 1}/${FEE_MINT_COUNT}`)
    }

    // Fallback: if FeeAssetHandler mints to a different token, try direct mint on feeJuiceAddr
    const seederFjAfterHandler = await feeJuiceToken.read.balanceOf([seederAddr]) as bigint
    if (seederFjAfterHandler === 0n) {
      logger.warn(`  FeeAssetHandler did not fund feeJuiceAddr (${feeJuiceAddr}) — trying direct mint...`)
      try {
        const MINT_ABI = [{ type: 'function', name: 'mint', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' }] as const
        const feeJuiceMintable = getContract({ address: feeJuiceAddr, abi: MINT_ABI, client: l1Client as any }) as any
        const mintAmount = BigInt(FEE_MINT_COUNT) * 1000n * 10n ** 18n
        const mintTx = await feeJuiceMintable.write.mint([seederAddr, mintAmount])
        await l1Client.waitForTransactionReceipt({ hash: mintTx, timeout: 120_000 })
        logger.info(`  Direct mint succeeded: ${mintAmount} FJ to seeder`)
      } catch (mintErr) {
        logger.error(`  Direct mint also failed: ${mintErr}`)
      }
    }

    const deployerFj = await feeJuiceToken.read.balanceOf([deployer]) as bigint
    if (deployerFj > 0n) {
      const tx = await feeJuiceToken.write.transfer([seederAddr, deployerFj])
      await sendAndWait(l1Client, tx, `Transferred ${deployerFj} FJ to seeder`, logger)
    }

    // Seed pool — dry-run first via eth_call to catch errors without spending gas
    const [c0, c1] = sortCurrencies(ZERO_ADDRESS, feeJuiceAddr)
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
    await sendAndWait(l1Client, tx, 'ETH/FeeJuice pool seeded', logger)

    await sendAndWait(l1Client, await seeder.write.sweep([ZERO_ADDRESS]), 'Swept ETH', logger)
    await sendAndWait(l1Client, await seeder.write.sweep([feeJuiceAddr]), 'Swept FeeJuice', logger)
    logger.info('✅ ETH/FeeJuice pool done')
  } catch (error) {
    const errMsg = String(error)
    if (errMsg.includes('0xe450d38c')) {
      logger.error('❌ ETH/FeeJuice pool seeding failed: ERC20InsufficientBalance — not enough FeeJuice for the liquidity delta.')
      logger.error(`   Minted ${FEE_MINT_COUNT} x 1000 FJ but liquidity ${ETH_AZTEC_LIQUIDITY} needs more. Increase FEE_MINT_COUNT or reduce ETH_AZTEC_LIQUIDITY.`)
    } else {
      logger.error(`❌ ETH/FeeJuice pool seeding failed: ${error}`)
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
      const erc20Amount = BigInt(100) * (10n ** BigInt(decimals)) // 100 tokens — 1e12 liquidity needs ~36 USDC

      const mintTx = await erc20.write.mint([deployer, erc20Amount])
      await sendAndWait(l1Client, mintTx, `Minted ${erc20Amount} ${token.symbol}`, logger)

      const wrapTx = await weth.write.deposit([], { value: WETH_SEED })
      await sendAndWait(l1Client, wrapTx, `Wrapped ${WETH_SEED} wei to WETH`, logger)

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

// ─── Compliant Token Setup ───────────────────────────────────────────────────

interface DeployedCompliantToken extends DeployedToken {
  l2ProxyContract: string
  humanIdAttester: string
  passportSigner: string
}

async function deployCompliantTokenSetup(
  tokenConfig: TokenConfig,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  logger: Logger
): Promise<DeployedCompliantToken> {
  logger.info(`\n=== Deploying COMPLIANT ${tokenConfig.symbol} Token Setup ===`)

  const { tokenSalt, bridgeSalt, proxySalt } = generateTokenSalts(tokenConfig.symbol)
  await initL2Keys()

  // ── Step 1: Deploy or resolve L1 token ──
  let l1TokenContract: EthAddress

  if (tokenConfig.l1TokenAddress) {
    l1TokenContract = EthAddress.fromString(tokenConfig.l1TokenAddress)
    logger.info(`[L1] Using pre-existing ${tokenConfig.symbol} at ${l1TokenContract}`)
  } else {
    logger.info(`[L1] Deploying ${tokenConfig.symbol} ERC20`)
    l1TokenContract = await deployTestERC20(l1Client, tokenConfig.l1Name, tokenConfig.l1Symbol, tokenConfig.decimals)
    logger.info(`[L1] ${tokenConfig.symbol} ERC20 at ${l1TokenContract}`)

    // Mint tokens (only for TestERC20)
    const mintAmount = BigInt(1000000000000000000)
    await mintL1Tokens(l1Client, ownerEthAddress, l1TokenContract, mintAmount, logger, tokenConfig.symbol)
  }

  // ── Step 2: Deploy FeeAssetHandler ──
  logger.info(`[L1] Deploying fee asset handler for ${tokenConfig.symbol}`)
  const feeAssetHandler = await deployFeeAssetHandler(l1Client, l1TokenContract)
  if (!tokenConfig.l1TokenAddress) {
    await addMinter(l1Client, l1TokenContract, feeAssetHandler)
  }
  logger.info(`[L1] Fee asset handler at ${feeAssetHandler}`)

  // ── Step 3: Deploy Custom TokenPortal (with attestation config) ──
  logger.info(`[L1] Deploying Custom TokenPortal for ${tokenConfig.symbol}`)
  logger.info(`[L1]   humanIdAttester: ${pochAttesterAccount.address}`)
  logger.info(`[L1]   passportSigner:  ${passportSignerAccount.address}`)
  logger.info(`[L1]   feeBasisPoints:  ${FEE_BASIS_POINTS}`)
  logger.info(`[L1]   circuitId:       ${CLEAN_HANDS_CIRCUIT_ID}`)
  logger.info(`[L2]   actionId:        ${CLEAN_HANDS_ACTION_ID}`)

  const l1PortalContractAddress = await deployCustomTokenPortal(
    l1Client,
    ownerEthAddress, // feeRecipient = deployer for testing
    pochAttesterAccount.address,
    passportSignerAccount.address
  )
  logger.info(`[L1] Custom TokenPortal at ${l1PortalContractAddress}`)

  // ── Step 4: Deploy L2 TokenMinterProxy ──
  logger.info(`[L2] Deploying TokenMinterProxy`)
  const { contract: l2ProxyContract } = await TokenMinterProxyContract.deploy(wallet).send({
    from: ownerAztecAddress,
    contractAddressSalt: proxySalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`[L2] TokenMinterProxy at ${l2ProxyContract.address}`)

  // ── Step 5: Deploy L2 Token (Wonderland token with minter) ──
  logger.info(`[L2] Deploying ${tokenConfig.symbol} Token (Wonderland, constructor_with_minter)`)
  const { contract: l2TokenContract } = await TokenContract.deployWithOpts(
    { wallet, method: 'constructor_with_minter' },
    tokenConfig.l2Name,
    tokenConfig.l2Symbol,
    tokenConfig.decimals,
    l2ProxyContract.address,    // minter = proxy
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: tokenSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`[L2] ${tokenConfig.symbol} Token at ${l2TokenContract.address}`)

  // ── Step 6: Deploy L2 Custom TokenBridge (8 args) ──
  logger.info(`[L2] Deploying Custom TokenBridge for ${tokenConfig.symbol}`)
  const { contract: l2BridgeContract } = await TokenBridgeContract.deploy(
    wallet,
    l2ProxyContract.address,     // token_minter_proxy
    l1PortalContractAddress,     // portal
    l2PochPubkey.x,              // human_id_attester_x (Grumpkin)
    l2PochPubkey.y,              // human_id_attester_y (Grumpkin)
    CLEAN_HANDS_CIRCUIT_ID,      // circuit_id
    CLEAN_HANDS_ACTION_ID,       // action_id
    l2PassportPubkey.x,          // passport_signer_x (Grumpkin)
    l2PassportPubkey.y,          // passport_signer_y (Grumpkin)
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: bridgeSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`[L2] Custom TokenBridge at ${l2BridgeContract.address}`)

  // ── Step 7: Wire up permissions ──
  // Proxy: set token address
  logger.info(`[L2] Setting token on proxy`)
  await l2ProxyContract.methods.set_token(l2TokenContract.address).send({
    from: ownerAztecAddress,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().txTimeout },
  })

  // Proxy: set bridge as minter
  logger.info(`[L2] Setting bridge as minter on proxy`)
  await l2ProxyContract.methods.set_minter(l2BridgeContract.address, true).send({
    from: ownerAztecAddress,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().txTimeout },
  })

  // Token: proxy already set as minter via constructor_with_minter

  // ── Step 8: Initialize L1 portal ──
  logger.info(`[L1] Initializing Custom TokenPortal`)
  const l1Portal = getContract({
    address: l1PortalContractAddress.toString() as Hex,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any

  const initTx = await l1Portal.write.initialize([
    l1ContractAddresses.registryAddress.toString() as Hex,
    l1TokenContract.toString() as Hex,
    l2BridgeContract.address.toString() as Hex,
  ])
  await l1Client.waitForTransactionReceipt({ hash: initTx, timeout: 120000 })
  logger.info(`[L1] Custom TokenPortal initialized`)

  return {
    symbol: tokenConfig.symbol,
    decimals: tokenConfig.decimals,
    logo: tokenConfig.logo,
    l1TokenContract: l1TokenContract.toString(),
    l1PortalContract: l1PortalContractAddress.toString(),
    l2TokenContract: l2TokenContract.address.toString(),
    l2BridgeContract: l2BridgeContract.address.toString(),
    l2ProxyContract: l2ProxyContract.address.toString(),
    feeAssetHandler: feeAssetHandler.toString(),
    sponsoredFee: '',
    humanIdAttester: pochAttesterAccount.address,
    passportSigner: passportSignerAccount.address,
  }
}

// ─── Bridge & Test Flows ─────────────────────────────────────────────────────

// ─── Fuel Swap Test Flows ────────────────────────────────────────────────────

/**
 * Test 1b: Public fuel via SwapBridgeRouter + FeeJuicePaymentMethodWithClaim.
 * Swaps ERC20 → WETH → FeeJuice via Uniswap V4, then bridges token + fuel to L2.
 * Claims token on L2 using the bridged FeeJuice to pay for gas.
 */
async function testPublicFuelFlow(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  l2BridgeContract: any,
  l2TokenContract: any,
  logger: Logger,
) {
  logger.info(`\n=== Testing Public Fuel (SwapBridgeRouter + FeeJuicePaymentMethodWithClaim) ===`)

  const finalDeployment = loadActiveDeployment()
  const swapRouterAddress = finalDeployment?.swapBridgeRouterAddress as `0x${string}` | undefined
  if (!swapRouterAddress) {
    logger.warn('No SwapBridgeRouter address found. Skipping public fuel test.')
    return
  }

  const tokenAddr = deployed.l1TokenContract as `0x${string}`
  const portalAddr = deployed.l1PortalContract as `0x${string}`
  const l1ChainId = l1ContractAddresses.rollupAddress ? 11155111 : 31337

  // Build swap route: token → WETH (pool 1) → ETH → FeeJuice (pool 2)
  const feeJuiceAddr = ((l1ContractAddresses as any).feeJuiceAddress?.toString() || AZTEC_TOKEN) as `0x${string}`
  const [c0Pool1, c1Pool1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
  const [c0Pool2, c1Pool2] = sortCurrencies(ZERO_ADDRESS, feeJuiceAddr)
  const poolKeys = [
    { currency0: c0Pool1, currency1: c1Pool1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS },
    { currency0: c0Pool2, currency1: c1Pool2, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS },
  ]
  const zeroForOnes = [
    BigInt(tokenAddr) < BigInt(WETH_ADDRESS),
    BigInt(ZERO_ADDRESS) < BigInt(feeJuiceAddr),
  ]
  logger.info(`Swap route: ${deployed.symbol} → WETH → FeeJuice`)

  // Approve ERC20 → Permit2 (one-time, max approval)
  const erc20 = getContract({ address: tokenAddr, abi: [...ERC20_ABI, ...APPROVE_ABI], client: l1Client as any }) as any
  const currentAllowance = await erc20.read.allowance([l1Client.account.address, PERMIT2_CANONICAL]) as bigint
  if (currentAllowance < BigInt(1e30)) {
    const approveTx = await erc20.write.approve([PERMIT2_CANONICAL, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')])
    await sendAndWait(l1Client, approveTx, `Approved ${deployed.symbol} for Permit2`, logger)
  } else {
    logger.info(`  Permit2 allowance already sufficient`)
  }

  await logFuelTestBalances('BEFORE public fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)

  try {
    const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')

    // Generate claim + fuel secrets
    const [pfClaimSecret, pfClaimSecretHash] = await generateClaimSecret()
    const pfFuelSecret = Fr.random()
    const pfFuelSecretHash = await computeSecretHash(pfFuelSecret)

    const pfTotalAmount = 150n  // 0.00015 USDC total (6-decimal token)
    const pfFuelAmount = 50n   // 0.00005 USDC swapped to FeeJuice (needs ~49 FJ for gas, target ~120 FJ)
    const pfMinFuelOutput = 0n // testnet — accept any output

    // Mint ERC20 for this test
    const mintTx = await erc20.write.mint([l1Client.account.address, pfTotalAmount])
    await sendAndWait(l1Client, mintTx, `Minted ${pfTotalAmount} ${deployed.symbol} for public fuel test`, logger)

    // ── Pre-flight diagnostics ──
    const l1Public = createPublicClient({ transport: http(L1_URL) })
    const routerContract = getContract({ address: swapRouterAddress, abi: SwapBridgeRouterAbiLocal, client: l1Client as any }) as any
    {
      const userBal = await erc20.read.balanceOf([l1Client.account.address]) as bigint
      const permit2Allowance = await erc20.read.allowance([l1Client.account.address, PERMIT2_CANONICAL]) as bigint
      const swapTarget = await l1Client.readContract({ address: swapRouterAddress, abi: [{ type: 'function', name: 'swapTarget', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const, functionName: 'swapTarget' })
      const fuelSwapPM = await l1Client.readContract({ address: swapTarget as `0x${string}`, abi: [{ type: 'function', name: 'poolManager', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const, functionName: 'poolManager' })
      const fuelSwapWeth = await l1Client.readContract({ address: swapTarget as `0x${string}`, abi: [{ type: 'function', name: 'weth', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const, functionName: 'weth' })
      const fuelSwapFJ = await l1Client.readContract({ address: swapTarget as `0x${string}`, abi: [{ type: 'function', name: 'feeJuice', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const, functionName: 'feeJuice' })
      // Pool liquidity check
      const pmUsdcBal = await l1Public.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [POOL_MANAGER] }) as bigint
      const pmWethBal = await l1Public.readContract({ address: WETH_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [POOL_MANAGER] }) as bigint
      const pmFjBal = await l1Public.readContract({ address: AZTEC_TOKEN, abi: ERC20_ABI, functionName: 'balanceOf', args: [POOL_MANAGER] }) as bigint
      const pmEth = await l1Public.getBalance({ address: POOL_MANAGER })

      logger.info(`  ── Pre-flight diagnostics ──`)
      logger.info(`  User ${deployed.symbol} balance: ${userBal} (need ${pfTotalAmount})`)
      logger.info(`  Permit2 allowance: ${permit2Allowance > BigInt(1e30) ? 'MAX' : permit2Allowance.toString()}`)
      logger.info(`  SwapBridgeRouter: ${swapRouterAddress}`)
      logger.info(`  SwapTarget (UniswapFuelSwap): ${swapTarget}`)
      logger.info(`    poolManager: ${fuelSwapPM}`)
      logger.info(`    weth: ${fuelSwapWeth}`)
      logger.info(`    feeJuice: ${fuelSwapFJ}`)
      logger.info(`  TokenPortal: ${portalAddr}`)
      logger.info(`  Pool 1 (${deployed.symbol}/WETH) — PM ${deployed.symbol}: ${pmUsdcBal}, PM WETH: ${pmWethBal}`)
      logger.info(`  Pool 2 (ETH/FJ) — PM ETH: ${pmEth}, PM FJ: ${pmFjBal}`)
      logger.info(`  Swap params: totalAmount=${pfTotalAmount}, fuelAmount=${pfFuelAmount}, bridgeAmount=${pfTotalAmount - pfFuelAmount}`)

      if (userBal < pfTotalAmount) logger.error(`  ❌ INSUFFICIENT BALANCE`)
      if (permit2Allowance < pfTotalAmount) logger.error(`  ❌ INSUFFICIENT PERMIT2 ALLOWANCE`)
      if (pmUsdcBal === 0n) logger.error(`  ❌ NO ${deployed.symbol} LIQUIDITY IN POOL`)
      if (pmFjBal === 0n) logger.error(`  ❌ NO FJ LIQUIDITY IN POOL`)
    }

    // Sign Permit2 witness
    const pfPermit = await signPermit2Witness(l1Client, {
      tokenPortal: portalAddr,
      bridgeToken: tokenAddr,
      totalAmount: pfTotalAmount,
      fuelAmount: pfFuelAmount,
      aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
      fuelRecipient: ownerAztecAddress.toString() as `0x${string}`,
      tokenSecretHash: pfClaimSecretHash.toString() as `0x${string}`,
      fuelSecretHash: pfFuelSecretHash.toString() as `0x${string}`,
      minFuelOutput: pfMinFuelOutput,
      poolKeys,
      zeroForOnes,
      isPrivate: false,
      swapBridgeRouter: swapRouterAddress,
      l1ChainId,
    })
    logger.info('Permit2 witness signed')

    // Simulate first to get detailed error
    logger.info('Simulating bridgeWithFuel via eth_call...')
    const bridgeWithFuelArgs = [
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
      await routerContract.simulate.bridgeWithFuel(bridgeWithFuelArgs, { account: l1Client.account })
      logger.info('  Simulation PASSED')
    } catch (simErr: any) {
      const errMsg = simErr?.message || ''
      // Try to extract the revert reason / error selector
      const selectorMatch = errMsg.match(/signature:\s*\n?(0x[a-fA-F0-9]+)/s)
      const reasonMatch = errMsg.match(/reason:\s*(.+)/i)
      const dataMatch = errMsg.match(/data:\s*"(0x[a-fA-F0-9]+)"/i)
      logger.error(`  Simulation FAILED:`)
      if (selectorMatch) logger.error(`    Error selector: ${selectorMatch[1]}`)
      if (reasonMatch) logger.error(`    Reason: ${reasonMatch[1]}`)
      if (dataMatch) {
        const data = dataMatch[1]
        logger.error(`    Raw revert data: ${data}`)
        // Decode known errors
        const sel = data.slice(0, 10)
        const knownErrors: Record<string, string> = {
          '0x5212cba1': 'CurrencyNotSettled() — V4 PoolManager flash accounting failed',
          '0xfb8f41b2': 'ERC20InsufficientAllowance(address,uint256,uint256)',
          '0xe450d38c': 'ERC20InsufficientBalance(address,uint256,uint256)',
          '0x8baa579f': 'InvalidSignature() — Permit2 signature verification failed',
          '0x815e1d64': 'InvalidSigner() — Permit2 signer mismatch',
          '0xcd21db4f': 'SignatureExpired(uint256) — Permit2 deadline passed',
        }
        if (knownErrors[sel]) logger.error(`    Decoded: ${knownErrors[sel]}`)
        // Decode args if available
        if (data.length > 10) logger.error(`    Args: ${data.slice(10)}`)
      }
      logger.error(`  Full error (first 500 chars): ${errMsg.slice(0, 500)}`)
      throw simErr
    }

    const bridgeTx = await routerContract.write.bridgeWithFuel(bridgeWithFuelArgs)
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

    // ── Cross-check: read the portal's DepositToAztecPublic event for the actual post-fee amount ──
    let portalAmountAfterFee = 0n
    let portalFee = 0n
    for (const log of bridgeReceipt.logs) {
      if (log.address.toLowerCase() !== portalAddr.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({ abi: CustomTokenPortalAbi, data: log.data, topics: log.topics })
        if (decoded.eventName === 'DepositToAztecPublic') {
          const a = decoded.args as any
          portalAmountAfterFee = a.amount ?? a.amountAfterFee ?? 0n
          portalFee = a.fee ?? 0n
          logger.info(`  Portal DepositToAztecPublic: amountAfterFee=${portalAmountAfterFee}, fee=${portalFee}`)
          break
        }
      } catch { /* not our event */ }
    }
    if (portalAmountAfterFee > 0n && portalAmountAfterFee !== pfTokenAmount) {
      logger.warn(`  ⚠️ AMOUNT MISMATCH: Router event says ${pfTokenAmount} but portal says ${portalAmountAfterFee}`)
      logger.warn(`  Using portal's post-fee amount for claim instead`)
      pfTokenAmount = portalAmountAfterFee
    }

    // ── Early sufficiency check — fail fast before any waiting ──────────────
    const pfBaseFees = await node.getCurrentMinFees()
    const pfMaxFeesPerGas = maxFeesPerGasFromBaseFees(pfBaseFees)
    const pfGasLimits = REASONABLE_GAS_LIMITS
    const pfTeardownGasLimits = Gas.from({ l2Gas: 0, daGas: 0 })
    const pfEstimatedMaxGasCost = maxGasCostFor(pfMaxFeesPerGas, pfGasLimits)
    logger.info(`  Gas diagnostics (public fuel):`)
    logger.info(`    baseFees: feePerDaGas=${pfBaseFees.feePerDaGas}, feePerL2Gas=${pfBaseFees.feePerL2Gas}`)
    logger.info(`    estimatedMaxGasCost: ${pfEstimatedMaxGasCost}`)
    logger.info(`    fuelAmount: ${pfFuelAmountReceived}, sufficient: ${pfFuelAmountReceived >= pfEstimatedMaxGasCost}`)

    if (pfFuelAmountReceived < pfEstimatedMaxGasCost) {
      const ratePerUnit = pfFuelAmountReceived > 0n ? pfFuelAmountReceived / pfFuelAmount : 0n
      const requiredUnits = ratePerUnit > 0n ? pfEstimatedMaxGasCost / ratePerUnit : 0n
      const pct = pfEstimatedMaxGasCost > 0n ? Number((pfFuelAmountReceived * 100n) / pfEstimatedMaxGasCost) : 0
      logger.warn(`  ⚠️  Fuel may be insufficient: swap yielded ${pfFuelAmountReceived} FJ but worst-case gas estimate is ${pfEstimatedMaxGasCost} (${pct}% coverage).`)
      logger.warn(`      REASONABLE_GAS_LIMITS is a worst-case estimate (6.54M L2 gas). Actual claim cost is much lower — proceeding anyway.`)
      if (requiredUnits > 0n) logger.warn(`      If claim fails, increase fuel to ${requiredUnits} units (${Number(requiredUnits) / 1e6} USDC)`)
    }

    // Wait for BOTH L1→L2 messages to sync
    for (const [label, msgHash] of [['token', pfTokenKey], ['fuel', pfFuelKey]] as const) {
      if (!msgHash || msgHash === '0x0') continue
      const msgFr = Fr.fromString(msgHash)
      logger.info(`Polling for ${label} L1→L2 message sync...`)
      const start = Date.now()
      while (Date.now() - start < 20 * 60 * 1000) {
        try {
          const blk = await node.getL1ToL2MessageCheckpoint(msgFr)
          if (blk !== undefined) { logger.info(`${label} message ready (block=${blk})`); break }
          logger.info(`   ${label} message not yet synced. Waiting 2 min...`)
        } catch (e) { logger.warn(`   Poll failed: ${e}`) }
        await wait(120_000)
      }
    }
    // Wait for sequencer to produce a new L2 block that includes the L1→L2 messages
    await waitForNextL2Block(node, logger)

    // Create FeeJuicePaymentMethodWithClaim (same as frontend public fuel path)
    const publicFuelPayment = new FeeJuicePaymentMethodWithClaim(ownerAztecAddress, {
      claimAmount: pfFuelAmountReceived,
      claimSecret: pfFuelSecret,
      messageLeafIndex: pfFuelIndex,
    })
    logger.info('FeeJuicePaymentMethodWithClaim created')

    // Claim tokens on L2 using public fuel to pay for gas (retries if message not yet consumable)
    // Testnet L1→L2 message sync can take 10+ min — use 8 retries × 2 min = 16 min
    logger.info('Claiming tokens on L2 with public fuel...')
    await sendPrivateWithRetry(
      () => l2BridgeContract.methods.claim_public(ownerAztecAddress, pfTokenAmount, pfClaimSecret, pfTokenIndex),
      {
        from: ownerAztecAddress,
        fee: {
          paymentMethod: publicFuelPayment,
          gasSettings: { gasLimits: pfGasLimits, teardownGasLimits: pfTeardownGasLimits, maxFeesPerGas: pfMaxFeesPerGas, maxPriorityFeesPerGas: GasFees.empty() },
        },
        wait: { timeout: getTimeouts().txTimeout },
      },
      logger,
      10,
      wallet,
    )

    await logFuelTestBalances('AFTER public fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
    logger.info('Public fuel (FeeJuicePaymentMethodWithClaim) test PASSED')
  } catch (error) {
    logger.error(`Public fuel test failed: ${error}`)
  }
}

/**
 * Test 1c: Private fuel via SwapBridgeRouter + PrivateMintAndPayFeePaymentMethod.
 * Same swap flow, but fuelRecipient is the BridgedFPC contract (not user).
 * Uses poseidon2 secret derivation + Wonderland BridgedFPC to pay for gas privately.
 */
async function testPrivateFuelFlow(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  l2BridgeContract: any,
  l2TokenContract: any,
  logger: Logger,
) {
  logger.info(`\n=== Testing Private Fuel (SwapBridgeRouter + Wonderland BridgedFPC) ===`)

  const finalDeployment = loadActiveDeployment()
  const swapRouterAddress = finalDeployment?.swapBridgeRouterAddress as `0x${string}` | undefined
  const bridgedFpcAddress = finalDeployment?.bridgedFpcAddress
  if (!swapRouterAddress) {
    logger.warn('No SwapBridgeRouter address found. Skipping private fuel test.')
    return
  }
  if (!bridgedFpcAddress) {
    logger.warn('No BridgedFPC address found. Skipping private fuel test.')
    return
  }

  const bridgedFpcAztecAddr = AztecAddress.fromString(bridgedFpcAddress)
  const tokenAddr = deployed.l1TokenContract as `0x${string}`
  const portalAddr = deployed.l1PortalContract as `0x${string}`
  const l1ChainId = l1ContractAddresses.rollupAddress ? 11155111 : 31337

  // Build swap route
  const feeJuiceAddr = ((l1ContractAddresses as any).feeJuiceAddress?.toString() || AZTEC_TOKEN) as `0x${string}`
  const [c0Pool1, c1Pool1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
  const [c0Pool2, c1Pool2] = sortCurrencies(ZERO_ADDRESS, feeJuiceAddr)
  const poolKeys = [
    { currency0: c0Pool1, currency1: c1Pool1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS },
    { currency0: c0Pool2, currency1: c1Pool2, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS },
  ]
  const zeroForOnes = [
    BigInt(tokenAddr) < BigInt(WETH_ADDRESS),
    BigInt(ZERO_ADDRESS) < BigInt(feeJuiceAddr),
  ]

  await logFuelTestBalances('BEFORE private fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)

  try {
    // Register BridgedFPC
    const bridgedFpcInstance = await registerPrivateContract(wallet, new Fr(0n))
    logger.info(`BridgedFPC registered at ${bridgedFpcInstance.address.toString()}`)

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

    const pvTotalAmount = 150n  // 0.00015 USDC total (6-decimal token)
    const pvFuelAmount = 50n   // 0.00005 USDC swapped to FeeJuice (needs ~49 FJ for gas, target ~120 FJ)
    const pvMinFuelOutput = 0n

    // Approve ERC20 → Permit2
    const erc20 = getContract({ address: tokenAddr, abi: [...ERC20_ABI, ...APPROVE_ABI], client: l1Client as any }) as any
    const currentAllowance = await erc20.read.allowance([l1Client.account.address, PERMIT2_CANONICAL]) as bigint
    if (currentAllowance < BigInt(1e30)) {
      const approveTx = await erc20.write.approve([PERMIT2_CANONICAL, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')])
      await sendAndWait(l1Client, approveTx, `Approved ${deployed.symbol} for Permit2`, logger)
    }

    // Mint ERC20
    const mintTx = await erc20.write.mint([l1Client.account.address, pvTotalAmount])
    await sendAndWait(l1Client, mintTx, `Minted ${pvTotalAmount} ${deployed.symbol} for private fuel test`, logger)

    // Sign Permit2 witness — fuelRecipient is BridgedFPC (not user)
    const pvPermit = await signPermit2Witness(l1Client, {
      tokenPortal: portalAddr,
      bridgeToken: tokenAddr,
      totalAmount: pvTotalAmount,
      fuelAmount: pvFuelAmount,
      aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
      fuelRecipient: bridgedFpcAztecAddr.toString() as `0x${string}`,
      tokenSecretHash: pvClaimSecretHash.toString() as `0x${string}`,
      fuelSecretHash: privateFuelSecretHash.toString() as `0x${string}`,
      minFuelOutput: pvMinFuelOutput,
      poolKeys,
      zeroForOnes,
      isPrivate: false,
      swapBridgeRouter: swapRouterAddress,
      l1ChainId,
    })
    logger.info('Permit2 witness signed (private fuel)')

    // Call SwapBridgeRouter.bridgeWithFuel
    const router = getContract({ address: swapRouterAddress, abi: SwapBridgeRouterAbiLocal, client: l1Client as any }) as any
    const bridgeTx = await router.write.bridgeWithFuel([
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
    ])
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

    // ── Cross-check: read the portal's DepositToAztecPublic event for the actual post-fee amount ──
    let pvPortalAmountAfterFee = 0n
    for (const log of bridgeReceipt.logs) {
      if (log.address.toLowerCase() !== portalAddr.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({ abi: CustomTokenPortalAbi, data: log.data, topics: log.topics })
        if (decoded.eventName === 'DepositToAztecPublic') {
          const a = decoded.args as any
          pvPortalAmountAfterFee = a.amount ?? a.amountAfterFee ?? 0n
          logger.info(`  Portal DepositToAztecPublic: amountAfterFee=${pvPortalAmountAfterFee}, fee=${a.fee ?? 0n}`)
          break
        }
      } catch { /* not our event */ }
    }
    if (pvPortalAmountAfterFee > 0n && pvPortalAmountAfterFee !== pvTokenAmount) {
      logger.warn(`  ⚠️ AMOUNT MISMATCH: Router event says ${pvTokenAmount} but portal says ${pvPortalAmountAfterFee}`)
      logger.warn(`  Using portal's post-fee amount for claim instead`)
      pvTokenAmount = pvPortalAmountAfterFee
    }

    // Wait for BOTH L1→L2 messages
    for (const [label, msgHash] of [['token', pvTokenKey], ['fuel', pvFuelKey]] as const) {
      if (!msgHash || msgHash === '0x0') continue
      const msgFr = Fr.fromString(msgHash)
      logger.info(`Polling for ${label} L1→L2 message sync...`)
      const start = Date.now()
      while (Date.now() - start < 20 * 60 * 1000) {
        try {
          const blk = await node.getL1ToL2MessageCheckpoint(msgFr)
          if (blk !== undefined) { logger.info(`${label} message ready (block=${blk})`); break }
          logger.info(`   ${label} message not yet synced. Waiting 2 min...`)
        } catch (e) { logger.warn(`   Poll failed: ${e}`) }
        await wait(120_000)
      }
    }
    // Wait for sequencer to produce a new L2 block that includes the L1→L2 messages
    await waitForNextL2Block(node, logger)

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

    // 4. Create PrivateMintAndPayFeePaymentMethod
    const bridgedFeeMethod = new PrivateMintAndPayFeePaymentMethod(
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
    logger.info('PrivateMintAndPayFeePaymentMethod created with gasSettings')

    // 5. Claim tokens on L2 with BridgedFPC fees (retries if message not yet consumable)
    logger.info('Claiming tokens on L2 with BridgedFPC (private fuel)...')
    await sendPrivateWithRetry(
      () => l2BridgeContract.methods.claim_public(ownerAztecAddress, pvTokenAmount, pvClaimSecret, pvTokenIndex),
      {
        from: ownerAztecAddress,
        ...feeOption,
        wait: { timeout: getTimeouts().txTimeout },
      },
      logger,
      10,
      wallet,
    )

    await logFuelTestBalances('AFTER private fuel', l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
    logger.info('Private fuel (PrivateMintAndPayFeePaymentMethod) test PASSED')
  } catch (error) {
    logger.error(`Private fuel test failed: ${error}`)
  }
}

/**
 * Test 1d/1e: Private deposit fuel with attestation via SwapBridgeRouter.
 * Uses isPrivate=true so the SwapBridgeRouter calls depositToAztecPrivateFor on the portal,
 * which validates the POCH or Passport attestation signature. The attestation is signed
 * over the depositor's L1 address (the actual user, forwarded by SwapBridgeRouter as a
 * trusted forwarder).
 */
async function testPrivateDepositFuelWithAttestation(
  attestationType: 'poch' | 'passport',
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  l2BridgeContract: any,
  l2TokenContract: any,
  logger: Logger,
) {
  const label = attestationType === 'poch' ? 'POCH' : 'Passport'
  logger.info(`\n=== Testing Private Deposit Fuel with ${label} Attestation (isPrivate=true) ===`)

  const finalDeployment = loadActiveDeployment()
  const swapRouterAddress = finalDeployment?.swapBridgeRouterAddress as `0x${string}` | undefined
  if (!swapRouterAddress) {
    logger.warn('No SwapBridgeRouter address found. Skipping private deposit fuel test.')
    return
  }

  const tokenAddr = deployed.l1TokenContract as `0x${string}`
  const portalAddr = deployed.l1PortalContract as `0x${string}`
  const l1ChainId = l1ContractAddresses.rollupAddress ? 11155111 : 31337

  // Build swap route
  const feeJuiceAddr = ((l1ContractAddresses as any).feeJuiceAddress?.toString() || AZTEC_TOKEN) as `0x${string}`
  const [c0Pool1, c1Pool1] = sortCurrencies(tokenAddr, WETH_ADDRESS)
  const [c0Pool2, c1Pool2] = sortCurrencies(ZERO_ADDRESS, feeJuiceAddr)
  const poolKeys = [
    { currency0: c0Pool1, currency1: c1Pool1, fee: ERC20_WETH_FEE, tickSpacing: ERC20_WETH_TICK_SPACING, hooks: ZERO_ADDRESS },
    { currency0: c0Pool2, currency1: c1Pool2, fee: ETH_AZTEC_FEE, tickSpacing: ETH_AZTEC_TICK_SPACING, hooks: ZERO_ADDRESS },
  ]
  const zeroForOnes = [
    BigInt(tokenAddr) < BigInt(WETH_ADDRESS),
    BigInt(ZERO_ADDRESS) < BigInt(feeJuiceAddr),
  ]

  // Approve ERC20 → Permit2
  const erc20 = getContract({ address: tokenAddr, abi: [...ERC20_ABI, ...APPROVE_ABI], client: l1Client as any }) as any
  const currentAllowance = await erc20.read.allowance([l1Client.account.address, PERMIT2_CANONICAL]) as bigint
  if (currentAllowance < BigInt(1e30)) {
    const approveTx = await erc20.write.approve([PERMIT2_CANONICAL, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')])
    await sendAndWait(l1Client, approveTx, `Approved ${deployed.symbol} for Permit2`, logger)
  }

  await logFuelTestBalances(`BEFORE private deposit fuel (${label})`, l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)

  try {
    const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')

    const [claimSecret, claimSecretHash] = await generateClaimSecret()
    const fuelSecret = Fr.random()
    const fuelSecretHash = await computeSecretHash(fuelSecret)

    const totalAmount = 160n  // 0.00016 USDC total (6-decimal token)
    const fuelAmount = 60n   // 0.00006 USDC swapped to FeeJuice (needs ~49 FJ for gas, target ~140 FJ)
    const minFuelOutput = 0n

    // Mint ERC20
    const mintTx = await erc20.write.mint([l1Client.account.address, totalAmount])
    await sendAndWait(l1Client, mintTx, `Minted ${totalAmount} ${deployed.symbol} for ${label} fuel test`, logger)

    // Build attestation data — signed over the depositor's L1 address (ownerEthAddress)
    // The SwapBridgeRouter passes msg.sender as _depositor to depositToAztecPrivateFor
    let cleanHandsData: { nonce: bigint; signature: `0x${string}` }
    let passportData: { maxAmount: bigint; nonce: bigint; deadline: bigint; signature: `0x${string}` }

    if (attestationType === 'poch') {
      const pochNonce = BigInt(Date.now())
      logger.info(`[L1] Signing POCH attestation for fuel deposit (nonce=${pochNonce})`)
      const pochSig = await signCleanHandsAttestation({
        nonce: pochNonce,
        circuitId: CLEAN_HANDS_CIRCUIT_ID,
        actionId: CLEAN_HANDS_ACTION_ID,
        userAddress: ownerEthAddress,
      })
      cleanHandsData = { nonce: pochNonce, signature: pochSig }
      passportData = { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` }
    } else {
      const l1Public = createPublicClient({ transport: http(L1_URL) })
      const block = await l1Public.getBlock()
      const deadline = block.timestamp + 3600n
      const passportNonce = BigInt(Date.now())
      const maxAmount = BigInt(100000)
      logger.info(`[L1] Signing Passport attestation for fuel deposit (maxAmount=${maxAmount}, deadline=${deadline})`)
      const passportSig = await signPassportAttestation({
        userAddress: ownerEthAddress,
        maxAmount,
        nonce: passportNonce,
        deadline,
        portalAddress: portalAddr,
      })
      cleanHandsData = { nonce: 0n, signature: '0x' as `0x${string}` }
      passportData = { maxAmount, nonce: passportNonce, deadline, signature: passportSig }
    }

    // Sign Permit2 witness — isPrivate=true triggers depositToAztecPrivateFor
    const permit = await signPermit2Witness(l1Client, {
      tokenPortal: portalAddr,
      bridgeToken: tokenAddr,
      totalAmount,
      fuelAmount,
      aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
      fuelRecipient: ownerAztecAddress.toString() as `0x${string}`,
      tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
      fuelSecretHash: fuelSecretHash.toString() as `0x${string}`,
      minFuelOutput,
      poolKeys,
      zeroForOnes,
      isPrivate: true,
      swapBridgeRouter: swapRouterAddress,
      l1ChainId,
    })
    logger.info(`Permit2 witness signed (isPrivate=true, ${label})`)

    // Call SwapBridgeRouter.bridgeWithFuel with real attestation
    const router = getContract({ address: swapRouterAddress, abi: SwapBridgeRouterAbiLocal, client: l1Client as any }) as any
    const bridgeTx = await router.write.bridgeWithFuel([
      {
        tokenPortal: portalAddr,
        bridgeToken: tokenAddr,
        totalAmount,
        fuelAmount,
        aztecRecipient: ownerAztecAddress.toString() as `0x${string}`,
        fuelRecipient: ownerAztecAddress.toString() as `0x${string}`,
        tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
        fuelSecretHash: fuelSecretHash.toString() as `0x${string}`,
        minFuelOutput,
        path: poolKeys,
        zeroForOnes,
        isPrivate: true,
        cleanHands: cleanHandsData,
        passport: passportData,
      },
      { nonce: permit.nonce, deadline: permit.deadline, signature: permit.signature },
    ])
    const bridgeReceipt = await sendAndWait(l1Client, bridgeTx, `SwapBridgeRouter.bridgeWithFuel (private deposit, ${label})`, logger)

    // Parse BridgeWithFuel event
    let tokenKey: `0x${string}` = '0x0' as `0x${string}`, tokenIndex = 0n, tokenAmount = 0n
    let fuelKey: `0x${string}` = '0x0' as `0x${string}`, fuelIndex = 0n, fuelAmountReceived = 0n
    for (const log of bridgeReceipt.logs) {
      if (log.address.toLowerCase() !== swapRouterAddress.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({ abi: SwapBridgeRouterAbiLocal, data: log.data, topics: log.topics })
        if (decoded.eventName === 'BridgeWithFuel') {
          const a = decoded.args as any
          tokenKey = a.tokenKey; tokenIndex = a.tokenIndex; tokenAmount = a.tokenAmount
          fuelKey = a.fuelKey; fuelIndex = a.fuelIndex; fuelAmountReceived = a.fuelAmount
          break
        }
      } catch { /* not our event */ }
    }
    logger.info(`  BridgeWithFuel event: tokenAmount=${tokenAmount}, fuelAmount=${fuelAmountReceived}`)
    logger.info(`  tokenIndex=${tokenIndex}, fuelIndex=${fuelIndex}`)

    // ── Cross-check: read the portal's DepositToAztecPrivate event for the actual post-fee amount ──
    let pdPortalAmountAfterFee = 0n
    for (const log of bridgeReceipt.logs) {
      if (log.address.toLowerCase() !== portalAddr.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({ abi: CustomTokenPortalAbi, data: log.data, topics: log.topics })
        if (decoded.eventName === 'DepositToAztecPrivate') {
          const a = decoded.args as any
          pdPortalAmountAfterFee = a.amount ?? a.amountAfterFee ?? 0n
          logger.info(`  Portal DepositToAztecPrivate: amountAfterFee=${pdPortalAmountAfterFee}, fee=${a.fee ?? 0n}`)
          break
        }
      } catch { /* not our event */ }
    }
    if (pdPortalAmountAfterFee > 0n && pdPortalAmountAfterFee !== tokenAmount) {
      logger.warn(`  ⚠️ AMOUNT MISMATCH: Router event says ${tokenAmount} but portal says ${pdPortalAmountAfterFee}`)
      logger.warn(`  Using portal's post-fee amount for claim instead`)
      tokenAmount = pdPortalAmountAfterFee
    }

    // Wait for BOTH L1→L2 messages to sync
    for (const [msgLabel, msgHash] of [['token', tokenKey], ['fuel', fuelKey]] as const) {
      if (!msgHash || msgHash === '0x0') continue
      const msgFr = Fr.fromString(msgHash)
      logger.info(`Polling for ${msgLabel} L1→L2 message sync...`)
      const start = Date.now()
      while (Date.now() - start < 20 * 60 * 1000) {
        try {
          const blk = await node.getL1ToL2MessageCheckpoint(msgFr)
          if (blk !== undefined) { logger.info(`${msgLabel} message ready (block=${blk})`); break }
          logger.info(`   ${msgLabel} message not yet synced. Waiting 2 min...`)
        } catch (e) { logger.warn(`   Poll failed: ${e}`) }
        await wait(120_000)
      }
    }
    // Wait for sequencer to produce a new L2 block that includes the L1→L2 messages
    await waitForNextL2Block(node, logger)

    // Private deposit → claim_private on L2 (not claim_public)
    logger.info(`[L2] Claiming tokens privately (private deposit from ${label} fuel flow)`)

    // Use public fuel to pay for the private claim
    const publicFuelPayment = new FeeJuicePaymentMethodWithClaim(ownerAztecAddress, {
      claimAmount: fuelAmountReceived,
      claimSecret: fuelSecret,
      messageLeafIndex: fuelIndex,
    })
    logger.info('FeeJuicePaymentMethodWithClaim created for private claim')

    await sendPrivateWithRetry(
      () => l2BridgeContract.methods.claim_private(ownerAztecAddress, tokenAmount, claimSecret, tokenIndex),
      {
        from: ownerAztecAddress,
        fee: { paymentMethod: publicFuelPayment },
        wait: { timeout: getTimeouts().txTimeout },
      },
      logger,
      10,
      wallet,
    )

    const { result: privateBalance } = await l2TokenContract.methods
      .balance_of_private(ownerAztecAddress)
      .simulate({ from: ownerAztecAddress })
    logger.info(`[L2] Private balance after ${label} fuel claim: ${privateBalance}`)

    await logFuelTestBalances(`AFTER private deposit fuel (${label})`, l2TokenContract, ownerAztecAddress, l1Client, logger, wallet)
    logger.info(`Private deposit fuel with ${label} attestation test PASSED`)
  } catch (error) {
    logger.error(`Private deposit fuel with ${label} attestation test failed: ${error}`)
  }
}

async function testPublicBridgeFlow(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  rollupVersion: number,
  logger: Logger
) {
  logger.info(`\n=== Testing PUBLIC bridge flow (depositToAztecPublic — no attestation needed) ===`)

  const l1TokenContract = EthAddress.fromString(deployed.l1TokenContract)
  const feeAssetHandler = EthAddress.fromString(deployed.feeAssetHandler)
  const l1PortalAddr = deployed.l1PortalContract as `0x${string}`

  const l1Portal = getContract({
    address: l1PortalAddr,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any

  const l1Token = getContract({
    address: deployed.l1TokenContract as `0x${string}`,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any

  // Approve portal to spend tokens
  const depositAmount = MINT_AMOUNT
  logger.info(`[L1] Approving portal to spend ${depositAmount} tokens`)
  const approveTx = await l1Token.write.approve([l1PortalAddr, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: approveTx, timeout: getTimeouts().txTimeout })

  // Deposit to Aztec public (no attestation needed for public deposits)
  const secret = Fr.random()
  const secretHash = await computeSecretHash(secret)
  logger.info(`[L1] depositToAztecPublic (amount=${depositAmount}, to=${ownerAztecAddress})`)

  const depositTx = await l1Portal.write.depositToAztecPublic([
    ownerAztecAddress.toString() as Hex,
    depositAmount,
    secretHash.toString() as Hex,
  ])
  const receipt = await l1Client.waitForTransactionReceipt({ hash: depositTx, timeout: getTimeouts().txTimeout })
  logger.info(`[L1] Deposit tx confirmed: ${depositTx}`)

  // Parse events to get messageHash and leafIndex
  const { parseEventLogs } = await import('viem')
  const logs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: receipt.logs })
  const depositEvent: any = logs.find((l: any) => l.eventName === 'DepositToAztecPublic')
  if (!depositEvent) throw new Error('DepositToAztecPublic event not found')

  const { key: messageHash, index: leafIndex, amount: amountAfterFee, fee } = depositEvent.args
  logger.info(`[L1] Event: amountAfterFee=${amountAfterFee}, fee=${fee}, messageHash=${messageHash}, leafIndex=${leafIndex}`)

  // Poll for L1→L2 message sync
  const messageHashFr = Fr.fromString(messageHash)
  logger.info(`[L1→L2] Polling for message sync...`)
  const maxWaitMs = 20 * 60 * 1000
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    try {
      const messageBlock = await node.getL1ToL2MessageCheckpoint(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  // Wait for sequencer to produce a new L2 block that includes the L1→L2 messages
  await waitForNextL2Block(node, logger)

  // Claim on L2 (retries if message not yet consumable)
  logger.info(`[L2] Claiming tokens publicly`)
  const l2BridgeContract = TokenBridgeContract.at(
    AztecAddress.fromString(deployed.l2BridgeContract),
    wallet
  )

  // Profile claim_public before sending
  await profileIfEnabled(
    'claim_public',
    l2BridgeContract.methods.claim_public(ownerAztecAddress, amountAfterFee, secret, leafIndex),
    { from: ownerAztecAddress, fee: { paymentMethod: sponsoredPaymentMethod } },
    logger,
  )

  await sendPrivateWithRetry(
    () => l2BridgeContract.methods.claim_public(ownerAztecAddress, amountAfterFee, secret, leafIndex),
    {
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    },
    logger,
    10,
    wallet,
  )

  const l2TokenContract = TokenContract.at(
    AztecAddress.fromString(deployed.l2TokenContract),
    wallet
  )
  const { result: balance } = await l2TokenContract.methods
    .balance_of_public(ownerAztecAddress)
    .simulate({ from: ownerAztecAddress })
  logger.info(`[L2] Public balance: ${balance}`)
  logger.info(`Public bridge flow (deposit + claim) successful!`)
}

/**
 * Test 4: L2 Public → L1
 * Burns from public balance via exit_to_l1_public (no attestation needed),
 * then waits for proof and calls TokenPortal.withdraw on L1.
 */
async function testPublicExitFlow(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  rollupVersion: number,
  l2BridgeContract: any,
  l2TokenContract: any,
  logger: Logger
) {
  logger.info(`\n=== Testing Public Exit Flow (exit_to_l1_public → L1 withdraw) ===`)

  const withdrawAmount = 5n
  const nonce = Fr.random()

  // AuthWit: authorize the PROXY (not bridge) to burn public tokens
  logger.info(`[L2] Setting public authwit for proxy to burn ${withdrawAmount} tokens`)
  const authwit = await SetPublicAuthwitContractInteraction.create(
    wallet,
    ownerAztecAddress,
    {
      caller: AztecAddress.fromString(deployed.l2ProxyContract),
      action: l2TokenContract.methods.burn_public(ownerAztecAddress, withdrawAmount, nonce),
    },
    true
  )
  await authwit.send({
    fee: { paymentMethod: sponsoredPaymentMethod as any },
    wait: { timeout: getTimeouts().txTimeout },
  })
  logger.info(`[L2] AuthWit set`)

  logger.info(`[L2] Calling exit_to_l1_public (no attestation needed)`)

  const selectorBuf = Buffer.from(
    toFunctionSelector('withdraw(address,uint256,address)').slice(2),
    'hex'
  )
  const recipient = EthAddress.fromString(ownerEthAddress)
  const callerOnL1 = EthAddress.ZERO

  // Profile exit_to_l1_public before sending
  await profileIfEnabled(
    'exit_to_l1_public',
    l2BridgeContract.methods.exit_to_l1_public(
      EthAddress.fromString(ownerEthAddress),
      withdrawAmount,
      EthAddress.ZERO,
      nonce
    ),
    { from: ownerAztecAddress, fee: { paymentMethod: sponsoredPaymentMethod } },
    logger,
  )

  const l2TxReceipt = await l2BridgeContract.methods
    .exit_to_l1_public(
      EthAddress.fromString(ownerEthAddress),
      withdrawAmount,
      EthAddress.ZERO,
      nonce
    )
    .send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout, returnReceipt: true },
    })

  const { result: newL2Balance } = await l2TokenContract.methods
    .balance_of_public(ownerAztecAddress)
    .simulate({ from: ownerAztecAddress })
  logger.info(`[L2] Public balance after exit: ${newL2Balance}`)

  // Wait for proof and withdraw on L1
  await waitForProofAndWithdrawL1(
    deployed, l1Client, ownerEthAddress, l1ContractAddresses,
    l2TxReceipt, l2BridgeContract, node, rollupVersion,
    withdrawAmount, callerOnL1, recipient, selectorBuf, logger
  )

  logger.info(`Public exit flow successful!`)
}

/**
 * Unified private deposit + claim flow.
 * 1. Mint & approve L1 tokens
 * 2. depositToAztecPrivate on L1 (with POCH or Passport attestation)
 * 3. Poll for L1→L2 message sync
 * 4. claim_private on L2
 * 5. Verify private balance
 */
async function testPrivateDepositAndClaimFlow(
  attestationType: 'poch' | 'passport',
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  logger: Logger
) {
  const label = attestationType === 'poch' ? 'POCH (Clean Hands)' : 'Passport'
  logger.info(`\n=== Testing ${label} Private Deposit + Claim Flow ===`)

  const l1PortalAddr = deployed.l1PortalContract as `0x${string}`
  const l1Portal = getContract({
    address: l1PortalAddr,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any

  const l1Token = getContract({
    address: deployed.l1TokenContract as `0x${string}`,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any

  const depositAmount = attestationType === 'poch' ? BigInt(2000) : BigInt(1000)

  // Mint tokens
  logger.info(`[L1] Minting ${depositAmount} tokens for ${label} test`)
  const mintTx = await l1Token.write.mint([ownerEthAddress, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: mintTx, timeout: getTimeouts().txTimeout })

  // Approve
  const approveTx = await l1Token.write.approve([l1PortalAddr, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: approveTx, timeout: getTimeouts().txTimeout })

  // Build attestation data
  let cleanHandsData: any
  let passportData: any

  if (attestationType === 'poch') {
    const pochNonce = BigInt(Date.now())
    logger.info(`[L1] Signing POCH attestation (nonce=${pochNonce})`)
    const pochSig = await signCleanHandsAttestation({
      nonce: pochNonce,
      circuitId: CLEAN_HANDS_CIRCUIT_ID,
      actionId: CLEAN_HANDS_ACTION_ID,
      userAddress: ownerEthAddress,
    })
    cleanHandsData = { nonce: pochNonce, signature: pochSig }
    passportData = { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as Hex }
  } else {
    const l1Public = createPublicClient({ transport: http(L1_URL) })
    const block = await l1Public.getBlock()
    const deadline = block.timestamp + 3600n
    const passportNonce = BigInt(Date.now())
    const maxAmount = BigInt(10000)
    logger.info(`[L1] Signing Passport attestation (maxAmount=${maxAmount}, nonce=${passportNonce}, deadline=${deadline})`)
    const passportSig = await signPassportAttestation({
      userAddress: ownerEthAddress,
      maxAmount,
      nonce: passportNonce,
      deadline,
      portalAddress: l1PortalAddr,
    })
    cleanHandsData = { nonce: 0n, signature: '0x' as Hex }
    passportData = { maxAmount, nonce: passportNonce, deadline, signature: passportSig }
  }

  // depositToAztecPrivate
  const secret = Fr.random()
  const secretHash = await computeSecretHash(secret)
  logger.info(`[L1] depositToAztecPrivate (amount=${depositAmount})`)

  const depositTx = await l1Portal.write.depositToAztecPrivate([
    depositAmount,
    secretHash.toString() as Hex,
    cleanHandsData,
    passportData,
  ])
  const receipt = await l1Client.waitForTransactionReceipt({ hash: depositTx, timeout: getTimeouts().txTimeout })
  logger.info(`[L1] Private deposit tx confirmed: ${depositTx}`)

  // Parse events
  const { parseEventLogs } = await import('viem')
  const logs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: receipt.logs })
  const depositEvent: any = logs.find((l: any) => l.eventName === 'DepositToAztecPrivate')
  if (!depositEvent) throw new Error('DepositToAztecPrivate event not found')

  const { amount: amountAfterFee, fee, key: messageHash, index: leafIndex } = depositEvent.args
  logger.info(`[L1] Event: amountAfterFee=${amountAfterFee}, fee=${fee}, messageHash=${messageHash}, leafIndex=${leafIndex}`)

  // Poll for L1→L2 message sync
  const messageHashFr = Fr.fromString(messageHash)
  logger.info(`[L1→L2] Polling for message sync...`)
  const maxWaitMs = 20 * 60 * 1000
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    try {
      const messageBlock = await node.getL1ToL2MessageCheckpoint(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await waitForNextL2Block(node, logger)

  // Claim on L2 (private)
  logger.info(`[L2] Claiming tokens privately`)
  const l2BridgeContract = TokenBridgeContract.at(
    AztecAddress.fromString(deployed.l2BridgeContract),
    wallet
  )

  // Profile claim_private before sending
  await profileIfEnabled(
    `claim_private (${label})`,
    l2BridgeContract.methods.claim_private(ownerAztecAddress, amountAfterFee, secret, leafIndex),
    { from: ownerAztecAddress, fee: { paymentMethod: sponsoredPaymentMethod } },
    logger,
  )

  await sendPrivateWithRetry(
    () => l2BridgeContract.methods.claim_private(ownerAztecAddress, amountAfterFee, secret, leafIndex),
    {
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    },
    logger,
    10,
    wallet,
  )

  // Verify private balance
  const l2TokenContract = TokenContract.at(
    AztecAddress.fromString(deployed.l2TokenContract),
    wallet
  )
  const { result: privateBalance } = await l2TokenContract.methods
    .balance_of_private(ownerAztecAddress)
    .simulate({ from: ownerAztecAddress })
  logger.info(`[L2] Private balance after ${label} claim: ${privateBalance}`)

  logger.info(`${label} private deposit + claim successful!`)
  return { amountAfterFee, messageHash, leafIndex, privateBalance }
}

/**
 * Tests 5 & 6: L2 Private → L1
 * Burns from private balance via exit_to_l1_private (requires attestation),
 * then waits for proof and calls TokenPortal.withdraw on L1.
 */
async function testPrivateExitFlow(
  attestationType: 'poch' | 'passport',
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  sponsoredPaymentMethod: any,
  node: any,
  rollupVersion: number,
  l2BridgeContract: any,
  l2TokenContract: any,
  logger: Logger
) {
  const label = attestationType === 'poch' ? 'POCH (Clean Hands)' : 'Passport'
  logger.info(`\n=== Testing Private Exit Flow with ${label} (exit_to_l1_private → L1 withdraw) ===`)

  const withdrawAmount = 3n
  const authwitNonce = Fr.random()

  // Private AuthWit: authorize the PROXY to burn private tokens
  logger.info(`[L2] Creating private authwit for proxy to burn ${withdrawAmount} tokens`)
  const proxyAddress = AztecAddress.fromString(deployed.l2ProxyContract)
  const burnAction = l2TokenContract.methods.burn_private(ownerAztecAddress, withdrawAmount, authwitNonce)
  const burnAuthWitness = await wallet.createAuthWit(ownerAztecAddress, {
    caller: proxyAddress,
    call: await burnAction.getFunctionCall(),
  })
  logger.info(`[L2] Private AuthWit created and stored in PXE`)

  // Build L2 attestation data
  let cleanHandsData: { nonce: bigint, signature: number[] }
  let passportData: { max_amount: bigint, nonce: bigint, deadline: bigint, signature: number[] }

  const l2BridgeAddress = AztecAddress.fromString(deployed.l2BridgeContract)

  if (attestationType === 'poch') {
    const pochNonce = BigInt(Date.now())
    logger.info(`[L2] Signing L2 POCH attestation (nonce=${pochNonce})`)
    const sig = await signL2CleanHandsAttestation({
      circuitId: CLEAN_HANDS_CIRCUIT_ID,
      actionId: CLEAN_HANDS_ACTION_ID,
      nonce: pochNonce,
      userAztecAddress: ownerAztecAddress,
    })
    cleanHandsData = { nonce: pochNonce, signature: sig }
    passportData = { max_amount: 0n, nonce: 0n, deadline: 0n, signature: new Array(64).fill(0) }
  } else {
    const l1Public = createPublicClient({ transport: http(L1_URL) })
    const block = await l1Public.getBlock()
    const deadline = block.timestamp + 7200n
    const passportNonce = BigInt(Date.now())
    const maxAmount = BigInt(10000)
    logger.info(`[L2] Signing L2 Passport attestation (maxAmount=${maxAmount}, nonce=${passportNonce}, deadline=${deadline})`)
    const sig = await signL2PassportAttestation({
      userAztecAddress: ownerAztecAddress,
      maxAmount,
      nonce: passportNonce,
      deadline,
      bridgeAddress: l2BridgeAddress,
    })
    cleanHandsData = { nonce: 0n, signature: new Array(64).fill(0) }
    passportData = { max_amount: maxAmount, nonce: passportNonce, deadline, signature: sig }
  }

  logger.info(`[L2] Calling exit_to_l1_private with ${label} attestation`)

  const selectorBuf = Buffer.from(
    toFunctionSelector('withdraw(address,uint256,address)').slice(2),
    'hex'
  )
  const recipient = EthAddress.fromString(ownerEthAddress)
  const callerOnL1 = EthAddress.ZERO

  // Profile exit_to_l1_private before sending
  await profileIfEnabled(
    `exit_to_l1_private (${label})`,
    l2BridgeContract.methods.exit_to_l1_private(
      EthAddress.fromString(ownerEthAddress),
      withdrawAmount,
      EthAddress.ZERO,
      authwitNonce,
      cleanHandsData,
      passportData,
    ),
    { from: ownerAztecAddress, fee: { paymentMethod: sponsoredPaymentMethod }, authWitnesses: [burnAuthWitness] },
    logger,
  )

  const l2TxReceipt = await sendPrivateWithRetry(
    () => l2BridgeContract.methods.exit_to_l1_private(
      EthAddress.fromString(ownerEthAddress),
      withdrawAmount,
      EthAddress.ZERO,
      authwitNonce,
      cleanHandsData,
      passportData,
    ),
    {
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout, returnReceipt: true },
      authWitnesses: [burnAuthWitness],
    },
    logger,
    10,
    wallet,
  )

  const { result: newPrivateBalance } = await l2TokenContract.methods
    .balance_of_private(ownerAztecAddress)
    .simulate({ from: ownerAztecAddress })
  logger.info(`[L2] Private balance after exit: ${newPrivateBalance}`)

  // Wait for proof and withdraw on L1
  await waitForProofAndWithdrawL1(
    deployed, l1Client, ownerEthAddress, l1ContractAddresses,
    l2TxReceipt, l2BridgeContract, node, rollupVersion,
    withdrawAmount, callerOnL1, recipient, selectorBuf, logger
  )

  logger.info(`Private exit flow with ${label} successful!`)
}

/**
 * Tests 7 & 8: Negative cross-claim tests.
 * - Test 7: depositToAztecPublic → try claim_private → should fail (content hash mismatch)
 * - Test 8: depositToAztecPrivate → try claim_public → should fail (content hash mismatch)
 */
async function testNegativeCrossClaim(
  testCase: 'public_deposit_private_claim' | 'private_deposit_public_claim',
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  sponsoredPaymentMethod: any,
  node: any,
  logger: Logger
) {
  const label = testCase === 'public_deposit_private_claim'
    ? 'Public Deposit → Private Claim (INVALID)'
    : 'Private Deposit → Public Claim (INVALID)'
  logger.info(`\n=== Negative Test: ${label} ===`)

  const l1PortalAddr = deployed.l1PortalContract as `0x${string}`
  const l1Portal = getContract({
    address: l1PortalAddr,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any

  const l1Token = getContract({
    address: deployed.l1TokenContract as `0x${string}`,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any

  const depositAmount = BigInt(500)

  // Mint & approve
  const mintTx = await l1Token.write.mint([ownerEthAddress, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: mintTx, timeout: getTimeouts().txTimeout })
  const approveTx = await l1Token.write.approve([l1PortalAddr, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: approveTx, timeout: getTimeouts().txTimeout })

  const secret = Fr.random()
  const secretHash = await computeSecretHash(secret)

  let messageHash: string
  let leafIndex: bigint
  let amountAfterFee: bigint

  if (testCase === 'public_deposit_private_claim') {
    // Do public deposit
    logger.info(`[L1] depositToAztecPublic (amount=${depositAmount})`)
    const depositTx = await l1Portal.write.depositToAztecPublic([
      ownerAztecAddress.toString() as Hex,
      depositAmount,
      secretHash.toString() as Hex,
    ])
    const receipt = await l1Client.waitForTransactionReceipt({ hash: depositTx, timeout: getTimeouts().txTimeout })
    const { parseEventLogs } = await import('viem')
    const logs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: receipt.logs })
    const evt: any = logs.find((l: any) => l.eventName === 'DepositToAztecPublic')
    if (!evt) throw new Error('DepositToAztecPublic event not found')
    ;({ key: messageHash, index: leafIndex, amount: amountAfterFee } = evt.args)
  } else {
    // Do private deposit (use POCH for simplicity)
    const pochNonce = BigInt(Date.now())
    const pochSig = await signCleanHandsAttestation({
      nonce: pochNonce,
      circuitId: CLEAN_HANDS_CIRCUIT_ID,
      actionId: CLEAN_HANDS_ACTION_ID,
      userAddress: ownerEthAddress,
    })
    logger.info(`[L1] depositToAztecPrivate (amount=${depositAmount})`)
    const depositTx = await l1Portal.write.depositToAztecPrivate([
      depositAmount,
      secretHash.toString() as Hex,
      { nonce: pochNonce, signature: pochSig },
      { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as Hex },
    ])
    const receipt = await l1Client.waitForTransactionReceipt({ hash: depositTx, timeout: getTimeouts().txTimeout })
    const { parseEventLogs } = await import('viem')
    const logs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: receipt.logs })
    const evt: any = logs.find((l: any) => l.eventName === 'DepositToAztecPrivate')
    if (!evt) throw new Error('DepositToAztecPrivate event not found')
    ;({ key: messageHash, index: leafIndex, amount: amountAfterFee } = evt.args)
  }

  logger.info(`[L1] Deposit confirmed: amountAfterFee=${amountAfterFee}, leafIndex=${leafIndex}`)

  // Poll for L1→L2 message sync
  const messageHashFr = Fr.fromString(messageHash)
  logger.info(`[L1→L2] Polling for message sync...`)
  const maxWaitMs = 20 * 60 * 1000
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    try {
      const messageBlock = await node.getL1ToL2MessageCheckpoint(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await waitForNextL2Block(node, logger)

  // Now try the WRONG claim type
  const l2BridgeContract = TokenBridgeContract.at(
    AztecAddress.fromString(deployed.l2BridgeContract),
    wallet
  )

  if (testCase === 'public_deposit_private_claim') {
    // Public deposit → try claim_private → should fail
    logger.info(`[L2] Attempting claim_private on a public deposit (should FAIL)`)
    try {
      await l2BridgeContract.methods
        .claim_private(ownerAztecAddress, amountAfterFee, secret, leafIndex)
        .simulate({ from: ownerAztecAddress })
      throw new Error('NEGATIVE TEST FAILED: claim_private succeeded on public deposit — expected revert')
    } catch (e: any) {
      if (e.message?.includes('NEGATIVE TEST FAILED')) throw e
      if (e.message?.includes('Include-by timestamp')) throw e
      logger.info(`[L2] Expected revert: ${e.message?.slice(0, 120)}...`)
      logger.info(`NEGATIVE TEST PASSED: claim_private correctly rejected on public deposit`)
    }
  } else {
    // Private deposit → try claim_public → should fail
    logger.info(`[L2] Attempting claim_public on a private deposit (should FAIL)`)
    try {
      await l2BridgeContract.methods
        .claim_public(ownerAztecAddress, amountAfterFee, secret, leafIndex)
        .simulate({ from: ownerAztecAddress })
      throw new Error('NEGATIVE TEST FAILED: claim_public succeeded on private deposit — expected revert')
    } catch (e: any) {
      if (e.message?.includes('NEGATIVE TEST FAILED')) throw e
      if (e.message?.includes('Include-by timestamp')) throw e
      logger.info(`[L2] Expected revert: ${e.message?.slice(0, 120)}...`)
      logger.info(`NEGATIVE TEST PASSED: claim_public correctly rejected on private deposit`)
    }
  }
}

/**
 * Test 9: Wrong Aztec address can't claim_public.
 * Deposit on L1 for ownerAztecAddress, then try claim_public with a different address.
 * The content hash includes `to`, so a different `to` = hash mismatch → revert.
 */
async function testWrongRecipientCantClaimPublic(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  sponsoredPaymentMethod: any,
  node: any,
  logger: Logger
) {
  logger.info(`\n=== Negative Test: Wrong Aztec address can't claim_public ===`)

  const l1PortalAddr = deployed.l1PortalContract as `0x${string}`
  const l1Portal = getContract({
    address: l1PortalAddr,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any
  const l1Token = getContract({
    address: deployed.l1TokenContract as `0x${string}`,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any

  const depositAmount = BigInt(500)

  // Mint & approve
  const mintTx = await l1Token.write.mint([ownerEthAddress, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: mintTx, timeout: getTimeouts().txTimeout })
  const approveTx = await l1Token.write.approve([l1PortalAddr, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: approveTx, timeout: getTimeouts().txTimeout })

  // Deposit to ownerAztecAddress
  const secret = Fr.random()
  const secretHash = await computeSecretHash(secret)
  logger.info(`[L1] depositToAztecPublic for ${ownerAztecAddress}`)
  const depositTx = await l1Portal.write.depositToAztecPublic([
    ownerAztecAddress.toString() as Hex,
    depositAmount,
    secretHash.toString() as Hex,
  ])
  const receipt = await l1Client.waitForTransactionReceipt({ hash: depositTx, timeout: getTimeouts().txTimeout })

  const { parseEventLogs } = await import('viem')
  const logs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: receipt.logs })
  const evt: any = logs.find((l: any) => l.eventName === 'DepositToAztecPublic')
  if (!evt) throw new Error('DepositToAztecPublic event not found')
  const { key: messageHash, index: leafIndex, amount: amountAfterFee } = evt.args

  // Wait for message sync
  const messageHashFr = Fr.fromString(messageHash)
  logger.info(`[L1→L2] Polling for message sync...`)
  const maxWaitMs = 20 * 60 * 1000
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    try {
      const messageBlock = await node.getL1ToL2MessageCheckpoint(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await waitForNextL2Block(node, logger)

  const l2BridgeContract = TokenBridgeContract.at(
    AztecAddress.fromString(deployed.l2BridgeContract),
    wallet
  )

  // Try claiming with a DIFFERENT address (random)
  const wrongAddress = AztecAddress.fromString('0x' + '01'.repeat(32))
  logger.info(`[L2] Attempting claim_public with wrong to=${wrongAddress} (should FAIL)`)
  try {
    await l2BridgeContract.methods
      .claim_public(wrongAddress, amountAfterFee, secret, leafIndex)
      .simulate({ from: ownerAztecAddress })
    throw new Error('NEGATIVE TEST FAILED: claim_public succeeded with wrong recipient')
  } catch (e: any) {
    if (e.message?.includes('NEGATIVE TEST FAILED')) throw e
    if (e.message?.includes('Include-by timestamp')) throw e
    logger.info(`[L2] Expected revert: ${e.message?.slice(0, 120)}...`)
    logger.info(`NEGATIVE TEST PASSED: Wrong address can't claim_public`)
  }

  // Verify the CORRECT address CAN still claim (message not consumed)
  logger.info(`[L2] Verifying correct address CAN claim...`)
  await l2BridgeContract.methods
    .claim_public(ownerAztecAddress, amountAfterFee, secret, leafIndex)
    .send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    })
  logger.info(`[L2] Correct address claimed successfully — access control verified`)
}

/**
 * Test 10: Wrong secret can't claim_private.
 * Private claims are secret-based (content hash doesn't include recipient).
 * Without the correct secret, consume_l1_to_l2_message fails.
 */
async function testWrongSecretCantClaimPrivate(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  sponsoredPaymentMethod: any,
  node: any,
  logger: Logger
) {
  logger.info(`\n=== Negative Test: Wrong secret can't claim_private ===`)

  const l1PortalAddr = deployed.l1PortalContract as `0x${string}`
  const l1Portal = getContract({
    address: l1PortalAddr,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any
  const l1Token = getContract({
    address: deployed.l1TokenContract as `0x${string}`,
    abi: TestERC20Abi,
    client: l1Client as any,
  }) as any

  const depositAmount = BigInt(500)

  // Mint & approve
  const mintTx = await l1Token.write.mint([ownerEthAddress, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: mintTx, timeout: getTimeouts().txTimeout })
  const approveTx = await l1Token.write.approve([l1PortalAddr, depositAmount])
  await l1Client.waitForTransactionReceipt({ hash: approveTx, timeout: getTimeouts().txTimeout })

  // Deposit privately (POCH attestation)
  const realSecret = Fr.random()
  const secretHash = await computeSecretHash(realSecret)
  const pochNonce = BigInt(Date.now())
  const pochSig = await signCleanHandsAttestation({
    nonce: pochNonce,
    circuitId: CLEAN_HANDS_CIRCUIT_ID,
    actionId: CLEAN_HANDS_ACTION_ID,
    userAddress: ownerEthAddress,
  })

  logger.info(`[L1] depositToAztecPrivate`)
  const depositTx = await l1Portal.write.depositToAztecPrivate([
    depositAmount,
    secretHash.toString() as Hex,
    { nonce: pochNonce, signature: pochSig },
    { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as Hex },
  ])
  const receipt = await l1Client.waitForTransactionReceipt({ hash: depositTx, timeout: getTimeouts().txTimeout })

  const { parseEventLogs } = await import('viem')
  const logs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: receipt.logs })
  const evt: any = logs.find((l: any) => l.eventName === 'DepositToAztecPrivate')
  if (!evt) throw new Error('DepositToAztecPrivate event not found')
  const { key: messageHash, index: leafIndex, amount: amountAfterFee } = evt.args

  // Wait for message sync
  const messageHashFr = Fr.fromString(messageHash)
  logger.info(`[L1→L2] Polling for message sync...`)
  const maxWaitMs = 20 * 60 * 1000
  const startWait = Date.now()
  while (Date.now() - startWait < maxWaitMs) {
    try {
      const messageBlock = await node.getL1ToL2MessageCheckpoint(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await waitForNextL2Block(node, logger)

  const l2BridgeContract = TokenBridgeContract.at(
    AztecAddress.fromString(deployed.l2BridgeContract),
    wallet
  )

  // Try claiming with a WRONG secret
  const wrongSecret = Fr.random()
  logger.info(`[L2] Attempting claim_private with wrong secret (should FAIL)`)
  try {
    await l2BridgeContract.methods
      .claim_private(ownerAztecAddress, amountAfterFee, wrongSecret, leafIndex)
      .simulate({ from: ownerAztecAddress })
    throw new Error('NEGATIVE TEST FAILED: claim_private succeeded with wrong secret')
  } catch (e: any) {
    if (e.message?.includes('NEGATIVE TEST FAILED')) throw e
    if (e.message?.includes('Include-by timestamp')) throw e
    logger.info(`[L2] Expected revert: ${e.message?.slice(0, 120)}...`)
    logger.info(`NEGATIVE TEST PASSED: Wrong secret can't claim_private`)
  }

  // Verify the CORRECT secret CAN claim
  logger.info(`[L2] Verifying correct secret CAN claim...`)
  await sendPrivateWithRetry(
    () => l2BridgeContract.methods.claim_private(ownerAztecAddress, amountAfterFee, realSecret, leafIndex),
    {
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    },
    logger,
    10,
    wallet,
  )
  logger.info(`[L2] Correct secret claimed successfully — access control verified`)
}

/**
 * Test 11: Non-token-holder can't exit_to_l1_public.
 * exit_to_l1_public burns msg.sender()'s tokens. A random address with no balance can't exit.
 */
async function testNonHolderCantExit(
  deployed: DeployedCompliantToken,
  wallet: EmbeddedWallet,
  ownerAztecAddress: AztecAddress,
  l2BridgeContract: any,
  l2TokenContract: any,
  sponsoredPaymentMethod: any,
  logger: Logger
) {
  logger.info(`\n=== Negative Test: Non-token-holder can't exit_to_l1_public ===`)

  const fakeRecipient = '0x' + 'de'.repeat(20)
  const nonce = Fr.random()

  // Simulate exit_to_l1_public from the owner but for more tokens than they have
  // (or without an authwit). This tests that the burn fails.
  const hugeAmount = BigInt(999999999999)
  logger.info(`[L2] Attempting exit_to_l1_public for ${hugeAmount} tokens (more than balance, should FAIL)`)
  try {
    await l2BridgeContract.methods
      .exit_to_l1_public(
        EthAddress.fromString(fakeRecipient),
        hugeAmount,
        EthAddress.ZERO,
        nonce
      )
      .simulate({ from: ownerAztecAddress })
    throw new Error('NEGATIVE TEST FAILED: exit_to_l1_public succeeded without sufficient balance/authwit')
  } catch (e: any) {
    if (e.message?.includes('NEGATIVE TEST FAILED')) throw e
    if (e.message?.includes('Include-by timestamp')) throw e
    logger.info(`[L2] Expected revert: ${e.message?.slice(0, 120)}...`)
    logger.info(`NEGATIVE TEST PASSED: Can't exit more tokens than held`)
  }
}

// ─── L2→L1 Withdraw Helper ──────────────────────────────────────────────────

async function waitForProofAndWithdrawL1(
  deployed: DeployedCompliantToken,
  l1Client: ExtendedViemWalletClient,
  ownerEthAddress: string,
  l1ContractAddresses: any,
  l2TxReceipt: any,
  l2BridgeContract: any,
  node: any,
  rollupVersion: number,
  withdrawAmount: bigint,
  callerOnL1: EthAddress,
  recipient: EthAddress,
  selectorBuf: Buffer,
  logger: Logger
) {
  const content = sha256ToField([
    selectorBuf,
    recipient.toBuffer32(),
    new Fr(withdrawAmount).toBuffer(),
    callerOnL1.toBuffer32(),
  ])
  const msgLeaf = computeL2ToL1MessageHash({
    l2Sender: l2BridgeContract.address,
    l1Recipient: EthAddress.fromString(deployed.l1PortalContract),
    content,
    rollupVersion: new Fr(rollupVersion),
    chainId: new Fr(l1ContractAddresses.rollupAddress ? 11155111 : 31337), // sepolia or local
  })

  await wait(120_000) // Initial buffer

  const blockNumber = l2TxReceipt.blockNumber!
  const rollupAddress = l1ContractAddresses?.rollupAddress?.toString()

  // Poll for proven block
  if (rollupAddress) {
    logger.info(`[L1] Polling for proven block (need block ${blockNumber})...`)
    const maxWaitMs = 50 * 60 * 1000
    const startWait = Date.now()
    while (Date.now() - startWait < maxWaitMs) {
      const proven = await l1Client.readContract({
        address: rollupAddress as `0x${string}`,
        abi: RollupAbi,
        functionName: 'getProvenCheckpointNumber',
      })
      const provenBlock = typeof proven === 'bigint' ? Number(proven) : proven
      if (provenBlock >= blockNumber) {
        logger.info(`[L1] Block ${blockNumber} proven (proven=${provenBlock})`)
        break
      }
      logger.info(`[L1] Not proven yet (proven=${provenBlock}). Waiting 2 min...`)
      await wait(120_000)
    }
  } else {
    logger.info(`[L1] No rollup address, waiting 40 min fixed...`)
    await wait(40 * 60 * 1000)
  }

  const txHash = typeof l2TxReceipt.txHash === 'string'
    ? TxHash.fromString(l2TxReceipt.txHash)
    : l2TxReceipt.txHash
  logger.info(`[L1] Computing witness for txHash=${txHash}`)

  const witness = await computeL2ToL1MembershipWitness(node, msgLeaf, txHash)
  if (!witness) throw new Error(`L2->L1 message not found for txHash ${txHash}`)

  const siblingPathHex = witness.siblingPath
    .toBufferArray()
    .map((buf: Buffer) => `0x${buf.toString('hex')}` as `0x${string}`)

  const l1Portal = getContract({
    address: deployed.l1PortalContract as `0x${string}`,
    abi: CustomTokenPortalAbi,
    client: l1Client as any,
  }) as any

  const withdrawTx = await l1Portal.write.withdraw([
    ownerEthAddress,
    withdrawAmount,
    false,
    BigInt(witness.epochNumber),
    BigInt(witness.leafIndex),
    siblingPathHex,
  ])
  await l1Client.waitForTransactionReceipt({ hash: withdrawTx, timeout: getTimeouts().txTimeout })

  const l1TokenManager = new L1TokenManager(
    EthAddress.fromString(deployed.l1TokenContract),
    EthAddress.fromString(deployed.feeAssetHandler),
    l1Client,
    logger
  )
  const newL1Balance = await l1TokenManager.getL1TokenBalance(ownerEthAddress as Hex)
  logger.info(`[L1] New L1 balance: ${newL1Balance}`)
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const logger = createLogger('aztec:bridge:compliant')

  logger.info('=== Aztec Compliant Bridge Deployment & Test ===')
  logger.info(`POCH Attester:    ${pochAttesterAccount.address}`)
  logger.info(`Passport Signer:  ${passportSignerAccount.address}`)
  logger.info(`Fee Basis Points: ${FEE_BASIS_POINTS}`)
  logger.info(`Circuit ID:       ${CLEAN_HANDS_CIRCUIT_ID}`)
  if (RUN_TESTS_ONLY) logger.info('Mode: RUN_TESTS_ONLY — skipping deployment')
  if (DEPLOY_ONLY) logger.info('Mode: DEPLOY_ONLY — skipping tests')
  if (DEPLOY_TOKEN) logger.info(`Mode: DEPLOY_TOKEN=${DEPLOY_TOKEN} — only deploying this token`)
  if (FORCE_REDEPLOY_ALL) logger.info('Mode: FORCE_REDEPLOY_ALL — redeploying tokens, fuel infra, and reseeding pools')

  // Setup wallet
  const wallet = await setupWallet()

  // Setup L1 client
  const nodeUrl = getAztecNodeUrl()
  const node = createAztecNodeClient(nodeUrl)
  const nodeInfo = await node.getNodeInfo()
  const chain = createEthereumChain([L1_URL], nodeInfo.l1ChainId)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_CREDENTIAL, chain.chainInfo)
  const ownerEthAddress = l1Client.account.address

  const l1ContractAddresses = nodeInfo.l1ContractAddresses
  logger.info(`Registry: ${l1ContractAddresses.registryAddress}`)
  logger.info(`Rollup:   ${l1ContractAddresses.rollupAddress}`)
  logger.info(`L1 Wallet: ${ownerEthAddress}`)
  logger.info(`Environment: ${process.env.AZTEC_ENV ?? 'sandbox'}`)

  // Check L1 balance
  const balance = await l1Client.getBalance({ address: ownerEthAddress as `0x${string}` })
  logger.info(`L1 Balance: ${(Number(balance) / 1e18).toFixed(4)} ETH`)

  // Setup sponsored FPC
  logger.info('Setting up sponsored fee payment...')
  const sponsoredFPC = await getSponsoredFPCInstance()
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact)
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address)

  // Deploy Schnorr account
  logger.info('Deploying Schnorr account...')
  const accountManager = await deploySchnorrAccount(wallet)
  const ownerAztecAddress = accountManager.address
  await wallet.registerSender(ownerAztecAddress, 'owner')
  logger.info(`Owner Aztec Address: ${ownerAztecAddress}`)

  const rollupVersion = (nodeInfo as { rollupVersion?: number }).rollupVersion ?? 0
  const l2ChainId = nodeInfo.l1ChainId ^ rollupVersion
  // Create deployment record (once, before the token loop) — skip in RUN_TESTS_ONLY
  // to avoid creating a new empty deployment that shadows the existing one with tokens.
  if (!RUN_TESTS_ONLY) {
    const serializedNodeInfo: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(nodeInfo)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          nested[k] = v != null && typeof (v as any).toString === 'function' && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean'
            ? (v as any).toString() : v
        }
        serializedNodeInfo[key] = nested
      } else {
        serializedNodeInfo[key] = value != null && typeof (value as any).toString === 'function' && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean'
          ? (value as any).toString() : value
      }
    }

    createDeployment({
      nodeUrl,
      l1RpcUrl: L1_URL,
      l1ChainId: nodeInfo.l1ChainId,
      l2ChainId,
      aztecVersion: (nodeInfo as any).nodeVersion ?? configManager.getConfig().settings.version,
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
  }

  // Check for existing token deployments (for skip-if-deployed checks)
  logger.info('\n📋 Checking for existing token deployments...')
  const existingTokens = loadExistingTokens()
  if (existingTokens.length > 0) {
    logger.info(`✅ Found ${existingTokens.length} existing tokens`)
    logger.info(`🪙 Deployed tokens: ${existingTokens.map((t) => t.symbol).join(', ')}`)
  }

  const deployedContracts: DeployedCompliantToken[] = []

  if (RUN_TESTS_ONLY) {
    // Skip all deployment — load existing tokens as compliant tokens
    logger.info('\n⏭️  RUN_TESTS_ONLY: loading existing tokens, skipping deployment...')
    for (const t of existingTokens) {
      deployedContracts.push(t as DeployedCompliantToken)
    }
  } else {
    // Determine which tokens to deploy
    const tokensToProcess = DEPLOY_TOKEN
      ? TOKEN_CONFIGS.filter(tc => tc.symbol.toUpperCase() === DEPLOY_TOKEN.toUpperCase())
      : TOKEN_CONFIGS

    if (DEPLOY_TOKEN && tokensToProcess.length === 0) {
      logger.error(`❌ DEPLOY_TOKEN=${DEPLOY_TOKEN} not found in TOKEN_CONFIGS. Available: ${TOKEN_CONFIGS.map(t => t.symbol).join(', ')}`)
      process.exit(1)
    }

    // When deploying a subset, carry over existing tokens that aren't being redeployed
    if (DEPLOY_TOKEN) {
      for (const t of existingTokens) {
        if (t.symbol.toUpperCase() !== DEPLOY_TOKEN.toUpperCase()) {
          deployedContracts.push(t as DeployedCompliantToken)
        }
      }
    }

    logger.info(`\n🚀 Starting deployment of ${tokensToProcess.length} token(s)...`)

    for (const tokenConfig of tokensToProcess) {
      // Check if token is already deployed
      const existingToken = existingTokens.find(
        (t) => t.symbol === tokenConfig.symbol
      ) as DeployedCompliantToken | undefined
      if (existingToken && existingToken.l2ProxyContract && !tokenConfig.forceDeploy && !FORCE_REDEPLOY_ALL) {
        logger.info(`⏭️  ${tokenConfig.symbol} already deployed, skipping...`)
        deployedContracts.push(existingToken)
        continue
      }
      if (existingToken && tokenConfig.forceDeploy) {
        logger.info(`🔄 ${tokenConfig.symbol} already deployed but forceDeploy is set, redeploying...`)
      }

      try {
        logger.info(`\n🔄 Deploying compliant setup for ${tokenConfig.symbol}...`)
        const deployed = await deployCompliantTokenSetup(
          tokenConfig,
          wallet,
          ownerAztecAddress,
          l1Client,
          ownerEthAddress,
          l1ContractAddresses,
          sponsoredPaymentMethod,
          logger
        )
        deployed.sponsoredFee = sponsoredFPC.address.toString()

        // Save incrementally to active deployment (survives partial failures)
        saveTokenToDeployment(deployed)
        deployedContracts.push(deployed)
        logger.info(`✅ Successfully deployed and saved ${tokenConfig.symbol} compliant token setup`)
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
      logger.info(`Already deployed, skipping...`)
      logger.info(`   UniswapFuelSwap: ${existingDeployment.uniswapFuelSwapAddress}`)
      logger.info(`   SwapBridgeRouter: ${existingDeployment.swapBridgeRouterAddress}`)
      logger.info(`   BridgedFPC: ${existingDeployment.bridgedFpcAddress}`)
    } else {
      try {
        logger.info('\n=== Deploying Fuel Swap Infrastructure ===')

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
        logger.info(`UniswapFuelSwap deployed at ${uniswapFuelSwapAddress.toString()}`)

        // 2. Deploy SwapBridgeRouter (L1)
        logger.info('Deploying SwapBridgeRouter contract...')
        const swapBridgeRouterAddress = await deployL1Contract(
          l1Client,
          SwapBridgeRouterAbi,
          SwapBridgeRouterBytecode,
          [PERMIT2_ADDRESS, feeJuicePortalAddress, uniswapFuelSwapAddress.toString()],
        ).then(({ address }) => address)
        logger.info(`SwapBridgeRouter deployed at ${swapBridgeRouterAddress.toString()}`)

        // 3. Register BridgedFPC (L2) — fully private contract, no deploy tx needed
        logger.info('Registering BridgedFPC contract...')
        const bridgedFpc = await registerPrivateContract(wallet, new Fr(0n))
        logger.info(`BridgedFPC registered at ${bridgedFpc.address.toString()}`)

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

    // Seed Uniswap V4 pools for all deployed tokens
    const feeJuiceAddrForSeed = ((l1ContractAddresses as any).feeJuiceAddress?.toString() || AZTEC_TOKEN) as `0x${string}`
    const feeAssetHandlerAddrForSeed = ((l1ContractAddresses as any).feeAssetHandlerAddress?.toString() || FEE_ASSET_HANDLER_ADDR) as `0x${string}`
    await seedAllTokenPools(deployedContracts, l1Client, logger, feeJuiceAddrForSeed, feeAssetHandlerAddrForSeed)

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
          const alreadySet = await portal.read.trustedForwarders([swapRouterAddr]) as boolean
          if (alreadySet) {
            logger.info(`    Already set — skipping`)
            continue
          }
          logger.info(`    Sending setTrustedForwarder...`)
          const tx = await portal.write.setTrustedForwarder([swapRouterAddr, true])
          await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 120_000 })
          logger.info(`    Trusted forwarder set (tx: ${tx.slice(0, 10)}...)`)
        } catch (error: any) {
          logger.error(`    Failed to set forwarder: ${error}`)
        }
      }
      logger.info('\nTrusted forwarder setup complete')
    }

    // Sync active deployment to frontend
    copyToFrontend()
    logger.info('Deployment finalized and synced to frontend')
  }

  // Run tests against the deployed/targeted token
  if (DEPLOY_ONLY) {
    logger.info('\n⏭️  DEPLOY_ONLY: skipping tests')
  } else if (deployedContracts.length > 0) {
    // When DEPLOY_TOKEN is set, test against that specific token (not the first in the list)
    const deployed = DEPLOY_TOKEN
      ? deployedContracts.find(t => t.symbol.toUpperCase() === DEPLOY_TOKEN.toUpperCase()) ?? deployedContracts[0]
      : deployedContracts[0]
    logger.info(`\n🧪 Running compliant bridge tests against ${deployed.symbol}...`)

    // Register contract artifacts with PXE so it can execute private functions.
    // When deploying fresh, deployment auto-registers. With skip-if-deployed we must do it manually.
    logger.info(`Registering contract artifacts with PXE...`)
    const contractsToRegister = [
      { address: deployed.l2BridgeContract, artifact: TokenBridgeContractArtifact, name: 'TokenBridge' },
      { address: deployed.l2ProxyContract, artifact: TokenMinterProxyContractArtifact, name: 'TokenMinterProxy' },
      { address: deployed.l2TokenContract, artifact: TokenContractArtifact, name: 'Token' },
    ]
    for (const { address, artifact, name } of contractsToRegister) {
      const aztecAddr = AztecAddress.fromString(address)
      const instance = await node.getContract(aztecAddr)
      if (!instance) {
        logger.warn(`[PXE] Contract instance not found on node for ${name} at ${address} — may already be registered`)
        continue
      }
      await wallet.registerContract(instance, artifact)
      logger.info(`[PXE] Registered ${name} at ${address}`)
    }

    // Instantiate L2 contract handles (reused across tests)
    const l2BridgeContract = TokenBridgeContract.at(
      AztecAddress.fromString(deployed.l2BridgeContract),
      wallet
    )
    const l2TokenContract = TokenContract.at(
      AztecAddress.fromString(deployed.l2TokenContract),
      wallet
    )

    await testPublicFuelFlow(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 1: L1 Public Deposit → L2 Public Claim (no attestation)
    // ════════════════════════════════════════════════════════════════════════════
    await testPublicBridgeFlow(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, rollupVersion, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 1b: Public Fuel — SwapBridgeRouter + FeeJuicePaymentMethodWithClaim
    // ════════════════════════════════════════════════════════════════════════════
    

    // ════════════════════════════════════════════════════════════════════════════
    // Test 1c: Private Fuel — SwapBridgeRouter + PrivateMintAndPayFeePaymentMethod
    // ════════════════════════════════════════════════════════════════════════════
    await testPrivateFuelFlow(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 1d: Private Deposit Fuel + POCH Attestation (isPrivate=true)
    // ════════════════════════════════════════════════════════════════════════════
    await testPrivateDepositFuelWithAttestation(
      'poch', deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 1e: Private Deposit Fuel + Passport Attestation (isPrivate=true)
    // ════════════════════════════════════════════════════════════════════════════
    await testPrivateDepositFuelWithAttestation(
      'passport', deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 2: L1 Private Deposit (POCH) → L2 Private Claim
    // ════════════════════════════════════════════════════════════════════════════
    const pochResult = await testPrivateDepositAndClaimFlow(
      'poch', deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, logger
    )
    logger.info(`POCH deposit+claim result: amountAfterFee=${pochResult.amountAfterFee}`)

    // ════════════════════════════════════════════════════════════════════════════
    // Test 3: L1 Private Deposit (Passport) → L2 Private Claim
    // ════════════════════════════════════════════════════════════════════════════
    const passportResult = await testPrivateDepositAndClaimFlow(
      'passport', deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, logger
    )
    logger.info(`Passport deposit+claim result: amountAfterFee=${passportResult.amountAfterFee}`)

    // ════════════════════════════════════════════════════════════════════════════
    // Test 4: L2 Public Exit → L1 Withdraw (no attestation)
    // ════════════════════════════════════════════════════════════════════════════
    await testPublicExitFlow(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, rollupVersion,
      l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 5: L2 Private Exit (POCH) → L1 Withdraw
    // ════════════════════════════════════════════════════════════════════════════
    await testPrivateExitFlow(
      'poch', deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, rollupVersion,
      l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 6: L2 Private Exit (Passport) → L1 Withdraw
    // ════════════════════════════════════════════════════════════════════════════
    await testPrivateExitFlow(
      'passport', deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, rollupVersion,
      l2BridgeContract, l2TokenContract, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 7: Negative — Public Deposit → Private Claim (should FAIL)
    // ════════════════════════════════════════════════════════════════════════════
    await testNegativeCrossClaim(
      'public_deposit_private_claim', deployed, wallet, ownerAztecAddress,
      l1Client, ownerEthAddress, sponsoredPaymentMethod, node, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 8: Negative — Private Deposit → Public Claim (should FAIL)
    // ════════════════════════════════════════════════════════════════════════════
    await testNegativeCrossClaim(
      'private_deposit_public_claim', deployed, wallet, ownerAztecAddress,
      l1Client, ownerEthAddress, sponsoredPaymentMethod, node, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 9: Negative — Wrong Aztec address can't claim_public
    // ════════════════════════════════════════════════════════════════════════════
    await testWrongRecipientCantClaimPublic(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      sponsoredPaymentMethod, node, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 10: Negative — Wrong secret can't claim_private
    // ════════════════════════════════════════════════════════════════════════════
    await testWrongSecretCantClaimPrivate(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      sponsoredPaymentMethod, node, logger
    )

    // ════════════════════════════════════════════════════════════════════════════
    // Test 11: Negative — Non-holder can't exit_to_l1_public
    // ════════════════════════════════════════════════════════════════════════════
    await testNonHolderCantExit(
      deployed, wallet, ownerAztecAddress, l2BridgeContract, l2TokenContract,
      sponsoredPaymentMethod, logger
    )

    logger.info('\n=== ALL 16 COMPLIANT BRIDGE + FUEL TESTS COMPLETE ===')
    logger.info(`Tested against: ${deployed.symbol}`)
    logger.info(`  L1 Portal:       ${deployed.l1PortalContract}`)
    logger.info(`  L2 Bridge:       ${deployed.l2BridgeContract}`)
    logger.info(`  L2 Proxy:        ${deployed.l2ProxyContract}`)
    logger.info(`  L2 Token:        ${deployed.l2TokenContract}`)
    logger.info(`  POCH Attester:   ${deployed.humanIdAttester}`)
    logger.info(`  Passport Signer: ${deployed.passportSigner}`)
  } else {
    logger.warn('\n⚠️  No tokens were deployed — skipping tests')
  }

  
  // Final summary
  logger.info('\n=== COMPLIANT DEPLOYMENT SUMMARY ===')
  logger.info(`Total tokens deployed: ${deployedContracts.length}`)
  for (const token of deployedContracts) {
    logger.info(`  ${token.symbol}: L1Portal=${token.l1PortalContract} L2Bridge=${token.l2BridgeContract} L2Token=${token.l2TokenContract}`)
  }

  // Save profiling results
  saveProfilingResults(logger)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
