/**
 * Aztec Token Bridge — Mainnet Deployment
 *
 * Deploys the production bridge on Ethereum mainnet + Aztec mainnet and wires
 * every layer so bridging is usable immediately after this script returns
 * (modulo pool seeding, see below).
 *
 * Contracts deployed:
 *   L1 (shared):   UniswapFuelSwap, SwapBridgeRouter
 *   L1 (per tok):  TokenPortal
 *   L2 (per tok):  TokenMinterProxy, TokenContract (Wonderland), TokenBridge
 *   L2 (shared):   BridgedFPC (registered, no deploy tx — fully private)
 *
 * Wiring performed automatically:
 *   proxy.set_token(l2Token)
 *   proxy.set_minter(l2Bridge, true)
 *   TokenPortal.initialize(registry, l1Token, l2Bridge)
 *   TokenPortal.setTrustedForwarder(SwapBridgeRouter, true)
 *
 * NOT performed (manual mainnet steps):
 *   1. Uniswap V4 pool seeding (ERC20/WETH, ETH/AZTEC, optional direct ERC20/AZTEC).
 *      Use Uniswap PositionManager — PoolSeeder locks liquidity permanently and
 *      is testnet-only.
 *   2. Ownership acceptance by the multisig (if OWNER is set, this script only
 *      *proposes* the transfer; the multisig must call `acceptOwnership()`).
 *
 * Required env:
 *   AZTEC_ENV=mainnet
 *   L1_PRIVATE_KEY=0x…                   deployer EOA (pays L1 gas)
 *   FEE_RECIPIENT=0x…                    portal fee collector (use multisig)
 *   POCH_ATTESTER_PRIVATE_KEY=0x…        L1 ECDSA attester
 *   PASSPORT_SIGNER_PRIVATE_KEY=0x…      L1 ECDSA passport signer
 *   L2_POCH_ATTESTER_PRIVATE_KEY=0x…     L2 Grumpkin attester (derived pubkey -> bridge)
 *   L2_PASSPORT_SIGNER_PRIVATE_KEY=0x…   L2 Grumpkin passport signer
 *
 * Optional env:
 *   OWNER=0x…                   Multisig to transfer L1 ownership to (two-step).
 *   FEE_BASIS_POINTS=500        Portal fee (default 5%, max 10%).
 *   CLEAN_HANDS_CIRCUIT_ID=…    Override default circuit ID.
 *   CLEAN_HANDS_ACTION_ID=…     Override default action ID.
 *   L1_URL=…                    Override L1 RPC.
 *   AZTEC_NODE_URL=…            Override Aztec node.
 *   FORCE_REDEPLOY_SWAPS=true   Redeploy UniswapFuelSwap + SwapBridgeRouter.
 *   DEPLOY_TOKEN=USDC           Only (re)deploy this token.
 *   FEE_JUICE_FUNDING=…         AZTEC (18-dec) to bridge as L2 FeeJuice for deploy gas (default 10e18).
 *   L2_DEPLOYER_SECRET_KEY=0x…  L2 deployer account keys. Auto-generated + logged if unset;
 *   L2_DEPLOYER_SIGNING_KEY=0x… save them to reuse the same funded admin account on re-runs
 *   L2_DEPLOYER_SALT=0x…        (this account owns the L2 TokenMinterProxy).
 *   <SYMBOL>_L1_ADDRESS=0x…     Override the pre-existing L1 token address (e.g. USDC_L1_ADDRESS).
 *   STRICT_POOL_CHECK=true      Abort if the V4 pool preflight finds no liquid AZTEC fuel pool
 *                               at the assumed key (default: warn + continue).
 *
 * Prerequisite: Aztec Alpha Mainnet has no SponsoredFPC, so the deployer bridges AZTEC →
 * L2 FeeJuice to pay for L2 deploys. The L1 deployer EOA must therefore hold
 * ≥ FEE_JUICE_FUNDING AZTEC (0xa27ec0…e62d2) in addition to ETH for L1 gas.
 *
 * Run: AZTEC_ENV=mainnet node --import tsx deploy-mainnet.ts
 */

import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr, GrumpkinScalar } from '@aztec/aztec.js/fields'
import { createLogger, type Logger } from '@aztec/aztec.js/log'
import { createExtendedL1Client } from '@aztec/ethereum/client'
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract'
import { createEthereumChain } from '@aztec/ethereum/chain'
import type { ExtendedViemWalletClient } from '@aztec/ethereum/types'
import { TokenContract } from '@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js'
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum'
import { NO_FROM } from '@aztec/aztec.js/account'
import type { AccountManager } from '@aztec/aztec.js/wallet'
import type { EmbeddedWallet } from '@aztec/wallets/embedded'
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice'
import { getCanonicalFeeJuice } from '@aztec/protocol-contracts/fee-juice'
import { Schnorr } from '@aztec/foundation/crypto/schnorr'
import { deriveSigningKey } from '@aztec/stdlib/keys'
import { registerPrivateContract } from '@wonderland/aztec-fee-payment'
import { getContract, keccak256, encodeAbiParameters, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve as resolvePath } from 'path'
import 'dotenv/config'

import { TokenBridgeContract } from './artifacts/TokenBridge.js'
import { TokenMinterProxyContract } from './artifacts/TokenMinterProxy.js'

// @ts-ignore
import CustomTokenPortalJson from '../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
// @ts-ignore
import UniswapFuelSwapJson from '../l1-contracts/out/UniswapFuelSwap.sol/UniswapFuelSwap.json'
// @ts-ignore
import SwapBridgeRouterJson from '../l1-contracts/out/SwapBridgeRouter.sol/SwapBridgeRouter.json'

import { setupWallet } from './utils/setup_wallet.js'
import { TOKEN_CONFIGS, TokenConfig } from './constants/tokens.js'
import {
  createDeployment,
  saveTokenToDeployment,
  saveFuelSwapInfraToDeployment,
  loadActiveDeployment,
  loadExistingTokens,
  copyToFrontend,
  type DeployedToken,
} from './utils/save_contracts.js'
import {
  getAztecNodeUrl,
  getL1RpcUrl,
  getTimeouts,
  isMainnet,
} from './config/config.js'
import configManager from './config/config.js'

// ─── Mainnet constants ──────────────────────────────────────────────
const POOL_MANAGER = '0x000000000004444c5dc75cB358380D2e3dE08A90' as const
const WETH = '0xc02aaa39b223fe8d0a0e8e4f27ead9083c756cc2' as const
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

// Pre-existing L1 token addresses on mainnet, overridable per symbol via <SYMBOL>_L1_ADDRESS.
// Deliberately NOT in the shared TOKEN_CONFIGS — the testnet/devnet scripts treat a set
// l1TokenAddress as "use this real token", so a mainnet address there would break Sepolia.
const MAINNET_L1_TOKENS: Record<string, Hex> = {
  USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
}

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ─── Env ────────────────────────────────────────────────────────────
const L1_PRIVATE_KEY = process.env.L1_PRIVATE_KEY as Hex | undefined
const OWNER = process.env.OWNER as Hex | undefined
const FEE_RECIPIENT = process.env.FEE_RECIPIENT as Hex | undefined
const FEE_BASIS_POINTS = BigInt(process.env.FEE_BASIS_POINTS || '500')
const CLEAN_HANDS_CIRCUIT_ID = BigInt(
  process.env.CLEAN_HANDS_CIRCUIT_ID ||
    '0x1c98fc4f7f1ad3805aefa81ad25fa466f8342292accf69566b43691d12742a19',
)
const CLEAN_HANDS_ACTION_ID = BigInt(process.env.CLEAN_HANDS_ACTION_ID || '123456789')
const FORCE_REDEPLOY_SWAPS = process.env.FORCE_REDEPLOY_SWAPS === 'true'
const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || ''

// Fee Juice funding — Aztec Alpha Mainnet has no SponsoredFPC, so the deployer bridges
// AZTEC → L2 FeeJuice to pay for L2 contract deploys. Default 10 AZTEC (18 decimals).
const FEE_JUICE_FUNDING = BigInt(process.env.FEE_JUICE_FUNDING || (10n ** 19n).toString())
const L2_DEPLOYER_SECRET_KEY = process.env.L2_DEPLOYER_SECRET_KEY
const L2_DEPLOYER_SIGNING_KEY = process.env.L2_DEPLOYER_SIGNING_KEY
const L2_DEPLOYER_SALT = process.env.L2_DEPLOYER_SALT

// ─── Helpers ────────────────────────────────────────────────────────
function asHex(pk: string): Hex {
  return (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is required in .env`)
  return v
}

const schnorr = new Schnorr()

async function deriveL2Pubkey(hex: string): Promise<{ x: Fr; y: Fr }> {
  const secretKey = Fr.fromString(asHex(hex))
  const signingKey = deriveSigningKey(secretKey)
  const pubkey = await schnorr.computePublicKey(signingKey)
  return { x: pubkey.x, y: pubkey.y }
}

function generateTokenSalts(symbol: string) {
  const t = Date.now()
  const s = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return {
    tokenSalt: new Fr(BigInt(t + s)),
    bridgeSalt: new Fr(BigInt(t + s + 1000)),
    proxySalt: new Fr(BigInt(t + s + 2000)),
  }
}

// ─── L1 deploy helpers ──────────────────────────────────────────────
async function deployUniswapFuelSwap(
  l1Client: ExtendedViemWalletClient,
  feeJuice: Hex,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    UniswapFuelSwapJson.abi,
    UniswapFuelSwapJson.bytecode.object as Hex,
    [POOL_MANAGER, feeJuice, WETH],
  )
  return address
}

async function deploySwapBridgeRouter(
  l1Client: ExtendedViemWalletClient,
  feeJuicePortal: Hex,
  uniswapFuelSwap: Hex,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    SwapBridgeRouterJson.abi,
    SwapBridgeRouterJson.bytecode.object as Hex,
    [PERMIT2, feeJuicePortal, uniswapFuelSwap],
  )
  return address
}

async function deployTokenPortal(
  l1Client: ExtendedViemWalletClient,
  initialOwner: Hex,
  feeRecipient: Hex,
  humanIdAttester: Hex,
  passportSigner: Hex,
): Promise<EthAddress> {
  const { address } = await deployL1Contract(
    l1Client,
    CustomTokenPortalJson.abi,
    CustomTokenPortalJson.bytecode.object as Hex,
    [
      initialOwner,
      feeRecipient,
      FEE_BASIS_POINTS,
      humanIdAttester,
      CLEAN_HANDS_CIRCUIT_ID,
      CLEAN_HANDS_ACTION_ID,
      passportSigner,
    ],
  )
  return address
}

function resolveL1TokenAddress(tc: TokenConfig): Hex | undefined {
  const sym = tc.symbol.toUpperCase()
  return (process.env[`${sym}_L1_ADDRESS`] || MAINNET_L1_TOKENS[sym] || tc.l1TokenAddress) as
    | Hex
    | undefined
}

// ─── FeeJuice claim persistence ─────────────────────────────────────
// The L1→L2 FeeJuice claim secret is generated in-memory and is the ONLY way to consume the
// bridged AZTEC. We persist it the instant it's created so an interrupted run never strands
// funds. The claim's recipient is fixed in the L1 message (this account), so the secret can
// only ever credit FeeJuice to that account — it is NOT a theft vector.
const CLAIMS_FILE = resolvePath(process.cwd(), '.fee-juice-claims.json')

interface SavedFeeJuiceClaim {
  recipient: string
  claimAmount: string
  claimSecret: string
  claimSecretHash?: string
  messageLeafIndex: string
  l1Token?: string
  bridgedAt?: string
  deployed?: boolean
}

function loadClaimRecord(account: string): SavedFeeJuiceClaim | undefined {
  if (!existsSync(CLAIMS_FILE)) return undefined
  try {
    return (JSON.parse(readFileSync(CLAIMS_FILE, 'utf8')) as Record<string, SavedFeeJuiceClaim>)[
      account.toLowerCase()
    ]
  } catch {
    return undefined
  }
}

function writeClaimRecord(account: string, rec: SavedFeeJuiceClaim): void {
  const all: Record<string, SavedFeeJuiceClaim> = existsSync(CLAIMS_FILE)
    ? JSON.parse(readFileSync(CLAIMS_FILE, 'utf8'))
    : {}
  all[account.toLowerCase()] = rec
  writeFileSync(CLAIMS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 })
}

function markClaimDeployed(account: string): void {
  const rec = loadClaimRecord(account) ?? { recipient: account, claimAmount: '0', claimSecret: '', messageLeafIndex: '0' }
  writeClaimRecord(account, { ...rec, deployed: true })
}

// ─── L2 deployer account: bridge FeeJuice + deploy (no SponsoredFPC on mainnet) ──
async function fundAndDeployL2Account(
  wallet: EmbeddedWallet,
  node: ReturnType<typeof createAztecNodeClient>,
  l1Client: ExtendedViemWalletClient,
  feeJuiceL1: Hex,
  logger: Logger,
): Promise<AccountManager> {
  const secretKey = L2_DEPLOYER_SECRET_KEY ? Fr.fromString(asHex(L2_DEPLOYER_SECRET_KEY)) : Fr.random()
  const salt = L2_DEPLOYER_SALT ? Fr.fromString(asHex(L2_DEPLOYER_SALT)) : Fr.random()
  const signingKey = L2_DEPLOYER_SIGNING_KEY
    ? GrumpkinScalar.fromString(asHex(L2_DEPLOYER_SIGNING_KEY))
    : GrumpkinScalar.random()

  if (!L2_DEPLOYER_SECRET_KEY || !L2_DEPLOYER_SIGNING_KEY || !L2_DEPLOYER_SALT) {
    logger.warn('L2 deployer keys not fully set in env — generated fresh keys.')
    logger.warn('SAVE THESE: this account owns the L2 TokenMinterProxy (controls minting). Re-runs reuse it:')
    logger.warn(`  L2_DEPLOYER_SECRET_KEY=${secretKey.toString()}`)
    logger.warn(`  L2_DEPLOYER_SIGNING_KEY=${signingKey.toString()}`)
    logger.warn(`  L2_DEPLOYER_SALT=${salt.toString()}`)
  }

  const account = await wallet.createSchnorrAccount(secretKey, salt, signingKey)
  const address = account.address
  logger.info(`L2 deployer account: ${address}`)

  const acct = address.toString()
  const rec = loadClaimRecord(acct)
  const timeouts = getTimeouts()
  const deployMethod = await account.getDeployMethod()

  // Fully deployed on a prior run — nothing to fund or deploy.
  if (rec?.deployed) {
    logger.info('L2 deployer account already deployed (per .fee-juice-claims.json) — skipping funding.')
    return account
  }

  // Already funded (FeeJuice claimed) but maybe not deployed? Pay the deploy from its own FeeJuice.
  let l2FjBalance = 0n
  try {
    const { address: feeJuiceL2 } = await getCanonicalFeeJuice()
    const feeJuice = await FeeJuiceContract.at(feeJuiceL2, wallet)
    l2FjBalance = ((await feeJuice.methods.balance_of_public(address).simulate({ from: address }))
      .result ?? 0n) as bigint
  } catch {
    l2FjBalance = 0n
  }
  if (l2FjBalance >= FEE_JUICE_FUNDING) {
    logger.info(`Account already holds ${l2FjBalance} FeeJuice — skipping L1 bridge.`)
    try {
      await deployMethod.send({ from: NO_FROM, wait: { timeout: timeouts.deployTimeout } })
    } catch (e) {
      if (!/Existing nullifier|already deployed/.test(String(e))) throw e
      logger.info('Account already deployed — continuing.')
    }
    markClaimDeployed(acct)
    return account
  }

  // Build the claim: reuse a persisted one (interrupted prior run) or bridge fresh.
  let claim: { claimAmount: bigint; claimSecret: Fr; messageLeafIndex: bigint }
  if (rec?.claimSecret && rec.claimSecret !== '') {
    logger.info('Reusing the persisted FeeJuice claim from a previous run — NOT bridging again.')
    claim = {
      claimAmount: BigInt(rec.claimAmount),
      claimSecret: Fr.fromString(rec.claimSecret),
      messageLeafIndex: BigInt(rec.messageLeafIndex),
    }
  } else {
    // Pre-flight: deployer must hold enough AZTEC on L1 (no faucet on mainnet).
    const aztec = getContract({ address: feeJuiceL1, abi: ERC20_BALANCE_ABI, client: l1Client as any }) as any
    const l1AztecBal = (await aztec.read.balanceOf([l1Client.account.address])) as bigint
    if (l1AztecBal < FEE_JUICE_FUNDING) {
      throw new Error(
        `Deployer holds ${l1AztecBal} AZTEC on L1 but needs ${FEE_JUICE_FUNDING} to fund the L2 deployer account. ` +
          `Acquire AZTEC (${feeJuiceL1}) or lower FEE_JUICE_FUNDING.`,
      )
    }

    logger.info(`Bridging ${FEE_JUICE_FUNDING} AZTEC → L2 FeeJuice for ${address}…`)
    const portalMgr = await L1FeeJuicePortalManager.new(node, l1Client, logger)
    // mint=false: bridge real AZTEC held by the deployer, never a testnet faucet mint.
    const fresh = await portalMgr.bridgeTokensPublic(address, FEE_JUICE_FUNDING, false)
    // Persist IMMEDIATELY — before any step that can fail. Without this, an interrupt strands
    // the bridged AZTEC (the in-memory secret is the only way to claim it).
    writeClaimRecord(acct, {
      recipient: acct,
      claimAmount: fresh.claimAmount.toString(),
      claimSecret: fresh.claimSecret.toString(),
      claimSecretHash: (fresh as any).claimSecretHash?.toString?.(),
      messageLeafIndex: fresh.messageLeafIndex.toString(),
      l1Token: feeJuiceL1,
      bridgedAt: new Date().toISOString(),
    })
    logger.warn(`FeeJuice claim saved to ${CLAIMS_FILE} (gitignored). RECOVERY backup (recipient is fixed = safe to record):`)
    logger.warn(`  recipient=${acct} amount=${fresh.claimAmount} leafIndex=${fresh.messageLeafIndex}`)
    logger.warn(`  claimSecret=${fresh.claimSecret.toString()}`)
    claim = { claimAmount: fresh.claimAmount, claimSecret: fresh.claimSecret, messageLeafIndex: fresh.messageLeafIndex }
    logger.info('Bridged. Waiting for the L1→L2 message to become consumable on L2…')
  }

  // Deploy the account, claiming the bridged FJ in the same tx. The L1→L2 message takes a few
  // L2 blocks to land — retry until it does.
  const claimPayment = new FeeJuicePaymentMethodWithClaim(address, claim)
  const maxAttempts = 40
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await deployMethod.send({
        from: NO_FROM,
        fee: { paymentMethod: claimPayment },
        wait: { timeout: timeouts.deployTimeout },
      })
      logger.info('L2 deployer account deployed (paid via claimed FeeJuice).')
      markClaimDeployed(acct)
      return account
    } catch (e) {
      const msg = String(e)
      if (/Existing nullifier|already deployed/.test(msg)) {
        logger.info('Account already deployed — continuing.')
        markClaimDeployed(acct)
        return account
      }
      // PXE can't sync against a pruning node — retrying won't help. Fail fast; the bridged
      // FeeJuice is persisted and will be reused on re-run, so no funds are lost.
      if (/Unknown state|First available state/.test(msg)) {
        throw new Error(
          `PXE failed to sync against the Aztec node (${msg.split('\n')[0]}). The bridged FeeJuice ` +
            `is saved in ${CLAIMS_FILE} and will be reused on re-run — no funds lost. Point ` +
            `AZTEC_NODE_URL at a non-pruning / archive Aztec mainnet node and re-run.`,
        )
      }
      if (attempt === maxAttempts) {
        throw new Error(`Account deploy via FeeJuice claim failed after ${maxAttempts} attempts: ${msg}`)
      }
      logger.info(`  Attempt ${attempt}/${maxAttempts}: L1→L2 message not yet consumable (${msg.split('\n')[0]}). Retrying in 30s…`)
      await new Promise((r) => setTimeout(r, 30_000))
    }
  }
  return account
}

// ─── Uniswap V4 pool preflight (read-only) ──────────────────────────
// Pool keys are passed per-call to UniswapFuelSwap/SwapBridgeRouter, so a mismatch is fixed in
// packages/sdk/src/config.ts + frontend config — NOT by redeploying. This just surfaces the
// real pool keys (and liquidity) for each leg of the fuel route before launch.
const STATE_VIEW = '0x7ffe42c4a5deea5b0fec41c94c136cf115597227' as const
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const
// MUST mirror packages/sdk/src/config.ts (FEE_POOL_FEE / tick spacing / FEE_POOL_USES_NATIVE_ETH).
const ASSUMED_FEE = 10000
const ASSUMED_TICK_SPACING = 200
const FEE_POOL_USES_NATIVE_ETH = true
const V4_FEE_TIERS: { fee: number; tickSpacing: number }[] = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
]
const STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
  {
    type: 'function',
    name: 'getLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [{ name: 'liquidity', type: 'uint128' }],
  },
] as const

function v4PoolId(a: Hex, b: Hex, fee: number, tickSpacing: number): Hex {
  const [c0, c1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [c0.toLowerCase() as Hex, c1.toLowerCase() as Hex, fee, tickSpacing, ZERO_ADDR],
    ),
  )
}

async function scanPair(stateView: any, label: string, a: Hex, b: Hex, logger: Logger): Promise<boolean> {
  const hits: string[] = []
  let foundAssumed = false
  for (const { fee, tickSpacing } of V4_FEE_TIERS) {
    const id = v4PoolId(a, b, fee, tickSpacing)
    try {
      const [sqrtPriceX96] = (await stateView.read.getSlot0([id])) as [bigint, number, number, number]
      if (sqrtPriceX96 === 0n) continue
      const liq = (await stateView.read.getLiquidity([id])) as bigint
      const assumed = fee === ASSUMED_FEE && tickSpacing === ASSUMED_TICK_SPACING
      hits.push(`fee=${fee} tickSpacing=${tickSpacing} liquidity=${liq}${assumed ? '  ← assumed key' : ''}`)
      if (assumed && liq > 0n) foundAssumed = true
    } catch {
      // pool not initialized at this key — skip
    }
  }
  if (hits.length === 0) {
    logger.warn(`  ${label}: ❌ no initialized pool at standard fee tiers`)
  } else {
    logger.info(`  ${label}:`)
    for (const h of hits) logger.info(`    ${h}`)
  }
  return foundAssumed
}

async function preflightPools(
  l1Client: ExtendedViemWalletClient,
  feeJuice: Hex,
  tokens: TokenConfig[],
  logger: Logger,
): Promise<void> {
  logger.info('\n── Uniswap V4 pool preflight (read-only) ──')
  const stateView = getContract({ address: STATE_VIEW, abi: STATE_VIEW_ABI, client: l1Client as any }) as any

  const base = FEE_POOL_USES_NATIVE_ETH ? ZERO_ADDR : WETH
  const baseLabel = FEE_POOL_USES_NATIVE_ETH ? 'nativeETH' : 'WETH'
  const altBase = FEE_POOL_USES_NATIVE_ETH ? WETH : ZERO_ADDR
  const altLabel = FEE_POOL_USES_NATIVE_ETH ? 'WETH' : 'nativeETH'

  // Terminal fuel leg (…→ AZTEC). Scan both bases so liquidity on the non-assumed side is visible.
  const terminalOk = await scanPair(stateView, `${baseLabel}/AZTEC (terminal fuel leg)`, base, feeJuice, logger)
  await scanPair(stateView, `${altLabel}/AZTEC (alt base)`, altBase, feeJuice, logger)

  for (const tc of tokens) {
    const token = resolveL1TokenAddress(tc)
    if (!token) continue
    await scanPair(stateView, `${tc.symbol}/WETH (multi-hop leg)`, token, WETH, logger)
    await scanPair(stateView, `${tc.symbol}/AZTEC (direct route)`, token, feeJuice, logger)
  }

  if (!terminalOk) {
    const msg =
      `No liquid AZTEC fuel pool at the assumed key (fee=${ASSUMED_FEE}, tickSpacing=${ASSUMED_TICK_SPACING}, ${baseLabel}). ` +
      'Fuel swaps will fail until a pool is seeded or the SDK/frontend pool-key config is updated to match a pool listed above.'
    if (process.env.STRICT_POOL_CHECK === 'true') throw new Error(msg)
    logger.warn(`  ⚠️  ${msg}`)
    logger.warn('  (Set STRICT_POOL_CHECK=true to abort on this. Plain bridging is unaffected.)')
  } else {
    logger.info(`  ✅ Liquid AZTEC fuel pool found at the assumed key (fee=${ASSUMED_FEE}, ${baseLabel}).`)
  }
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const logger = createLogger('aztec:deploy-mainnet')

  // ── Validate env ──
  if (!isMainnet()) {
    throw new Error(
      `AZTEC_ENV must be 'mainnet' (got '${process.env.AZTEC_ENV}'). This script refuses to run on any other network.`,
    )
  }
  if (!L1_PRIVATE_KEY) throw new Error('L1_PRIVATE_KEY is required')
  if (!FEE_RECIPIENT) throw new Error('FEE_RECIPIENT is required (multisig recommended)')

  requireEnv('POCH_ATTESTER_PRIVATE_KEY')
  requireEnv('PASSPORT_SIGNER_PRIVATE_KEY')
  requireEnv('L2_POCH_ATTESTER_PRIVATE_KEY')
  requireEnv('L2_PASSPORT_SIGNER_PRIVATE_KEY')

  const pochAttester = privateKeyToAccount(asHex(process.env.POCH_ATTESTER_PRIVATE_KEY!))
  const passportSigner = privateKeyToAccount(asHex(process.env.PASSPORT_SIGNER_PRIVATE_KEY!))
  const l2PochPubkey = await deriveL2Pubkey(process.env.L2_POCH_ATTESTER_PRIVATE_KEY!)
  const l2PassportPubkey = await deriveL2Pubkey(process.env.L2_PASSPORT_SIGNER_PRIVATE_KEY!)

  // Pre-existing L1 tokens required for every config entry on mainnet
  const tokensToProcess: TokenConfig[] = DEPLOY_TOKEN
    ? TOKEN_CONFIGS.filter((t) => t.symbol.toUpperCase() === DEPLOY_TOKEN.toUpperCase())
    : TOKEN_CONFIGS
  if (DEPLOY_TOKEN && tokensToProcess.length === 0) {
    throw new Error(`DEPLOY_TOKEN=${DEPLOY_TOKEN} not found in TOKEN_CONFIGS`)
  }
  const missing = tokensToProcess.filter((t) => !resolveL1TokenAddress(t))
  if (missing.length > 0) {
    throw new Error(
      `Mainnet deploy requires an L1 token address for every token. Missing: ${missing
        .map((t) => t.symbol)
        .join(', ')}. Add it to MAINNET_L1_TOKENS or set ${missing
        .map((t) => `${t.symbol.toUpperCase()}_L1_ADDRESS`)
        .join('/')}.`,
    )
  }

  // ── L1 client / node info ──
  const nodeUrl = getAztecNodeUrl()
  const L1_URL = getL1RpcUrl()
  const node = createAztecNodeClient(nodeUrl)
  const nodeInfo = await node.getNodeInfo()

  if (nodeInfo.l1ChainId !== 1) {
    throw new Error(`Expected L1 chain ID 1 (mainnet), got ${nodeInfo.l1ChainId}`)
  }

  const chain = createEthereumChain([L1_URL], nodeInfo.l1ChainId)
  const l1Client = createExtendedL1Client(chain.rpcUrls, L1_PRIVATE_KEY, chain.chainInfo)
  const deployerEth = l1Client.account.address as Hex

  const l1Addrs = nodeInfo.l1ContractAddresses
  const registryAddr = l1Addrs.registryAddress.toString() as Hex
  const feeJuiceAddr = (l1Addrs as any).feeJuiceAddress?.toString() as Hex | undefined
  const feeJuicePortalAddr = (l1Addrs as any).feeJuicePortalAddress?.toString() as Hex | undefined
  if (!feeJuiceAddr || !feeJuicePortalAddr) {
    throw new Error('Missing feeJuiceAddress / feeJuicePortalAddress from node info')
  }

  logger.info('=== Aztec Bridge Mainnet Deployment ===')
  logger.info(`Deployer (L1):       ${deployerEth}`)
  logger.info(`FeeRecipient:        ${FEE_RECIPIENT}`)
  logger.info(`Multisig OWNER:      ${OWNER ?? '(none — ownership stays with deployer)'}`)
  logger.info(`L1 Registry:         ${registryAddr}`)
  logger.info(`L1 Rollup:           ${l1Addrs.rollupAddress}`)
  logger.info(`FeeJuice:            ${feeJuiceAddr}`)
  logger.info(`FeeJuicePortal:      ${feeJuicePortalAddr}`)
  logger.info(`PoolManager:         ${POOL_MANAGER}`)
  logger.info(`WETH:                ${WETH}`)
  logger.info(`Permit2:             ${PERMIT2}`)
  logger.info(`Fee basis points:    ${FEE_BASIS_POINTS} (max 1000 = 10%)`)
  logger.info(`POCH attester (L1):  ${pochAttester.address}`)
  logger.info(`Passport signer (L1):${passportSigner.address}`)
  logger.info(`Tokens:              ${tokensToProcess.map((t) => t.symbol).join(', ')}`)

  const bal = await l1Client.getBalance({ address: deployerEth })
  logger.info(`Deployer L1 balance: ${(Number(bal) / 1e18).toFixed(4)} ETH`)
  if (bal === 0n) throw new Error('Deployer has 0 ETH on L1')

  // ── Uniswap V4 pool preflight (read-only; before spending AZTEC on FeeJuice funding) ──
  await preflightPools(l1Client, feeJuiceAddr, tokensToProcess, logger)

  // ── L2 wallet + FeeJuice-funded deployer account (no SponsoredFPC on mainnet) ──
  const wallet = await setupWallet()
  const accountManager = await fundAndDeployL2Account(wallet, node, l1Client, feeJuiceAddr, logger)
  const ownerAztecAddress = accountManager.address
  await wallet.registerSender(ownerAztecAddress, 'owner')
  logger.info(`Deployer (L2):       ${ownerAztecAddress}`)
  // Per-token L2 txs below omit fee.paymentMethod ⇒ the deployer account pays from the
  // FeeJuice it claimed during account deploy (no SponsoredFPC on mainnet).

  // ── Deployment record ──
  const rollupVersion = (nodeInfo as { rollupVersion?: number }).rollupVersion ?? 0
  const l2ChainId = nodeInfo.l1ChainId ^ rollupVersion
  const serializedNodeInfo: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nodeInfo)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested: Record<string, unknown> = {}
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        nested[nk] =
          nv != null &&
          typeof (nv as any).toString === 'function' &&
          typeof nv !== 'string' &&
          typeof nv !== 'number' &&
          typeof nv !== 'boolean'
            ? (nv as any).toString()
            : nv
      }
      serializedNodeInfo[k] = nested
    } else {
      serializedNodeInfo[k] =
        v != null &&
        typeof (v as any).toString === 'function' &&
        typeof v !== 'string' &&
        typeof v !== 'number' &&
        typeof v !== 'boolean'
          ? (v as any).toString()
          : v
    }
  }

  createDeployment({
    nodeUrl,
    l1RpcUrl: L1_URL,
    l1ChainId: nodeInfo.l1ChainId,
    l2ChainId,
    aztecVersion:
      (nodeInfo as any).nodeVersion ?? configManager.getConfig().settings.version,
    rollupVersion,
    networkName: 'mainnet',
    l1ContractAddresses: {
      rollupAddress: l1Addrs.rollupAddress.toString(),
      registryAddress: registryAddr,
      inboxAddress: l1Addrs.inboxAddress.toString(),
      outboxAddress: l1Addrs.outboxAddress.toString(),
    },
    nodeInfo: serializedNodeInfo,
    sponsoredFeeAddress: '',
  })

  // ── Shared L1 infra (idempotent across re-runs) ──
  logger.info('\n── Shared L1 infrastructure ──')
  const prior = loadActiveDeployment()

  let uniswapFuelSwap: Hex
  if (!FORCE_REDEPLOY_SWAPS && prior?.uniswapFuelSwapAddress) {
    uniswapFuelSwap = prior.uniswapFuelSwapAddress as Hex
    logger.info(`UniswapFuelSwap (existing): ${uniswapFuelSwap}`)
  } else {
    logger.info('Deploying UniswapFuelSwap…')
    uniswapFuelSwap = (await deployUniswapFuelSwap(l1Client, feeJuiceAddr)).toString() as Hex
    logger.info(`UniswapFuelSwap: ${uniswapFuelSwap}`)
    saveFuelSwapInfraToDeployment({ uniswapFuelSwapAddress: uniswapFuelSwap })
  }

  let swapBridgeRouter: Hex
  if (!FORCE_REDEPLOY_SWAPS && prior?.swapBridgeRouterAddress) {
    swapBridgeRouter = prior.swapBridgeRouterAddress as Hex
    logger.info(`SwapBridgeRouter (existing): ${swapBridgeRouter}`)
  } else {
    logger.info('Deploying SwapBridgeRouter…')
    swapBridgeRouter = (
      await deploySwapBridgeRouter(l1Client, feeJuicePortalAddr, uniswapFuelSwap)
    ).toString() as Hex
    logger.info(`SwapBridgeRouter: ${swapBridgeRouter}`)
    saveFuelSwapInfraToDeployment({ swapBridgeRouterAddress: swapBridgeRouter })
  }

  let bridgedFpcAddress: string
  if (prior?.bridgedFpcAddress) {
    bridgedFpcAddress = prior.bridgedFpcAddress
    logger.info(`BridgedFPC (existing): ${bridgedFpcAddress}`)
  } else {
    logger.info('Registering BridgedFPC on L2…')
    const bridgedFpc = await registerPrivateContract(wallet, new Fr(0n))
    bridgedFpcAddress = bridgedFpc.address.toString()
    logger.info(`BridgedFPC: ${bridgedFpcAddress}`)
    saveFuelSwapInfraToDeployment({ bridgedFpcAddress })
  }

  // ── Per-token deploy + wire ──
  const existingTokens = loadExistingTokens()
  const deployed: DeployedToken[] = []

  for (const tc of tokensToProcess) {
    logger.info(`\n── ${tc.symbol} ──`)

    if (existingTokens.find((e) => e.symbol === tc.symbol && !tc.forceDeploy)) {
      logger.info(`  Already deployed — skipping. Set forceDeploy=true to redeploy.`)
      deployed.push(existingTokens.find((e) => e.symbol === tc.symbol)!)
      continue
    }

    const l1TokenContract = EthAddress.fromString(resolveL1TokenAddress(tc)!)
    logger.info(`  L1 token (existing): ${l1TokenContract}`)

    // L1 TokenPortal — deployer = initialOwner (transferred to OWNER at the end)
    logger.info('  Deploying TokenPortal…')
    const portal = await deployTokenPortal(
      l1Client,
      deployerEth,
      FEE_RECIPIENT,
      pochAttester.address as Hex,
      passportSigner.address as Hex,
    )
    logger.info(`  TokenPortal: ${portal}`)

    const salts = generateTokenSalts(tc.symbol)

    // L2 TokenMinterProxy (owner is immutable — set at deploy)
    logger.info('  Deploying L2 TokenMinterProxy…')
    const { contract: l2Proxy } = await TokenMinterProxyContract.deploy(wallet).send({
      from: ownerAztecAddress,
      contractAddressSalt: salts.proxySalt,
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info(`  TokenMinterProxy: ${l2Proxy.address}`)

    // L2 Token (Wonderland, constructor_with_minter)
    logger.info('  Deploying L2 Token (Wonderland)…')
    const { contract: l2Token } = await TokenContract.deployWithOpts(
      { wallet, method: 'constructor_with_minter' },
      tc.l2Name,
      tc.l2Symbol,
      tc.decimals,
      l2Proxy.address,
    ).send({
      from: ownerAztecAddress,
      contractAddressSalt: salts.tokenSalt,
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info(`  L2 Token: ${l2Token.address}`)

    // L2 TokenBridge (with attestation config + Grumpkin pubkeys)
    logger.info('  Deploying L2 TokenBridge…')
    const { contract: l2Bridge } = await TokenBridgeContract.deploy(
      wallet,
      l2Proxy.address,
      portal,
      l2PochPubkey.x,
      l2PochPubkey.y,
      CLEAN_HANDS_CIRCUIT_ID,
      CLEAN_HANDS_ACTION_ID,
      l2PassportPubkey.x,
      l2PassportPubkey.y,
    ).send({
      from: ownerAztecAddress,
      contractAddressSalt: salts.bridgeSalt,
      wait: { timeout: getTimeouts().deployTimeout },
    })
    logger.info(`  TokenBridge: ${l2Bridge.address}`)

    // Wire proxy: set_token (immutable), set_minter(bridge, true)
    logger.info('  Wiring proxy.set_token…')
    await l2Proxy.methods.set_token(l2Token.address).send({
      from: ownerAztecAddress,
      wait: { timeout: getTimeouts().txTimeout },
    })
    logger.info('  Wiring proxy.set_minter(bridge, true)…')
    await l2Proxy.methods.set_minter(l2Bridge.address, true).send({
      from: ownerAztecAddress,
      wait: { timeout: getTimeouts().txTimeout },
    })

    // Initialize L1 portal
    logger.info('  Initializing TokenPortal…')
    const portalCtr = getContract({
      address: portal.toString() as Hex,
      abi: CustomTokenPortalJson.abi,
      client: l1Client as any,
    }) as any
    const initTx = await portalCtr.write.initialize([
      registryAddr,
      l1TokenContract.toString() as Hex,
      l2Bridge.address.toString() as Hex,
    ])
    await l1Client.waitForTransactionReceipt({
      hash: initTx,
      timeout: getTimeouts().txTimeout,
    })

    // Trust SwapBridgeRouter for relayed private deposits
    logger.info('  Setting trusted forwarder (SwapBridgeRouter)…')
    const fwTx = await portalCtr.write.setTrustedForwarder([swapBridgeRouter, true])
    await l1Client.waitForTransactionReceipt({
      hash: fwTx,
      timeout: getTimeouts().txTimeout,
    })

    const record: DeployedToken = {
      symbol: tc.symbol,
      decimals: tc.decimals,
      logo: tc.logo,
      l1TokenContract: l1TokenContract.toString(),
      l1PortalContract: portal.toString(),
      l2TokenContract: l2Token.address.toString(),
      l2BridgeContract: l2Bridge.address.toString(),
      l2ProxyContract: l2Proxy.address.toString(),
      feeAssetHandler: '',
      sponsoredFee: '',
    }
    saveTokenToDeployment(record)
    deployed.push(record)
    logger.info(`  ${tc.symbol} deployed + wired`)
  }

  // ── Optional: propose ownership transfer to multisig ──
  if (OWNER) {
    logger.info(`\n── Proposing L1 ownership transfer → ${OWNER} ──`)
    const transfer = async (addr: Hex, label: string, abi: any) => {
      const c = getContract({ address: addr, abi, client: l1Client as any }) as any
      const tx = await c.write.transferOwnership([OWNER])
      await l1Client.waitForTransactionReceipt({
        hash: tx,
        timeout: getTimeouts().txTimeout,
      })
      logger.info(`  ${label}: pending acceptOwnership from ${OWNER}`)
    }
    await transfer(uniswapFuelSwap, 'UniswapFuelSwap', UniswapFuelSwapJson.abi)
    await transfer(swapBridgeRouter, 'SwapBridgeRouter', SwapBridgeRouterJson.abi)
    for (const d of deployed) {
      await transfer(
        d.l1PortalContract as Hex,
        `TokenPortal(${d.symbol})`,
        CustomTokenPortalJson.abi,
      )
    }
    logger.info(`  Multisig ${OWNER} must call acceptOwnership() on each contract to complete.`)
  }

  copyToFrontend()

  // ── Summary ──
  logger.info('\n=== Mainnet Deployment Summary ===')
  logger.info(`UniswapFuelSwap:   ${uniswapFuelSwap}`)
  logger.info(`SwapBridgeRouter:  ${swapBridgeRouter}`)
  logger.info(`BridgedFPC (L2):   ${bridgedFpcAddress}`)
  for (const d of deployed) {
    logger.info(`\n${d.symbol}`)
    logger.info(`  L1 Token:   ${d.l1TokenContract}`)
    logger.info(`  L1 Portal:  ${d.l1PortalContract}`)
    logger.info(`  L2 Token:   ${d.l2TokenContract}`)
    logger.info(`  L2 Bridge:  ${d.l2BridgeContract}`)
  }

  logger.info('\nNext steps (manual):')
  logger.info(
    '  1. Seed Uniswap V4 pools via Uniswap PositionManager (do NOT use PoolSeeder on mainnet).',
  )
  logger.info('     Required: ETH/AZTEC (terminal fuel leg) and one of:')
  logger.info('       - ERC20/WETH pool for each bridged token (multi-hop route), or')
  logger.info('       - Direct ERC20/AZTEC pool (single-hop route)')
  if (OWNER) {
    logger.info(`  2. From multisig ${OWNER}, call acceptOwnership() on:`)
    logger.info(`     - UniswapFuelSwap   (${uniswapFuelSwap})`)
    logger.info(`     - SwapBridgeRouter  (${swapBridgeRouter})`)
    for (const d of deployed) {
      logger.info(`     - TokenPortal ${d.symbol.padEnd(6)} (${d.l1PortalContract})`)
    }
  } else {
    logger.info(
      '  2. Consider transferring L1 ownership to a multisig+timelock (set OWNER on re-run).',
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
