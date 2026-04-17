/**
 * L1→L2 bridge orchestrator.
 *
 * Extracts all deposit logic from the frontend hooks into a pure,
 * framework-agnostic module. All React/browser dependencies are
 * replaced with injected callbacks and config objects.
 *
 * Frontend step mapping (5-step UI):
 *   Step 1: Validate + generate secret + approve + send L1 deposit + extract receipt
 *   Step 2: Poll for L1→L2 message sync
 *   Step 3: Execute L2 claim
 *   Step 4: Complete (success animation)
 *   Step 5: Done
 */

import { Fr } from '@aztec/aztec.js/fields'
import { computeSecretHash } from '@aztec/stdlib/hash'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TestERC20Abi } from '@aztec/l1-artifacts'
import { extractEvent } from '@aztec/ethereum/utils'
import { encodeFunctionData, decodeEventLog, parseUnits, keccak256, encodeAbiParameters } from 'viem'
import { CustomTokenPortalAbi } from '../contracts/abis/CustomTokenPortalAbi'

import type { BridgeApiClient } from '../api'
import {
  patchOperationWithRetry,
  patchOperationAsync,
  createOperation,
} from '../operations'
import {
  createSigningMessage,
  deriveEncryptionKey,
  encryptData,
} from '../encryption'
import { SwapBridgeRouterAbi } from '../contracts/abis/SwapBridgeRouterAbi'
import type {
  ResolvedConfig,
  BridgeL1ToL2Params,
  BridgeResult,
  L2ClaimDeps,
  L2ClaimResult,
  BridgeEventCallback,
} from '../types'

// ─── Permit2 Constants ──────────────────────────────────────────────

const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const

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

/** Permit2 SignatureTransfer params returned from signing step. */
interface Permit2Params {
  nonce: bigint
  deadline: bigint
  signature: `0x${string}`
}

/**
 * Sign a Permit2 witness-bound SignatureTransfer via signTypedData.
 */
async function signPermit2Transfer(params: {
  signTypedData: (address: string, typedDataJson: string) => Promise<string>
  l1Address: string
  swapBridgeRouterAddress: string
  l1ChainId: number
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
}): Promise<Permit2Params> {
  const {
    signTypedData,
    swapBridgeRouterAddress,
    l1ChainId,
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

  // Random unordered nonce -- any unused uint256 works with Permit2
  const nonceBytes = new Uint8Array(32)
  crypto.getRandomValues(nonceBytes)
  const nonce = BigInt('0x' + Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join(''))

  // 30-minute deadline
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)

  const domain = {
    name: 'Permit2',
    chainId: l1ChainId,
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
        [poolKeys as any, zeroForOnes as any],
      ))
    : zeroBytes32Route

  const message = {
    permitted: {
      token: bridgeToken,
      amount: totalAmount.toString(),
    },
    spender: swapBridgeRouterAddress,
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

  const typedData = {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ...BRIDGE_WITNESS_TYPE,
    },
    primaryType: 'PermitWitnessTransferFrom' as const,
    domain,
    message,
  }

  const signature = await signTypedData(params.l1Address, JSON.stringify(typedData)) as `0x${string}`
  return { nonce, deadline, signature }
}
import { createL1PublicClient, serializeNodeInfo, wait, extractErrorString } from './utils'
import { getEtherscanUrl as getEtherscanBaseUrl, getAztecscanUrl as getAztecscanBaseUrl } from '../config'
import { pollL1ToL2MessageSync, waitForNextL2Block } from './polling'
import { pushDeposit, updateDeposit } from '../storage'
import { fetchAttestationsForDeposit } from '../attestation'

// ─── L2 Claim Execution ─────────────────────────────────────────────

/**
 * Execute claim_public or claim_private on L2.
 *
 * If messageLeafIndex is provided: retry up to maxAttempts on "nonexistent message".
 * If messageLeafIndex is null: brute-force indices 0..bruteForceMaxIndex.
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
    walletTimeoutMs?: number
    onAttempt?: (attempt: number, maxAttempts: number) => void
    onRetry?: (attempt: number, maxAttempts: number, retryDelayMs: number) => void
    feeOption?: { fee: { paymentMethod: any } }
  },
): Promise<L2ClaimResult> {
  const { walletAdapter, aztecAddress, isPrivacyModeEnabled } = deps
  const { amount, claimSecret, messageLeafIndex } = params
  const maxAttempts = options?.maxAttempts ?? 10
  const retryDelayMs = options?.retryDelayMs ?? 120_000
  const bruteForceMaxIndex = options?.bruteForceMaxIndex ?? 64
  const walletTimeoutMs = options?.walletTimeoutMs ?? 5 * 60_000 // 5 min default

  const method = isPrivacyModeEnabled ? 'claim_private' : 'claim_public'

  /** Race the wallet call against a timeout so we never hang forever. */
  const callWithTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'Wallet did not respond in time. Check for a hidden wallet popup behind your browser window.',
              ),
            ),
          walletTimeoutMs,
        ),
      ),
    ])

  if (messageLeafIndex != null) {
    let result: { txHash: string } | undefined
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        options?.onAttempt?.(attempt, maxAttempts)
        result = await callWithTimeout(
          walletAdapter.executeCall(
            walletAdapter.bridgeAddress,
            method,
            [
              AztecAddress.fromString(aztecAddress),
              amount,
              claimSecret,
              messageLeafIndex,
            ],
            { contractType: 'bridge', ...options?.feeOption },
          ),
        )
        break
      } catch (err) {
        // Don't retry user rejections — they are intentional
        const errMsg = err instanceof Error ? err.message : String(err)
        const errLower = errMsg.toLowerCase()
        const errCode = (err as any)?.code
        const isUserRejection =
          errCode === 4001 ||
          errLower.includes('user rejected') ||
          errLower.includes('user denied') ||
          errLower.includes('action_rejected') ||
          errLower.includes('user cancelled')
        if (isUserRejection) throw err

        // Non-transient errors that should surface immediately rather than retry
        if (errLower.includes('message already consumed') || errLower.includes('already been consumed')) {
          throw new Error('This deposit has already been claimed.')
        }
        if (
          errLower.includes('capability scope') ||
          errLower.includes('not in capability') ||
          errLower.includes('permission denied')
        ) {
          throw new Error(`Wallet permission error: ${errMsg}`)
        }

        // Retry on transient errors — the claim is idempotent
        // (reorgs, block header not found, message not synced, PXE lag, network errors, etc.)
        if (attempt < maxAttempts) {
          options?.onRetry?.(attempt, maxAttempts, retryDelayMs)
          await wait(retryDelayMs)
          continue
        }
        throw err
      }
    }
    return { l2TxHash: result!.txHash, usedBruteForce: false }
  } else {
    // Brute-force path — only catch index-miss errors, re-throw everything else
    for (let idx = 0; idx < bruteForceMaxIndex; idx++) {
      try {
        const result = await callWithTimeout(
          walletAdapter.executeCall(
            walletAdapter.bridgeAddress,
            method,
            [
              AztecAddress.fromString(aztecAddress),
              amount,
              claimSecret,
              BigInt(idx),
            ],
            { contractType: 'bridge', ...options?.feeOption },
          ),
        )
        return {
          l2TxHash: result.txHash,
          usedBruteForce: true,
          bruteForceLeafIndex: idx,
        }
      } catch (bruteErr) {
        const msg = bruteErr instanceof Error ? bruteErr.message : String(bruteErr)
        // Only swallow "wrong index" errors — re-throw network/wallet/unexpected errors
        const isIndexMiss =
          msg.includes('nonexistent L1-to-L2 message') ||
          msg.includes('l1_to_l2_msg_exists') ||
          msg.includes('message not found') ||
          msg.includes('does not match')
        if (!isIndexMiss) {
          throw bruteErr
        }
        // Wrong index — try next
      }
    }
    throw new Error(
      `Could not find correct messageLeafIndex after trying 0–${bruteForceMaxIndex - 1}. ` +
        'The L1→L2 message may not be synced to L2 yet. Try again later.',
    )
  }
}

// ─── Main L1→L2 Bridge Orchestrator ─────────────────────────────────

/**
 * Execute a full L1→L2 bridge operation.
 *
 * Frontend UI steps:
 *   1: Validate + secret + approve + L1 deposit + receipt
 *   2: Poll for L1→L2 message sync
 *   3: Execute L2 claim
 *   4: Complete (success animation)
 *   5: Done
 */
export async function bridgeL1ToL2(
  config: ResolvedConfig,
  apiClient: BridgeApiClient,
  aztecNode: any,
  domain: string,
  params: BridgeL1ToL2Params,
): Promise<BridgeResult> {
  const {
    token: tokenOrSymbol,
    amount: amountStr,
    l1Address,
    l2Address,
    isPrivate,
    fuel,
    fuelQuote,
    sendTransaction,
    walletAdapter,
    signMessage,
    signTypedData,
    onStep,
    onEvent,
  } = params

  const emit: BridgeEventCallback = onEvent ?? (() => {})

  // Resolve token
  const tokenConfig = config.tokens.find(
    (t) =>
      t.symbol.toLowerCase() === tokenOrSymbol.toLowerCase() ||
      `c${t.symbol}`.toLowerCase() === tokenOrSymbol.toLowerCase() ||
      t.l1TokenContract.toLowerCase() === tokenOrSymbol.toLowerCase(),
  )
  if (!tokenConfig) {
    throw new Error(`Unknown token: ${tokenOrSymbol}`)
  }

  // Use parseUnits instead of parseFloat to avoid floating-point precision loss
  const amount = parseUnits(amountStr, tokenConfig.decimals)
  if (amount === 0n) {
    throw new Error('Amount must be greater than zero')
  }
  const publicClient = createL1PublicClient(config)

  // 🔒 Track whether L1 deposit has been confirmed (funds are locked on L1).
  // If true, the outer catch must NEVER mark the operation as 'failed' — it stays
  // 'deposited' so the user can Resume the L2 claim from the activity page.
  let depositConfirmed = false
  // Track whether the L1 tx was sent (l1TxHash known). Between tx submission and
  // receipt confirmation, funds MAY be at risk (tx could be mining).
  let l1TxSent = false
  let operationId: number | undefined

  try {
    // ── Step 1: Validate + generate secret + approve + deposit + receipt ──
    onStep?.(1, 'active')

    if (!l1Address || !l2Address) throw new Error('Required accounts not connected')
    if (!walletAdapter) throw new Error('Aztec wallet not connected')

    // Validate l2Address is a valid 0x-prefixed 32-byte hex string
    if (!/^0x[0-9a-fA-F]{64}$/.test(l2Address)) {
      throw new Error(`Invalid L2 address format: expected 0x + 64 hex chars, got ${l2Address.slice(0, 20)}...`)
    }

    let nodeInfo: any
    try {
      nodeInfo = await aztecNode.getNodeInfo()
    } catch (err) {
      throw new Error('Could not get Aztec node info. Please check your connection and try again.')
    }
    const l1Addresses = nodeInfo?.l1ContractAddresses ?? null
    if (!l1Addresses?.outboxAddress?.toString()) {
      throw new Error('L1 contract addresses not initialized')
    }

    let l1BlockNumberBeforeTx: string
    try {
      l1BlockNumberBeforeTx = (await publicClient.getBlockNumber()).toString()
    } catch (err) {
      throw new Error('Could not get L1 block number. Please check your connection and try again.')
    }

    let l2BlockNumberBeforeTx: string
    try {
      l2BlockNumberBeforeTx = (await aztecNode.getBlockNumber()).toString()
    } catch (err) {
      throw new Error('Could not get L2 block number. Please check your connection and try again.')
    }

    // Generate claim secret
    const claimSecret = Fr.random()
    const claimSecretHash = await computeSecretHash(claimSecret)
    const nodeInfoSnapshot = serializeNodeInfo(nodeInfo)

    // Deterministic encryption
    const keyDerivationDomain = domain
    const signingMessage = createSigningMessage(l1Address, keyDerivationDomain)
    const signature = await signMessage(signingMessage)
    if (!signature) throw new Error('Failed to sign message for encryption key derivation')
    const encryptionKey = await deriveEncryptionKey(l1Address, signature, keyDerivationDomain)

    // Generate fuel secrets if applicable
    let fuelSecret: Fr | undefined
    let fuelSecretHash: Fr | undefined
    if (fuel?.enabled) {
      fuelSecret = Fr.random()
      fuelSecretHash = await computeSecretHash(fuelSecret)
    }

    const payloadToEncrypt: Record<string, unknown> = {
      claimSecret: claimSecret.toString(),
      claimSecretHash: claimSecretHash.toString(),
      amount: amount.toString(),
      l1Address,
      l2Address,
      isPrivacyModeEnabled: isPrivate,
      l1BlockNumberBeforeTx,
      nodeInfo: nodeInfoSnapshot,
    }
    if (fuelSecret && fuelSecretHash) {
      payloadToEncrypt.fuelSecret = fuelSecret.toString()
      payloadToEncrypt.fuelSecretHash = fuelSecretHash.toString()
      // Store fuel amount so resume can compute claimAmount = amount - fuelAmountTokenUnits
      payloadToEncrypt.fuelAmount = fuel?.amount ?? '0'
      if (tokenConfig.decimals != null) payloadToEncrypt.fuelDecimals = tokenConfig.decimals
    }

    const encrypted = await encryptData(JSON.stringify(payloadToEncrypt), encryptionKey)

    // Only emit hashes and encrypted payload — never plaintext secrets.
    // Any consumer that logs events (Datadog, Sentry) would expose secrets otherwise.
    emit({
      type: 'secrets_generated',
      claimSecretHash: claimSecretHash.toString(),
      fuelSecretHash: fuelSecretHash?.toString(),
      encryptedPayload: encrypted,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx,
      nodeInfo: nodeInfoSnapshot ?? {},
    })

    const snapshotRollupVersion = nodeInfoSnapshot?.rollupVersion as number | undefined
    const snapshotL1ChainId = nodeInfoSnapshot?.l1ChainId as number | undefined
    const snapshotL1Addresses = nodeInfoSnapshot?.l1ContractAddresses as Record<string, string> | undefined

    // Use token name fields correctly (pairedSymbol/title)
    const tokenSymbolL1 = tokenConfig.pairedSymbol ?? tokenConfig.symbol
    const tokenSymbolL2 = `c${tokenConfig.symbol}`
    const tokenNameL1 = tokenConfig.pairedSymbol ?? tokenConfig.symbol
    const tokenNameL2 = tokenConfig.title ?? `Clean ${tokenConfig.symbol}`

    const operationData = {
      encryptedCiphertext: encrypted.ciphertext,
      encryptedIv: encrypted.iv,
      encryptedTag: encrypted.tag,
      keyDerivationMessage: signingMessage,
      keyDerivationDomain,
      direction: 'L1_TO_L2',
      l1Address,
      l2Address,
      amountL1: amount.toString(),
      amountL2: amount.toString(),
      amountDisplayL1: amountStr,
      amountDisplayL2: amountStr,
      isPrivacyModeEnabled: isPrivate,
      l1BlockNumberBeforeTx,
      l2BlockNumberBeforeTx,
      nodeInfo: nodeInfoSnapshot,
      rollupVersion: snapshotRollupVersion,
      chainIdL1: snapshotL1ChainId ?? config.l1ChainId,
      chainIdL2: config.l2ChainId,
      portalAddressL1: tokenConfig.l1PortalContract,
      bridgeAddressL2: tokenConfig.l2BridgeContract,
      l1RollupAddress: snapshotL1Addresses?.rollupAddress,
      l1OutboxAddress: snapshotL1Addresses?.outboxAddress,
      l1InboxAddress: snapshotL1Addresses?.inboxAddress,
      l1RegistryAddress: snapshotL1Addresses?.registryAddress,
      tokenSymbol: tokenSymbolL1,
      tokenSymbolL1,
      tokenSymbolL2,
      tokenNameL1,
      tokenNameL2,
      tokenAddressL1: tokenConfig.l1TokenContract,
      tokenAddressL2: tokenConfig.l2TokenContract,
      tokenDecimalsL1: tokenConfig.decimals,
      tokenDecimalsL2: tokenConfig.decimals,
      tokenLogoUrlL1: tokenConfig.logo || undefined,
      tokenLogoUrlL2: tokenConfig.logo || undefined,
      currentStep: 1,
    }

    // Create operation BEFORE localStorage push so we have operationId.
    // If the server backup fails, abort BEFORE any L1 transaction to prevent fund loss.
    try {
      const createResult = await createOperation(apiClient, operationData)
      operationId = createResult.operationId
    } catch (backupErr) {
      const detail = backupErr instanceof Error ? backupErr.message : String(backupErr)
      throw new Error(
        `Failed to backup claim secret to server. Bridge aborted to prevent fund loss. (${detail})`,
      )
    }

    emit({ type: 'operation_created', operationId, data: operationData })

    // localStorage push with ALL fields matching frontend (including id, timestamp, etc.)
    pushDeposit({
      id: operationId,
      operationId,
      encryptedCiphertext: encrypted.ciphertext,
      encryptedIv: encrypted.iv,
      encryptedTag: encrypted.tag,
      keyDerivationMessage: signingMessage,
      keyDerivationDomain,
      l1Address,
      l2Address,
      l1BlockNumberBeforeTx,
      isPrivacyModeEnabled: isPrivate,
      tokenSymbol: tokenConfig.symbol,
      hasFuel: fuel?.enabled ?? false,
      amount: amount.toString(),
      amountDisplay: amountStr,
      claimAmount: amount.toString(),
      claimSecretHash: claimSecretHash.toString(),
      messageHash: null as string | null,
      messageLeafIndex: null as string | null,
      timestamp: Date.now(),
      success: false,
      l1TxHash: null as string | null,
      l1TxUrl: null as string | null,
      nodeInfo: nodeInfoSnapshot,
      fuelAmount: fuel?.enabled ? fuel.amount : undefined,
      status: 'pending',
    })

    // Resolve fuel amount in token units (needed for Permit2 witness + tx encoding).
    // Fuel is carved OUT of `amount` (not additive): the SwapBridgeRouter pulls
    // `amount` from the user, sends `fuelAmount` through the swap, and forwards
    // `amount - fuelAmount` to the token portal. So `fuelAmount` must be < `amount`.
    const isFuelEnabled = fuel?.enabled && fuelSecretHash && fuelQuote
    const fuelAmountTokenUnits = isFuelEnabled ? parseUnits(fuel!.amount, tokenConfig.decimals) : 0n

    if (fuel?.enabled && !fuelQuote) {
      throw new Error('fuel.enabled is true but fuelQuote was not provided. Use getUniswapFuelQuote() to generate one.')
    }
    if (isFuelEnabled && fuelAmountTokenUnits >= amount) {
      throw new Error(
        `Fuel amount (${fuel!.amount}) must be strictly less than bridge amount — fuel is carved out, not additive.`,
      )
    }

    // Check and approve allowance for Permit2 (one-time per token).
    // All deposits go through SwapBridgeRouter with Permit2 — approve the
    // canonical Permit2 contract with max uint256 (one-time).
    const spender = PERMIT2_ADDRESS
    const totalApprovalNeeded = amount

    const allowance = await publicClient.readContract({
      address: tokenConfig.l1TokenContract as `0x${string}`,
      abi: TestERC20Abi,
      functionName: 'allowance',
      args: [l1Address as `0x${string}`, spender as `0x${string}`],
    })

    if (BigInt(allowance as bigint) < totalApprovalNeeded) {
      const approveData = encodeFunctionData({
        abi: TestERC20Abi,
        functionName: 'approve',
        args: [spender as `0x${string}`, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
      })

      const approveTxHash = await sendTransaction({
        from: l1Address,
        to: tokenConfig.l1TokenContract,
        data: approveData,
      })

      await publicClient.waitForTransactionReceipt({ hash: approveTxHash as `0x${string}` })
    }

    // Send L1 deposit transaction — all paths go through SwapBridgeRouter with Permit2
    let txHash: string
    const zeroBytes32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`

    // Fetch attestation for private deposits (both fuel and standard paths)
    let cleanHandsData = { nonce: 0n, signature: '0x' as `0x${string}` }
    let passportData = { maxAmount: 0n, nonce: 0n, deadline: 0n, signature: '0x' as `0x${string}` }
    if (isPrivate) {
      const { cleanHands: attestCleanHands, passport: attestPassport } =
        await fetchAttestationsForDeposit(apiClient, tokenConfig.l1PortalContract, amount, tokenConfig.decimals, emit)
      cleanHandsData = {
        nonce: attestCleanHands.nonce,
        signature: attestCleanHands.signature as `0x${string}`,
      }
      passportData = {
        maxAmount: attestPassport.maxAmount,
        nonce: attestPassport.nonce,
        deadline: attestPassport.deadline,
        signature: attestPassport.signature as `0x${string}`,
      }
    }

    if (isFuelEnabled) {
      // ── Fuel path: call SwapBridgeRouter.bridgeWithFuel via Permit2 ──
      // `totalAmount` is what gets pulled from the user; `fuelAmount` is carved
      // out of it by the router for the swap. Must match main's semantics so the
      // Permit2 witness hash (which binds totalAmount) validates on-chain.
      const totalAmount = amount

      // Sign Permit2 witness-bound transfer
      const permit2 = await signPermit2Transfer({
        signTypedData,
        l1Address,
        swapBridgeRouterAddress: config.swapBridgeRouterAddress,
        l1ChainId: config.l1ChainId,
        tokenPortal: tokenConfig.l1PortalContract as `0x${string}`,
        bridgeToken: tokenConfig.l1TokenContract as `0x${string}`,
        totalAmount,
        fuelAmount: fuelAmountTokenUnits,
        aztecRecipient: l2Address as `0x${string}`,
        fuelRecipient: l2Address as `0x${string}`,
        tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
        fuelSecretHash: fuelSecretHash!.toString() as `0x${string}`,
        minFuelOutput: fuelQuote!.minOutput,
        poolKeys: (fuelQuote!.poolKeys ?? []) as any,
        zeroForOnes: fuelQuote!.zeroForOnes ?? [],
        isPrivate,
      })

      const bridgeData = encodeFunctionData({
        abi: SwapBridgeRouterAbi,
        functionName: 'bridgeWithFuel',
        args: [
          {
            tokenPortal: tokenConfig.l1PortalContract as `0x${string}`,
            bridgeToken: tokenConfig.l1TokenContract as `0x${string}`,
            totalAmount,
            fuelAmount: fuelAmountTokenUnits,
            aztecRecipient: l2Address as `0x${string}`,
            fuelRecipient: l2Address as `0x${string}`,
            tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
            fuelSecretHash: fuelSecretHash!.toString() as `0x${string}`,
            minFuelOutput: fuelQuote!.minOutput,
            path: (fuelQuote!.poolKeys ?? []) as any,
            zeroForOnes: fuelQuote!.zeroForOnes ?? [],
            isPrivate,
            cleanHands: cleanHandsData,
            passport: passportData,
          },
          {
            nonce: permit2.nonce,
            deadline: permit2.deadline,
            signature: permit2.signature,
          },
        ],
      })

      txHash = await sendTransaction({
        from: l1Address,
        to: config.swapBridgeRouterAddress,
        data: bridgeData,
      })
    } else {
      // ── Standard path: call SwapBridgeRouter.bridge via Permit2 ──

      // Sign Permit2 witness-bound transfer (no fuel — zero fields)
      const permit2 = await signPermit2Transfer({
        signTypedData,
        l1Address,
        swapBridgeRouterAddress: config.swapBridgeRouterAddress,
        l1ChainId: config.l1ChainId,
        tokenPortal: tokenConfig.l1PortalContract as `0x${string}`,
        bridgeToken: tokenConfig.l1TokenContract as `0x${string}`,
        totalAmount: amount,
        fuelAmount: 0n,
        aztecRecipient: l2Address as `0x${string}`,
        fuelRecipient: zeroBytes32,
        tokenSecretHash: claimSecretHash.toString() as `0x${string}`,
        fuelSecretHash: zeroBytes32,
        minFuelOutput: 0n,
        poolKeys: [],
        zeroForOnes: [],
        isPrivate,
      })

      const bridgeData = encodeFunctionData({
        abi: SwapBridgeRouterAbi,
        functionName: 'bridge',
        args: [
          {
            tokenPortal: tokenConfig.l1PortalContract as `0x${string}`,
            bridgeToken: tokenConfig.l1TokenContract as `0x${string}`,
            amount,
            aztecRecipient: l2Address as `0x${string}`,
            secretHash: claimSecretHash.toString() as `0x${string}`,
            isPrivate,
            cleanHands: cleanHandsData,
            passport: passportData,
          },
          {
            nonce: permit2.nonce,
            deadline: permit2.deadline,
            signature: permit2.signature,
          },
        ],
      })

      txHash = await sendTransaction({
        from: l1Address,
        to: config.swapBridgeRouterAddress,
        data: bridgeData,
      })
    }

    const l1TxHash = typeof txHash === 'string' ? txHash : String(txHash)
    l1TxSent = true
    const l1TxUrl = `${getEtherscanBaseUrl(config.l1ChainId)}/tx/${l1TxHash}`

    emit({ type: 'deposit_sent', l1TxHash, l1TxUrl })

    // Persist l1TxHash to localStorage immediately (before backend patch).
    // Pass a fallback entry so that if the original pushDeposit entry was lost
    // (e.g., localStorage cleared between steps), a new entry is created for recovery.
    updateDeposit(
      (c: any) => c.id === operationId,
      (c: any) => ({ ...c, l1TxHash, l1TxUrl }),
      {
        id: operationId,
        operationId,
        l1TxHash,
        l1TxUrl,
        l1Address,
        l2Address,
        claimSecretHash: claimSecretHash.toString(),
        isPrivacyModeEnabled: isPrivate,
        tokenSymbol: tokenConfig.symbol,
        hasFuel: fuel?.enabled ?? false,
        timestamp: Date.now(),
        status: 'deposited',
      },
    )

    const l1TxPatchOk = await patchOperationWithRetry(apiClient, operationId, { l1TxHash, l1TxUrl }, { label: 'l1TxHash' })
    if (!l1TxPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'l1TxHash', data: { l1TxHash, l1TxUrl } })
    }

    // Wait for receipt — only AFTER receipt confirms do we know funds are locked.
    // Add 5-minute timeout matching the resume path.
    const txReceipt = await publicClient.waitForTransactionReceipt({
      hash: l1TxHash as `0x${string}`,
      timeout: 300_000, // 5 minutes
    })

    // 🔒 Check receipt status BEFORE setting depositConfirmed.
    // A reverted tx means funds were NOT locked — the catch block should mark as 'failed'.
    if (txReceipt.status === 'reverted') {
      throw new Error(
        `L1 deposit transaction reverted on-chain (hash: ${txReceipt.transactionHash}). ` +
        `No funds were locked. You can retry the deposit.`
      )
    }

    // 🔒 Only set depositConfirmed AFTER confirming the tx succeeded on-chain.
    depositConfirmed = true

    // Extract message hash + leaf index from receipt
    let messageHashStr: string
    let messageLeafIndexStr: string
    let fuelMessageHashStr: string | undefined
    let fuelMessageLeafIndexStr: string | undefined
    let fuelAmountReceived: bigint | undefined
    let amountAfterFee: bigint | undefined

    if (isFuelEnabled) {
      // ── Fuel path: extract BridgeWithFuel event from SwapBridgeRouter contract ──
      let bridgeWithFuelLog: any = null
      for (const log of txReceipt.logs) {
        if (log.address.toLowerCase() !== config.swapBridgeRouterAddress.toLowerCase()) continue
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
      messageHashStr = args.tokenKey.toString()
      messageLeafIndexStr = args.tokenIndex.toString()
      fuelMessageHashStr = args.fuelKey.toString()
      fuelMessageLeafIndexStr = args.fuelIndex.toString()
      fuelAmountReceived = args.fuelAmount as bigint

      // Also extract amountAfterFee from the portal's DepositToAztecPublic event.
      // SwapBridgeRouter calls the portal internally, which emits this event with the post-fee amount.
      try {
        const portalLog = extractEvent(
          txReceipt.logs,
          tokenConfig.l1PortalContract as `0x${string}`,
          CustomTokenPortalAbi,
          'DepositToAztecPublic',
          (log: any) => log.args.secretHash?.toString() === claimSecretHash.toString(),
        )
        amountAfterFee = portalLog.args.amount as bigint
      } catch (e) {
        // Non-fatal — fall back to using `amount` for the claim.
        // Log because if the secretHash filter missed, the claim may use the wrong amount.
        console.warn('[SDK L1→L2] Could not extract amountAfterFee from portal event — using original amount for claim:', e)
      }
    } else {
      // ── Standard path: extract DepositToAztec event from TokenPortal ──
      // IMPORTANT: Use CustomTokenPortalAbi, NOT the upstream @aztec/l1-artifacts TokenPortalAbi.
      // Our deployed TokenPortal has a `fee` field in its events that changes the event signature
      // (different keccak256 hash). The standard ABI would never match these events.
      const eventName = isPrivate ? 'DepositToAztecPrivate' : 'DepositToAztecPublic'

      // Coerce both sides to string for safe comparison — viem may decode
      // event args as bigint or 0x-hex while Fr.toString() may produce a different format.
      const privateEventFilter = (log: any) =>
        log.args.secretHash?.toString() === claimSecretHash.toString()

      const publicEventFilter = (log: any) =>
        log.args.secretHash?.toString() === claimSecretHash.toString() &&
        log.args.to?.toString() === l2Address

      const eventFilter = isPrivate ? privateEventFilter : publicEventFilter

      const log = extractEvent(
        txReceipt.logs,
        tokenConfig.l1PortalContract as `0x${string}`,
        CustomTokenPortalAbi,
        eventName,
        eventFilter,
      )

      messageHashStr = log.args.key.toString()
      messageLeafIndexStr = log.args.index.toString()

      // The custom portal deducts fees before creating the L2 message.
      // The `amount` in the event is the POST-FEE amount — use it for the L2 claim.
      amountAfterFee = log.args.amount as bigint
    }

    emit({
      type: 'deposit_confirmed',
      l1TxHash,
      l1TxUrl,
      messageHash: messageHashStr,
      messageLeafIndex: messageLeafIndexStr,
      fuelMessageHash: fuelMessageHashStr,
      fuelMessageLeafIndex: fuelMessageLeafIndexStr,
      fuelAmount: fuelAmountReceived?.toString(),
    })

    // Persist deposit receipt data to localStorage with status: 'deposited'
    updateDeposit(
      (c: any) => c.id === operationId,
      (c: any) => ({
        ...c,
        messageHash: messageHashStr,
        messageLeafIndex: messageLeafIndexStr,
        l1TxHash,
        l1TxUrl,
        status: 'deposited',
        ...(fuelMessageHashStr ? { fuelMessageHash: fuelMessageHashStr } : {}),
        ...(fuelMessageLeafIndexStr ? { fuelMessageLeafIndex: fuelMessageLeafIndexStr } : {}),
        ...(fuelAmountReceived != null ? { fuelAmount: fuelAmountReceived.toString() } : {}),
        ...(amountAfterFee != null ? { amountAfterFee: amountAfterFee.toString() } : {}),
      }),
    )

    // Persist receipt to backend
    // l1TxHash/l1TxUrl already sent in the earlier PATCH — don't re-send to avoid redundant overwrites.
    const receiptPatchData: Record<string, unknown> = {
      status: 'deposited',
      messageHash: messageHashStr,
      messageLeafIndex: messageLeafIndexStr,
      l1BlockNumber: txReceipt.blockNumber != null ? String(txReceipt.blockNumber) : undefined,
      currentStep: 2,
    }
    if (fuelMessageHashStr) receiptPatchData.fuelMessageHash = fuelMessageHashStr
    if (fuelMessageLeafIndexStr) receiptPatchData.fuelMessageLeafIndex = fuelMessageLeafIndexStr
    if (fuelAmountReceived != null) receiptPatchData.fuelAmount = fuelAmountReceived.toString()
    if (amountAfterFee != null) receiptPatchData.amountAfterFee = amountAfterFee.toString()

    const receiptPatchOk = await patchOperationWithRetry(apiClient, operationId, receiptPatchData, { label: 'receipt data' })
    if (!receiptPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'receipt data', data: { messageHash: messageHashStr, messageLeafIndex: messageLeafIndexStr } })
    }

    onStep?.(1, 'completed')

    // ── Step 2: Poll for L1→L2 message sync ──
    onStep?.(2, 'active')

    // Poll for both messages in parallel when fuel is enabled
    const syncPromises: Promise<any>[] = [
      pollL1ToL2MessageSync(aztecNode, messageHashStr),
    ]
    if (fuelMessageHashStr) {
      syncPromises.push(pollL1ToL2MessageSync(aztecNode, fuelMessageHashStr))
    }
    const syncResults = await Promise.all(syncPromises)
    const syncResult = syncResults[0]
    const fuelSyncResult = syncResults[1]

    emit({ type: 'sync_poll', elapsedMinutes: syncResult.elapsedMinutes, synced: syncResult.synced })

    if (!syncResult.synced) {
      throw new Error(
        `L1-to-L2 message sync timeout after ${syncResult.elapsedMinutes.toFixed(1)} minutes. You can try resuming later.`,
      )
    }

    // Check fuel message sync too — if fuel didn't sync, the claim will fail
    if (fuelSyncResult && !fuelSyncResult.synced) {
      throw new Error(
        `Fuel message sync timeout after ${fuelSyncResult.elapsedMinutes.toFixed(1)} minutes. You can try resuming later.`,
      )
    }

    // Wait for the sequencer to include the L1→L2 message in a new L2 block.
    // The archiver checkpoint appears quickly, but the message is only consumable
    // after the sequencer includes it in an L2 block (can take up to ~1 epoch on testnet).
    await waitForNextL2Block(aztecNode)

    onStep?.(2, 'completed')

    // ── Step 3: Execute L2 claim ──
    onStep?.(3, 'active')
    patchOperationAsync(apiClient, operationId, { currentStep: 3 })

    // Build fee payment method if fuel is enabled
    let feeOption: { fee: { paymentMethod: any } } | undefined
    if (isFuelEnabled && fuelSecret && fuelMessageLeafIndexStr && fuelAmountReceived) {
      const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')
      const paymentMethod = new FeeJuicePaymentMethodWithClaim(
        AztecAddress.fromString(l2Address),
        {
          claimAmount: fuelAmountReceived,
          claimSecret: fuelSecret,
          messageLeafIndex: BigInt(fuelMessageLeafIndexStr),
        },
      )
      feeOption = { fee: { paymentMethod } }
    }

    // When fuel is enabled, SwapBridgeRouter splits totalAmount into amount (token) + fuel.
    // The L2 claim is always for `amount` (the token portion).
    // For standard (non-fuel) deposits, the custom TokenPortal deducts fees before
    // creating the L2 message. The `amountAfterFee` extracted from the receipt event
    // is the actual amount in the L2 message — use it for the claim.
    const claimAmount = amountAfterFee ?? amount

    const claimResult = await executeL2Claim(
      { walletAdapter, aztecAddress: l2Address, isPrivacyModeEnabled: isPrivate },
      { amount: claimAmount, claimSecret, messageLeafIndex: BigInt(messageLeafIndexStr) },
      {
        onAttempt: (attempt, maxAttempts) => {
          emit({ type: 'claim_attempt', attempt, maxAttempts })
        },
        onRetry: (attempt, maxAttempts, delayMs) => {
          emit({ type: 'claim_retry', attempt, maxAttempts, delayMs })
        },
        feeOption,
      },
    )

    const l2TxHash = claimResult.l2TxHash
    const l2TxUrl = `${getAztecscanBaseUrl(config.l2ChainId)}/tx-effects/${l2TxHash}`

    // Persist brute-forced leaf index
    if (claimResult.usedBruteForce && claimResult.bruteForceLeafIndex != null) {
      patchOperationAsync(apiClient, operationId, {
        messageLeafIndex: claimResult.bruteForceLeafIndex.toString(),
      })
    }

    // Poll for L2 block number from claim receipt (best-effort, non-blocking for completion)
    let l2ClaimBlockNumber: string | undefined
    try {
      for (let i = 0; i < 15; i++) {
        const l2Receipt = await aztecNode.getTxReceipt(l2TxHash as any)
        if (l2Receipt?.blockNumber != null) {
          l2ClaimBlockNumber = String(l2Receipt.blockNumber)
          break
        }
        await wait(2000)
      }
      if (!l2ClaimBlockNumber) {
        console.warn('[SDK L1→L2] Could not get L2 claim block number after 15 attempts — will be null in DB')
      }
    } catch (err) {
      console.warn('[SDK L1→L2] Could not get L2 claim block number:', err)
    }

    // Mark as completed on server (retry — critical for DB consistency)
    const completionData: Record<string, unknown> = {
      status: 'completed',
      l2TxHash,
      l2TxUrl,
      completedAt: new Date().toISOString(),
      currentStep: 4,
    }
    if (l2ClaimBlockNumber) completionData.l2BlockNumber = l2ClaimBlockNumber
    const completionPatchOk = await patchOperationWithRetry(apiClient, operationId, completionData, { label: 'L1→L2 completion' })
    if (!completionPatchOk) {
      emit({ type: 'patch_failed', operationId: operationId!, label: 'L1→L2 completion', data: { l2TxHash, status: 'completed' } })
    }

    onStep?.(3, 'completed')

    // ── Step 4: Complete ──
    onStep?.(4, 'active')

    emit({ type: 'operation_completed', operationId, l1TxHash, l2TxHash })

    // Mark localStorage entry as completed with URL fields
    updateDeposit(
      (c: any) => c.id === operationId,
      (c: any) => ({
        ...c,
        success: true,
        status: 'completed',
        l2TxHash,
        l2TxUrl,
        l1TxUrl,
        completedAt: Date.now(),
      }),
    )

    // Token registration after successful bridge
    if (walletAdapter?.registerToken) {
      try {
        await walletAdapter.registerToken(tokenConfig.l2TokenContract)
      } catch {
        // Non-critical — token will still appear after refresh
      }
    }

    await wait(3000)
    onStep?.(4, 'completed')

    return { operationId, l1TxHash, l2TxHash, l1TxUrl, l2TxUrl }
  } catch (error) {
    // 🔒 CRITICAL: Only mark as 'failed' if no funds are at risk.
    // If deposit was confirmed OR l1TxHash was sent (tx may be mining),
    // status stays 'deposited'/'pending' so user can Resume from Activity page.
    const err = error instanceof Error ? error : new Error(extractErrorString(error))
    const errorMessage = err.message

    // Funds may be at risk if deposit confirmed OR tx was broadcast
    const fundsAtRisk = depositConfirmed || l1TxSent
    emit({ type: 'error', error: err, fundsAtRisk, operationId })

    if (operationId) {
      const patchData: Record<string, unknown> = {
        lastErrorMessage: errorMessage.slice(0, 500),
      }
      // Only mark 'failed' if no tx was sent — otherwise the tx may still mine
      if (!depositConfirmed && !l1TxSent) {
        patchData.status = 'failed'
      }
      // Await retry so 'failed' status persists to DB before the throw
      await patchOperationWithRetry(apiClient, operationId, patchData, { label: 'error status' })
    }

    throw error
  }
}

