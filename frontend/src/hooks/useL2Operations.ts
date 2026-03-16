import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { aztecNode } from '@/aztec'
import {
  L1_CHAIN_ID,
  L1_CONTRACT_ADDRESSES,
  L1_TOKENS,
  L2_CHAIN_ID,
  L2_NODE_URL,
} from '@/config'
import { useBridgeStore } from '@/stores/bridgeStore'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits } from 'viem'
import { useToast, useToastMutation } from './useToast'
import { wait, exportWithdrawalData, copyToClipboard } from '@/utils'
import {
  createSigningMessage,
  deriveEncryptionKey,
  decryptData,
} from '@/utils/encryption'
import { useL2ErrorHandler } from '@/utils/l2ErrorHandler'
import { requestWaapWallet, WAAP_METHOD, useWalletStore } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import {
  LS_KEY_BRIDGE_WITHDRAWALS,
  patchOperationAsync,
  updateLocalStorageItem,
} from './bridge/bridgeUtils'
import {
  computeL2ToL1MessageLeaf,
  computeWitness,
  waitForBlockProven,
  executeL1Withdraw,
  validateAndCaptureBlocksL2,
  encryptAndBackupWithdrawalNonce,
  executeBurnAndExit,
  persistBurnReceiptAndPollBlock,
  fetchNodeInfoAndComputeWitness,
  fetchL2PochAttestation,
} from './bridge/bridgeL2ToL1'

// Define types for balance queries
export interface L2TokenBalanceData {
  publicBalance: string
  privateBalance: string
}

// -----------------------------------

export const useL2TokenBalance = () => {
  const { aztecAddress, isAztecConnected } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()
  const walletAdapter = useWalletAdapter()
  const { bridgeConfig } = useBridgeStore()

  // Use the selected L2 token's contract address and decimals
  const selectedL2Token = bridgeConfig.to.token
  const l2TokenAddress = selectedL2Token?.l2TokenContract ?? walletAdapter?.tokenAddress ?? ''
  const tokenDecimals = selectedL2Token?.decimals ?? 6

  // Create a stable query key that doesn't change with renders
  const queryKey = ['l2TokenBalance', aztecAddress, l2TokenAddress]

  // Query function without tracking state
  const queryFn = async (): Promise<L2TokenBalanceData> => {
    try {
      if (!aztecAddress) {
        throw new Error('Aztec address not found')
      }
      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized',
        )
      }

      const userAddress = AztecAddress.fromString(aztecAddress)

      // Single simulate_views call for both balances
      const tokenAddr = l2TokenAddress || walletAdapter.tokenAddress
      const [privateBalanceResult, publicBalanceResult] =
        await walletAdapter.simulateViews([
          {
            contract: tokenAddr,
            method: 'balance_of_private',
            args: [userAddress],
          },
          {
            contract: tokenAddr,
            method: 'balance_of_public',
            args: [userAddress],
          },
        ])

      const privateBalance = BigInt(privateBalanceResult.result.toString())
      const publicBalance = BigInt(publicBalanceResult.result.toString())

      const publicBalanceFormat = formatUnits(
        publicBalance,
        tokenDecimals,
      )
      const privateBalanceFormat = formatUnits(
        privateBalance,
        tokenDecimals,
      )

      return {
        publicBalance: publicBalanceFormat,
        privateBalance: privateBalanceFormat,
      }
    } catch (error) {
      handleL2Error<L2TokenBalanceData>(error, 'BALANCE')
      throw error
    }
  }

  // Use regular React Query instead of toast query
  return useQuery<L2TokenBalanceData, Error>({
    queryKey,
    queryFn,
    enabled: !!aztecAddress && !!walletAdapter,
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

const FEE_JUICE_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000005'
const FEE_JUICE_DECIMALS = 18

export const useL2FeeJuiceBalance = () => {
  const { aztecAddress } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()
  const walletAdapter = useWalletAdapter()

  const queryKey = ['l2FeeJuiceBalance', aztecAddress]

  const queryFn = async (): Promise<string> => {
    try {
      if (!aztecAddress) {
        throw new Error('Aztec address not found')
      }
      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized',
        )
      }

      const userAddress = AztecAddress.fromString(aztecAddress)

      const [publicBalanceResult] = await walletAdapter.simulateViews([
        {
          contract: FEE_JUICE_ADDRESS,
          method: 'balance_of_public',
          args: [userAddress],
        },
      ])

      const publicBalance = BigInt(publicBalanceResult.result.toString())
      return formatUnits(publicBalance, FEE_JUICE_DECIMALS)
    } catch (error) {
      handleL2Error<string>(error, 'BALANCE')
      throw error
    }
  }

  return useQuery<string, Error>({
    queryKey,
    queryFn,
    enabled: !!aztecAddress && !!walletAdapter,
    refetchInterval: 30_000,
  })
}

export function useL1ContractAddresses() {
  const { isAztecConnected } = useWalletStore()

  const queryKey = ['l1ContractAddresses']
  const queryFn = async () => {
    const info = await aztecNode.getNodeInfo()
    return info?.l1ContractAddresses ?? null
  }
  return useQuery({
    queryKey,
    queryFn,
    enabled: isAztecConnected,
  })
}

export function useL2NodeIsReady() {
  const { isAztecConnected } = useWalletStore()
  const queryKey = ['nodeIsReady']
  const queryFn = async () => {
    return await aztecNode.isReady()
  }
  return useQuery({
    queryKey,
    queryFn,
    enabled: isAztecConnected,
  })
}

/** Threshold in seconds — if the latest block is older than this, the network is considered down. */
const NETWORK_STALE_THRESHOLD_SECONDS = 300 // 5 minutes

/**
 * Checks whether the Aztec L2 network is alive by comparing the latest block's
 * timestamp to the current wall-clock time.
 *
 * Returns `{ isNetworkDown, timeSinceLastBlock }`.
 */
export function useNetworkHealth() {
  const queryKey = ['networkHealth']

  const queryFn = async () => {
    const header = await aztecNode.getBlockHeader('latest')
    if (!header) {
      return { isNetworkDown: true, timeSinceLastBlock: Infinity }
    }

    const blockTimestamp = Number(header.globalVariables.timestamp)
    const now = Math.floor(Date.now() / 1000)
    const timeSinceLastBlock = now - blockTimestamp

    console.log('[NetworkHealth]', {
      blockTimestamp,
      now,
      timeSinceLastBlock,
      threshold: NETWORK_STALE_THRESHOLD_SECONDS,
    })

    return {
      isNetworkDown: timeSinceLastBlock > NETWORK_STALE_THRESHOLD_SECONDS,
      timeSinceLastBlock,
    }
  }

  return useQuery({
    queryKey,
    queryFn,
    refetchInterval: 30_000, // poll every 30 seconds
    meta: { persist: false },
  })
}

// -----------------------------------

export function useL2WithdrawTokensToL1(onBridgeSuccess?: (data: any) => void) {
  const { waapAddress: l1Address } = useWalletStore()
  const { aztecAddress, aztecAccount, aztecLoginMethod } = useWalletStore()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { setProgressStep, setTransactionUrls, isPrivacyModeEnabled, bridgeConfig } =
    useBridgeStore()

  // Get wallet information from useWalletStore
  const {
    waapLoginMethod: loginMethod,
    waapWalletProvider: walletProvider,
    waapChainId: chainId,
  } = useWalletStore()
  const walletAdapter = useWalletAdapter()
  const selectedToken = bridgeConfig.from.token ?? undefined

  const mutationFn = async (params: {
    amountL1: string
    amountL2: string
    amountDisplayL1: string
    amountDisplayL2: string
  }) => {
    const { amountL1, amountL2, amountDisplayL1, amountDisplayL2 } = params
    const amount = BigInt(amountL2)
    if (!l1Address) {
      throw new Error('Ethereum wallet not connected')
    }
    if (!aztecAddress) {
      throw new Error('Aztec wallet not connected')
    }
    if (!aztecAccount) {
      throw new Error('Required accounts not connected')
    }

    // 🔒 Track whether L2 burn+exit has been confirmed (funds are burned on L2).
    // If true, the outer catch must NEVER mark the operation as 'failed' — it stays
    // 'submitted' so the user can Resume from the activity page.
    let burnConfirmed = false
    let operationId: string | undefined

    try {
      // ─── Step 1: Validate wallets and capture block numbers ──────────
      setProgressStep(1, 'active')

      const { l1BlockNumberBeforeTx, l2BlockNumberBeforeTx, nodeInfoSnapshot } =
        await validateAndCaptureBlocksL2(
          l1Address,
          aztecAddress,
          walletAdapter,
          {
            walletType: WalletType.WAAP,
            loginMethod: loginMethod,
            walletProvider: walletProvider,
            address: l1Address,
            chainId: chainId,
            aztecLoginMethod: aztecLoginMethod,
            aztecAddress: aztecAddress,
            amount: amount.toString(),
          },
          selectedToken,
        )

      console.log('[L2→L1] Initiating withdrawal from L2 to L1...', {
        amount: amount.toString(),
        l1Address,
        private: isPrivacyModeEnabled,
        l2BlockNumberBeforeTx: l2BlockNumberBeforeTx ?? null,
      })

      // ─── Step 2: Encrypt nonce and backup to server ─────────────────
      const backup = await encryptAndBackupWithdrawalNonce({
        l1Address,
        aztecAddress,
        amountL1,
        amountL2,
        amountDisplayL1,
        amountDisplayL2,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? false,
        l1BlockNumberBeforeTx,
        l2BlockNumberBeforeTx,
        nodeInfoSnapshot,
        selectedToken,
      })
      operationId = backup.operationId

      // ─── Step 2b: Fetch POCH attestation for private withdrawal ─────
      let attestation: { l2Signature: number[]; nonce: number; actionId: string } | undefined
      if (isPrivacyModeEnabled) {
        const portalAddress = selectedToken?.l1PortalContract
        if (!portalAddress) {
          throw new Error('Portal address not configured — cannot fetch POCH attestation for private withdrawal')
        }
        console.log('[L2→L1] Fetching POCH attestation for private exit...')
        attestation = await fetchL2PochAttestation(portalAddress)
        console.log('[L2→L1] POCH attestation received:', { nonce: attestation.nonce, actionId: attestation.actionId })
      }

      // ─── Step 3: Burn + exit on L2 (DANGER ZONE) ───────────────────
      notify(
        'warn',
        {
          heading: 'Do Not Reload',
          message:
            'Your withdrawal is in progress. Please do not reload or close this page until it completes, or it may be difficult to recover your funds.',
        },
        { autoClose: false },
      )

      const burnResult = await executeBurnAndExit({
        walletAdapter,
        l1Address,
        aztecAddress,
        amount,
        nonce: backup.nonce,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? false,
        attestation,
      })
      burnConfirmed = true // 🔒 Funds are now burned — never mark as 'failed'

      const l2TxHash = burnResult.l2TxHash

      // ─── Step 4: Persist receipt + poll for block number ────────────
      setProgressStep(1, 'completed')
      setProgressStep(2, 'active')

      const receiptResult = await persistBurnReceiptAndPollBlock({
        operationId,
        l2TxHash,
        l2BlockNumber: burnResult.l2BlockNumber,
      })
      if (!receiptResult.l2TxHashPatchOk) {
        notify(
          'warn',
          {
            heading: 'Backup Warning',
            message:
              'Could not save L2 transaction hash to server. Please do not close this page until the withdrawal completes.',
          },
          { autoClose: false },
        )
      }

      setTransactionUrls(null, receiptResult.l2TxUrl)

      // ─── Step 5: Fetch nodeInfo + compute witness + persist ─────────
      const witnessResult = await fetchNodeInfoAndComputeWitness({
        operationId,
        l1Address,
        amount,
        l2BridgeAddress: backup.l2BridgeAddress,
        blockNumberForProof: receiptResult.blockNumberForProof,
        portalAddress: selectedToken?.l1PortalContract,
      })
      if (!witnessResult.witnessPatchOk) {
        notify(
          'warn',
          {
            heading: 'Backup Warning',
            message:
              'Could not save withdrawal proof to server. Please do not close this page until the withdrawal completes.',
          },
          { autoClose: false },
        )
      }

      setProgressStep(2, 'completed')

      // ─── Step 6: Wait for block proven on L1 ───────────────────────
      setProgressStep(3, 'active')

      await waitForBlockProven({
        blockNumberForProof: receiptResult.blockNumberForProof,
        rollupAddress: witnessResult.rollupAddress,
        onPoll: (provenBlock, neededBlock, elapsedMs) => {
          const elapsedMin = Math.round(elapsedMs / 60_000)
          notify(
            'info',
            `Waiting for L2 block to be proven on L1 (proven: ${provenBlock}, need: ${neededBlock}, ${elapsedMin} min elapsed)...`,
          )
        },
        onFallback: (fixedWaitMs) => {
          notify(
            'info',
            `Waiting ~${Math.round(fixedWaitMs / 60_000)} min for block finalization...`,
          )
        },
      })

      setProgressStep(3, 'completed')

      // Final wait before sending L1 withdraw tx
      console.log('[L2→L1] Final wait before L1 withdraw (30s)...')
      await wait(30_000)

      // ─── Step 7: L1 withdraw ───────────────────────────────────────
      setProgressStep(4, 'active')
      patchOperationAsync(operationId, { currentStep: 4 })

      try {
        const withdrawResult = await executeL1Withdraw({
          l1Address,
          amount,
          epoch: witnessResult.epoch,
          leafIndex: witnessResult.leafIndex,
          siblingPath: witnessResult.siblingPath,
          portalAddress: selectedToken?.l1PortalContract,
        })

        setTransactionUrls(withdrawResult.l1TxUrl, receiptResult.l2TxUrl)

        // PATCH: mark as completed on server
        patchOperationAsync(operationId, {
          status: 'completed',
          l1TxHash: withdrawResult.l1TxHash,
          l1TxUrl: withdrawResult.l1TxUrl,
          completedAt: new Date().toISOString(),
          currentStep: 5,
        })

        // Update localStorage
        updateLocalStorageItem(
          LS_KEY_BRIDGE_WITHDRAWALS,
          (w: any) => w.id === operationId,
          (w: any) => ({
            ...w,
            success: true,
            status: BridgeOperationStatus.completed,
            l1TxHash: withdrawResult.l1TxHash,
            l1TxUrl: withdrawResult.l1TxUrl,
            completedAt: Date.now(),
          }),
        )
      } catch (error) {
        // L1 withdraw failed — tokens are still burned on L2.
        // PATCH lastErrorMessage but do NOT change status (stays 'ready' for Resume).
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        if (operationId) {
          patchOperationAsync(operationId, {
            lastErrorMessage: `L1 withdraw failed: ${errorMessage}`.slice(
              0,
              500,
            ),
          })
        }

        const isArtifactError =
          errorMessage.includes('Contract artifact not found') ||
          errorMessage.includes('artifact not found') ||
          errorMessage.includes('Contract artifact') ||
          (errorMessage.includes('artifact') &&
            errorMessage.includes('not found'))

        if (isArtifactError) {
          notify('error', {
            heading: 'Contract Artifact Not Found',
            message: `The contract artifact is not available in the public registry. Please upload it to https://devnet.aztec-registry.xyz/ to make it available for the wallet.`,
          })
        } else {
          notify('error', `Failed to withdraw tokens on L1. ${errorMessage}`)
        }
        throw error
      }

      // ─── Step 8: Bridge Complete ───────────────────────────────────
      setProgressStep(4, 'completed')
      setProgressStep(5, 'active')

      logInfo('Withdrawal from L2 to L1 completed', {
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address,
        chainId: chainId,
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress,
        direction: BridgeDirection.L2_TO_L1,
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: selectedToken?.symbol ?? 'cUSDC',
        toToken: selectedToken?.pairedSymbol ?? 'USDC',
        amount: amount.toString(),
        l1Address: l1Address,
        l2Address: aztecAddress,
        txHash: l2TxHash,
        userAction: 'withdrawal_l2_to_l1_completed',
      })

      await wait(3000)
      setProgressStep(5, 'completed')

      return l2TxHash
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

      logError('Withdrawal from L2 to L1 failed', {
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address,
        chainId: chainId,
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress,
        direction: BridgeDirection.L2_TO_L1,
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: selectedToken?.symbol ?? 'cUSDC',
        toToken: selectedToken?.pairedSymbol ?? 'USDC',
        amount: amount.toString(),
        l1Address: l1Address,
        l2Address: aztecAddress,
        error: errorMessage,
        userAction: 'withdrawal_l2_to_l1_failed',
      })

      // 🔒 CRITICAL: Only mark as 'failed' if burn has NOT happened.
      // If burn confirmed, status stays 'submitted'/'ready' so user can Resume.
      if (operationId) {
        const patchData: Record<string, unknown> = {
          lastErrorMessage: errorMessage.slice(0, 500),
        }
        if (!burnConfirmed) {
          patchData.status = 'failed'
        }
        patchOperationAsync(operationId, patchData)
      }

      const isBlockNotProven =
        /BlockNotProven|NothingToConsumeAtBlock|block.*required|required.*block/i.test(
          errorMessage,
        ) ||
        (errorMessage.includes('leaf') && errorMessage.includes('block'))
      const userMessage = isBlockNotProven
        ? `L1 withdraw failed: the L2 block may not be proven on Ethereum yet. Wait the full ~40 minutes after the L2 exit, then try again. (${errorMessage})`
        : `Failed to withdraw tokens. ${errorMessage}`
      notify('error', userMessage)
      throw error
    }
  }

  return useToastMutation({
    mutationFn,
    onSuccess: (txHash) => {
      console.log('[L2→L1] Withdrawal mutation onSuccess', {
        txHash,
        hasOnBridgeSuccess: !!onBridgeSuccess,
      })
      queryClient.invalidateQueries({
        queryKey: ['l1TokenBalances', l1Address],
      })
      queryClient.invalidateQueries({ queryKey: ['l1TokenBalance', l1Address] })
      queryClient.invalidateQueries({
        queryKey: ['l2TokenBalance', aztecAddress],
      })

      logInfo('Withdrawal from L2 to L1 callback', {
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address ?? '',
        chainId: chainId,
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress ?? '',
        direction: BridgeDirection.L2_TO_L1,
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: selectedToken?.symbol ?? 'cUSDC',
        toToken: selectedToken?.pairedSymbol ?? 'USDC',
        l1Address: l1Address,
        l2Address: aztecAddress,
        userAction: 'withdrawal_l2_to_l1_callback',
        txHash: typeof txHash === 'string' ? txHash : 'completed',
      })

      if (onBridgeSuccess) {
        console.log('[L2→L1] Calling onBridgeSuccess (handleBridgeSuccess)')
        onBridgeSuccess(txHash)
      }
    },
  })
}

// -----------------------------------

/**
 * Recovery for L2→L1 withdrawals when witness data is missing (e.g. after refresh).
 * Recomputes L2→L1 message leaf and membership witness from stored withdrawal (nonce, amount, l1Address, l2BlockNumber).
 * ⚠️ Cannot recover the nonce – if nonce is lost after burn, withdrawal cannot be completed.
 */
export function useL2RecoverWithdrawal() {
  const { aztecAccount, aztecAddress } = useWalletStore()
  const walletAdapter = useWalletAdapter()
  const notify = useToast()

  const mutationFn = async ({
    l2TxHash,
    l1Address,
  }: {
    l2TxHash: string
    l1Address: string
  }) => {
    if (!aztecNode) {
      throw new Error('Aztec node not available')
    }
    if (!walletAdapter) {
      throw new Error('Wallet adapter not initialized')
    }

    const storedWithdrawals = localStorage.getItem(LS_KEY_BRIDGE_WITHDRAWALS)
    const list = storedWithdrawals ? JSON.parse(storedWithdrawals) : []
    const w = list.find(
      (x: any) => x.l2TxHash === l2TxHash && x.l1Address === l1Address,
    )
    if (!w) {
      throw new Error(
        'Withdrawal not found in storage. To recover, provide L2 tx hash, L1 address, and ensure nonce is saved.',
      )
    }
    if (w.l2ToL1MessageIndex != null && w.siblingPath != null) {
      notify('info', 'Withdrawal data already complete. No recovery needed.')
      return { success: true, withdrawal: w }
    }
    const blockNumber = w.l2BlockNumber ?? w.l2TxReceipt?.blockNumber
    if (!blockNumber) {
      const beforeHint = w.l2BlockNumberBeforeTx
        ? ` Your backup may include l2BlockNumberBeforeTx (${w.l2BlockNumberBeforeTx}); the tx block is at or after that.`
        : ''
      throw new Error(
        'Block number is required for recovery. Provide the L2 block number where the transaction was included.' +
          beforeHint,
      )
    }
    const nodeInfo = await aztecNode.getNodeInfo()
    const rollupVersion = nodeInfo?.rollupVersion
    if (rollupVersion == null) {
      throw new Error('Rollup version not available from node.')
    }
    const l1Addresses = nodeInfo?.l1ContractAddresses as Record<string, any> | undefined
    const rollupAddress = l1Addresses?.rollupAddress?.toString() || L1_CONTRACT_ADDRESSES.rollupAddress
    if (!rollupAddress) {
      throw new Error('Rollup address not available. Cannot convert block number to epoch for L2→L1 witness.')
    }
    const amount = BigInt(w.amount)
    const l2BridgeAddress =
      w.l2BridgeAddress ?? L1_TOKENS[0]?.l2BridgeContract ?? ''

    const msgLeaf = computeL2ToL1MessageLeaf({
      l1Recipient: w.l1Address,
      amount,
      l2BridgeAddress,
      portalAddress: L1_TOKENS[0]?.l1PortalContract ?? '',
      rollupVersion,
      chainId: L1_CHAIN_ID,
    })

    const witnessResult = await computeWitness(Number(blockNumber), msgLeaf, rollupAddress)
    const leafIndexStr = witnessResult.leafIndex
    const siblingPathArr = witnessResult.siblingPath
    const updatedWithdrawals = list.map((x: any) =>
      x.l2TxHash === l2TxHash && x.l1Address === l1Address
        ? {
            ...x,
            l2ToL1MessageIndex: leafIndexStr,
            siblingPath: siblingPathArr,
            status: 'ready',
          }
        : x,
    )
    localStorage.setItem(
      LS_KEY_BRIDGE_WITHDRAWALS,
      JSON.stringify(updatedWithdrawals),
    )
    notify('success', 'Withdrawal data recovered successfully!')
    return {
      success: true,
      withdrawal: {
        ...w,
        l2ToL1MessageIndex: leafIndexStr,
        siblingPath: siblingPathArr,
        status: 'ready',
      },
    }
  }

  return useToastMutation({
    mutationFn,
    toastMessages: {
      pending: 'Recovering withdrawal data...',
      success: 'Withdrawal data recovered successfully!',
      error: 'Failed to recover withdrawal data',
    },
  })
}

// -----------------------------------

/**
 * Export L2→L1 withdrawal data for backup (nonce, witness, etc.).
 */
export function useExportWithdrawalData() {
  const notify = useToast()

  const exportWithdrawal = (withdrawalId: string) => {
    try {
      const raw = localStorage.getItem(LS_KEY_BRIDGE_WITHDRAWALS)
      if (!raw) {
        notify('error', 'No withdrawal data found')
        return
      }
      const withdrawals = JSON.parse(raw)
      const w = withdrawals.find((x: any) => x.id === withdrawalId)
      if (!w) {
        notify('error', 'Withdrawal not found')
        return
      }
      exportWithdrawalData(w)
      notify(
        'success',
        'Withdrawal data exported successfully! Save this file in a safe place.',
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      notify('error', `Failed to export: ${msg}`)
    }
  }

  const copyNonce = async (withdrawalId: string) => {
    try {
      const raw = localStorage.getItem(LS_KEY_BRIDGE_WITHDRAWALS)
      if (!raw) {
        notify('error', 'No withdrawal data found')
        return false
      }
      const withdrawals = JSON.parse(raw)
      const w = withdrawals.find((x: any) => x.id === withdrawalId)
      if (!w?.encryptedCiphertext) {
        notify('error', 'Encrypted withdrawal data not found')
        return false
      }

      // Decrypt the nonce from the encrypted localStorage entry
      const signingMessage = createSigningMessage(w.l1Address)
      const signature = await requestWaapWallet(WAAP_METHOD.personal_sign, [
        signingMessage,
        w.l1Address,
      ]) as string
      const encryptionKey = await deriveEncryptionKey(w.l1Address, signature, w.keyDerivationDomain)
      const decrypted = JSON.parse(
        await decryptData(w.encryptedCiphertext, w.encryptedIv, w.encryptedTag, encryptionKey)
      )

      if (!decrypted.nonce) {
        notify('error', 'Nonce not found in decrypted data')
        return false
      }

      const ok = await copyToClipboard(decrypted.nonce)
      if (ok) notify('success', 'Nonce copied to clipboard!')
      else notify('error', 'Failed to copy')
      return ok
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      notify('error', `Failed to copy nonce: ${msg}`)
      return false
    }
  }

  const getAllPendingWithdrawals = () => {
    try {
      const raw = localStorage.getItem(LS_KEY_BRIDGE_WITHDRAWALS)
      if (!raw) return []
      const withdrawals = JSON.parse(raw)
      return withdrawals.filter((x: any) => !x.success)
    } catch {
      return []
    }
  }

  return {
    exportWithdrawal,
    copyNonce,
    getAllPendingWithdrawals,
  }
}

// -----------------------------------

/**
 * Hook to check if an address has a soulbound token on L2
 */
export function useL2HasSoulboundToken() {
  const { aztecAddress } = useWalletStore()

  const queryKey = ['l2HasSoulboundToken', aztecAddress]
  const queryFn = async () => {
    // For now, just return a promise with value true
    return Promise.resolve(true)
  }

  return useQuery({
    queryKey,
    queryFn,
    enabled: !!aztecAddress,
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

// -----------------------------------

/**
 * Hook to mint a soulbound token on L2
 */
export function useL2MintSoulboundToken(onSuccess: (data: any) => void) {
  const { aztecAddress } = useWalletStore()
  const queryClient = useQueryClient()

  const mutationFn = async () => {
    if (!aztecAddress) {
      throw new Error('Aztec wallet not connected')
    }

    // For now, just return a promise with success
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return { success: true }
  }

  return useToastMutation({
    mutationFn,
    onSuccess: (data) => {
      queryClient.invalidateQueries({
        queryKey: ['l2HasSoulboundToken', aztecAddress],
      })
      onSuccess(data)
    },
    toastMessages: {
      pending: 'Minting Soulbound Token on Aztec...',
      success: 'Soulbound Token minted successfully on Aztec!',
      error: 'Failed to mint Soulbound Token on Aztec',
    },
  })
}

export const useL2PendingTxCount = () => {
  const { aztecAddress, isAztecConnected } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()

  // Create a stable query key that doesn't change with renders
  const queryKey = ['l2PendingTxCount']

  // Query function without tracking state
  const queryFn = async (): Promise<number> => {
    try {
      const response = await fetch(L2_NODE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 15,
          method: 'node_getPendingTxCount',
          params: [],
        }),
      })

      const data = await response.json()
      return (data.result as number) ?? 0
    } catch (error) {
      handleL2Error<number>(error, 'NODE')
      throw error
    }
  }

  // Use regular React Query instead of toast query
  return useQuery<number, Error>({
    queryKey,
    queryFn,
    enabled: !!aztecAddress,
    meta: {
      persist: false, // Mark this query for persistence
    },
  })
}

export const useL2TokenTransfer = () => {
  const { aztecAddress, isAztecConnected } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()
  const walletAdapter = useWalletAdapter()

  const mutation = useMutation({
    mutationFn: async ({
      amount,
      recipient,
      isPrivate,
    }: {
      amount: string
      recipient: string
      isPrivate: boolean
    }) => {
      try {
        if (!aztecAddress) {
          throw new Error('Aztec address not found')
        }
        if (!walletAdapter) {
          throw new Error(
            'Aztec wallet not connected or contracts not initialized',
          )
        }

        const amountInWei = parseUnits(amount, L1_TOKENS[0]?.decimals ?? 6)
        const recipientAddress = AztecAddress.fromString(recipient)

        // Use wallet adapter to execute transfer
        const method = isPrivate ? 'transfer_to_private' : 'transfer'
        const args = isPrivate
          ? [
              AztecAddress.fromString(aztecAddress),
              recipientAddress,
              amountInWei,
            ]
          : [recipientAddress, amountInWei]

        const result = await walletAdapter.executeCall(
          walletAdapter.tokenAddress,
          method,
          args,
          { contractType: 'token' },
        )

        // Return a receipt-like object for compatibility
        return { txHash: result.txHash, status: 'mined' }
      } catch (error) {
        handleL2Error<null>(error, 'TRANSACTION')
        throw error
      }
    },
  })

  return mutation
}
