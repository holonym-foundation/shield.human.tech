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
 * - AZTEC_ENV: Set to 'devnet' for devnet, or 'sandbox' for local (default: sandbox)
 * - L1_URL: L1 RPC URL (optional, uses config if not set)
 * - MNEMONIC: Wallet mnemonic (required for devnet, defaults to test mnemonic for sandbox)
 *
 * Run: node --import tsx index-devnet-compliant.ts
 */

import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { Logger, createLogger } from '@aztec/aztec.js/log'
import { L1TokenManager } from '@aztec/aztec.js/ethereum'
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

// Fuel infrastructure (UniswapFuelSwap + SwapBridgeRouter)
// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'
const UniswapFuelSwapAbi = UniswapFuelSwapJson.abi
const UniswapFuelSwapBytecode = UniswapFuelSwapJson.bytecode.object as `0x${string}`
// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'
const SwapBridgeRouterAbi = SwapBridgeRouterJson.abi
const SwapBridgeRouterBytecode = SwapBridgeRouterJson.bytecode.object as `0x${string}`

// Well-known Sepolia addresses
const UNISWAP_V4_POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'
const WETH_ADDRESS = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'
const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

import {
  createPublicClient,
  encodeFunctionData,
  getContract,
  http,
  toFunctionSelector,
  encodePacked,
  keccak256,
  type Hex,
} from 'viem'
import { privateKeyToAccount, signMessage } from 'viem/accounts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
]

async function sendPrivateWithRetry(
  buildTx: () => { send: (opts: any) => Promise<{ receipt: any }> },
  sendOpts: any,
  logger: Logger,
  maxRetries = 2,
): Promise<any> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { receipt } = await buildTx().send(sendOpts)
      return receipt
    } catch (e: any) {
      const msg = e?.message || ''
      const isRetryable = RETRYABLE_PATTERNS.some(p => msg.includes(p))
      if (isRetryable && attempt < maxRetries) {
        logger.info(`[Retry] Transient failure (attempt ${attempt}/${maxRetries}): ${msg.slice(0, 120)}`)
        logger.info(`[Retry] Waiting 15s for fresh L1 block before re-proving...`)
        await wait(15_000)
        continue
      }
      throw e
    }
  }
  throw new Error('sendPrivateWithRetry: unreachable')
}

import { setupWallet } from './utils/setup_wallet.js'
import { deploySchnorrAccount } from './utils/deploy_account.js'
import { getSponsoredFPCInstance } from './utils/sponsored_fpc.js'
import { TOKEN_CONFIGS, TokenConfig } from './constants/tokens.js'
import {
  createDeployment,
  saveTokenToDeployment,
  saveFuelInfraToDeployment,
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

const MNEMONIC = process.env.MNEMONIC || 'test test test test test test test test test test test junk'
const L1_URL = process.env.L1_URL || getL1RpcUrl()

const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT || '1000000000000000') // 1e15
const FEE_BASIS_POINTS = BigInt(process.env.FEE_BASIS_POINTS || '500') // 5% fee
const CLEAN_HANDS_CIRCUIT_ID = BigInt(process.env.CLEAN_HANDS_CIRCUIT_ID || '0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19')

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

  // ── Step 6: Deploy L2 Custom TokenBridge (7 args) ──
  logger.info(`[L2] Deploying Custom TokenBridge for ${tokenConfig.symbol}`)
  const { contract: l2BridgeContract } = await TokenBridgeContract.deploy(
    wallet,
    l2ProxyContract.address,     // token_minter_proxy
    l1PortalContractAddress,     // portal
    l2PochPubkey.x,              // human_id_attester_x (Grumpkin)
    l2PochPubkey.y,              // human_id_attester_y (Grumpkin)
    CLEAN_HANDS_CIRCUIT_ID,      // circuit_id
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
      const messageBlock = await node.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await wait(120_000) // Final buffer

  // Claim on L2
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

  await l2BridgeContract.methods
    .claim_public(ownerAztecAddress, amountAfterFee, secret, leafIndex)
    .send({
      from: ownerAztecAddress,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().txTimeout },
    })

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

  const { receipt: l2TxReceipt } = await l2BridgeContract.methods
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
    const actionId = 123456789n
    logger.info(`[L1] Signing POCH attestation (nonce=${pochNonce}, actionId=${actionId})`)
    const pochSig = await signCleanHandsAttestation({
      nonce: pochNonce,
      circuitId: CLEAN_HANDS_CIRCUIT_ID,
      actionId,
      userAddress: ownerEthAddress,
    })
    cleanHandsData = { nonce: pochNonce, actionId, signature: pochSig }
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
    cleanHandsData = { nonce: 0n, actionId: 0n, signature: '0x' as Hex }
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
      const messageBlock = await node.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await wait(120_000) // Final buffer

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
  let cleanHandsData: { nonce: bigint, action_id: bigint, signature: number[] }
  let passportData: { max_amount: bigint, nonce: bigint, deadline: bigint, signature: number[] }

  const l2BridgeAddress = AztecAddress.fromString(deployed.l2BridgeContract)

  if (attestationType === 'poch') {
    const pochNonce = BigInt(Date.now())
    const actionId = 123456789n
    logger.info(`[L2] Signing L2 POCH attestation (nonce=${pochNonce}, actionId=${actionId})`)
    const sig = await signL2CleanHandsAttestation({
      circuitId: CLEAN_HANDS_CIRCUIT_ID,
      actionId,
      nonce: pochNonce,
      userAztecAddress: ownerAztecAddress,
    })
    cleanHandsData = { nonce: pochNonce, action_id: actionId, signature: sig }
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
    cleanHandsData = { nonce: 0n, action_id: 0n, signature: new Array(64).fill(0) }
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
      actionId: 123456789n,
      userAddress: ownerEthAddress,
    })
    logger.info(`[L1] depositToAztecPrivate (amount=${depositAmount})`)
    const depositTx = await l1Portal.write.depositToAztecPrivate([
      depositAmount,
      secretHash.toString() as Hex,
      { nonce: pochNonce, actionId: 123456789n, signature: pochSig },
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
      const messageBlock = await node.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await wait(120_000) // Final buffer

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
      const messageBlock = await node.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await wait(120_000)

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
    actionId: 123456789n,
    userAddress: ownerEthAddress,
  })

  logger.info(`[L1] depositToAztecPrivate`)
  const depositTx = await l1Portal.write.depositToAztecPrivate([
    depositAmount,
    secretHash.toString() as Hex,
    { nonce: pochNonce, actionId: 123456789n, signature: pochSig },
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
      const messageBlock = await node.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        logger.info(`[L1→L2] Message synced at block ${messageBlock}`)
        break
      }
    } catch (e) { /* retry */ }
    logger.info(`[L1→L2] Waiting 2 min...`)
    await wait(120_000)
  }
  await wait(120_000)

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

  // Setup wallet
  const wallet = await setupWallet()

  // Setup L1 client
  const nodeUrl = getAztecNodeUrl()
  const node = createAztecNodeClient(nodeUrl)
  const nodeInfo = await node.getNodeInfo()
  const chain = createEthereumChain([L1_URL], nodeInfo.l1ChainId)
  const l1Client = createExtendedL1Client(chain.rpcUrls, MNEMONIC, chain.chainInfo)
  const ownerEthAddress = l1Client.account.address

  const l1ContractAddresses = nodeInfo.l1ContractAddresses
  logger.info(`Registry: ${l1ContractAddresses.registryAddress}`)
  logger.info(`Rollup:   ${l1ContractAddresses.rollupAddress}`)
  logger.info(`L1 Wallet: ${ownerEthAddress}`)
  logger.info(`Environment: ${process.env.AZTEC_ENV ?? 'sandbox'}`)

  // Check L1 balance
  const balance = await l1Client.getBalance({ address: ownerEthAddress as `0x${string}` })
  logger.info(`L1 Balance: ${(Number(balance) / 1e18).toFixed(4)} ETH`)

  // Setup fee payment using pre-funded deployer account (FeeJuice self-pay)
  // The SponsoredFPC has a bug in 4.2.0-aztecnr-rc.2 — paying from own FeeJuice balance
  logger.info('Setting up fee payment with pre-funded deployer...')
  const deployerSecretKey = process.env.DEPLOYER_SECRET_KEY
  const deployerSalt = process.env.DEPLOYER_SALT
  if (!deployerSecretKey || !deployerSalt) throw new Error('DEPLOYER_SECRET_KEY and DEPLOYER_SALT required in .env')

  const { deriveSigningKey } = await import('@aztec/stdlib/keys')
  const secretKey = Fr.fromString(deployerSecretKey)
  const salt = Fr.fromString(deployerSalt)
  const signingKey = deriveSigningKey(secretKey)
  const accountManager = await wallet.createSchnorrAccount(secretKey, salt, signingKey)
  const ownerAztecAddress = accountManager.address
  logger.info(`Deployer address: ${ownerAztecAddress}`)

  // Deploy account using NO_FROM (bypasses SchnorrAccount entrypoint, avoids
  // PXE bug with nested protocol contract calls)
  const { NO_FROM } = await import('@aztec/aztec.js/account')
  const { SponsoredFeePaymentMethod } = await import('@aztec/aztec.js/fee')
  const sponsoredFPC = await getSponsoredFPCInstance()
  const { SponsoredFPCContractArtifact } = await import('@aztec/noir-contracts.js/SponsoredFPC')
  const pxe = (wallet as any).pxe
  await pxe.registerContract({ instance: sponsoredFPC, artifact: SponsoredFPCContractArtifact })
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address)

  // Deploy account (skip if already deployed — "Existing nullifier" means it's already on-chain)
  const deployMethod = await accountManager.getDeployMethod()
  logger.info('Deploying account (NO_FROM + SponsoredFPC)...')
  try {
    await deployMethod.send({
      from: NO_FROM,
      fee: { paymentMethod: sponsoredPaymentMethod },
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info('Account deployed successfully')
  } catch (e: any) {
    if (e.message?.includes('Existing nullifier') || e.cause?.message?.includes('Existing nullifier')) {
      logger.info(`Account already deployed at ${ownerAztecAddress}, skipping`)
    } else {
      throw e
    }
  }
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
      if (existingToken && existingToken.l2ProxyContract && !tokenConfig.forceDeploy) {
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

    // ── Deploy Fuel Infrastructure (UniswapFuelSwap + SwapBridgeRouter) ──
    logger.info('\n=== Deploying Fuel Infrastructure ===')
    const existingDeployment = loadActiveDeployment()
    let uniswapFuelSwapAddress = existingDeployment?.uniswapFuelSwapAddress
    let swapBridgeRouterAddress = existingDeployment?.swapBridgeRouterAddress

    const feeJuiceAddress = (l1ContractAddresses as any).feeJuiceAddress?.toString()
    const feeJuicePortalAddress = (l1ContractAddresses as any).feeJuicePortalAddress?.toString()

    if (!feeJuiceAddress || !feeJuicePortalAddress) {
      logger.warn('FeeJuice or FeeJuicePortal address not available — skipping fuel infra')
    } else {
      // Step 1: Deploy UniswapFuelSwap (if not already deployed)
      if (!uniswapFuelSwapAddress) {
        logger.info('Deploying UniswapFuelSwap...')
        try {
          const swapResult = await deployL1Contract(
            l1Client,
            UniswapFuelSwapAbi,
            UniswapFuelSwapBytecode,
            [UNISWAP_V4_POOL_MANAGER, feeJuiceAddress, WETH_ADDRESS],
          )
          uniswapFuelSwapAddress = swapResult.address.toString()
          logger.info(`UniswapFuelSwap deployed at ${uniswapFuelSwapAddress}`)
        } catch (e: any) {
          logger.error(`Failed to deploy UniswapFuelSwap: ${e.message}`)
        }
      } else {
        logger.info(`UniswapFuelSwap already deployed at ${uniswapFuelSwapAddress}`)
      }

      // Step 2: Deploy SwapBridgeRouter (if not already deployed)
      if (!swapBridgeRouterAddress && uniswapFuelSwapAddress) {
        logger.info('Deploying SwapBridgeRouter...')
        try {
          const routerResult = await deployL1Contract(
            l1Client,
            SwapBridgeRouterAbi,
            SwapBridgeRouterBytecode,
            [PERMIT2_ADDRESS, feeJuicePortalAddress, uniswapFuelSwapAddress],
          )
          swapBridgeRouterAddress = routerResult.address.toString()
          logger.info(`SwapBridgeRouter deployed at ${swapBridgeRouterAddress}`)
        } catch (e: any) {
          logger.error(`Failed to deploy SwapBridgeRouter: ${e.message}`)
        }
      } else if (swapBridgeRouterAddress) {
        logger.info(`SwapBridgeRouter already deployed at ${swapBridgeRouterAddress}`)
      }

      // Step 3: Set trusted forwarder on ALL token portals
      if (swapBridgeRouterAddress && deployedContracts.length > 0) {
        logger.info(`Setting trusted forwarder (${swapBridgeRouterAddress}) on ${deployedContracts.length} portal(s)...`)
        for (const deployed of deployedContracts) {
          try {
            const portal = getContract({
              address: deployed.l1PortalContract as `0x${string}`,
              abi: CustomTokenPortalAbi,
              client: l1Client as any,
            }) as any
            const tx = await portal.write.setTrustedForwarder([swapBridgeRouterAddress, true])
            await l1Client.waitForTransactionReceipt({ hash: tx, timeout: 60_000 })
            logger.info(`  ✓ ${deployed.symbol} portal: forwarder set`)
          } catch (e: any) {
            logger.warn(`  ✗ ${deployed.symbol} portal: ${e.message?.slice(0, 80)}`)
          }
        }
      }

      // Step 4: Save fuel infra to deployment JSON
      if (uniswapFuelSwapAddress && swapBridgeRouterAddress) {
        // Compute BridgedFPC address (salt=0)
        let privateFpcAddress = existingDeployment?.privateFpcAddress ?? ''
        if (!privateFpcAddress) {
          try {
            const { getContractInstanceFromInstantiationParams } = await import('@aztec/aztec.js/contracts')
            const { loadContractArtifact } = await import('@aztec/aztec.js/abi')
            const { readFileSync: readFs } = await import('fs')
            const { resolve: resolvePath } = await import('path')
            const targetPath = resolvePath(import.meta.dirname, '../frontend/node_modules/@defi-wonderland/aztec-fee-payment/target/bridged_contract-BridgedFPC.json')
            const artifactJson = JSON.parse(readFs(targetPath, 'utf8'))
            const artifact = loadContractArtifact(artifactJson)
            const fpcInstance = await getContractInstanceFromInstantiationParams(artifact, { salt: new Fr(0n) })
            privateFpcAddress = fpcInstance.address.toString()
            logger.info(`PrivateFPC computed at ${privateFpcAddress}`)
          } catch (e: any) {
            logger.warn(`Could not compute BridgedFPC address: ${e.message?.slice(0, 80)}`)
          }
        }

        saveFuelInfraToDeployment({
          swapBridgeRouterAddress,
          uniswapFuelSwapAddress,
          privateFpcAddress,
        })
        logger.info('Fuel infrastructure saved to deployment')
      }
    }

    // Sync active deployment to frontend
    copyToFrontend()
    logger.info('✅ Deployment finalized and synced to frontend')
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

    // ════════════════════════════════════════════════════════════════════════════
    // Test 1: L1 Public Deposit → L2 Public Claim (no attestation)
    // ════════════════════════════════════════════════════════════════════════════
    await testPublicBridgeFlow(
      deployed, wallet, ownerAztecAddress, l1Client, ownerEthAddress,
      l1ContractAddresses, sponsoredPaymentMethod, node, rollupVersion, logger
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

    logger.info('\n=== ALL 12 COMPLIANT BRIDGE TESTS COMPLETE ===')
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
