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
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { L1ToL2Message, L1Actor, L2Actor } from '@aztec/stdlib/messaging'
import { sha256ToField } from '@aztec/foundation/crypto/sha256'
import { EthAddress } from '@aztec/foundation/eth-address'
import { TestERC20Abi, TokenPortalAbi } from '@aztec/l1-artifacts'
import { extractEvent } from '@aztec/ethereum/utils'
import { encodeFunctionData, decodeEventLog, keccak256, toBytes } from 'viem'
import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { aztecNode } from '@/aztec'
import { api } from '@/lib/api'
import axios from 'axios'
import {
  L1_CHAIN_ID,
  L2_CHAIN_ID,
  ROLLUP_VERSION,
  BRIDGE_AND_FUEL_ADDRESS,
  FEE_JUICE_PORTAL_ADDRESS,
  PERMIT2_ADDRESS,
  SWAP_BRIDGE_ROUTER_ADDRESS,
} from '@/config'
import { BridgeAndFuelAbi } from '@/constants/abis/BridgeAndFuelAbi'
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
} from './bridgeUtils'

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
    console.warn('[L1→L2] Failed to query calculateFee, using original amount:', err)
    return amount
  }
}

// ═════════════════════════════════════════════════════════════════════
// DEBUG: Verify L1→L2 message hash (TODO remove after debugging)
// ═════════════════════════════════════════════════════════════════════

/**
 * Reconstruct the L1→L2 message hash client-side and compare with the L1 event key.
 * This helps diagnose "nonexistent L1-to-L2 message" errors by showing exactly
 * which component differs between what L1 stored and what L2 expects.
 */
export async function debugVerifyL1ToL2Message(params: {
  portalAddress: string
  l2BridgeAddress: string
  aztecRecipient: string
  amountAfterFee: bigint
  claimSecretHash: Fr
  leafIndex: bigint
  l1EventKey: string  // the 'key' from the L1 Inbox event (message hash)
  isPrivate: boolean
}): Promise<void> {
  const TAG = '[DEBUG-MSG-HASH] TODO remove after debugging'
  try {
    console.log(`${TAG} ── Starting message hash verification ──`)
    console.log(`${TAG} Params:`, {
      portalAddress: params.portalAddress,
      l2BridgeAddress: params.l2BridgeAddress,
      aztecRecipient: params.aztecRecipient,
      amountAfterFee: params.amountAfterFee.toString(),
      claimSecretHash: params.claimSecretHash.toString(),
      leafIndex: params.leafIndex.toString(),
      l1EventKey: params.l1EventKey,
      isPrivate: params.isPrivate,
      l1ChainId: L1_CHAIN_ID,
      rollupVersion: ROLLUP_VERSION,
    })

    // ── 1. Compute content hash (same as TokenPortal on L1) ──
    const funcSig = params.isPrivate
      ? 'mint_to_private(uint256)'
      : 'mint_to_public(bytes32,uint256)'
    const selectorHex = keccak256(toBytes(funcSig)).slice(0, 10) // '0xabcdef12'
    const selectorBuf = Buffer.from(selectorHex.slice(2), 'hex') // 4 bytes

    let contentBuf: Buffer
    if (params.isPrivate) {
      // mint_to_private(uint256): 4 + 32 = 36 bytes
      const amountBuf = Buffer.from(params.amountAfterFee.toString(16).padStart(64, '0'), 'hex')
      contentBuf = Buffer.concat([selectorBuf, amountBuf])
    } else {
      // mint_to_public(bytes32,uint256): 4 + 32 + 32 = 68 bytes
      const recipientBuf = Buffer.from(params.aztecRecipient.replace('0x', '').padStart(64, '0'), 'hex')
      const amountBuf = Buffer.from(params.amountAfterFee.toString(16).padStart(64, '0'), 'hex')
      contentBuf = Buffer.concat([selectorBuf, recipientBuf, amountBuf])
    }
    const contentHash = sha256ToField([contentBuf])
    console.log(`${TAG} Content hash computed:`, contentHash.toString())
    console.log(`${TAG}   funcSig: "${funcSig}"`)
    console.log(`${TAG}   selector: ${selectorHex}`)
    console.log(`${TAG}   contentBuf (${contentBuf.length} bytes): 0x${contentBuf.toString('hex')}`)

    // ── 2. Construct the full L1ToL2Message ──
    const sender = new L1Actor(
      EthAddress.fromString(params.portalAddress),
      L1_CHAIN_ID,
    )
    const recipient = new L2Actor(
      AztecAddress.fromString(params.l2BridgeAddress),
      ROLLUP_VERSION,
    )
    const secretHashFr = Fr.fromString(params.claimSecretHash.toString())
    const indexFr = new Fr(params.leafIndex)

    const message = new L1ToL2Message(sender, recipient, contentHash, secretHashFr, indexFr)
    const computedHash = message.hash()

    console.log(`${TAG} ── Message components ──`)
    console.log(`${TAG}   sender.actor (portal): ${params.portalAddress}`)
    console.log(`${TAG}   sender.chainId: ${L1_CHAIN_ID}`)
    console.log(`${TAG}   recipient.actor (l2Bridge): ${params.l2BridgeAddress}`)
    console.log(`${TAG}   recipient.version (rollupVersion): ${ROLLUP_VERSION}`)
    console.log(`${TAG}   content: ${contentHash.toString()}`)
    console.log(`${TAG}   secretHash: ${secretHashFr.toString()}`)
    console.log(`${TAG}   index: ${indexFr.toString()}`)
    console.log(`${TAG}   toFields():`, message.toFields().map(f => f.toString()))

    // ── 3. Compare with L1 event key ──
    const l1Hash = Fr.fromString(params.l1EventKey)
    const hashMatch = computedHash.toString() === l1Hash.toString()
    console.log(`${TAG} ── Hash comparison ──`)
    console.log(`${TAG}   L1 event key:   ${l1Hash.toString()}`)
    console.log(`${TAG}   Computed hash:   ${computedHash.toString()}`)
    console.log(`${TAG}   MATCH: ${hashMatch ? '✅ YES' : '❌ NO — hash mismatch!'}`)

    if (!hashMatch) {
      console.error(`${TAG} ❌ HASH MISMATCH — one of the message components differs between L1 and our computation`)
      console.error(`${TAG}   Check: portalAddress, l2BridgeAddress, L1_CHAIN_ID, ROLLUP_VERSION, contentHash, secretHash, leafIndex`)
    }

    // ── 4. Query Aztec node for the L1 event hash ──
    try {
      const l1Block = await aztecNode.getL1ToL2MessageBlock(l1Hash)
      console.log(`${TAG}   L1 event hash in L2 tree: ${l1Block !== undefined ? `YES (block ${l1Block})` : 'NO — not synced'}`)
    } catch (e) {
      console.warn(`${TAG}   Node query for L1 hash failed:`, e)
    }

    // ── 5. Query Aztec node for our computed hash ──
    if (!hashMatch) {
      try {
        const computedBlock = await aztecNode.getL1ToL2MessageBlock(computedHash)
        console.log(`${TAG}   Computed hash in L2 tree: ${computedBlock !== undefined ? `YES (block ${computedBlock})` : 'NO — not in tree'}`)
      } catch (e) {
        console.warn(`${TAG}   Node query for computed hash failed:`, e)
      }
    }

    // ── 6. Query membership witness for L1 hash ──
    try {
      const witness = await aztecNode.getL1ToL2MessageMembershipWitness('latest', l1Hash)
      if (witness) {
        const [witnessIndex] = witness
        console.log(`${TAG}   L1 hash tree index: ${witnessIndex}`)
        console.log(`${TAG}   Expected leaf index: ${params.leafIndex}`)
        console.log(`${TAG}   Index match: ${witnessIndex === params.leafIndex ? '✅ YES' : '❌ NO — index mismatch!'}`)
      } else {
        console.log(`${TAG}   No membership witness found for L1 hash`)
      }
    } catch (e) {
      console.warn(`${TAG}   Membership witness query failed:`, e)
    }

    console.log(`${TAG} ── Verification complete ──`)
  } catch (err) {
    console.error(`${TAG} Diagnostic failed:`, err)
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

  console.log('[DEBUG-CLAIM] TODO remove after debugging — executeL2Claim called:', { // TODO remove after debugging
    method,
    bridgeAddress: walletAdapter?.bridgeAddress,
    aztecAddress,
    amount: amount.toString(),
    claimSecret: claimSecret.toString().slice(0, 18) + '...',
    messageLeafIndex: messageLeafIndex?.toString() ?? 'null (brute-force)',
    hasFeeOption: !!options?.feeOption,
  })

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

        console.log('[L1→L2] Claim succeeded ✅')
        return { l2TxHash: result.txHash, usedBruteForce: false }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const isNonexistentMsg =
          errMsg.includes('nonexistent L1-to-L2 message') ||
          errMsg.includes('l1_to_l2_msg_exists') ||
          errMsg.includes('No L1 to L2 message found')
        if (isNonexistentMsg && attempt < maxAttempts) {
          console.warn(`[L1→L2] Message not found on attempt ${attempt}, retrying in ${retryDelayMs / 1000}s...`)
          options?.onRetry?.(attempt, maxAttempts, retryDelayMs)
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
  // Compute poseidon2 hash server-side to avoid needing SharedArrayBuffer
  // (cross-origin isolation headers block wallet iframe/popup communication)
  const hashRes = await fetch('/api/compute-secret-hash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: claimSecret.toString() }),
  })
  if (!hashRes.ok) {
    throw new Error('Failed to compute claim secret hash')
  }
  const { secretHash } = await hashRes.json()
  const claimSecretHash = Fr.fromString(secretHash)
  const nodeInfoSnapshot = serializeNodeInfo(nodeInfo)
  console.log('[L1→L2] Claim secret generated, backing up to backend')

  // Deterministic encryption: same wallet + same message = same key (always recoverable)
  const keyDerivationDomain = getKeyDerivationDomain()
  const signingMessage = createSigningMessage(l1Address)
  const signature = await signWaapMessage(signingMessage)
  if (!signature) {
    throw new Error('Failed to sign message for encryption key derivation')
  }
  const encryptionKey = await deriveEncryptionKey(l1Address, signature, keyDerivationDomain)

  const payloadToEncrypt = {
    claimSecret: claimSecret.toString(),
    claimSecretHash: claimSecretHash.toString(),
    amount: amountL1,
    l1Address,
    l2Address: aztecAddress,
    isPrivacyModeEnabled,
    l1BlockNumberBeforeTx,
    nodeInfo: nodeInfoSnapshot,
  }
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

  // Generate fuel secrets.
  // Public fuel: random secret + hash → used with FeeJuicePaymentMethodWithClaim on L2.
  // Private fuel: derived secret (poseidon2([salt, userAddress], DOM_SEP)) + hash → FJ
  //   deposited to FPC on L1, then BridgedMintAndPayFeePaymentMethod on L2
  //   (FeeJuice.claim + BridgedFPC.mint_and_pay_fee, all private, in one tx).
  // When private fuel is active, fuel is also set (for the swap quote), but we skip
  // the public fuel secret since it would be unused — private fuel has its own secret.
  let fuelSecret: Fr | undefined
  let fuelSecretHash: Fr | undefined
  if (params.fuel && !params.privateFuel) {
    fuelSecret = Fr.random()
    const fuelHashRes = await fetch('/api/compute-secret-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: fuelSecret.toString() }),
    })
    if (!fuelHashRes.ok) {
      throw new Error('Failed to compute fuel secret hash')
    }
    const { secretHash: fuelHashStr } = await fuelHashRes.json()
    fuelSecretHash = Fr.fromString(fuelHashStr)
    console.log('[L1→L2] Public fuel secret generated')
  }

  let privateFuelSalt: Fr | undefined
  let privateFuelSecret: Fr | undefined
  let privateFuelSecretHash: Fr | undefined
  if (params.privateFuel) {
    privateFuelSalt = Fr.random()
    // Derive BridgedFPC secret: poseidon2([salt, claimer], DOM_SEP)
    // claimer = user's Aztec address (the contract uses msg_sender() as claimer)
    const pfHashRes = await fetch('/api/compute-secret-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fpc-bridge',
        salt: privateFuelSalt.toString(),
        claimer: params.aztecAddress,
      }),
    })
    if (!pfHashRes.ok) {
      throw new Error('Failed to compute private fuel secret hash')
    }
    const { secret: pfSecret, secretHash: pfSecretHash } = await pfHashRes.json()
    privateFuelSecret = Fr.fromString(pfSecret)
    privateFuelSecretHash = Fr.fromString(pfSecretHash)
    console.log('[L1→L2] Private fuel (BridgedFPC) secret generated')
  }

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
 *   3. Sign Permit2 transfer via eth_signTypedData_v4 (gasless)
 *   4. Return { nonce, deadline, signature } for use in Step 4
 *
 * Falls back to legacy direct approve when SWAP_BRIDGE_ROUTER_ADDRESS is not set.
 */
export async function checkAndApproveAllowance(
  l1Address: string,
  amount: bigint,
  selectedToken?: Token,
  fuel?: FuelParams,
): Promise<Permit2Params | void> {
  const l1TokenAddress = selectedToken?.l1TokenContract ?? ''

  // ── Permit2 path (SwapBridgeRouter is deployed) ──
  if (SWAP_BRIDGE_ROUTER_ADDRESS) {
    const spender = PERMIT2_ADDRESS

    const allowanceData = encodeFunctionData({
      abi: TestERC20Abi,
      functionName: 'allowance',
      args: [l1Address as `0x${string}`, spender as `0x${string}`],
    })

    const allowance = await requestWaapWallet(WAAP_METHOD.eth_call, [
      { to: l1TokenAddress, data: allowanceData },
    ])

    console.log('[L1→L2] Permit2 allowance:', allowance, 'needed:', amount.toString())
    if (BigInt(allowance as string) < amount) {
      // One-time max approval for Permit2
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

    // Sign Permit2 transfer
    return signPermit2Transfer(l1Address, l1TokenAddress as `0x${string}`, amount)
  }

  // ── Legacy path (direct approve to BridgeAndFuel or TokenPortal) ──
  const spender = fuel ? BRIDGE_AND_FUEL_ADDRESS : (selectedToken?.l1PortalContract ?? '')

  const allowanceData = encodeFunctionData({
    abi: TestERC20Abi,
    functionName: 'allowance',
    args: [l1Address as `0x${string}`, spender as `0x${string}`],
  })

  const allowance = await requestWaapWallet(WAAP_METHOD.eth_call, [
    { to: l1TokenAddress, data: allowanceData },
  ])

  console.log('[L1→L2] Current allowance:', allowance, 'needed:', amount.toString(), 'spender:', spender)
  if (BigInt(allowance as string) < amount) {
    const approveData = encodeFunctionData({
      abi: TestERC20Abi,
      functionName: 'approve',
      args: [spender as `0x${string}`, amount],
    })

    const approveTxHash = await requestWaapWallet(
      WAAP_METHOD.eth_sendTransaction,
      [{ from: l1Address as `0x${string}`, to: l1TokenAddress, data: approveData }],
    )

    console.log('[L1→L2] Approve tx sent:', approveTxHash, '— waiting for confirmation...')
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
    console.log('[L1→L2] Approve tx confirmed')
  } else {
    console.log('[L1→L2] Allowance sufficient, skipping approve')
  }
}

/**
 * Sign a Permit2 SignatureTransfer via eth_signTypedData_v4.
 * Uses an unordered nonce (random uint256) and 30-minute deadline.
 */
async function signPermit2Transfer(
  l1Address: string,
  tokenAddress: `0x${string}`,
  amount: bigint,
): Promise<Permit2Params> {
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

  const types = {
    PermitTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' },
      { name: 'spender', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
    TokenPermissions: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
  }

  const message = {
    permitted: {
      token: tokenAddress,
      amount: amount.toString(),
    },
    spender: SWAP_BRIDGE_ROUTER_ADDRESS,
    nonce: nonce.toString(),
    deadline: deadline.toString(),
  }

  const typedData = JSON.stringify({
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...types,
    },
    primaryType: 'PermitTransferFrom',
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
  permit2?: Permit2Params
}): Promise<DepositTxResult> {
  const {
    l1Address, aztecAddress, amount, claimSecretHash, claimSecret,
    isPrivacyModeEnabled, operationId, selectedToken, fuel, privateFuel, permit2,
  } = params

  let txHash: any

  if (permit2 && SWAP_BRIDGE_ROUTER_ADDRESS) {
    // ── SwapBridgeRouter path (Permit2) ──
    const l1PortalAddress = selectedToken?.l1PortalContract ?? ''
    const l1TokenAddress = selectedToken?.l1TokenContract ?? ''
    const permitArgs = {
      nonce: permit2.nonce,
      deadline: permit2.deadline,
      signature: permit2.signature,
    }

    // Empty attestation data — private deposits with real attestation TBD
    const emptyCleanHands = { nonce: 0n, actionId: 0n, signature: '0x' as `0x${string}` }
    const emptyPassport = { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` }

    if (fuel) {
      // Fuel path: SwapBridgeRouter.bridgeWithFuel with typed params
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
            tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
            fuelSecretHash: (privateFuel ? privateFuel.secretHash : fuel.fuelSecretHash).toString() as `0x${string}`,
            minFuelOutput: fuel.fuelQuote.minOutput,
            path: fuel.fuelQuote.poolKeys!,
            zeroForOnes: fuel.fuelQuote.zeroForOnes!,
            isPrivate: isPrivacyModeEnabled,
            cleanHands: emptyCleanHands,
            passport: emptyPassport,
          },
          permitArgs,
        ],
      })

      console.log('[L1→L2] Sending SwapBridgeRouter.bridgeWithFuel tx, totalAmount:', amount.toString(), 'fuelAmount:', fuel.fuelAmount.toString())
      txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
        { from: l1Address as `0x${string}`, to: SWAP_BRIDGE_ROUTER_ADDRESS, data: bridgeData },
      ])
    } else {
      // Non-fuel path: SwapBridgeRouter.bridge (public or private)
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
            cleanHands: emptyCleanHands,
            passport: emptyPassport,
          },
          permitArgs,
        ],
      })

      console.log('[L1→L2] Sending SwapBridgeRouter.bridge tx, amount:', amount.toString(), 'private:', isPrivacyModeEnabled)
      txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
        { from: l1Address as `0x${string}`, to: SWAP_BRIDGE_ROUTER_ADDRESS, data: bridgeData },
      ])
    }
  }

  if (!txHash && fuel) {
    // ── Legacy fuel path: call BridgeAndFuel.bridgeWithFuel ──
    const l1PortalAddress = selectedToken?.l1PortalContract ?? ''
    const l1TokenAddress = selectedToken?.l1TokenContract ?? ''

    const bridgeData = encodeFunctionData({
      abi: BridgeAndFuelAbi,
      functionName: 'bridgeWithFuel',
      args: [
        {
          tokenPortal: l1PortalAddress as `0x${string}`,
          bridgeToken: l1TokenAddress as `0x${string}`,
          totalAmount: amount,
          fuelAmount: fuel.fuelAmount,
          aztecRecipient: aztecAddress as `0x${string}`,
          fuelRecipient: (privateFuel?.fpcAddress ?? aztecAddress) as `0x${string}`,
          tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
          fuelSecretHash: (privateFuel ? privateFuel.secretHash : fuel.fuelSecretHash).toString() as `0x${string}`,
          feeJuicePortal: FEE_JUICE_PORTAL_ADDRESS,
          swapTarget: fuel.fuelQuote.swapTarget,
          swapAllowanceTarget: fuel.fuelQuote.swapAllowanceTarget,
          minFuelOutput: fuel.fuelQuote.minOutput,
        },
        fuel.fuelQuote.swapData,
      ],
    })

    console.log('[L1→L2] Sending BridgeAndFuel tx, totalAmount:', amount.toString(), 'fuelAmount:', fuel.fuelAmount.toString())
    txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
      { from: l1Address as `0x${string}`, to: BRIDGE_AND_FUEL_ADDRESS, data: bridgeData },
    ])
  }

  if (!txHash) {
    // ── Legacy standard path: call TokenPortal directly ──
    // Fallback when SwapBridgeRouter is not deployed
    const l1PortalAddress = selectedToken?.l1PortalContract ?? ''

    const functionName = isPrivacyModeEnabled
      ? 'depositToAztecPrivate'
      : 'depositToAztecPublic'
    const args = isPrivacyModeEnabled
      ? ([amount, claimSecretHash.toString()] as const)
      : ([aztecAddress as `0x${string}`, amount, claimSecretHash.toString()] as const)

    console.log('[L1→L2] Sending deposit tx:', functionName, 'to portal:', l1PortalAddress, 'amount:', amount.toString())
    const bridgeData = encodeFunctionData({
      abi: TokenPortalAbi,
      functionName,
      args,
    })

    txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
      { from: l1Address as `0x${string}`, to: l1PortalAddress, data: bridgeData },
    ])
  }

  console.log('[L1→L2] Deposit tx sent:', txHash)

  const l1TxHash =
    typeof txHash === 'string'
      ? txHash
      : ((txHash as { toString?: () => string })?.toString?.() ?? String(txHash))
  const l1TxUrl = `https://sepolia.etherscan.io/tx/${l1TxHash}`

  updateLocalStorageItem(
    LS_KEY_BRIDGE_DEPOSITS,
    (c: any) => c.id === operationId,
    (c: any) => ({ ...c, l1TxHash, l1TxUrl }),
  )
  console.log('L1 tx hash stored immediately in localStorage')

  console.log('[L1→L2] PATCH l1TxHash →', { operationId, l1TxHash })
  try {
    await api.patch(`/api/bridge/operations/${operationId}`, { l1TxHash, l1TxUrl })
    console.log('[L1→L2] l1TxHash stored on backend')
  } catch (err) {
    console.warn('[L1→L2] PATCH l1TxHash failed (will retry after receipt):', err)
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
  selectedToken?: Token
  fuel?: FuelParams
}): Promise<ReceiptResult> {
  const {
    txHash, amount, claimSecretHash, claimSecret, aztecAddress,
    isPrivacyModeEnabled, l1Address, selectedToken, fuel,
  } = params

  const l1PortalAddress = selectedToken?.l1PortalContract ?? ''

  console.log('[L1→L2] Waiting for deposit tx to be mined...')
  const txReceipt = await publicClient.waitForTransactionReceipt({ hash: txHash })

  const l1TxHash = txReceipt?.transactionHash?.toString()
  const l1TxUrl = `https://sepolia.etherscan.io/tx/${l1TxHash}`
  console.log('[L1→L2] Deposit tx confirmed:', l1TxHash, 'status:', txReceipt.status, 'logs:', txReceipt.logs.length)

  // ── Extract the post-fee claim amount from TokenPortal's DepositToAztecPublic/Private event ──
  // TokenPortal deducts fees before computing the L1→L2 content hash, so the L2 claim
  // must use amountAfterFee (from the event) rather than the original pre-fee amount.
  const portalEventName = isPrivacyModeEnabled ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'
  let claimAmount: bigint = amount // fallback to pre-fee amount if event not found
  console.log('[DEBUG-CLAIM] TODO remove after debugging — searching for TokenPortal event:', { // TODO remove after debugging
    portalEventName, l1PortalAddress, totalLogs: txReceipt.logs.length,
    preFeeAmount: amount.toString(), isPrivacyModeEnabled,
  })
  let portalEventFound = false
  for (const log of txReceipt.logs) {
    if (l1PortalAddress && log.address.toLowerCase() !== l1PortalAddress.toLowerCase()) continue
    // Try our custom ABI first (has fee field), then upstream ABI as fallback
    for (const abi of [CustomTokenPortalEventAbi, TokenPortalAbi]) {
      try {
        const decoded = decodeEventLog({
          abi,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === portalEventName) {
          claimAmount = (decoded.args as any).amount as bigint
          portalEventFound = true
          const fee = (decoded.args as any).fee
          console.log('[DEBUG-CLAIM] TODO remove after debugging — TokenPortal event decoded:', { // TODO remove after debugging
            eventName: decoded.eventName,
            claimAmount: claimAmount.toString(),
            fee: fee?.toString() ?? 'N/A (upstream ABI)',
            preFeeAmount: amount.toString(),
          })
          break
        }
      } catch {
        // Not our event with this ABI, skip
      }
    }
    if (portalEventFound) break
  }
  if (!portalEventFound) {
    console.warn('[DEBUG-CLAIM] TODO remove after debugging — TokenPortal event NOT found! Using pre-fee amount as fallback:', amount.toString()) // TODO remove after debugging
  }

  if (fuel) {
    // ── Fuel path: extract BridgeWithFuel event from BridgeAndFuel or SwapBridgeRouter ──
    // Find the BridgeWithFuel event log by decoding
    let bridgeWithFuelLog: any = null
    const fuelContractAddresses = [BRIDGE_AND_FUEL_ADDRESS, SWAP_BRIDGE_ROUTER_ADDRESS].filter(Boolean)
    const fuelAbis = [BridgeAndFuelAbi, SwapBridgeRouterAbi]
    for (const log of txReceipt.logs) {
      const logAddr = log.address.toLowerCase()
      if (!fuelContractAddresses.some(a => a.toLowerCase() === logAddr)) continue
      for (const abi of fuelAbis) {
        try {
          const decoded = decodeEventLog({
            abi,
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
      if (bridgeWithFuelLog) break
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
      (c: any) => c.l1Address === l1Address && c.status === BridgeOperationStatus.pending,
      (c: any) => ({ ...c, messageHash: messageHashStr, messageLeafIndex: messageLeafIndexStr }),
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

  // Fallback: try DepositToAztecPublic/Private from TokenPortal (legacy direct path)
  if (!messageHash) {
    // Try with our custom ABI first (has fee field), then upstream as fallback
    for (const abi of [CustomTokenPortalEventAbi, TokenPortalAbi]) {
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
    (c: any) => c.l1Address === l1Address && c.status === BridgeOperationStatus.pending,
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
  },
): Promise<boolean> {
  const patchData = {
    status: 'deposited',
    messageHash: receiptData.messageHashStr,
    messageLeafIndex: receiptData.messageLeafIndexStr,
    l1TxHash: receiptData.l1TxHash,
    l1TxUrl: receiptData.l1TxUrl,
    currentStep: 2,
  }
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
}): { updatedClaim: any; wasExisting: boolean } {
  const {
    claimSecret, claimSecretHash, claimAmount, l1Address, aztecAddress,
    messageHashStr, messageLeafIndexStr, l1TxHash, l1TxUrl,
    l1BlockNumberBeforeTx, nodeInfo, isPrivacyModeEnabled,
  } = params

  const existingClaims = localStorage.getItem(LS_KEY_BRIDGE_DEPOSITS)
  const claims = existingClaims ? JSON.parse(existingClaims) : []

  const claimIndex = claims.findIndex(
    (c: any) =>
      c.l1Address === l1Address &&
      c.status === BridgeOperationStatus.pending,
  )

  let updatedClaim: any = null

  if (claimIndex !== -1) {
    updatedClaim = {
      ...claims[claimIndex],
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

