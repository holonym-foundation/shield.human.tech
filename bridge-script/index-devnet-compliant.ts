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
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee/testing'
import { SetPublicAuthwitContractInteraction, computeInnerAuthWitHashFromAction } from '@aztec/aztec.js/authorization'
import { EmbeddedWallet } from '@aztec/wallets/embedded'
import { createAztecNodeClient } from '@aztec/aztec.js/node'
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging'
import { sha256ToField } from '@aztec/foundation/crypto/sha256'
import { computeL2ToL1MessageHash, computeSecretHash } from '@aztec/stdlib/hash'
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

import {
  createPublicClient,
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

async function sendPrivateWithRetry<T>(
  buildTx: () => { send: (opts: any) => Promise<T> },
  sendOpts: any,
  logger: Logger,
  maxRetries = 2,
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await buildTx().send(sendOpts)
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

import { SponsoredFPCContract, SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC'
import { setupWallet } from './utils/setup_wallet.js'
import { deploySchnorrAccount } from './utils/deploy_account.js'
import { getSponsoredFPCInstance } from './utils/sponsored_fpc.js'
import { TOKEN_CONFIGS, TokenConfig } from './constants/tokens.js'
import {
  createDeployment,
  saveTokenToDeployment,
  loadExistingTokens,
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

const MINT_AMOUNT = BigInt(1e15)
const FEE_BASIS_POINTS = 500n // 5% fee
const CLEAN_HANDS_CIRCUIT_ID = 1n // arbitrary circuit ID for testing

// Temp attestation keys for testing
// In production these would be managed by the attestation service
const POCH_ATTESTER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const PASSPORT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const pochAttesterAccount = privateKeyToAccount(POCH_ATTESTER_PRIVATE_KEY)
const passportSignerAccount = privateKeyToAccount(PASSPORT_SIGNER_PRIVATE_KEY)

// ─── Helpers: Public key → [u8; 32] ─────────────────────────────────────────

function pubKeyToCoords(uncompressedPubKey: Hex): { x: number[]; y: number[] } {
  // Uncompressed key: 0x04 || x(32 bytes) || y(32 bytes)
  const hex = uncompressedPubKey.startsWith('0x04')
    ? uncompressedPubKey.slice(4)
    : uncompressedPubKey.slice(2)
  const xHex = hex.slice(0, 64)
  const yHex = hex.slice(64, 128)

  const toBytes = (h: string): number[] => {
    const arr: number[] = []
    for (let i = 0; i < h.length; i += 2) {
      arr.push(parseInt(h.slice(i, i + 2), 16))
    }
    return arr
  }

  return { x: toBytes(xHex), y: toBytes(yHex) }
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

// ─── Helpers: byte conversions for L2 attestation signing ────────────────────

function bigIntToBytes32(value: bigint): Uint8Array {
  const hex = value.toString(16).padStart(64, '0')
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** Strip v from a 65-byte hex signature, return r||s as number[64] */
function hexSigToU8_64(sig: Hex): number[] {
  const hex = sig.startsWith('0x') ? sig.slice(2) : sig
  const arr: number[] = []
  for (let i = 0; i < 128; i += 2) {
    arr.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return arr
}

/**
 * Sign a Clean Hands (POCH) attestation for the L2 bridge.
 * L2 verification builds: circuit_id(32 BE) || action_id(32 BE) || nonce(32 BE) || user_address(last 20 bytes of Field BE)
 * Then keccak256 → eth_personal_sign_hash → ECDSA verify against stored pubkey.
 */
async function signL2CleanHandsAttestation(params: {
  circuitId: bigint
  actionId: bigint
  nonce: bigint
  userAztecAddress: AztecAddress
}): Promise<number[]> {
  const buf = new Uint8Array(116)
  buf.set(bigIntToBytes32(params.circuitId), 0)
  buf.set(bigIntToBytes32(params.actionId), 32)
  buf.set(bigIntToBytes32(params.nonce), 64)
  const addrBytes = bigIntToBytes32(BigInt(params.userAztecAddress.toString()))
  buf.set(addrBytes.slice(12, 32), 96)

  const digest = keccak256(buf as any)
  const signature = await signMessage({
    privateKey: POCH_ATTESTER_PRIVATE_KEY,
    message: { raw: digest },
  })
  return hexSigToU8_64(signature)
}

/**
 * Sign a Passport attestation for the L2 bridge.
 * L2 verification builds: user(32 BE) || max_amount(32 BE) || nonce(32 BE) || deadline(32 BE) || bridge_address(32 BE)
 * Then keccak256 → eth_personal_sign_hash → ECDSA verify against stored pubkey.
 */
async function signL2PassportAttestation(params: {
  userAztecAddress: AztecAddress
  maxAmount: bigint
  nonce: bigint
  deadline: bigint
  bridgeAddress: AztecAddress
}): Promise<number[]> {
  const buf = new Uint8Array(160)
  buf.set(bigIntToBytes32(BigInt(params.userAztecAddress.toString())), 0)
  buf.set(bigIntToBytes32(params.maxAmount), 32)
  buf.set(bigIntToBytes32(params.nonce), 64)
  buf.set(bigIntToBytes32(params.deadline), 96)
  buf.set(bigIntToBytes32(BigInt(params.bridgeAddress.toString())), 128)

  const digest = keccak256(buf as any)
  const signature = await signMessage({
    privateKey: PASSPORT_SIGNER_PRIVATE_KEY,
    message: { raw: digest },
  })
  return hexSigToU8_64(signature)
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
  const pochCoords = pubKeyToCoords(pochAttesterAccount.publicKey)
  const passportCoords = pubKeyToCoords(passportSignerAccount.publicKey)

  // ── Step 1: Deploy L1 TestERC20 ──
  logger.info(`[L1] Deploying ${tokenConfig.symbol} ERC20`)
  const l1TokenContract = await deployTestERC20(l1Client, tokenConfig.l1Name, tokenConfig.l1Symbol, tokenConfig.decimals)
  logger.info(`[L1] ${tokenConfig.symbol} ERC20 at ${l1TokenContract}`)

  // Mint tokens
  const mintAmount = BigInt(1000000000000000000)
  await mintL1Tokens(l1Client, ownerEthAddress, l1TokenContract, mintAmount, logger, tokenConfig.symbol)

  // ── Step 2: Deploy FeeAssetHandler ──
  logger.info(`[L1] Deploying fee asset handler for ${tokenConfig.symbol}`)
  const feeAssetHandler = await deployFeeAssetHandler(l1Client, l1TokenContract)
  await addMinter(l1Client, l1TokenContract, feeAssetHandler)
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
  const l2ProxyContract = await TokenMinterProxyContract.deploy(wallet).send({
    from: ownerAztecAddress,
    contractAddressSalt: proxySalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`[L2] TokenMinterProxy at ${l2ProxyContract.address}`)

  // ── Step 5: Deploy L2 Token (Wonderland token with minter) ──
  logger.info(`[L2] Deploying ${tokenConfig.symbol} Token (Wonderland, constructor_with_minter)`)
  const l2TokenContract = await TokenContract.deployWithOpts(
    { wallet, method: 'constructor_with_minter' },
    tokenConfig.l2Name,
    tokenConfig.l2Symbol,
    tokenConfig.decimals,
    l2ProxyContract.address,    // minter = proxy
    ownerAztecAddress,          // upgrade_authority = owner
  ).send({
    from: ownerAztecAddress,
    contractAddressSalt: tokenSalt,
    fee: { paymentMethod: sponsoredPaymentMethod },
    wait: { timeout: getTimeouts().deployTimeout },
  })
  logger.info(`[L2] ${tokenConfig.symbol} Token at ${l2TokenContract.address}`)

  // ── Step 6: Deploy L2 Custom TokenBridge (7 args) ──
  logger.info(`[L2] Deploying Custom TokenBridge for ${tokenConfig.symbol}`)
  const l2BridgeContract = await TokenBridgeContract.deploy(
    wallet,
    l2ProxyContract.address,     // token_minter_proxy
    l1PortalContractAddress,     // portal
    pochCoords.x,                // human_id_attester_x
    pochCoords.y,                // human_id_attester_y
    CLEAN_HANDS_CIRCUIT_ID,      // circuit_id
    passportCoords.x,            // passport_signer_x
    passportCoords.y,            // passport_signer_y
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
  const balance = await l2TokenContract.methods
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

  const newL2Balance = await l2TokenContract.methods
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
    const actionId = 100n
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
  const privateBalance = await l2TokenContract.methods
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
  const innerHash = await computeInnerAuthWitHashFromAction(proxyAddress, burnAction)
  await wallet.createAuthWit(ownerAztecAddress, {
    consumer: AztecAddress.fromString(deployed.l2TokenContract),
    innerHash,
  })
  logger.info(`[L2] Private AuthWit created and stored in PXE`)

  // Build L2 attestation data
  let cleanHandsData: { nonce: bigint, action_id: bigint, signature: number[] }
  let passportData: { max_amount: bigint, nonce: bigint, deadline: bigint, signature: number[] }

  const l2BridgeAddress = AztecAddress.fromString(deployed.l2BridgeContract)

  if (attestationType === 'poch') {
    const pochNonce = BigInt(Date.now())
    const actionId = 200n
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
    },
    logger,
  )

  const newPrivateBalance = await l2TokenContract.methods
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
      actionId: 300n,
      userAddress: ownerEthAddress,
    })
    logger.info(`[L1] depositToAztecPrivate (amount=${depositAmount})`)
    const depositTx = await l1Portal.write.depositToAztecPrivate([
      depositAmount,
      secretHash.toString() as Hex,
      { nonce: pochNonce, actionId: 300n, signature: pochSig },
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
  const wrongAddress = AztecAddress.fromString('0x' + 'ab'.repeat(32))
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
    actionId: 400n,
    userAddress: ownerEthAddress,
  })

  logger.info(`[L1] depositToAztecPrivate`)
  const depositTx = await l1Portal.write.depositToAztecPrivate([
    depositAmount,
    secretHash.toString() as Hex,
    { nonce: pochNonce, actionId: 400n, signature: pochSig },
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

  const rollup = new RollupContract(l1Client, rollupAddress as any)
  const epoch = await rollup.getEpochNumberForCheckpoint(
    CheckpointNumber.fromBlockNumber(blockNumber)
  )
  logger.info(`[L1] Block ${blockNumber} -> Epoch ${epoch}`)

  const witness = await computeL2ToL1MembershipWitness(node, epoch, msgLeaf)
  if (!witness) throw new Error(`L2->L1 message not found in epoch ${epoch}`)

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
    BigInt(epoch),
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
  logger.info(`Environment: ${isDevnet() ? 'devnet' : 'local sandbox'}`)

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
  const tokenConfig = TOKEN_CONFIGS[0]
  const skipDeploy = process.env.SKIP_DEPLOY === 'true'

  // Check for existing deployment
  const existingTokens = loadExistingTokens()
  const existingToken = existingTokens.find(t => t.symbol === tokenConfig.symbol) as DeployedCompliantToken | undefined

  let deployed: DeployedCompliantToken

  if (skipDeploy && existingToken?.l2ProxyContract) {
    logger.info(`\nSkipping deployment — reusing existing ${tokenConfig.symbol} contracts`)
    logger.info(`  L1 Portal:  ${existingToken.l1PortalContract}`)
    logger.info(`  L2 Bridge:  ${existingToken.l2BridgeContract}`)
    logger.info(`  L2 Proxy:   ${existingToken.l2ProxyContract}`)
    logger.info(`  L2 Token:   ${existingToken.l2TokenContract}`)
    deployed = existingToken
  } else {
    if (skipDeploy) {
      logger.info(`SKIP_DEPLOY set but no existing compliant deployment found, deploying...`)
    }

    // Create deployment record
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
      aztecVersion: configManager.getConfig().settings.version,
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

    logger.info(`\nDeploying compliant setup for ${tokenConfig.symbol}...`)

    deployed = await deployCompliantTokenSetup(
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
    saveTokenToDeployment(deployed)
    logger.info(`\nAll contracts deployed for ${tokenConfig.symbol}!`)
  }

  // Register contract artifacts with PXE so it can execute private functions.
  // When deploying fresh, deployment auto-registers. With SKIP_DEPLOY we must do it manually.
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

  // Sync to frontend
  copyToFrontend()

  logger.info('\n=== ALL 11 COMPLIANT BRIDGE TESTS COMPLETE ===')
  logger.info(`Token:           ${tokenConfig.symbol}`)
  logger.info(`L1 Portal:       ${deployed.l1PortalContract}`)
  logger.info(`L2 Bridge:       ${deployed.l2BridgeContract}`)
  logger.info(`L2 Proxy:        ${deployed.l2ProxyContract}`)
  logger.info(`L2 Token:        ${deployed.l2TokenContract}`)
  logger.info(`POCH Attester:   ${deployed.humanIdAttester}`)
  logger.info(`Passport Signer: ${deployed.passportSigner}`)
  logger.info(`Tests passed:`)
  logger.info(`  1. L1 Public  → L2 Public  (deposit + claim)`)
  logger.info(`  2. L1 Private → L2 Private (POCH deposit + claim)`)
  logger.info(`  3. L1 Private → L2 Private (Passport deposit + claim)`)
  logger.info(`  4. L2 Public  → L1         (exit_to_l1_public + withdraw)`)
  logger.info(`  5. L2 Private → L1         (exit_to_l1_private POCH + withdraw)`)
  logger.info(`  6. L2 Private → L1         (exit_to_l1_private Passport + withdraw)`)
  logger.info(`  7. NEGATIVE: L1 Public  → L2 Private claim (content hash mismatch)`)
  logger.info(`  8. NEGATIVE: L1 Private → L2 Public claim  (content hash mismatch)`)
  logger.info(`  9. NEGATIVE: Wrong Aztec address can't claim_public`)
  logger.info(` 10. NEGATIVE: Wrong secret can't claim_private`)
  logger.info(` 11. NEGATIVE: Non-holder can't exit (insufficient balance/no authwit)`)
}

main()
