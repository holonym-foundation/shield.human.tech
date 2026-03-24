/**
 * L1→L2 bridge operations: shared polling/claim + deposit step functions.
 *
 * Shared (used by both main hook and resume hook):
 *   - pollL1ToL2MessageSync
 *   - executeL2Claim
 *
 * Deposit steps (used only by useL1BridgeToL2):
 *   - validateAndCaptureBlocks  (step 1)
 *   - generateAndBackupClaimSecret  (step 2)
 *   - checkAndApproveAllowance  (step 3)
 *   - sendL1DepositTransaction  (step 4)
 *   - waitForReceiptAndExtractEvent  (step 5)
 *   - persistReceiptToBackend  (step 6)
 *   - finalizeLocalStorageAfterDeposit  (step 7)
 */

import { Fr } from '@aztec/aztec.js/fields'
import { computeSecretHash } from '@aztec/stdlib/hash'
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TestERC20Abi, TokenPortalAbi } from '@aztec/l1-artifacts'
// @ts-ignore — JSON import from forge build output (custom compliant portal w/ attestation structs)
import CustomTokenPortalJson from '../../../../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
const CustomTokenPortalAbi = CustomTokenPortalJson.abi
import { encodeFunctionData, decodeEventLog, parseEventLogs, keccak256, encodeAbiParameters } from 'viem'
import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { aztecNode } from '@/aztec'
import { api } from '@/lib/api'
import axios from 'axios'
import {
  L1_CHAIN_ID,
  L2_CHAIN_ID,
  ROLLUP_VERSION,
  PERMIT2_ADDRESS,
  SWAP_BRIDGE_ROUTER_ADDRESS,
} from '@/config'
import { SwapBridgeRouterAbi } from '@/constants/abis/SwapBridgeRouterAbi'
import { type FuelQuote } from '@/utils/fuelQuote'
import type { Token } from '@/types/bridge'
import { serializeNodeInfo, wait } from '@/utils'
import { logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import {
  getKeyDerivationDomain,
  createSigningMessage,
  deriveEncryptionKey,
  encryptData,
} from '@/utils/encryption'
import {
  requestWaapWallet,
  WAAP_METHOD,
} from '@/stores/walletStore'
import {
  type BridgeLogContext,
  LS_KEY_BRIDGE_DEPOSITS,
  patchOperationWithRetry,
  publicClient,
  updateLocalStorageItem,
  pushToLocalStorageArray,
  getL1TxUrl,
} from './bridgeUtils'
import { extractEvent } from '@aztec/ethereum/utils'

// ─── Shared Types ────────────────────────────────────────────────────

/** Dependencies injected from the calling hook (React-dependent values). */
export interface L2ClaimDeps {
  walletAdapter: any
  aztecAddress: string
  isPrivacyModeEnabled: boolean
}

export interface MessageSyncResult {
  synced: boolean
  elapsedMinutes: number
}

export interface L2ClaimResult {
  l2TxHash: string
  usedBruteForce: boolean
  bruteForceLeafIndex?: number
}

/** Optional fuel parameters threaded through deposit steps. */
export interface FuelParams {
  fuelAmount: bigint
  fuelQuote: FuelQuote
}

/** Attestation data fetched from /api/attestation/poch for private deposits. */
export interface PochAttestationData {
  l1Signature: string
  l2Signature: number[]
  nonce: number
  circuitId: string
  actionId: string
}

/** Attestation data fetched from /api/attestation/passport for private deposits. */
export interface PassportAttestationData {
  l1Signature: string
  l2Signature: number[] | null
  nonce: number
  maxAmount: string
  deadline: string
  score: number
  threshold: number
}

// ─── Attestation Fetch ──────────────────────────────────────────────

/**
 * Fetch a POCH (clean hands) attestation from the backend API.
 * Called before private deposits to get the L1 ECDSA signature
 * required by the custom TokenPortal's depositToAztecPrivate.
 */
export async function fetchPochAttestation(
  portalAddress: string,
): Promise<PochAttestationData> {
  const res = await api.post('/api/attestation/poch', { portalAddress })
  return res.data as PochAttestationData
}

/**
 * Fetch a Passport attestation from the backend API.
 * Called as fallback when POCH is unavailable for private deposits.
 */
export async function fetchPassportAttestation(
  portalAddress: string,
): Promise<PassportAttestationData> {
  const res = await api.post('/api/attestation/passport', { portalAddress })
  return res.data as PassportAttestationData
}

/** Parameters for private fuel (BridgedFPC) flow. */
export interface PrivateFuelParams {
  fuelAmount: bigint
  fpcAddress: string
}

/** Permit2 SignatureTransfer params returned from signing step. */
export interface Permit2Params {
  nonce: bigint
  deadline: bigint
  signature: `0x${string}`
}

interface Permit2WitnessParams {
  l1Address: string
  tokenPortal: `0x${string}`
  bridgeToken: `0x${string}`
  totalAmount: bigint
  fuelAmount: bigint
  aztecRecipient: `0x${string}`
  fuelRecipient: `0x${string}`
  tokenSecretHash: `0x${string}`
  fuelSecretHash: `0x${string}`
  minFuelOutput: bigint
  poolKeys: readonly {
    currency0: `0x${string}`
    currency1: `0x${string}`
    fee: number
    tickSpacing: number
    hooks: `0x${string}`
  }[]
  zeroForOnes: readonly boolean[]
  isPrivate: boolean
}

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

// ─── Deposit Step Result Types ───────────────────────────────────────

export interface CaptureBlocksResult {
  nodeInfo: any
  l1Addresses: any
  l1BlockNumberBeforeTx: string
  l2BlockNumberBeforeTx: string
}

export interface BackupResult {
  operationId: string
  claimSecret: Fr
  claimSecretHash: Fr
  nodeInfoSnapshot: any
  fuelSecret?: Fr
  fuelSecretHash?: Fr
  /** For private fuel (BridgedFPC): the random salt used in secret derivation */
  privateFuelSalt?: Fr
  /** For private fuel (BridgedFPC): the derived secret */
  privateFuelSecret?: Fr
  /** For private fuel (BridgedFPC): hash of the derived secret */
  privateFuelSecretHash?: Fr
}

export interface DepositTxResult {
  txHash: any
  l1TxHash: string
  l1TxUrl: string
}

export interface ReceiptResult {
  l1TxHash: string
  l1TxUrl: string
  messageHashStr: string
  messageLeafIndexStr: string
  messageHash: any
  messageLeafIndex: any
  /** Post-fee amount to use for the L2 claim (extracted from TokenPortal DepositToAztecPublic event). */
  claimAmount: bigint
  // Fuel-specific fields (present when fuel path used)
  fuelMessageHashStr?: string
  fuelMessageLeafIndexStr?: string
  fuelMessageHash?: any
  fuelMessageLeafIndex?: any
  fuelAmount?: bigint
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: Post-fee Claim Amount
// ═════════════════════════════════════════════════════════════════════

/**
 * Query the TokenPortal's feeBasisPoints and compute the post-fee claim amount.
 * TokenPortal deducts fees before computing the L1→L2 content hash, so the L2
 * claim must use amountAfterFee to match the content hash.
 *
 * @param portalAddress The L1 TokenPortal contract address.
 * @param amount The pre-fee amount (as passed to TokenPortal.depositToAztecPublic).
 * @returns The post-fee amount that the L2 bridge contract expects.
 */
const calculateFeeAbi = [{
  name: 'calculateFee',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: '_amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const

// Our custom TokenPortal event ABIs — the upstream @aztec/l1-artifacts ABI doesn't
// include the `fee` field, so it has a different topic hash and can't decode our events.
export const CustomTokenPortalEventAbi = [
  {
    type: 'event',
    name: 'DepositToAztecPublic',
    inputs: [
      { name: 'to', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'secretHash', type: 'bytes32', indexed: false },
      { name: 'key', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'DepositToAztecPrivate',
    inputs: [
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
      { name: 'secretHash', type: 'bytes32', indexed: false },
      { name: 'key', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
    ],
  },
] as const

export async function getPostFeeClaimAmount(
  portalAddress: string,
  amount: bigint,
): Promise<bigint> {
  try {
    const fee = await publicClient.readContract({
      address: portalAddress as `0x${string}`,
      abi: calculateFeeAbi,
      functionName: 'calculateFee',
      args: [amount],
    })
    const claimAmount = amount - fee
    console.log('[L1→L2] Post-fee claim amount:', { amount: amount.toString(), fee: fee.toString(), claimAmount: claimAmount.toString() })
    return claimAmount
  } catch (err) {
    console.error('[L1→L2] Failed to query calculateFee — cannot determine post-fee amount:', err)
    throw new Error(
      'Failed to query portal fee. Cannot safely determine the claim amount. ' +
      'Please check your RPC connection and try again.'
    )
  }
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: Message Sync Polling
// ═════════════════════════════════════════════════════════════════════

/**
 * Poll aztecNode.getL1ToL2MessageBlock() until the message is synced on L2.
 *
 * Does NOT include the final 2-minute buffer wait — the caller should add
 * that if needed (so the caller can update UI progress between poll and wait).
 */
export async function pollL1ToL2MessageSync(
  messageHash: string,
  options?: { pollIntervalMs?: number; maxWaitMs?: number },
): Promise<MessageSyncResult> {
  const pollIntervalMs = options?.pollIntervalMs ?? 30_000
  const maxWaitMs = options?.maxWaitMs ?? 40 * 60 * 1000
  const messageHashFr = Fr.fromString(messageHash)
  const startWait = Date.now()
  let pollCount = 0

  console.log('[L1→L2] Polling for L1-to-L2 message sync...')
  console.log('[L1→L2]   messageHash:', messageHash)
  console.log('[L1→L2]   messageHashFr:', messageHashFr.toString())
  console.log('[L1→L2]   pollInterval:', pollIntervalMs / 1000, 's, maxWait:', maxWaitMs / 60_000, 'min')

  while (Date.now() - startWait < maxWaitMs) {
    pollCount++
    const elapsedSec = Math.round((Date.now() - startWait) / 1000)
    try {
      const messageBlock = await aztecNode.getL1ToL2MessageBlock(messageHashFr)
      if (messageBlock !== undefined) {
        console.log(`[L1→L2] Message ready after ${pollCount} polls (${elapsedSec}s), block=${messageBlock}`)
        return {
          synced: true,
          elapsedMinutes: (Date.now() - startWait) / 60_000,
        }
      }
      console.log(`[L1→L2] Poll #${pollCount} (${elapsedSec}s): not yet synced, response:`, messageBlock)
    } catch (error) {
      console.warn(`[L1→L2] Poll #${pollCount} (${elapsedSec}s) failed:`, error)
    }
    await wait(pollIntervalMs)
  }

  console.error(`[L1→L2] Message sync timed out after ${pollCount} polls (${maxWaitMs / 60_000} min)`)
  return {
    synced: false,
    elapsedMinutes: (Date.now() - startWait) / 60_000,
  }
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: L2 Claim Execution
// ═════════════════════════════════════════════════════════════════════

/**
 * Execute claim_public or claim_private on L2.
 *
 * - If messageLeafIndex is provided: retry up to maxAttempts times on
 *   "nonexistent L1-to-L2 message" (wallet node lag).
 * - If messageLeafIndex is null: brute-force indices 0..bruteForceMaxIndex.
 */
export async function executeL2Claim(
  deps: L2ClaimDeps,
  params: {
    amount: bigint
    claimSecret: Fr
    messageLeafIndex: bigint | null
  },
  options?: {
    maxAttempts?: number
    retryDelayMs?: number
    bruteForceMaxIndex?: number
    /** Max time (ms) to wait for the wallet to respond before timing out. Default: 5 min. */
    walletTimeoutMs?: number
    /** Called before each claim attempt. */
    onAttempt?: (attempt: number, maxAttempts: number) => void
    /** Called when a retryable "nonexistent message" error occurs before waiting. */
    onRetry?: (attempt: number, maxAttempts: number, retryDelayMs: number) => void
    /** Fee payment option (e.g. FeeJuicePaymentMethodWithClaim for self-paying gas) */
    feeOption?: { fee: { paymentMethod: any } }
  },
): Promise<L2ClaimResult> {
  const { walletAdapter, aztecAddress, isPrivacyModeEnabled } = deps
  const { amount, claimSecret, messageLeafIndex } = params
  const maxAttempts = options?.maxAttempts ?? 5
  const retryDelayMs = options?.retryDelayMs ?? 120_000
  const bruteForceMaxIndex = options?.bruteForceMaxIndex ?? 64
  const walletTimeoutMs = options?.walletTimeoutMs ?? 5 * 60_000 // 5 min default

  const method = isPrivacyModeEnabled ? 'claim_private' : 'claim_public'

  /** Race the wallet call against a timeout so we never hang forever. */
  const callWithTimeout = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(
            'Wallet did not respond in time. Check for a hidden wallet popup behind your browser window.',
          )),
          walletTimeoutMs,
        ),
      ),
    ])

  if (messageLeafIndex != null) {
    // ── Normal path: known leaf index ──
    //
    // NOTE: We send the claim directly via wallet.sendTx() (through executeCall)
    // without pre-simulating via wallet.simulateTx(). This is critical because:
    //   - simulateTx() runs public function simulation locally in the wallet's PXE
    //   - The wallet's PXE checks the L1→L2 message tree, which may lag behind
    //   - sendTx() → proveTx() does NOT simulate public functions; it packages
    //     the public call and submits to the sequencer, which has the latest state
    //   - The sequencer executes consume_l1_to_l2_message against its own up-to-date tree

    const claimArgs = [
      AztecAddress.fromString(aztecAddress),
      amount,
      claimSecret,
      messageLeafIndex,
    ]

    // Send the claim transaction directly (triggers wallet popup).
    // Retry on "nonexistent message" errors (sequencer might need more time).
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        options?.onAttempt?.(attempt, maxAttempts)
        console.log(`[L1→L2] Sending claim transaction via wallet (attempt ${attempt}/${maxAttempts})...`)

        const result = await callWithTimeout(
          walletAdapter.executeCall(
            walletAdapter.bridgeAddress,
            method,
            claimArgs,
            { contractType: 'bridge', ...options?.feeOption },
          ),
        ) as { txHash: string }

        console.log('[L1→L2] Claim succeeded')
        return { l2TxHash: result.txHash, usedBruteForce: false }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errLower = errMsg.toLowerCase()

        // Don't retry on user rejection or already-consumed messages — surface immediately
        if (errLower.includes('user rejected') || errLower.includes('user denied') || errLower.includes('user cancelled')) {
          throw new Error('Transaction rejected by user.')
        }
        if (errLower.includes('message already consumed') || errLower.includes('already been consumed')) {
          throw new Error('This deposit has already been claimed.')
        }

        // Retry on transient errors (reorgs, block header not found, message not synced, PXE lag, etc.)
        if (attempt < maxAttempts) {
          options?.onRetry?.(attempt, maxAttempts, retryDelayMs)
          console.warn(
            `[L1→L2] Claim attempt ${attempt} failed, retrying in ${retryDelayMs / 1000}s...`,
            errMsg,
          )
          await wait(retryDelayMs)
          continue
        }
        throw err
      }
    }
    throw new Error('L2 claim failed after maximum retries')
  } else {
    // ── Brute-force path: try indices 0..bruteForceMaxIndex ──
    console.log('[L1→L2] Brute-forcing messageLeafIndex (trying 0..', bruteForceMaxIndex - 1, ')...')
    for (let idx = 0; idx < bruteForceMaxIndex; idx++) {
      try {
        console.log('[L1→L2] Trying leafIndex=', idx)
        const res = await callWithTimeout(
          walletAdapter.executeCall(
            walletAdapter.bridgeAddress,
            method,
            [
              AztecAddress.fromString(aztecAddress),
              amount,
              claimSecret,
              BigInt(idx),
            ],
            { contractType: 'bridge' },
          ),
        ) as { txHash: string }
        console.log('[L1→L2] Claim succeeded with leafIndex=', idx)
        return {
          l2TxHash: res.txHash,
          usedBruteForce: true,
          bruteForceLeafIndex: idx,
        }
      } catch {
        console.log('[L1→L2] leafIndex=', idx, 'failed, trying next...')
      }
    }
    throw new Error(
      `Could not find correct messageLeafIndex after trying 0–${bruteForceMaxIndex - 1}. ` +
        'The L1→L2 message may not be synced to L2 yet. Try again later.',
    )
  }
}

// ═════════════════════════════════════════════════════════════════════
// DEPOSIT STEPS (useL1BridgeToL2 only)
// ═════════════════════════════════════════════════════════════════════

// ─── Step 1: Validate wallets and capture block numbers ──────────────

export async function validateAndCaptureBlocks(
  l1Address: string,
  aztecAddress: string,
  walletAdapter: any,
  logContext?: BridgeLogContext & { amount: string },
  selectedToken?: Token,
): Promise<CaptureBlocksResult> {
  if (!l1Address || !aztecAddress) {
    console.log({ l1Address, aztecAddress })
    throw new Error('Required accounts not connected')
  }

  const nodeInfo = await aztecNode.getNodeInfo()
  const l1Addresses = nodeInfo?.l1ContractAddresses ?? null
  console.log('[L1→L2] Node info fetched, outboxAddress:', l1Addresses.outboxAddress.toString())
  if (!l1Addresses?.outboxAddress.toString()) {
    throw new Error(
      'L1 contract addresses not initialized. Please wait for contract initialization to complete.',
    )
  }

  if (!walletAdapter) {
    throw new Error(
      'Aztec wallet not connected or contracts not initialized. Please wait for wallet initialization to complete.',
    )
  }

  let l1BlockNumberBeforeTx: string
  try {
    const block = await publicClient.getBlockNumber()
    l1BlockNumberBeforeTx = block.toString()
    console.log('[L1→L2] Current L1 block before tx:', l1BlockNumberBeforeTx)
  } catch (e) {
    console.warn('[L1→L2] Could not get current L1 block number before tx:', e)
    throw new Error(
      'Could not get L1 block number. Please check your connection and try again. Required for recovery.',
    )
  }

  let l2BlockNumberBeforeTx: string
  try {
    const l2Block = await aztecNode.getBlockNumber()
    l2BlockNumberBeforeTx = l2Block.toString()
    console.log('[L1→L2] Current L2 block before tx:', l2BlockNumberBeforeTx)
  } catch (e) {
    console.warn('[L1→L2] Could not get current L2 block number before tx:', e)
    throw new Error(
      'Could not get L2 block number. Please check your connection and try again. Required for recovery.',
    )
  }

  // Log "initiated" if context provided
  if (logContext) {
    logInfo('Bridge from L1 to L2 initiated', {
      ...logContext,
      direction: BridgeDirection.L1_TO_L2,
      fromNetwork: 'Ethereum',
      toNetwork: 'Aztec',
      fromToken: selectedToken?.symbol ?? 'USDC',
      toToken: selectedToken?.pairedSymbol ?? 'cUSDC',
      l1Address,
      l2Address: aztecAddress,
      l1BlockNumberBeforeTx,
      userAction: 'bridge_l1_to_l2_initiated',
    })
  }

  return { nodeInfo, l1Addresses, l1BlockNumberBeforeTx, l2BlockNumberBeforeTx }
}

// ─── Step 2: Generate claim secret, encrypt, backup to server ────────

export async function generateAndBackupClaimSecret(params: {
  l1Address: string
  aztecAddress: string
  amountL1: string
  amountL2: string
  amountDisplayL1: string
  amountDisplayL2: string
  isPrivacyModeEnabled: boolean
  l1BlockNumberBeforeTx: string
  l2BlockNumberBeforeTx: string
  nodeInfo: any
  signWaapMessage: (msg: string) => Promise<string | null>
  selectedToken?: Token
  fuel?: FuelParams
  privateFuel?: PrivateFuelParams
}): Promise<BackupResult> {
  const {
    l1Address, aztecAddress, amountL1, amountL2, amountDisplayL1, amountDisplayL2,
    isPrivacyModeEnabled, l1BlockNumberBeforeTx, l2BlockNumberBeforeTx, nodeInfo, signWaapMessage,
    selectedToken,
  } = params

  const claimSecret = Fr.random()
  const claimSecretHash = await computeSecretHash(claimSecret)
  const nodeInfoSnapshot = serializeNodeInfo(nodeInfo)
  console.log('[L1→L2] Claim secret generated, backing up to backend')

  // ── Generate fuel secrets BEFORE backup so they are included in the encrypted payload ──
  // Public fuel: random secret + hash → used with FeeJuicePaymentMethodWithClaim on L2.
  // Private fuel: derived secret (poseidon2([salt, userAddress], DOM_SEP)) + hash → FJ
  //   deposited to FPC on L1, then BridgedMintAndPayFeePaymentMethod on L2.
  let fuelSecret: Fr | undefined
  let fuelSecretHash: Fr | undefined
  if (params.fuel && !params.privateFuel) {
    fuelSecret = Fr.random()
    fuelSecretHash = await computeSecretHash(fuelSecret)
    console.log('[L1→L2] Public fuel secret generated')
  }

  let privateFuelSalt: Fr | undefined
  let privateFuelSecret: Fr | undefined
  let privateFuelSecretHash: Fr | undefined
  if (params.privateFuel) {
    privateFuelSalt = Fr.random()
    const DOM_SEP_FPC_BRIDGE_SECRET = 3952304070
    const claimerFr = Fr.fromString(params.aztecAddress)
    privateFuelSecret = await poseidon2HashWithSeparator(
      [privateFuelSalt, claimerFr],
      DOM_SEP_FPC_BRIDGE_SECRET,
    )
    privateFuelSecretHash = await computeSecretHash(privateFuelSecret)
    console.log('[L1→L2] Private fuel (BridgedFPC) secret generated')
  }

  // Deterministic encryption: same wallet + same message = same key (always recoverable)
  const keyDerivationDomain = getKeyDerivationDomain()
  const signingMessage = createSigningMessage(l1Address)
  const signature = await signWaapMessage(signingMessage)
  if (!signature) {
    throw new Error('Failed to sign message for encryption key derivation')
  }
  const encryptionKey = await deriveEncryptionKey(l1Address, signature, keyDerivationDomain)

  const payloadToEncrypt: Record<string, unknown> = {
    claimSecret: claimSecret.toString(),
    claimSecretHash: claimSecretHash.toString(),
    amount: amountL1,
    l1Address,
    l2Address: aztecAddress,
    isPrivacyModeEnabled,
    l1BlockNumberBeforeTx,
    nodeInfo: nodeInfoSnapshot,
  }
  // Include fuel secrets in the encrypted backup so they survive session crashes
  if (fuelSecret) payloadToEncrypt.fuelSecret = fuelSecret.toString()
  if (fuelSecretHash) payloadToEncrypt.fuelSecretHash = fuelSecretHash.toString()
  if (privateFuelSalt) payloadToEncrypt.privateFuelSalt = privateFuelSalt.toString()
  if (privateFuelSecret) payloadToEncrypt.privateFuelSecret = privateFuelSecret.toString()
  if (privateFuelSecretHash) payloadToEncrypt.privateFuelSecretHash = privateFuelSecretHash.toString()
  console.log('[L1→L2] Payload to encrypt:', {
    amount: payloadToEncrypt.amount,
    l1Address: payloadToEncrypt.l1Address,
    l2Address: payloadToEncrypt.l2Address,
    isPrivacyModeEnabled: payloadToEncrypt.isPrivacyModeEnabled,
    l1BlockNumberBeforeTx: payloadToEncrypt.l1BlockNumberBeforeTx,
  })
  const encrypted = await encryptData(JSON.stringify(payloadToEncrypt), encryptionKey)
  console.log('[L1→L2] Encryption done, ciphertext length:', encrypted.ciphertext.length)

  // Recovery-critical fields from nodeInfo
  const snapshotRollupVersion = nodeInfoSnapshot?.rollupVersion as number | undefined
  const snapshotL1ChainId = nodeInfoSnapshot?.l1ChainId as number | undefined
  const snapshotL1Addresses = nodeInfoSnapshot?.l1ContractAddresses as Record<string, string> | undefined

  const reqBody = {
    encryptedCiphertext: encrypted.ciphertext,
    encryptedIv: encrypted.iv,
    encryptedTag: encrypted.tag,
    keyDerivationMessage: signingMessage,
    keyDerivationDomain,
    direction: 'L1_TO_L2',
    l1Address,
    l2Address: aztecAddress,
    amountL1,
    amountL2,
    amountDisplayL1,
    amountDisplayL2,
    isPrivacyModeEnabled,
    l1BlockNumberBeforeTx,
    l2BlockNumberBeforeTx: l2BlockNumberBeforeTx ?? undefined,
    nodeInfo: nodeInfoSnapshot,
    rollupVersion: snapshotRollupVersion,
    chainIdL1: snapshotL1ChainId ?? L1_CHAIN_ID,
    chainIdL2: L2_CHAIN_ID,
    portalAddressL1: selectedToken?.l1PortalContract ?? '',
    bridgeAddressL2: selectedToken?.l2BridgeContract ?? '',
    l1RollupAddress: snapshotL1Addresses?.rollupAddress,
    l1OutboxAddress: snapshotL1Addresses?.outboxAddress,
    l1InboxAddress: snapshotL1Addresses?.inboxAddress,
    l1RegistryAddress: snapshotL1Addresses?.registryAddress,
    tokenSymbol: selectedToken?.symbol ?? 'USDC',
    tokenSymbolL1: selectedToken?.symbol ?? 'USDC',
    tokenSymbolL2: selectedToken?.pairedSymbol ?? 'cUSDC',
    tokenNameL1: selectedToken?.title ?? selectedToken?.symbol ?? 'USDC',
    tokenNameL2: `Clean ${selectedToken?.symbol ?? 'USDC'}`,
    tokenAddressL1: selectedToken?.l1TokenContract ?? '',
    tokenAddressL2: selectedToken?.l2TokenContract ?? '',
    // Secret hashes (plaintext for querying; actual secrets in encrypted blob)
    claimSecretHash: claimSecretHash.toString(),
    fuelSecretHash: fuelSecretHash?.toString(),
    privateFuelSecretHash: privateFuelSecretHash?.toString(),
    tokenDecimalsL1: selectedToken?.decimals ?? 6,
    tokenDecimalsL2: selectedToken?.decimals ?? 6,
    currentStep: 1,
  }
  console.log('[L1→L2] POST /api/bridge/operations →', {
    direction: reqBody.direction,
    amountL1: reqBody.amountL1,
    l1BlockNumberBeforeTx: reqBody.l1BlockNumberBeforeTx,
    l2BlockNumberBeforeTx: reqBody.l2BlockNumberBeforeTx,
    rollupVersion: reqBody.rollupVersion,
    chainIdL1: reqBody.chainIdL1,
    portalAddressL1: reqBody.portalAddressL1,
    bridgeAddressL2: reqBody.bridgeAddressL2,
    isPrivacyModeEnabled: reqBody.isPrivacyModeEnabled,
    currentStep: reqBody.currentStep,
    hasEncrypted: !!reqBody.encryptedCiphertext,
    hasNodeInfo: !!reqBody.nodeInfo,
  })

  let operationId: string
  try {
    const res = await api.post('/api/bridge/operations', reqBody)
    operationId = res.data.operationId
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status : null
    const errBody = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data)
      : String(err)
    console.error('[L1→L2] Encrypted backup failed:', status, errBody)
    throw new Error(
      'Failed to backup claim secret to server. Bridge aborted to prevent fund loss.',
    )
  }
  console.log('Encrypted claim secret backed up (operationId:', operationId, ')')

  pushToLocalStorageArray(LS_KEY_BRIDGE_DEPOSITS, {
    id: operationId,
    claimAmount: amountL1,
    // Secrets stored encrypted only — never plaintext in localStorage
    encryptedCiphertext: encrypted.ciphertext,
    encryptedIv: encrypted.iv,
    encryptedTag: encrypted.tag,
    keyDerivationDomain,
    claimSecretHash: claimSecretHash.toString(),
    messageHash: null,
    messageLeafIndex: null,
    timestamp: Date.now(),
    l1Address,
    l2Address: aztecAddress,
    success: false,
    l1TxHash: null,
    l1TxUrl: null,
    l1BlockNumberBeforeTx,
    nodeInfo: nodeInfoSnapshot,
    isPrivacyModeEnabled,
    status: BridgeOperationStatus.pending,
    ...(params.fuel ? {
      fuelAmount: params.fuel.fuelAmount.toString(),
    } : {}),
  })
  console.log('Encrypted claim data stored in localStorage')

  return {
    operationId, claimSecret, claimSecretHash, nodeInfoSnapshot,
    fuelSecret, fuelSecretHash,
    privateFuelSalt, privateFuelSecret, privateFuelSecretHash,
  }
}

// ─── Step 3: Check and approve allowance + sign Permit2 ──────────────

/**
 * Approve Permit2 (one-time) and sign a Permit2 SignatureTransfer.
 *
 * When SWAP_BRIDGE_ROUTER_ADDRESS is set, ALL deposits go through SwapBridgeRouter
 * with Permit2. The flow:
 *   1. Check ERC20 allowance for Permit2 canonical contract
 *   2. If insufficient, send approve(Permit2, type(uint256).max) — one-time per token
 * The witness-bound Permit2 signature is created immediately before the deposit
 * transaction once all bridge intent fields are known.
 */
export async function checkAndApproveAllowance(
  l1Address: string,
  amount: bigint,
  selectedToken?: Token,
): Promise<void> {
  if (!SWAP_BRIDGE_ROUTER_ADDRESS) {
    throw new Error('SwapBridgeRouter is not configured for this deployment')
  }

  const l1TokenAddress = selectedToken?.l1TokenContract ?? ''
  const spender = PERMIT2_ADDRESS

  const allowanceData = encodeFunctionData({
    abi: TestERC20Abi,
    functionName: 'allowance',
    args: [l1Address as `0x${string}`, spender as `0x${string}`],
  })

  const allowance = await requestWaapWallet(WAAP_METHOD.eth_call, [
    { to: l1TokenAddress, data: allowanceData },
  ])

  console.log('[L1→L2] Permit2 allowance:', allowance, 'needed:', amount.toString(), 'spender:', spender)
  if (BigInt(allowance as string) < amount) {
    const approveData = encodeFunctionData({
      abi: TestERC20Abi,
      functionName: 'approve',
      args: [spender as `0x${string}`, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
    })

    const approveTxHash = await requestWaapWallet(
      WAAP_METHOD.eth_sendTransaction,
      [{ from: l1Address as `0x${string}`, to: l1TokenAddress, data: approveData }],
    )

    console.log('[L1→L2] Permit2 approve tx sent:', approveTxHash, '— waiting for confirmation...')
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
    console.log('[L1→L2] Permit2 approve tx confirmed')
  } else {
    console.log('[L1→L2] Permit2 allowance sufficient, skipping approve')
  }
}

/**
 * Sign a Permit2 witness-bound SignatureTransfer via eth_signTypedData_v4.
 */
async function signPermit2Transfer(
  params: Permit2WitnessParams,
): Promise<Permit2Params> {
  const {
    l1Address,
    tokenPortal,
    bridgeToken,
    totalAmount,
    fuelAmount,
    aztecRecipient,
    fuelRecipient,
    tokenSecretHash,
    fuelSecretHash,
    minFuelOutput,
    poolKeys,
    zeroForOnes,
    isPrivate,
  } = params

  if (!SWAP_BRIDGE_ROUTER_ADDRESS) {
    throw new Error('SwapBridgeRouter is not configured for Permit2 witness signing')
  }

  // Random unordered nonce — any unused uint256 works with Permit2
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = BigInt('0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join(''))

  // 30-minute deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)

  const domain = {
    name: 'Permit2',
    chainId: L1_CHAIN_ID,
    verifyingContract: PERMIT2_ADDRESS,
  }

  // When there's no swap route (simple bridge, no fuel), the contract uses bytes32(0)
  // as the routeHash. Only compute the keccak256 when there are actual pool keys.
  const zeroBytes32Route = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`
  const routeHash = poolKeys.length > 0
    ? keccak256(encodeAbiParameters(
        [
          {
            name: 'path',
            type: 'tuple[]',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOnes', type: 'bool[]' },
        ],
        [poolKeys, zeroForOnes],
      ))
    : zeroBytes32Route

  const message = {
    permitted: {
      token: bridgeToken,
      amount: totalAmount.toString(),
    },
    spender: SWAP_BRIDGE_ROUTER_ADDRESS,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    witness: {
      tokenPortal,
      bridgeToken,
      totalAmount: totalAmount.toString(),
      fuelAmount: fuelAmount.toString(),
      aztecRecipient,
      fuelRecipient,
      tokenSecretHash,
      fuelSecretHash,
      minFuelOutput: minFuelOutput.toString(),
      routeHash,
      isPrivate,
    },
  }

  const typedData = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...BRIDGE_WITNESS_TYPE,
    },
    primaryType: 'PermitWitnessTransferFrom',
    domain,
    message,
  })

  console.log('[L1→L2] Requesting Permit2 signature...')
  const signature = await requestWaapWallet(WAAP_METHOD.eth_signTypedData_v4, [
    l1Address,
    typedData,
  ]) as `0x${string}`

  console.log('[L1→L2] Permit2 signature obtained')
  return { nonce, deadline, signature }
}

// ─── Step 4: Send L1 deposit transaction ─────────────────────────────

export async function sendL1DepositTransaction(params: {
  l1Address: string
  aztecAddress: string
  amount: bigint
  claimSecretHash: Fr
  claimSecret: Fr
  isPrivacyModeEnabled: boolean
  operationId: string
  selectedToken?: Token
  fuel?: FuelParams & { fuelSecretHash: Fr }
  privateFuel?: PrivateFuelParams & { secretHash: Fr }
  attestation?: PochAttestationData
  passportAttestation?: PassportAttestationData
}): Promise<DepositTxResult> {
  const {
    l1Address, aztecAddress, amount, claimSecretHash, claimSecret,
    isPrivacyModeEnabled, operationId, selectedToken, fuel, privateFuel,
    attestation, passportAttestation,
  } = params

  if (!SWAP_BRIDGE_ROUTER_ADDRESS) {
    throw new Error('SwapBridgeRouter is not configured for this deployment')
  }

  const l1PortalAddress = selectedToken?.l1PortalContract ?? ''
  const l1TokenAddress = selectedToken?.l1TokenContract ?? ''
  const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const
  const fuelSecretHashHex = (
    (privateFuel ? privateFuel.secretHash : fuel?.fuelSecretHash)?.toString() ?? zeroBytes32
  ) as `0x${string}`
  const permit2 = await signPermit2Transfer({
    l1Address,
    tokenPortal: l1PortalAddress as `0x${string}`,
    bridgeToken: l1TokenAddress as `0x${string}`,
    totalAmount: amount,
    fuelAmount: fuel?.fuelAmount ?? 0n,
    aztecRecipient: aztecAddress as `0x${string}`,
    fuelRecipient: (privateFuel ? privateFuel.fpcAddress : (fuel ? aztecAddress : zeroBytes32)) as `0x${string}`,
    tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
    fuelSecretHash: fuelSecretHashHex,
    minFuelOutput: fuel?.fuelQuote.minOutput ?? 0n,
    poolKeys: fuel?.fuelQuote.poolKeys ?? [],
    zeroForOnes: fuel?.fuelQuote.zeroForOnes ?? [],
    isPrivate: isPrivacyModeEnabled,
  })
  const permitArgs = {
    nonce: permit2.nonce,
    deadline: permit2.deadline,
    signature: permit2.signature,
  }

  // Build attestation payloads for the router.
  // When real attestation data is available (from fetchPochAttestation / fetchPassportAttestation),
  // use it. Otherwise fall back to empty structs (acceptable for public deposits).
  const cleanHands = attestation
    ? { nonce: BigInt(attestation.nonce), actionId: BigInt(attestation.actionId), signature: attestation.l1Signature as `0x${string}` }
    : { nonce: 0n, actionId: 0n, signature: '0x' as `0x${string}` }
  const passport = passportAttestation
    ? { maxAmount: BigInt(passportAttestation.maxAmount), nonce: BigInt(passportAttestation.nonce), deadline: BigInt(passportAttestation.deadline), signature: passportAttestation.l1Signature as `0x${string}` }
    : { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` }

  let txHash: any
  if (fuel) {
    const bridgeData = encodeFunctionData({
      abi: SwapBridgeRouterAbi,
      functionName: 'bridgeWithFuel',
      args: [
        {
          tokenPortal: l1PortalAddress as `0x${string}`,
          bridgeToken: l1TokenAddress as `0x${string}`,
          totalAmount: amount,
          fuelAmount: fuel.fuelAmount,
          aztecRecipient: aztecAddress as `0x${string}`,
          fuelRecipient: (privateFuel ? privateFuel.fpcAddress : aztecAddress) as `0x${string}`,
          tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
          fuelSecretHash: fuelSecretHashHex,
          minFuelOutput: fuel.fuelQuote.minOutput,
          path: fuel.fuelQuote.poolKeys!,
          zeroForOnes: fuel.fuelQuote.zeroForOnes!,
          isPrivate: isPrivacyModeEnabled,
          cleanHands,
          passport,
        },
        permitArgs,
      ],
    })

    console.log('[L1→L2] Sending SwapBridgeRouter.bridgeWithFuel tx, totalAmount:', amount.toString(), 'fuelAmount:', fuel.fuelAmount.toString(), 'fuelRecipient:', privateFuel ? privateFuel.fpcAddress : aztecAddress)
    txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
      { from: l1Address as `0x${string}`, to: SWAP_BRIDGE_ROUTER_ADDRESS, data: bridgeData },
    ])
  } else {
    const bridgeData = encodeFunctionData({
      abi: SwapBridgeRouterAbi,
      functionName: 'bridge',
      args: [
        {
          tokenPortal: l1PortalAddress as `0x${string}`,
          bridgeToken: l1TokenAddress as `0x${string}`,
          amount,
          aztecRecipient: aztecAddress as `0x${string}`,
          secretHash: claimSecretHash.toString() as `0x${string}`,
          isPrivate: isPrivacyModeEnabled,
          cleanHands,
          passport,
        },
        permitArgs,
      ],
    })

    console.log('[L1→L2] Sending SwapBridgeRouter.bridge tx, amount:', amount.toString(), 'private:', isPrivacyModeEnabled)
    txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
      { from: l1Address as `0x${string}`, to: SWAP_BRIDGE_ROUTER_ADDRESS, data: bridgeData },
    ])
  }

  console.log('[L1→L2] Deposit tx sent:', txHash)

  const l1TxHash =
    typeof txHash === 'string'
      ? txHash
      : ((txHash as { toString?: () => string })?.toString?.() ?? String(txHash))
  const l1TxUrl = getL1TxUrl(l1TxHash)

  updateLocalStorageItem(
    LS_KEY_BRIDGE_DEPOSITS,
    (c: any) => c.id === operationId,
    (c: any) => ({ ...c, l1TxHash, l1TxUrl }),
  )
  console.log('L1 tx hash stored immediately in localStorage')

  console.log('[L1→L2] PATCH l1TxHash →', { operationId, l1TxHash })
  const l1TxPatchOk = await patchOperationWithRetry(
    operationId,
    { l1TxHash, l1TxUrl },
    { label: 'l1TxHash' },
  )
  if (!l1TxPatchOk) {
    console.warn('[L1→L2] l1TxHash PATCH failed after retries — will be retried in persistReceiptToBackend')
  }

  return { txHash, l1TxHash, l1TxUrl }
}

// ─── Step 5: Wait for receipt and extract deposit event ──────────────

export async function waitForReceiptAndExtractEvent(params: {
  txHash: any
  amount: bigint
  claimSecretHash: Fr
  claimSecret: Fr
  aztecAddress: string
  isPrivacyModeEnabled: boolean
  l1Address: string
  operationId?: string
  selectedToken?: Token
  fuel?: FuelParams
}): Promise<ReceiptResult> {
  const {
    txHash, amount, claimSecretHash, claimSecret, aztecAddress,
    isPrivacyModeEnabled, l1Address, operationId, selectedToken, fuel,
  } = params

  const l1PortalAddress = selectedToken?.l1PortalContract ?? ''

  console.log('[L1→L2] Waiting for deposit tx to be mined...')
  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

  const l1TxHash = txReceipt?.transactionHash?.toString()
  const l1TxUrl = getL1TxUrl(l1TxHash)
  console.log('[L1→L2] Deposit tx confirmed:', l1TxHash, 'status:', txReceipt.status, 'logs:', txReceipt.logs.length)

  if (txReceipt.status === 'reverted') {
    throw new Error(`L1 deposit transaction reverted: ${l1TxHash}. Tokens were NOT taken — Permit2 signature or contract call failed.`)
  }

  // ── Extract the post-fee claim amount from TokenPortal's DepositToAztecPublic/Private event ──
  // TokenPortal deducts fees before computing the L1→L2 content hash, so the L2 claim
  // must use amountAfterFee (from the event) rather than the original pre-fee amount.
  const portalEventName = isPrivacyModeEnabled ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'
  let claimAmount: bigint = amount // fallback to pre-fee amount if event not found
  let portalEventFound = false
  for (const log of txReceipt.logs) {
    if (l1PortalAddress && log.address.toLowerCase() !== l1PortalAddress.toLowerCase()) continue
    // Try our custom ABI first (has fee field), then upstream ABI as fallback
    for (const abi of [CustomTokenPortalEventAbi, CustomTokenPortalAbi]) {
      try {
        const decoded = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === portalEventName) {
          claimAmount = (decoded.args as any).amount as bigint
          portalEventFound = true
          break
        }
      } catch {
        // Not our event with this ABI, skip
      }
    }
    if (portalEventFound) break
  }
  if (!portalEventFound) {
    throw new Error(
      `[L1→L2] TokenPortal ${portalEventName} event not found in receipt. ` +
      `Cannot determine post-fee claim amount. L1 tx succeeded — tokens are safe in the portal. ` +
      `Resume the operation to retry event extraction.`
    )
  }

  if (fuel) {
    // ── Fuel path: extract BridgeWithFuel event from SwapBridgeRouter ──
    // Find the BridgeWithFuel event log by decoding
    let bridgeWithFuelLog: any = null
    for (const log of txReceipt.logs) {
      if (log.address.toLowerCase() !== SWAP_BRIDGE_ROUTER_ADDRESS.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: SwapBridgeRouterAbi,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === 'BridgeWithFuel') {
          bridgeWithFuelLog = decoded
          break
        }
      } catch {
        // Not our event, skip
      }
    }

    if (!bridgeWithFuelLog) {
      throw new Error('BridgeWithFuel event not found in transaction receipt')
    }

    const args = bridgeWithFuelLog.args as any
    const messageHashStr = args.tokenKey.toString()
    const messageLeafIndexStr = args.tokenIndex.toString()
    const fuelMessageHashStr = args.fuelKey.toString()
    const fuelMessageLeafIndexStr = args.fuelIndex.toString()
    const fuelAmountReceived = args.fuelAmount as bigint

    console.log('[L1→L2] BridgeWithFuel event extracted:', {
      tokenKey: messageHashStr, tokenIndex: messageLeafIndexStr,
      fuelKey: fuelMessageHashStr, fuelIndex: fuelMessageLeafIndexStr,
      fuelAmount: fuelAmountReceived.toString(),
      claimAmount: claimAmount.toString(),
    })

    updateLocalStorageItem(
      LS_KEY_BRIDGE_DEPOSITS,
      (c: any) => c.claimSecretHash === claimSecretHash.toString() && c.status === BridgeOperationStatus.pending,
      (c: any) => ({
        ...c,
        messageHash: messageHashStr,
        messageLeafIndex: messageLeafIndexStr,
        fuelMessageHash: fuelMessageHashStr,
        fuelMessageLeafIndex: fuelMessageLeafIndexStr,
        fuelAmount: fuelAmountReceived.toString(),
      }),
    )

    return {
      l1TxHash, l1TxUrl, messageHashStr, messageLeafIndexStr,
      messageHash: args.tokenKey, messageLeafIndex: args.tokenIndex,
      claimAmount,
      fuelMessageHashStr, fuelMessageLeafIndexStr,
      fuelMessageHash: args.fuelKey, fuelMessageLeafIndex: args.fuelIndex,
      fuelAmount: fuelAmountReceived,
    }
  }

  // ── Standard path: extract deposit event ──
  // Try SwapBridgeRouter Bridge event first (our custom portal has different event signatures)
  let messageHash: any
  let messageLeafIndex: any

  if (SWAP_BRIDGE_ROUTER_ADDRESS) {
    let bridgeLog: any = null
    for (const txLog of txReceipt.logs) {
      if (txLog.address.toLowerCase() !== SWAP_BRIDGE_ROUTER_ADDRESS.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: SwapBridgeRouterAbi,
          data: txLog.data,
          topics: txLog.topics,
        })
        if (decoded.eventName === 'Bridge') {
          bridgeLog = decoded
          break
        }
      } catch {
        // Not our event, skip
      }
    }
    if (bridgeLog) {
      messageHash = (bridgeLog.args as any).key
      messageLeafIndex = (bridgeLog.args as any).index
    }
  }

  // Fallback: try DepositToAztecPublic/Private from TokenPortal logs if needed
  if (!messageHash) {
    // Try with our custom ABI first (has fee field), then upstream as fallback
    for (const abi of [CustomTokenPortalEventAbi, CustomTokenPortalAbi]) {
      try {
        const eventName = isPrivacyModeEnabled
          ? 'DepositToAztecPrivate'
          : 'DepositToAztecPublic'

        // Match by secretHash only — amount in the event is post-fee (amountAfterFee),
        // so we can't filter by the pre-fee amount the frontend knows.
        const privateEventFilter = (log: any) =>
          log.args.secretHash === claimSecretHash.toString()

        const publicEventFilter = (log: any) =>
          log.args.secretHash === claimSecretHash.toString() &&
          log.args.to === aztecAddress

        const eventFilter = isPrivacyModeEnabled ? privateEventFilter : publicEventFilter

        const log = extractEvent(
          txReceipt.logs,
          l1PortalAddress as `0x${string}`,
          abi,
          eventName,
          eventFilter,
        )

        messageHash = log.args.key
        messageLeafIndex = log.args.index
        if (log.args.amount != null) {
          claimAmount = log.args.amount as bigint
        }
        break
      } catch {
        // This ABI didn't match, try next
      }
    }
    if (!messageHash) {
      throw new Error('Could not extract deposit event from TokenPortal (tried custom + upstream ABIs)')
    }
  }
  const messageHashStr = messageHash.toString()
  const messageLeafIndexStr = messageLeafIndex.toString()
  console.log('[L1→L2] Event extracted:', { messageHash: messageHashStr, messageLeafIndex: messageLeafIndexStr, claimAmount: claimAmount.toString() })

  updateLocalStorageItem(
    LS_KEY_BRIDGE_DEPOSITS,
    (c: any) => operationId ? c.id === operationId : c.claimSecretHash === claimSecretHash.toString() && c.status === BridgeOperationStatus.pending,
    (c: any) => ({ ...c, messageHash: messageHashStr, messageLeafIndex: messageLeafIndexStr }),
  )
  console.log('messageHash and messageLeafIndex stored immediately after receipt')

  return { l1TxHash, l1TxUrl, messageHashStr, messageLeafIndexStr, messageHash, messageLeafIndex, claimAmount }
}

// ─── Step 6: Persist receipt data to backend ─────────────────────────

export async function persistReceiptToBackend(
  operationId: string | undefined,
  receiptData: {
    messageHashStr: string
    messageLeafIndexStr: string
    l1TxHash: string
    l1TxUrl: string
    claimAmount?: bigint
    fuelMessageHashStr?: string
    fuelMessageLeafIndexStr?: string
    fuelAmount?: bigint
  },
): Promise<boolean> {
  const patchData: Record<string, unknown> = {
    status: 'deposited',
    messageHash: receiptData.messageHashStr,
    messageLeafIndex: receiptData.messageLeafIndexStr,
    l1TxHash: receiptData.l1TxHash,
    l1TxUrl: receiptData.l1TxUrl,
    currentStep: 2,
  }
  // Include post-fee claim amount from deposit event (critical for L2 claim content hash)
  if (receiptData.claimAmount != null) patchData.claimAmount = receiptData.claimAmount.toString()
  // Include fuel recovery data if present
  if (receiptData.fuelMessageHashStr) patchData.fuelMessageHash = receiptData.fuelMessageHashStr
  if (receiptData.fuelMessageLeafIndexStr) patchData.fuelMessageLeafIndex = receiptData.fuelMessageLeafIndexStr
  if (receiptData.fuelAmount != null) patchData.fuelAmount = receiptData.fuelAmount.toString()
  console.log('[L1→L2] PATCH receipt data →', { operationId, ...patchData })

  const succeeded = operationId
    ? await patchOperationWithRetry(operationId, patchData, { label: 'receipt data' })
    : false

  if (succeeded) {
    console.log('messageHash + messageLeafIndex stored on backend')
  } else {
    console.error('[Bridge] CRITICAL: Failed to store messageHash on backend after 3 attempts')
  }

  return succeeded
}

// ─── Step 7: Update localStorage with full deposit details ───────────

export function finalizeLocalStorageAfterDeposit(params: {
  claimSecret: Fr
  claimSecretHash: Fr
  claimAmount: bigint
  l1Address: string
  aztecAddress: string
  messageHashStr: string
  messageLeafIndexStr: string
  l1TxHash: string
  l1TxUrl: string
  l1BlockNumberBeforeTx: string
  nodeInfo: any
  isPrivacyModeEnabled: boolean
  operationId?: string
}): { updatedClaim: any; wasExisting: boolean } {
  const {
    claimSecret, claimSecretHash, claimAmount, l1Address, aztecAddress,
    messageHashStr, messageLeafIndexStr, l1TxHash, l1TxUrl,
    l1BlockNumberBeforeTx, nodeInfo, isPrivacyModeEnabled, operationId,
  } = params

  const existingClaims = localStorage.getItem(LS_KEY_BRIDGE_DEPOSITS)
  const claims = existingClaims ? JSON.parse(existingClaims) : []

  const claimIndex = claims.findIndex(
    (c: any) => operationId
      ? c.id === operationId
      : c.claimSecretHash === claimSecretHash.toString() && c.status === BridgeOperationStatus.pending,
  )

  let updatedClaim: any = null

  if (claimIndex !== -1) {
    updatedClaim = {
      ...claims[claimIndex],
      claimAmount: claimAmount.toString(),
      messageHash: messageHashStr,
      messageLeafIndex: messageLeafIndexStr,
      l1TxHash,
      l1TxUrl,
      status: BridgeOperationStatus.deposited,
    }
    claims[claimIndex] = updatedClaim
    localStorage.setItem(LS_KEY_BRIDGE_DEPOSITS, JSON.stringify(claims))
    console.log('Claim data updated with transaction details')
    return { updatedClaim, wasExisting: true }
  }

  console.warn('Pre-stored claim not found, creating new entry (this should not happen)')
  updatedClaim = {
    id: Date.now().toString(),
    claimAmount: claimAmount.toString(),
    claimSecretHash: claimSecretHash.toString(),
    messageHash: messageHashStr,
    messageLeafIndex: messageLeafIndexStr,
    timestamp: Date.now(),
    l1Address,
    l2Address: aztecAddress,
    success: false,
    l1TxHash,
    l1TxUrl,
    l1BlockNumberBeforeTx,
    nodeInfo: serializeNodeInfo(nodeInfo),
    isPrivacyModeEnabled,
    status: BridgeOperationStatus.deposited,
  }
  claims.push(updatedClaim)
  localStorage.setItem(LS_KEY_BRIDGE_DEPOSITS, JSON.stringify(claims))
  return { updatedClaim, wasExisting: false }
}
