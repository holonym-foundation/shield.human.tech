/**
 * L2→L1 bridge operations: shared witness/withdraw + withdrawal step functions.
 *
 * Shared (used by main hook, resume hook, and recover hook):
 *   - computeL2ToL1MessageLeaf
 *   - computeWitness
 *   - waitForBlockProven
 *   - executeL1Withdraw
 *
 * Withdrawal steps (used only by useL2WithdrawTokensToL1):
 *   - validateAndCaptureBlocksL2  (step 1)
 *   - encryptAndBackupWithdrawalNonce  (step 2)
 *   - executeBurnAndExit  (step 3)
 *   - persistBurnReceiptAndPollBlock  (step 4)
 *   - fetchNodeInfoAndComputeWitness  (step 5)
 */

import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { EthAddress } from "@aztec/foundation/eth-address";
import { sha256ToField } from "@aztec/foundation/crypto/sha256";
import { computeL2ToL1MessageHash } from "@aztec/stdlib/hash";
import { computeL2ToL1MembershipWitness } from "@aztec/stdlib/messaging";
import { TxHash } from "@aztec/stdlib/tx";
import { TokenPortalAbi, RollupAbi } from "@aztec/l1-artifacts";
import { toFunctionSelector, encodeFunctionData } from "viem";
import { BridgeDirection, BridgeOperationStatus } from "@prisma/client";
import { aztecNode } from "@/aztec";
import {
  getAztecscanUrl,
  L1_CHAIN_ID,
  L1_CONTRACT_ADDRESSES,
  L2_CHAIN_ID,
} from "@/config";
import type { Token } from "@/types/bridge";
import { wait, serializeNodeInfo } from "@/utils";
import { logInfo } from "@/utils/datadog";
import { api } from "@/lib/api";
import {
  getKeyDerivationDomain,
  createSigningMessage,
  deriveEncryptionKey,
  encryptData,
} from "@/utils/encryption";
import { requestWaapWallet, WAAP_METHOD } from "@/stores/walletStore";
import {
  type BridgeLogContext,
  LS_KEY_BRIDGE_WITHDRAWALS,
  publicClient,
  patchOperationWithRetry,
  updateLocalStorageItem,
  pushToLocalStorageArray,
  getL1TxUrl,
} from "./bridgeUtils";

// ─── Shared Types ───────────────────────────────────────────────────

export interface WitnessResult {
  leafIndex: string;
  siblingPath: string[];
  /** The epoch number used for the witness. */
  epoch: bigint | number;
}

export interface L1WithdrawResult {
  l1TxHash: string;
  l1TxUrl: string;
}

// ─── Attestation for Private Withdrawals ─────────────────────────────

/** Attestation data for L2 private exit (Schnorr signature). */
export interface L2PochAttestation {
  l2Signature: number[];
  nonce: number;
  actionId: string;
}

/** Passport attestation data for L2 private exit (Schnorr signature). */
export interface L2PassportAttestation {
  l2Signature: number[];
  nonce: number;
  maxAmount: string;
  deadline: string;
}

/**
 * Fetch a POCH attestation from the backend for use in exit_to_l1_private.
 * The API returns both L1 (ECDSA) and L2 (Schnorr) signatures — we only need the L2 one here.
 */
export async function fetchL2PochAttestation(
  portalAddress: string,
): Promise<L2PochAttestation> {
  const res = await api.post("/api/attestation/poch", { portalAddress });
  const data = res.data as {
    l2Signature: number[];
    nonce: number;
    actionId: string;
  };
  return {
    l2Signature: data.l2Signature,
    nonce: data.nonce,
    actionId: data.actionId,
  };
}

/**
 * Fetch a Passport attestation from the backend for use in exit_to_l1_private.
 * Requires bridgeAddress for L2 Schnorr signing.
 */
export async function fetchL2PassportAttestation(
  portalAddress: string,
  bridgeAddress: string,
): Promise<L2PassportAttestation> {
  const res = await api.post("/api/attestation/passport", {
    portalAddress,
    bridgeAddress,
  });
  const data = res.data as {
    l2Signature: number[];
    nonce: number;
    maxAmount: string;
    deadline: string;
  };
  return {
    l2Signature: data.l2Signature,
    nonce: data.nonce,
    maxAmount: data.maxAmount,
    deadline: data.deadline,
  };
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: Message Leaf Computation
// ═════════════════════════════════════════════════════════════════════

/**
 * Compute the L2-to-L1 message leaf hash from withdrawal parameters.
 * Pure computation — no network calls.
 */
export function computeL2ToL1MessageLeaf(params: {
  l1Recipient: string;
  amount: bigint;
  l2BridgeAddress: string;
  portalAddress: string;
  rollupVersion: number;
  chainId: number;
}): Fr {
  const {
    l1Recipient,
    amount,
    l2BridgeAddress,
    portalAddress,
    rollupVersion,
    chainId,
  } = params;

  const selectorBuf = Buffer.from(
    toFunctionSelector("withdraw(address,uint256,address)").slice(2),
    "hex",
  );
  const recipient = EthAddress.fromString(l1Recipient);
  const callerOnL1 = EthAddress.ZERO;
  const content = sha256ToField([
    selectorBuf,
    recipient.toBuffer32(),
    new Fr(amount).toBuffer(),
    callerOnL1.toBuffer32(),
  ]);

  return computeL2ToL1MessageHash({
    l2Sender: AztecAddress.fromString(l2BridgeAddress),
    l1Recipient: EthAddress.fromString(portalAddress),
    content,
    rollupVersion: new Fr(rollupVersion),
    chainId: new Fr(chainId),
  });
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: Membership Witness Computation
// ═════════════════════════════════════════════════════════════════════

/**
 * Compute L2-to-L1 membership witness (leaf index + sibling path) for a message.
 *
 * Uses `computeL2ToL1MembershipWitness(node, message, txHash)` which internally
 * resolves the block/epoch from the tx receipt.
 */
export async function computeWitness(
  blockNumber: number,
  msgLeaf: Fr,
  rollupAddress: string,
  l2TxHash?: string,
): Promise<WitnessResult> {
  console.log(
    "[L2→L1] Computing L2→L1 membership witness (block=",
    blockNumber,
    ", txHash=",
    l2TxHash,
    ")...",
  );

  if (!l2TxHash) {
    throw new Error(
      "l2TxHash is required for computing L2→L1 membership witness in SDK 4.2+",
    );
  }

  const txHash = TxHash.fromString(l2TxHash);

  // Retry — the epoch proof may not be available yet
  const maxRetries = 5;
  const retryDelayMs = 30_000;
  let witness:
    | Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>>
    | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      witness = await computeL2ToL1MembershipWitness(
        aztecNode,
        msgLeaf,
        txHash,
      );
      if (witness) break;
      if (attempt < maxRetries) {
        console.warn(
          `[L2→L1] Witness not found (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs / 1000}s...`,
        );
        await wait(retryDelayMs);
      }
    } catch (err) {
      if (attempt < maxRetries) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[L2→L1] computeL2ToL1MembershipWitness failed (attempt ${attempt}/${maxRetries}), retrying in ${retryDelayMs / 1000}s...`,
          msg,
        );
        await wait(retryDelayMs);
        continue;
      }
      throw err;
    }
  }

  if (!witness) {
    throw new Error(
      `L2→L1 message not found (block ${blockNumber}, txHash ${l2TxHash}). The block may not be finalized yet, or the message leaf does not match.`,
    );
  }

  const epoch = witness.epochNumber;

  const leafIndex =
    typeof witness.leafIndex === "bigint"
      ? witness.leafIndex.toString()
      : String(witness.leafIndex);

  const siblingPath = witness.siblingPath
    .toBufferArray()
    .map((buf: Buffer) => `0x${buf.toString("hex")}`);

  console.log(
    "[L2→L1] Witness ready: leafIndex=",
    leafIndex,
    "siblingPath length=",
    siblingPath.length,
    "epoch=",
    String(epoch),
  );

  return { leafIndex, siblingPath, epoch };
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: Block Proven Polling
// ═════════════════════════════════════════════════════════════════════

/**
 * Poll L1 Rollup.getProvenCheckpointNumber() until our L2 block is proven.
 * Falls back to a fixed wait if rollupAddress is unavailable or polling fails.
 */
export async function waitForBlockProven(params: {
  blockNumberForProof: number;
  rollupAddress: string | null | undefined;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  fixedFallbackMs?: number;
  /** Called each time we poll and the block is not yet proven. */
  onPoll?: (
    provenBlock: number,
    neededBlock: number,
    elapsedMs: number,
  ) => void;
  /** Called when we fall back to the fixed wait (no rollup address or poll failed). */
  onFallback?: (fixedWaitMs: number) => void;
}): Promise<{ proven: boolean; usedPoll: boolean }> {
  const {
    blockNumberForProof,
    rollupAddress,
    pollIntervalMs = 120_000,
    maxWaitMs = 50 * 60 * 1000,
    fixedFallbackMs = 40 * 60 * 1000,
    onPoll,
    onFallback,
  } = params;

  let blockProven = false;
  let usedPoll = false;

  if (rollupAddress) {
    try {
      usedPoll = true;
      const startWait = Date.now();
      console.log(
        "[L2→L1] Polling L1 Rollup for proven block (need block=",
        blockNumberForProof,
        ")...",
      );
      while (Date.now() - startWait < maxWaitMs) {
        const proven = await publicClient.readContract({
          address: rollupAddress as `0x${string}`,
          abi: RollupAbi,
          functionName: "getProvenCheckpointNumber",
        });
        const provenBlock =
          typeof proven === "bigint" ? Number(proven) : (proven as number);
        if (provenBlock >= blockNumberForProof) {
          console.log(
            "[L2→L1] Block",
            blockNumberForProof,
            "proven on L1 (proven=",
            provenBlock,
            ")",
          );
          blockProven = true;
          break;
        }
        console.log(
          "[L2→L1] Not yet proven (proven=",
          provenBlock,
          ", need=",
          blockNumberForProof,
          "). Waiting...",
        );
        onPoll?.(provenBlock, blockNumberForProof, Date.now() - startWait);
        await wait(pollIntervalMs);
      }
      if (!blockProven) {
        // Block is confirmed NOT proven after exhaustive polling — do NOT proceed.
        // Sending an L1 withdraw would burn gas on a guaranteed revert.
        throw new Error(
          "[L2→L1] Block not yet proven after max wait. " +
            "The L1 withdraw would revert. Please resume later when the block is proven.",
        );
      }
    } catch (e) {
      // If the block was confirmed unproven (our own timeout error), propagate it.
      // Only swallow transient RPC errors (getProvenCheckpointNumber call failures).
      if (
        e instanceof Error &&
        e.message.includes("Block not yet proven after max wait")
      ) {
        throw e;
      }
      console.warn("[L2→L1] Rollup poll failed, using fixed wait:", e);
      usedPoll = false;
    }
  }

  if (!blockProven && !usedPoll) {
    console.log(
      "[L2→L1] Using fixed",
      fixedFallbackMs / 60_000,
      "min wait for block finalization...",
    );
    onFallback?.(fixedFallbackMs);
    await wait(fixedFallbackMs);
  }

  return { proven: blockProven, usedPoll };
}

// ═════════════════════════════════════════════════════════════════════
// SHARED: L1 Withdraw Transaction
// ═════════════════════════════════════════════════════════════════════

/**
 * Encode and send the withdraw transaction on L1 TokenPortal, wait for confirmation.
 */
export async function executeL1Withdraw(params: {
  l1Address: string;
  amount: bigint;
  /** Epoch number (converted from block number via L1 Rollup). */
  epoch: bigint;
  leafIndex: string;
  siblingPath: string[];
  portalAddress?: string;
}): Promise<L1WithdrawResult> {
  const { l1Address, amount, epoch, leafIndex, siblingPath, portalAddress } =
    params;

  const siblingPathHex = siblingPath.map((s) => s as `0x${string}`);

  console.log(
    "[L2→L1] Sending L1 withdraw tx (recipient=",
    l1Address,
    "amount=",
    amount.toString(),
    "epoch=",
    epoch.toString(),
    ")...",
  );

  const withdrawCallData = encodeFunctionData({
    abi: TokenPortalAbi,
    functionName: "withdraw",
    args: [
      l1Address as `0x${string}`,
      amount,
      false, // _withCaller
      epoch,
      BigInt(leafIndex),
      siblingPathHex,
    ],
  });

  console.log(
    "[L2→L1] L1 withdraw tx encoded, sending to portal:",
    portalAddress,
  );
  const l1WithdrawTxHash = await requestWaapWallet(
    WAAP_METHOD.eth_sendTransaction,
    [
      {
        from: l1Address,
        to: portalAddress,
        data: withdrawCallData,
      },
    ],
  );

  console.log(
    "[L2→L1] L1 withdraw tx sent:",
    l1WithdrawTxHash,
    "— waiting for confirmation...",
  );
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: l1WithdrawTxHash,
  });
  console.log(
    "[L2→L1] L1 withdraw tx confirmed:",
    receipt.transactionHash,
    "status:",
    receipt.status,
  );

  if (receipt.status === "reverted") {
    throw new Error(
      `L1 withdraw transaction reverted: ${receipt.transactionHash}. ` +
        "The block may not be proven yet or the proof is invalid. Retry via Resume later.",
    );
  }

  const l1TxHash = receipt.transactionHash.toString();
  const l1TxUrl = getL1TxUrl(l1TxHash);

  return { l1TxHash, l1TxUrl };
}

// ═════════════════════════════════════════════════════════════════════
// WITHDRAWAL STEPS (useL2WithdrawTokensToL1 only)
// ═════════════════════════════════════════════════════════════════════

// ─── Step Result Types ──────────────────────────────────────────────

export interface CaptureBlocksL2Result {
  l1BlockNumberBeforeTx: string;
  l2BlockNumberBeforeTx: number;
  nodeInfoSnapshot: Record<string, unknown>;
}

export interface WithdrawalBackupResult {
  operationId: string;
  nonce: Fr;
  l2BridgeAddress: string;
}

export interface BurnExitResult {
  l2TxHash: string;
  l2BlockNumber: number | undefined;
}

export interface BurnReceiptResult {
  blockNumberForProof: number;
  l2TxUrl: string;
  l2TxHashPatchOk: boolean;
}

export interface WitnessComputeResult {
  leafIndex: string;
  siblingPath: string[];
  rollupAddress: string | undefined;
  /** Epoch number (converted from block number). Used for L1 withdraw. */
  epoch: bigint;
  witnessPatchOk: boolean;
}

// ─── Step 1: Validate wallets and capture block numbers + nodeInfo ──

/**
 * Validate wallets, capture current L1/L2 block numbers and node info.
 * Optionally emits the "initiated" log when logContext is provided.
 */
export async function validateAndCaptureBlocksL2(
  l1Address: string,
  aztecAddress: string,
  walletAdapter: any,
  logContext?: BridgeLogContext & { amount: string },
  selectedToken?: Token,
): Promise<CaptureBlocksL2Result> {
  if (!l1Address || !aztecAddress) {
    throw new Error("Required accounts not connected");
  }
  if (!walletAdapter) {
    throw new Error("Aztec wallet not connected or contracts not initialized");
  }

  // Capture L1 block
  let l1BlockNumberBeforeTx: string;
  try {
    const l1Block = await publicClient.getBlockNumber();
    l1BlockNumberBeforeTx = l1Block.toString();
    console.log("[L2→L1] Current L1 block before tx:", l1BlockNumberBeforeTx);
  } catch (e) {
    console.warn("[L2→L1] Could not get current L1 block number before tx:", e);
    throw new Error(
      "Could not get L1 block number. Please check your connection and try again. Required for recovery.",
    );
  }

  // Capture L2 block
  let l2BlockNumberBeforeTx: number;
  try {
    l2BlockNumberBeforeTx = await aztecNode.getBlockNumber();
    console.log("[L2→L1] Current L2 block before tx:", l2BlockNumberBeforeTx);
  } catch (e) {
    console.warn("[L2→L1] Could not get current L2 block number before tx:", e);
    throw new Error(
      "Could not get L2 block number. Please check your connection and try again. Required for recovery.",
    );
  }
  if (l2BlockNumberBeforeTx == null) {
    throw new Error(
      "L2 block number is required before sending the transaction (recovery).",
    );
  }

  // Get nodeInfo
  let nodeInfoSnapshot: Record<string, unknown>;
  try {
    const nodeInfoForTx = await aztecNode.getNodeInfo();
    nodeInfoSnapshot = serializeNodeInfo(nodeInfoForTx) as Record<
      string,
      unknown
    >;
  } catch (e) {
    console.warn("[L2→L1] Could not get node info before tx:", e);
    throw new Error(
      "Could not get Aztec node info. Please check your connection and try again. Required for recovery.",
    );
  }
  if (nodeInfoSnapshot?.rollupVersion == null) {
    throw new Error(
      "Rollup version is required before sending the transaction (recovery).",
    );
  }

  // Log "initiated" if context provided
  if (logContext) {
    logInfo("Withdrawal from L2 to L1 initiated", {
      ...logContext,
      direction: BridgeDirection.L2_TO_L1,
      fromNetwork: "Aztec",
      toNetwork: "Ethereum",
      fromToken: selectedToken?.symbol ?? "cUSDC",
      toToken: selectedToken?.pairedSymbol ?? "USDC",
      l1Address,
      l2Address: aztecAddress,
      l2BlockNumberBeforeTx: l2BlockNumberBeforeTx ?? null,
      userAction: "withdrawal_l2_to_l1_initiated",
    });
  }

  return { l1BlockNumberBeforeTx, l2BlockNumberBeforeTx, nodeInfoSnapshot };
}

// ─── Step 2: Encrypt nonce and backup to server ─────────────────────

/**
 * Generate random nonce, encrypt with deterministic key, POST to server,
 * and store in localStorage. MUST succeed before burn+exit.
 */
export async function encryptAndBackupWithdrawalNonce(params: {
  l1Address: string;
  aztecAddress: string;
  amountL1: string;
  amountL2: string;
  amountDisplayL1: string;
  amountDisplayL2: string;
  isPrivacyModeEnabled: boolean;
  l1BlockNumberBeforeTx: string;
  l2BlockNumberBeforeTx: number;
  nodeInfoSnapshot: Record<string, unknown>;
  selectedToken?: Token;
}): Promise<WithdrawalBackupResult> {
  const {
    l1Address,
    aztecAddress,
    amountL1,
    amountL2,
    amountDisplayL1,
    amountDisplayL2,
    isPrivacyModeEnabled,
    l1BlockNumberBeforeTx,
    l2BlockNumberBeforeTx,
    nodeInfoSnapshot,
    selectedToken,
  } = params;

  const nonce = Fr.random();
  const l2BridgeAddress = selectedToken?.l2BridgeContract ?? "";
  const portalAddressL1 = selectedToken?.l1PortalContract ?? "";

  // Deterministic encryption: same wallet + same message = same key
  const signingMessage = createSigningMessage(l1Address);
  const keyDerivationDomain = getKeyDerivationDomain();
  const signature = (await requestWaapWallet(WAAP_METHOD.personal_sign, [
    signingMessage,
    l1Address,
  ])) as string;

  const encryptionKey = await deriveEncryptionKey(
    l1Address,
    signature,
    keyDerivationDomain,
  );

  const secretsPayload = JSON.stringify({
    nonce: nonce.toString(),
    amount: amountL2,
    l1Address,
    l2Address: aztecAddress,
    l2BridgeAddress,
    portalAddressL1,
    isPrivacyModeEnabled,
  });
  const encrypted = await encryptData(secretsPayload, encryptionKey);

  // Extract recovery-critical fields from nodeInfo
  const snapshotRollupVersion = nodeInfoSnapshot?.rollupVersion as
    | number
    | undefined;
  const snapshotL1ChainId = nodeInfoSnapshot?.l1ChainId as number | undefined;
  const snapshotL1Addresses = nodeInfoSnapshot?.l1ContractAddresses as
    | Record<string, string>
    | undefined;

  console.log("[L2→L1] POST /api/bridge/operations →", {
    direction: "L2_TO_L1",
    amountL1,
    l1BlockNumberBeforeTx,
    l2BlockNumberBeforeTx,
    rollupVersion: snapshotRollupVersion,
    chainIdL1: snapshotL1ChainId ?? L1_CHAIN_ID,
    portalAddressL1,
    bridgeAddressL2: l2BridgeAddress,
    isPrivacyModeEnabled,
    hasEncrypted: !!encrypted.ciphertext,
    hasNodeInfo: !!nodeInfoSnapshot,
  });

  const postResponse = await api.post("/api/bridge/operations", {
    encryptedCiphertext: encrypted.ciphertext,
    encryptedIv: encrypted.iv,
    encryptedTag: encrypted.tag,
    keyDerivationMessage: signingMessage,
    keyDerivationDomain,
    direction: "L2_TO_L1",
    l1Address,
    l2Address: aztecAddress,
    amountL1,
    amountL2,
    amountDisplayL1,
    amountDisplayL2,
    isPrivacyModeEnabled,
    l1BlockNumberBeforeTx: l1BlockNumberBeforeTx ?? undefined,
    l2BlockNumberBeforeTx:
      l2BlockNumberBeforeTx != null ? String(l2BlockNumberBeforeTx) : undefined,
    recipientL1Address: l1Address,
    nodeInfo: nodeInfoSnapshot,
    rollupVersion: snapshotRollupVersion,
    chainIdL1: snapshotL1ChainId ?? L1_CHAIN_ID,
    chainIdL2: L2_CHAIN_ID,
    portalAddressL1,
    bridgeAddressL2: l2BridgeAddress,
    l1RollupAddress: snapshotL1Addresses?.rollupAddress,
    l1OutboxAddress: snapshotL1Addresses?.outboxAddress,
    l1InboxAddress: snapshotL1Addresses?.inboxAddress,
    l1RegistryAddress: snapshotL1Addresses?.registryAddress,
    tokenSymbol: selectedToken?.pairedSymbol ?? selectedToken?.symbol ?? "USDC",
    tokenSymbolL1: selectedToken?.pairedSymbol ?? "USDC",
    tokenSymbolL2: selectedToken?.symbol ?? "cUSDC",
    tokenNameL1: selectedToken?.pairedSymbol ?? "USDC",
    tokenNameL2:
      selectedToken?.title ?? `Clean ${selectedToken?.pairedSymbol ?? "USDC"}`,
    tokenAddressL1: selectedToken?.l1TokenContract ?? "",
    tokenAddressL2: selectedToken?.l2TokenContract ?? "",
    tokenDecimalsL1: selectedToken?.decimals ?? 6,
    tokenDecimalsL2: selectedToken?.decimals ?? 6,
    currentStep: 1,
  });

  const operationId = postResponse.data?.operationId;
  if (!operationId) {
    throw new Error(
      "Withdrawal aborted: server did not return operationId. No funds at risk.",
    );
  }
  console.log(
    "[L2→L1] Encrypted nonce backed up (operationId:",
    operationId,
    ")",
  );

  // Secondary: localStorage backup (secrets stored encrypted only — never plaintext)
  pushToLocalStorageArray(LS_KEY_BRIDGE_WITHDRAWALS, {
    id: operationId,
    operationId,
    l2BridgeAddress,
    portalAddressL1,
    timestamp: Date.now(),
    amount: amountL2,
    l1Address,
    l2Address: aztecAddress,
    encryptedCiphertext: encrypted.ciphertext,
    encryptedIv: encrypted.iv,
    encryptedTag: encrypted.tag,
    keyDerivationDomain,
    success: false,
    status: BridgeOperationStatus.pending,
    l2TxHash: null as string | null,
    l2BlockNumber: null as string | null,
    l2BlockNumberBeforeTx:
      l2BlockNumberBeforeTx != null
        ? String(l2BlockNumberBeforeTx)
        : (null as string | null),
    nodeInfo: nodeInfoSnapshot,
    l2TxUrl: null as string | null,
    l2ToL1MessageIndex: null as string | null,
    siblingPath: null as string[] | null,
  });

  return { operationId, nonce, l2BridgeAddress };
}

// ─── Step 3: Execute burn + exit on L2 ──────────────────────────────

/**
 * Send burn+exit transaction on L2 (private or public).
 * After this succeeds, tokens are burned — the operation must NOT be marked 'failed'.
 */
export async function executeBurnAndExit(params: {
  walletAdapter: any;
  l1Address: string;
  aztecAddress: string;
  amount: bigint;
  nonce: Fr;
  isPrivacyModeEnabled: boolean;
  /** POCH attestation for private withdrawals (l2Signature + nonce/actionId) */
  attestation?: { l2Signature: number[]; nonce: number; actionId: string };
  /** Passport attestation for private withdrawals (fallback when POCH unavailable) */
  passportAttestation?: L2PassportAttestation;
}): Promise<BurnExitResult> {
  const {
    walletAdapter,
    l1Address,
    aztecAddress,
    amount,
    nonce,
    isPrivacyModeEnabled,
    attestation,
    passportAttestation,
  } = params;
  const userAddress = AztecAddress.fromString(aztecAddress);

  console.log(
    "[L2→L1] Sending burn+exit tx:",
    isPrivacyModeEnabled ? "PRIVATE" : "PUBLIC",
    "amount:",
    amount.toString(),
    "recipient:",
    l1Address,
    "hasPassport:",
    !!passportAttestation,
  );

  let result: { txHash: string; blockNumber?: number };
  if (isPrivacyModeEnabled) {
    // Build CleanHandsData from POCH attestation (or empty if none)
    const cleanHandsData = attestation
      ? {
          nonce: BigInt(attestation.nonce),
          action_id: BigInt(attestation.actionId),
          signature: attestation.l2Signature,
        }
      : { nonce: 0n, action_id: 0n, signature: new Array(64).fill(0) };
    // Build PassportData from Passport attestation (or empty if none)
    const passportData = passportAttestation
      ? {
          max_amount: BigInt(passportAttestation.maxAmount),
          nonce: BigInt(passportAttestation.nonce),
          deadline: BigInt(passportAttestation.deadline),
          signature: passportAttestation.l2Signature,
        }
      : {
          max_amount: 0n,
          nonce: 0n,
          deadline: 0n,
          signature: new Array(64).fill(0),
        };
    result = await walletAdapter.executeWithdrawToL1Private(
      l1Address,
      amount,
      nonce,
      cleanHandsData,
      passportData,
      userAddress,
    );
  } else {
    result = await walletAdapter.executeWithdrawToL1Public(
      l1Address,
      amount,
      nonce,
      userAddress,
    );
  }

  const l2TxHash = result.txHash;
  const l2BlockNumber: number | undefined = result.blockNumber;

  console.log(
    "[L2→L1] L2 exit tx sent, hash:",
    l2TxHash,
    "blockNumber:",
    l2BlockNumber,
  );

  return { l2TxHash, l2BlockNumber };
}

// ─── Step 4: Persist burn receipt and poll for block number ─────────

/**
 * PATCH l2TxHash to server, poll for L2 block number if missing,
 * wait for block visibility, then PATCH l2BlockNumber.
 */
export async function persistBurnReceiptAndPollBlock(params: {
  operationId: string;
  l2TxHash: string;
  l2BlockNumber: number | undefined;
}): Promise<BurnReceiptResult> {
  const { operationId, l2TxHash } = params;
  let { l2BlockNumber } = params;

  const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`;

  // PATCH l2TxHash to server (3 retries — critical for recovery)
  console.log("[L2→L1] PATCH l2TxHash →", {
    operationId,
    status: "submitted",
    l2TxHash,
    currentStep: 2,
  });
  const l2TxHashPatchOk = await patchOperationWithRetry(
    operationId,
    {
      status: "submitted",
      l2TxHash,
      l2TxUrl,
      currentStep: 2,
    },
    { label: "l2TxHash" },
  );

  // Poll for block number if adapter didn't return it
  if (l2BlockNumber == null) {
    console.log(
      "[L2→L1] Polling for L2 block number (required for L1 withdraw leaf index)...",
    );
    for (let i = 0; i < 60; i++) {
      await wait(2000);
      const receipt = await aztecNode.getTxReceipt(
        l2TxHash as unknown as Parameters<typeof aztecNode.getTxReceipt>[0],
      );
      if (receipt?.blockNumber != null) {
        l2BlockNumber = receipt.blockNumber;
        console.log("[L2→L1] L2 block number from receipt:", l2BlockNumber);
        break;
      }
    }
  }

  // Final wait so the L2 block is visible on the wallet's node
  const finalWaitMs = 120_000;
  console.log(
    "[L2→L1] Final wait before continuing (",
    finalWaitMs / 1000,
    "s)...",
  );
  await wait(finalWaitMs);

  // Update localStorage with tx details
  updateLocalStorageItem(
    LS_KEY_BRIDGE_WITHDRAWALS,
    (w: any) => w.id === operationId,
    (w: any) => ({
      ...w,
      l2TxHash,
      l2TxUrl,
      l2BlockNumber: l2BlockNumber?.toString() ?? null,
      status: "submitted",
    }),
  );

  const blockNumberForProof = l2BlockNumber;
  if (blockNumberForProof == null || blockNumberForProof === 0) {
    throw new Error(
      "L2 block number is required for the withdrawal proof (leaf index and merkle path). Please wait for the L2 transaction to be confirmed and try again.",
    );
  }

  // PATCH l2BlockNumber to server (3 retries — needed for witness recomputation)
  console.log("[L2→L1] PATCH l2BlockNumber →", {
    operationId,
    l2BlockNumber: String(blockNumberForProof),
  });
  const blockPatchOk = await patchOperationWithRetry(
    operationId,
    {
      l2BlockNumber: String(blockNumberForProof),
    },
    { label: "l2BlockNumber" },
  );
  if (blockPatchOk) {
    console.log("[L2→L1] l2BlockNumber stored on backend");
  }

  return { blockNumberForProof, l2TxUrl, l2TxHashPatchOk };
}

// ─── Step 5: Fetch nodeInfo, compute witness, persist ───────────────

/**
 * Fetch nodeInfo + rollupVersion, compute L2→L1 message leaf and membership
 * witness, then persist to server and localStorage.
 */
export async function fetchNodeInfoAndComputeWitness(params: {
  operationId: string;
  l1Address: string;
  amount: bigint;
  l2BridgeAddress: string;
  blockNumberForProof: number;
  portalAddress?: string;
  l2TxHash?: string;
}): Promise<WitnessComputeResult> {
  const {
    operationId,
    l1Address,
    amount,
    l2BridgeAddress,
    blockNumberForProof,
    portalAddress,
    l2TxHash,
  } = params;

  // Get L1 addresses and rollup version from node
  console.log("[L2→L1] Fetching node info (rollupVersion, L1 addresses)...");
  const nodeInfo = await aztecNode.getNodeInfo();
  const l1Addresses = nodeInfo?.l1ContractAddresses ?? null;
  const rollupVersion = nodeInfo?.rollupVersion;
  console.log(
    "[L2→L1] Node info: rollupVersion=",
    rollupVersion,
    "blockNumberForProof=",
    blockNumberForProof,
  );
  if (rollupVersion == null) {
    throw new Error(
      "Rollup version not available from Aztec node. Cannot compute L2→L1 message leaf.",
    );
  }
  if (!l1Addresses?.outboxAddress) {
    throw new Error("L1 contract addresses not available from node.");
  }
  const rollupAddress =
    l1Addresses?.rollupAddress != null
      ? l1Addresses.rollupAddress.toString()
      : L1_CONTRACT_ADDRESSES.rollupAddress || undefined;

  if (!rollupAddress) {
    throw new Error(
      "Rollup address not available. Cannot convert block number to epoch for L2→L1 witness.",
    );
  }

  // Compute L2→L1 message leaf + membership witness
  const msgLeaf = computeL2ToL1MessageLeaf({
    l1Recipient: l1Address,
    amount,
    l2BridgeAddress,
    portalAddress: portalAddress ?? "",
    rollupVersion,
    chainId: L1_CHAIN_ID,
  });

  const witnessResult = await computeWitness(
    blockNumberForProof,
    msgLeaf,
    rollupAddress,
    l2TxHash,
  );
  const leafIndex = witnessResult.leafIndex;
  const siblingPath = witnessResult.siblingPath;
  const epoch = witnessResult.epoch;

  // Persist witness data to server (3 retries — critical for recovery)
  console.log("[L2→L1] PATCH witness →", {
    operationId,
    status: "ready",
    l2ToL1MessageIndex: leafIndex,
    siblingPathLen: siblingPath.length,
    currentStep: 3,
  });
  const witnessPatchOk = await patchOperationWithRetry(
    operationId,
    {
      status: "ready",
      l2ToL1MessageIndex: leafIndex,
      siblingPath,
      epoch: epoch != null ? Number(epoch) : undefined,
      currentStep: 3,
    },
    { label: "witness data" },
  );

  // Update localStorage with witness
  updateLocalStorageItem(
    LS_KEY_BRIDGE_WITHDRAWALS,
    (w: any) => w.id === operationId,
    (w: any) => ({
      ...w,
      l2ToL1MessageIndex: leafIndex,
      siblingPath,
      epoch: epoch != null ? Number(epoch) : undefined,
      status: "ready",
    }),
  );

  return {
    leafIndex,
    siblingPath,
    rollupAddress,
    epoch: BigInt(epoch),
    witnessPatchOk,
  };
}
