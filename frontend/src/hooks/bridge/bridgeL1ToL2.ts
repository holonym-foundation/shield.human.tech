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
import { computeSecretHash } from '@aztec/aztec.js/crypto'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TestERC20Abi } from '@aztec/l1-artifacts'
// @ts-ignore — JSON import from forge build output (custom compliant portal w/ attestation structs)
import CustomTokenPortalJson from '../../../../l1-contracts/out/TokenPortal.sol/TokenPortal.json'
const CustomTokenPortalAbi = CustomTokenPortalJson.abi
import { encodeFunctionData, decodeEventLog, parseEventLogs } from 'viem'
import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { aztecNode } from '@/aztec'
import { api } from '@/lib/api'
import axios from 'axios'
import {
  L1_CHAIN_ID,
  L2_CHAIN_ID,
  BRIDGE_AND_FUEL_ADDRESS,
  FEE_JUICE_PORTAL_ADDRESS,
  MOCK_FUEL_SWAP_ADDRESS,
} from '@/config'
import { BridgeAndFuelAbi } from '@/constants/abis/BridgeAndFuelAbi'
import { getMockFuelQuote, type FuelQuote } from '@/utils/fuelQuote'
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
  // Amount after fee deduction by the portal (always present for standard deposits, absent for fuel path)
  amountAfterFee?: bigint
  // Fuel-specific fields (present when fuel path used)
  fuelMessageHashStr?: string
  fuelMessageLeafIndexStr?: string
  fuelMessageHash?: any
  fuelMessageLeafIndex?: any
  fuelAmount?: bigint
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

  const method = isPrivacyModeEnabled ? 'claim_private' : 'claim_public'

  if (messageLeafIndex != null) {
    // ── Normal path: known leaf index, retry on "nonexistent message" ──
    let result: { txHash: string } | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        options?.onAttempt?.(attempt, maxAttempts)
        console.log(`[L1→L2] Claim attempt ${attempt}/${maxAttempts}...`)
        result = await walletAdapter.executeCall(
          walletAdapter.bridgeAddress,
          method,
          [
            AztecAddress.fromString(aztecAddress),
            amount,
            claimSecret,
            messageLeafIndex,
          ],
          { contractType: 'bridge', ...options?.feeOption },
        )
        console.log(`[L1→L2] Claim succeeded on attempt ${attempt}`)
        break
      } catch (err) {
        // Retry on any error — the claim is idempotent and most failures are transient
        // (reorgs, block header not found, message not synced, PXE lag, etc.)
        if (attempt < maxAttempts) {
          const errMsg = err instanceof Error ? err.message : String(err)
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
    return { l2TxHash: result!.txHash, usedBruteForce: false }
  } else {
    // ── Brute-force path: try indices 0..bruteForceMaxIndex ──
    console.log('[L1→L2] Brute-forcing messageLeafIndex (trying 0..', bruteForceMaxIndex - 1, ')...')
    for (let idx = 0; idx < bruteForceMaxIndex; idx++) {
      try {
        console.log('[L1→L2] Trying leafIndex=', idx)
        const result = await walletAdapter.executeCall(
          walletAdapter.bridgeAddress,
          method,
          [
            AztecAddress.fromString(aztecAddress),
            amount,
            claimSecret,
            BigInt(idx),
          ],
          { contractType: 'bridge' },
        )
        console.log('[L1→L2] Claim succeeded with leafIndex=', idx)
        return {
          l2TxHash: result.txHash,
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

  // Deterministic encryption: same wallet + same message = same key (always recoverable)
  const keyDerivationDomain = getKeyDerivationDomain()
  const signingMessage = createSigningMessage(l1Address)
  const signature = await signWaapMessage(signingMessage)
  if (!signature) {
    throw new Error('Failed to sign message for encryption key derivation')
  }
  const encryptionKey = await deriveEncryptionKey(l1Address, signature, keyDerivationDomain)

  // Generate fuel secrets before backup so they're included in the encrypted payload
  let fuelSecret: Fr | undefined
  let fuelSecretHash: Fr | undefined
  if (params.fuel) {
    fuelSecret = Fr.random()
    fuelSecretHash = await computeSecretHash(fuelSecret)
    console.log('[L1→L2] Fuel secret generated')
  }

  const payloadToEncrypt = {
    claimSecret: claimSecret.toString(),
    claimSecretHash: claimSecretHash.toString(),
    amount: amountL1,
    l1Address,
    l2Address: aztecAddress,
    isPrivacyModeEnabled,
    l1BlockNumberBeforeTx,
    nodeInfo: nodeInfoSnapshot,
    ...(fuelSecret && fuelSecretHash ? {
      fuelSecret: fuelSecret.toString(),
      fuelSecretHash: fuelSecretHash.toString(),
    } : {}),
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
    ...(fuelSecret ? {
      fuelAmount: params.fuel?.fuelAmount.toString(),
    } : {}),
  })
  console.log('Encrypted claim data stored in localStorage')

  return { operationId, claimSecret, claimSecretHash, nodeInfoSnapshot, fuelSecret, fuelSecretHash }
}

// ─── Step 3: Check and approve token allowance ───────────────────────

export async function checkAndApproveAllowance(
  l1Address: string,
  amount: bigint,
  selectedToken?: Token,
  fuel?: FuelParams,
): Promise<void> {
  const l1TokenAddress = selectedToken?.l1TokenContract ?? ''
  // When fuel is enabled, user approves BridgeAndFuel (which pulls totalAmount).
  // Otherwise, user approves TokenPortal directly.
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
  attestation?: PochAttestationData
  passportAttestation?: PassportAttestationData
}): Promise<DepositTxResult> {
  const {
    l1Address, aztecAddress, amount, claimSecretHash, claimSecret,
    isPrivacyModeEnabled, operationId, selectedToken, fuel, attestation, passportAttestation,
  } = params

  let txHash: any
  const l1PortalAddress = selectedToken?.l1PortalContract ?? ''

  if (isPrivacyModeEnabled) {
    // ── Private path: depositToAztecPrivate with POCH or Passport attestation (no fuel) ──
    const cleanHandsData = attestation
      ? { nonce: BigInt(attestation.nonce), actionId: BigInt(attestation.actionId), signature: attestation.l1Signature as `0x${string}` }
      : { nonce: 0n, actionId: 0n, signature: '0x' as `0x${string}` }
    const passportData = passportAttestation
      ? { maxAmount: BigInt(passportAttestation.maxAmount), nonce: BigInt(passportAttestation.nonce), deadline: BigInt(passportAttestation.deadline), signature: passportAttestation.l1Signature as `0x${string}` }
      : { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` }

    console.log('[L1→L2] Sending private deposit tx to portal:', l1PortalAddress, 'amount:', amount.toString(), 'hasAttestation:', !!attestation, 'hasPassport:', !!passportAttestation)
    const bridgeData = encodeFunctionData({
      abi: CustomTokenPortalAbi,
      functionName: 'depositToAztecPrivate',
      args: [
        amount,
        claimSecretHash.toString(),
        cleanHandsData,
        passportData,
      ],
    })

    txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
      { from: l1Address as `0x${string}`, to: l1PortalAddress, data: bridgeData },
    ])
  } else if (fuel) {
    // ── Public + Fuel path: BridgeAndFuel.bridgeWithFuel ──
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
          tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
          fuelSecretHash: fuel.fuelSecretHash.toString() as `0x${string}`,
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
  } else {
    // ── Public path: depositToAztecPublic ──
    console.log('[L1→L2] Sending public deposit tx to portal:', l1PortalAddress, 'amount:', amount.toString())
    const bridgeData = encodeFunctionData({
      abi: CustomTokenPortalAbi,
      functionName: 'depositToAztecPublic',
      args: [aztecAddress as `0x${string}`, amount, claimSecretHash.toString()],
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
  await patchOperationWithRetry(operationId, { l1TxHash, l1TxUrl }, { label: 'l1TxHash' })

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

  if (fuel) {
    // ── Fuel path: extract BridgeWithFuel event from BridgeAndFuel contract ──
    // Find the BridgeWithFuel event log by decoding
    let bridgeWithFuelLog: any = null
    for (const log of txReceipt.logs) {
      if (log.address.toLowerCase() !== BRIDGE_AND_FUEL_ADDRESS.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: BridgeAndFuelAbi,
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
    })

    updateLocalStorageItem(
      LS_KEY_BRIDGE_DEPOSITS,
      (c: any) => c.l1Address === l1Address && c.status === BridgeOperationStatus.pending,
      (c: any) => ({
        ...c,
        messageHash: messageHashStr,
        messageLeafIndex: messageLeafIndexStr,
        fuelMessageHash: fuelMessageHashStr,
        fuelMessageLeafIndex: fuelMessageLeafIndexStr,
        fuelAmount: fuelAmountReceived.toString(),
      }),
    )

    // Also extract amountAfterFee from the portal's DepositToAztecPublic event
    // (BridgeAndFuel calls the portal internally, which emits this event with the post-fee amount)
    const portalLogs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: txReceipt.logs })
    const portalDepositEvent: any = portalLogs.find((l: any) => l.eventName === 'DepositToAztecPublic')
    const amountAfterFee = portalDepositEvent?.args?.amount != null
      ? BigInt(portalDepositEvent.args.amount.toString())
      : undefined

    return {
      l1TxHash, l1TxUrl, messageHashStr, messageLeafIndexStr,
      messageHash: args.tokenKey, messageLeafIndex: args.tokenIndex,
      fuelMessageHashStr, fuelMessageLeafIndexStr,
      fuelMessageHash: args.fuelKey, fuelMessageLeafIndex: args.fuelIndex,
      fuelAmount: fuelAmountReceived,
      amountAfterFee,
    }
  }

  // ── Standard path: extract DepositToAztecPublic/Private from custom TokenPortal ──
  // Use parseEventLogs with the custom ABI (includes `fee` field in events)
  const eventName = isPrivacyModeEnabled
    ? 'DepositToAztecPrivate'
    : 'DepositToAztecPublic'

  const parsedLogs = parseEventLogs({ abi: CustomTokenPortalAbi, logs: txReceipt.logs })
  const depositEvent: any = parsedLogs.find((l: any) => l.eventName === eventName)

  if (!depositEvent) {
    throw new Error(`${eventName} event not found in transaction receipt`)
  }

  const messageHash = depositEvent.args.key
  const messageLeafIndex = depositEvent.args.index
  const messageHashStr = messageHash.toString()
  const messageLeafIndexStr = messageLeafIndex.toString()
  console.log('[L1→L2] Event extracted:', {
    eventName,
    messageHash: messageHashStr,
    messageLeafIndex: messageLeafIndexStr,
    amountAfterFee: depositEvent.args.amount?.toString(),
    fee: depositEvent.args.fee?.toString(),
  })

  updateLocalStorageItem(
    LS_KEY_BRIDGE_DEPOSITS,
    (c: any) => c.l1Address === l1Address && c.status === BridgeOperationStatus.pending,
    (c: any) => ({ ...c, messageHash: messageHashStr, messageLeafIndex: messageLeafIndexStr }),
  )
  console.log('messageHash and messageLeafIndex stored immediately after receipt')

  // The event's `amount` field is already the amount after fee deduction
  const amountAfterFee = depositEvent.args.amount != null
    ? BigInt(depositEvent.args.amount.toString())
    : undefined

  return { l1TxHash, l1TxUrl, messageHashStr, messageLeafIndexStr, messageHash, messageLeafIndex, amountAfterFee }
}

// ─── Step 6: Persist receipt data to backend ─────────────────────────

export async function persistReceiptToBackend(
  operationId: string | undefined,
  receiptData: {
    messageHashStr: string
    messageLeafIndexStr: string
    l1TxHash: string
    l1TxUrl: string
    // Fuel fields (present when BridgeAndFuel path used)
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
  // Include fuel fields if present (BridgeAndFuel path)
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
  fuelMessageHash?: string
  fuelMessageLeafIndex?: string
  fuelAmount?: string
}): { updatedClaim: any; wasExisting: boolean } {
  const {
    claimSecret, claimSecretHash, claimAmount, l1Address, aztecAddress,
    messageHashStr, messageLeafIndexStr, l1TxHash, l1TxUrl,
    l1BlockNumberBeforeTx, nodeInfo, isPrivacyModeEnabled,
    fuelMessageHash, fuelMessageLeafIndex, fuelAmount,
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
    ...(fuelMessageHash ? { fuelMessageHash } : {}),
    ...(fuelMessageLeafIndex ? { fuelMessageLeafIndex } : {}),
    ...(fuelAmount ? { fuelAmount } : {}),
  }
  claims.push(updatedClaim)
  localStorage.setItem(LS_KEY_BRIDGE_DEPOSITS, JSON.stringify(claims))
  return { updatedClaim, wasExisting: false }
}
