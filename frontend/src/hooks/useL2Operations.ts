import { L1_TOKENS, L1_CHAIN_ID, L2_CHAIN_ID, getAztecscanUrl, getEtherscanUrl } from '@/config'
import { useBridgeStore } from '@/stores/bridgeStore'
import { logInfo, logError } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits } from 'viem'
import { useToast, useToastMutation } from './useToast'
import { exportWithdrawalData, copyToClipboard, decryptStorageEntry, verifyEncryptionDomain } from '@/utils'
import { useL2ErrorHandler } from '@/utils/l2ErrorHandler'
import { requestWaapWallet, WAAP_METHOD, useWalletStore } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent, StepStatus } from '@human.tech/aztec-bridge-sdk'
import { getPendingWithdrawals, getWithdrawalById, getWithdrawals } from '@human.tech/aztec-bridge-sdk'

// Define types for balance queries
export interface L2TokenBalanceData {
  publicBalance: string
  privateBalance: string
}

// -----------------------------------

export const useL2TokenBalance = () => {
  const { aztecAddress } = useWalletStore()
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
        throw new Error('Aztec wallet not connected or contracts not initialized')
      }

      const userAddress = AztecAddress.fromString(aztecAddress)

      // Single simulate_views call for both balances
      const tokenAddr = l2TokenAddress || walletAdapter.tokenAddress
      const [privateBalanceResult, publicBalanceResult] = await walletAdapter.simulateViews([
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

      const publicBalanceFormat = formatUnits(publicBalance, tokenDecimals)
      const privateBalanceFormat = formatUnits(privateBalance, tokenDecimals)

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

const FEE_JUICE_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000005'
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
        throw new Error('Aztec wallet not connected or contracts not initialized')
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

export const useL2PrivateFeeJuiceBalance = () => {
  const { aztecAddress } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()
  const walletAdapter = useWalletAdapter()

  const queryKey = ['l2PrivateFeeJuiceBalance', aztecAddress]

  const queryFn = async (): Promise<string> => {
    try {
      if (!aztecAddress) {
        throw new Error('Aztec address not found')
      }
      if (!walletAdapter) {
        throw new Error('Aztec wallet not connected or contracts not initialized')
      }

      const userAddress = AztecAddress.fromString(aztecAddress)

      const [privateBalanceResult] = await walletAdapter.simulateViews([
        {
          contract: FEE_JUICE_ADDRESS,
          method: 'balance_of_private',
          args: [userAddress],
        },
      ])

      const privateBalance = BigInt(privateBalanceResult.result.toString())
      return formatUnits(privateBalance, FEE_JUICE_DECIMALS)
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
  const bridge = useBridge()

  const queryKey = ['l1ContractAddresses']
  const queryFn = async () => {
    const info = await bridge.getAztecNodeInfo()
    return (info as any)?.l1ContractAddresses ?? null
  }
  return useQuery({
    queryKey,
    queryFn,
    enabled: isAztecConnected,
  })
}

export function useL2NodeIsReady() {
  const { isAztecConnected } = useWalletStore()
  const bridge = useBridge()
  const queryKey = ['nodeIsReady']
  const queryFn = async () => {
    return await bridge.isAztecNodeReady()
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
  const bridge = useBridge()
  const queryKey = ['networkHealth']

  const queryFn = async () => {
    const header = await bridge.getAztecBlockHeader('latest')
    if (!header) {
      return { isNetworkDown: true, timeSinceLastBlock: Infinity }
    }

    const blockTimestamp = Number(header.globalVariables.timestamp)
    const now = Math.floor(Date.now() / 1000)
    const timeSinceLastBlock = now - blockTimestamp

    // console.log('[NetworkHealth]', {
    //   blockTimestamp,
    //   now,
    //   timeSinceLastBlock,
    //   threshold: NETWORK_STALE_THRESHOLD_SECONDS,
    // })

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
  const { aztecAddress, aztecLoginMethod } = useWalletStore()
  const queryClient = useQueryClient()
  const notify = useToast()
  const {
    setProgressStep,
    setTransactionUrls,
    isPrivacyModeEnabled,
    bridgeConfig,
    l2TxUrl: currentL2TxUrl,
  } = useBridgeStore()

  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()
  const walletAdapter = useWalletAdapter()
  const selectedToken = bridgeConfig.from.token ?? undefined
  const bridge = useBridge()

  const mutationFn = async (params: {
    amountL1: string
    amountL2: string
    amountDisplayL1: string
    amountDisplayL2: string
  }) => {
    const { amountDisplayL2 } = params

    if (!l1Address) throw new Error('Ethereum wallet not connected')
    if (!aztecAddress) throw new Error('Aztec wallet not connected')
    if (!walletAdapter) throw new Error('Aztec wallet adapter not ready')

    const result = await bridge.withdrawL2ToL1({
      token: selectedToken?.symbol ?? 'cUSDC',
      amount: amountDisplayL2,
      l1Address,
      l2Address: aztecAddress,
      isPrivate: isPrivacyModeEnabled ?? false,
      sendTransaction: async (tx) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx])) as string
      },
      walletAdapter: walletAdapter as any,
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        return (await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, l1Address])) as string
      },
      onStep: (step: number, status: StepStatus) => {
        setProgressStep(step, status)
      },
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case 'do_not_reload':
            // Persistent banner — stays up until burn_sent / burn_confirmed.
            // Tab close at this point loses the encrypted nonce needed to resume.
            notify(
              'warn',
              {
                heading: 'Do Not Reload',
                message:
                  'Your withdrawal transaction is being prepared. Closing or reloading this page now may make recovery harder.',
              },
              { autoClose: false, toastId: 'l2-to-l1-do-not-reload' },
            )
            break
          // Persist encrypted nonce payload (recovery-critical)
          case 'nonce_generated':
            console.log('[L2→L1] Nonce generated, encrypted payload persisted to localStorage via SDK')
            notify(
              'warn',
              {
                heading: 'Backup Available',
                message:
                  'Your withdrawal data is encrypted and backed up — only you can access it. For extra safety, click here to export a local copy — useful if you ever need to recover manually',
              },
              {
                autoClose: false,
                onClick: () => {
                  try {
                    const pending = getPendingWithdrawals()
                    const latest = pending[pending.length - 1]
                    if (latest) exportWithdrawalData(latest)
                  } catch (e) {
                    console.error('[L2→L1] Failed to export withdrawal data on toast click:', e)
                  }
                },
              },
            )
            break
          // Track operation ID for correlation
          case 'operation_created':
            logInfo('Withdrawal operation created', {
              direction: 'L2_TO_L1',
              operationId: event.operationId,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_l2_to_l1_created',
            })
            console.log('[L2→L1] Operation created:', event.operationId)
            break
          case 'burn_sent':
            logInfo('L2 burn tx sent', {
              direction: 'L2_TO_L1',
              l2TxHash: event.l2TxHash,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_l2_to_l1_burn_sent',
            })
            notify(
              'warn',
              {
                heading: 'Withdrawal In Progress',
                message:
                  'Please keep this page open while your withdrawal completes. Your data is encrypted and backed up — only you can access it.',
              },
              { autoClose: false },
            )
            break
          case 'burn_confirmed':
            logInfo('L2 burn confirmed', {
              direction: 'L2_TO_L1',
              l2TxHash: event.l2TxHash,
              l2BlockNumber: event.l2BlockNumber,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_l2_to_l1_burn_confirmed',
            })
            setTransactionUrls(null, event.l2TxUrl)
            // Prompt user to backup their withdrawal data (matches old flow pattern)
            notify(
              'warn',
              {
                heading: 'Withdrawal Confirmed',
                message:
                  'Your withdrawal is confirmed on L2. Click here to export a full backup — this includes all the data needed to resume if anything interrupts the process.',
              },
              {
                autoClose: false,
                onClick: () => {
                  try {
                    const pending = getPendingWithdrawals()
                    const latest = pending[pending.length - 1]
                    if (latest) exportWithdrawalData(latest)
                  } catch (e) {
                    console.error('[L2→L1] Failed to export withdrawal data on toast click:', e)
                  }
                },
              },
            )
            break
          // Handle recovery_l2_block event
          case 'recovery_l2_block':
            console.log('[L2→L1] Recovered L2 block number:', event.l2BlockNumber)
            break
          // Persist witness data on witness_computed (recovery-critical)
          case 'witness_computed':
            logInfo('L2→L1 witness computed', {
              direction: 'L2_TO_L1',
              leafIndex: event.leafIndex,
              epoch: event.epoch,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_l2_to_l1_witness_computed',
            })
            console.log('[L2→L1] Witness computed: leafIndex=', event.leafIndex, 'epoch=', event.epoch)
            break
          case 'proven_poll':
            logInfo('L2→L1 proven poll', {
              direction: 'L2_TO_L1',
              provenBlock: event.provenBlock,
              neededBlock: event.neededBlock,
              elapsedMs: event.elapsedMs,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l2_to_l1_proven_poll',
            })
            notify(
              'info',
              `Waiting for L2 block to be proven on L1 (${Math.round(event.elapsedMs / 60_000)} min elapsed)...`,
              { toastId: 'l2-to-l1-progress', autoClose: 15000 },
            )
            break
          case 'proven_fallback':
            logInfo('L2→L1 proven fallback', {
              direction: 'L2_TO_L1',
              fixedWaitMs: event.fixedWaitMs,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l2_to_l1_proven_fallback',
            })
            notify('info', `Waiting ~${Math.round(event.fixedWaitMs / 60_000)} min for block finalization...`, {
              toastId: 'l2-to-l1-progress',
              autoClose: 15000,
            })
            break
          case 'l1_withdraw_sent':
            logInfo('L1 withdraw tx sent', {
              direction: 'L2_TO_L1',
              l1TxHash: event.l1TxHash,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_l2_to_l1_l1_withdraw_sent',
            })
            setTransactionUrls(event.l1TxUrl, currentL2TxUrl)
            break
          case 'operation_completed': {
            const l1Url = event.l1TxHash ? `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}` : null
            const l2Url = event.l2TxHash ? `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${event.l2TxHash}` : null
            setTransactionUrls(l1Url, l2Url)
            break
          }
          case 'attestation_fetch':
            logInfo('Attestation fetch', {
              direction: 'L2_TO_L1',
              method: event.method,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_attestation_fetch',
            })
            break
          case 'attestation_fallback':
            logInfo('Attestation cascade fallback', {
              direction: 'L2_TO_L1',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_attestation_fallback',
            })
            break
          case 'patch_failed':
            // Observability: mirrors useL1Operations — PATCH failures here
            // mean withdrawal proof state drifts from on-chain reality.
            logError(`Withdrawal PATCH failed: ${event.label}`, {
              direction: 'L2_TO_L1',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'withdrawal_patch_failed',
            })
            notify(
              'warn',
              {
                heading: 'Backup Warning',
                message:
                  'Could not save withdrawal proof to server. Please do not close this page until the withdrawal completes.',
              },
              { autoClose: false },
            )
            break
          case 'error':
            logError(
              event.error?.message ?? 'Withdrawal error event',
              {
                direction: 'L2_TO_L1',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address,
                l2Address: aztecAddress,
                amount: amountDisplayL2,
                isPrivacyModeEnabled,
                userAction: 'withdrawal_l2_to_l1_error',
              },
              event.error,
            )
            console.log('[L2→L1] Error event raw:', event.error)
            console.log('[L2→L1] Error message:', event.error?.message)
            if (event.fundsAtRisk) {
              notify(
                'warn',
                {
                  heading: 'L1 Withdraw Failed — Funds Burned on L2',
                  message:
                    'Your tokens were burned on L2 but the L1 withdrawal did not complete. Go to Activity to resume.',
                },
                { autoClose: false },
              )
            } else {
              // Skip generic toast for backup failures — onError handler shows a more specific one
              const errorMsg = event.error?.message ?? 'Unknown error'
              console.log('[L2→L1] errorMsg for toast:', JSON.stringify(errorMsg))
              if (errorMsg.includes('Failed to backup')) break

              if (errorMsg.includes('Contract artifact not found') || errorMsg.includes('artifact not found')) {
                notify('error', {
                  heading: 'Contract Artifact Not Found',
                  message:
                    'The contract artifact is not available in the public registry. Please upload it to https://devnet.aztec-registry.xyz/ to make it available for the wallet.',
                })
              } else {
                notify('error', {
                  heading: 'Withdrawal Failed — No Funds Moved',
                  message:
                    'The transaction was not sent. Your balance is unchanged and no recovery is needed. You can safely retry.',
                })
              }
            }
            break
        }
      },
    })

    logInfo('Withdrawal from L2 to L1 completed', {
      walletType: WalletType.WAAP,
      loginMethod,
      walletProvider,
      address: l1Address,
      chainId,
      aztecLoginMethod,
      aztecAddress,
      direction: 'L2_TO_L1',
      fromNetwork: 'Aztec',
      toNetwork: 'Ethereum',
      fromToken: selectedToken?.symbol ?? 'cUSDC',
      toToken: selectedToken?.pairedSymbol ?? 'USDC',
      amount: amountDisplayL2,
      l1Address,
      l2Address: aztecAddress,
      l2TxHash: result.l2TxHash,
      l1TxHash: result.l1TxHash,
      isPrivacyModeEnabled,
      userAction: 'withdrawal_l2_to_l1_completed',
    })

    return result.l2TxHash
  }

  return useToastMutation({
    mutationFn,
    onSuccess: (txHash) => {
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
        direction: 'L2_TO_L1',
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
        onBridgeSuccess(txHash)
      }
    },
    onError: (error) => {
      // The onEvent 'error' handler already shows a toast for most errors.
      // Only show here for backup failures (which are skipped in onEvent).
      const errorMessage =
        error instanceof Error ? error.message : typeof error === 'object' ? JSON.stringify(error) : String(error)
      if (errorMessage.includes('Failed to backup')) {
        notify(
          'error',
          {
            heading: 'Backup Failed — Withdrawal Aborted',
            message: errorMessage.length > 200 ? errorMessage.slice(0, 200) + '...' : errorMessage,
          },
          { autoClose: false },
        )
      }
    },
  })
}

// -----------------------------------

export function useL2RecoverWithdrawal() {
  const { waapAddress: l1Address } = useWalletStore()
  const { aztecAddress } = useWalletStore()
  const { setProgressStep, setTransactionUrls, l2TxUrl: currentL2TxUrl } = useBridgeStore()
  const bridge = useBridge()
  const notify = useToast()

  const mutationFn = async ({ l2TxHash, l1Address: paramL1Address }: { l2TxHash: string; l1Address: string }) => {
    const resolvedL1Address = paramL1Address || l1Address

    const w = getWithdrawals().find(
      (x: any) => x.l2TxHash === l2TxHash && x.l1Address?.toLowerCase() === resolvedL1Address?.toLowerCase(),
    )

    const operationId = w?.id ?? w?.operationId
    if (!operationId) {
      throw new Error(
        'Operation ID not found in storage. Recovery requires the operation ID. Please use the Activity page to resume.',
      )
    }

    await bridge.resume(operationId, {
      sendTransaction: async (tx) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx])) as string
      },
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        return (await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, resolvedL1Address])) as string
      },
      l1Address: resolvedL1Address ?? undefined,
      l2Address: aztecAddress ?? undefined,
      onStep: (step, status) => setProgressStep(step, status),
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case 'proven_poll':
            logInfo('L2→L1 resume proven poll', {
              direction: 'L2_TO_L1_RESUME',
              provenBlock: event.provenBlock,
              neededBlock: event.neededBlock,
              elapsedMs: event.elapsedMs,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: 'resume_l2_to_l1_proven_poll',
            })
            notify(
              'info',
              `Waiting for L2 block to be proven (proven: ${event.provenBlock}, need: ${event.neededBlock}, ${Math.round(event.elapsedMs / 60_000)} min)...`,
              { toastId: 'resume-l2-to-l1-progress', autoClose: false },
            )
            break
          case 'proven_fallback':
            logInfo('L2→L1 resume proven fallback', {
              direction: 'L2_TO_L1_RESUME',
              fixedWaitMs: event.fixedWaitMs,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: 'resume_l2_to_l1_proven_fallback',
            })
            notify('info', `Waiting ~${Math.round(event.fixedWaitMs / 60_000)} min for block finalization...`, {
              toastId: 'resume-l2-to-l1-progress',
              autoClose: false,
            })
            break
          case 'l1_withdraw_sent':
            logInfo('Resume L1 withdraw tx sent', {
              direction: 'L2_TO_L1_RESUME',
              l1TxHash: event.l1TxHash,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: 'resume_l2_to_l1_l1_withdraw_sent',
            })
            setTransactionUrls(event.l1TxUrl, currentL2TxUrl)
            break
          case 'operation_completed':
            logInfo('Resume withdrawal completed', {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              l1TxHash: event.l1TxHash,
              alreadyCompleted: event.alreadyCompleted,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: 'resume_l2_to_l1_completed',
            })
            if (event.l1TxHash) {
              const l1Url = `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}`
              setTransactionUrls(l1Url, null)
            }
            break
          case 'patch_failed':
            logError(`Resume PATCH failed: ${event.label}`, {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: 'resume_l2_to_l1_patch_failed',
            })
            notify(
              'warn',
              {
                heading: 'Backup Warning',
                message: `Could not save ${event.label} to server. Do not close this page.`,
              },
              { autoClose: false },
            )
            break
          case 'error':
            logError(
              event.error?.message ?? 'Resume error event',
              {
                direction: 'L2_TO_L1_RESUME',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address: resolvedL1Address,
                l2Address: aztecAddress,
                userAction: 'resume_l2_to_l1_error',
              },
              event.error,
            )
            if (event.fundsAtRisk) {
              notify(
                'error',
                {
                  heading: 'Recovery Error — Funds Safe',
                  message: 'Your withdrawal proof is saved. Go to Activity to try again.',
                },
                { autoClose: false },
              )
            }
            break
        }
      },
    })

    return { success: true, operationId }
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
      const w = getWithdrawalById(withdrawalId)
      if (!w) {
        notify('error', 'Withdrawal not found')
        return
      }
      exportWithdrawalData(w)
      notify('success', 'Withdrawal data exported successfully! Save this file in a safe place.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      notify('error', `Failed to export: ${msg}`)
    }
  }

  const copyNonce = async (withdrawalId: string) => {
    try {
      const result = await decryptStorageEntry(
        'withdrawals',
        withdrawalId,
        'nonce',
        async (msg, addr) => (await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, addr])) as string,
      )

      if (!result) {
        notify('error', 'Encrypted withdrawal data not found')
        return false
      }

      logInfo('bridge.decrypt_nonce', {
        l1Address: result.entry.l1Address,
        operationId: result.entry.id,
        tokenSymbol: result.entry.tokenSymbol,
        amount: result.entry.amount?.toString(),
        userAction: 'copy_nonce',
      })

      const ok = await copyToClipboard(result.value)
      if (ok) notify('success', 'Nonce copied to clipboard!')
      else notify('error', 'Failed to copy')
      return ok
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error'
      notify('error', `Failed to copy nonce: ${msg}`)
      return false
    }
  }

  const getAllPendingWithdrawals = () => getPendingWithdrawals()

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
  const { aztecAddress } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()
  const bridge = useBridge()

  const queryKey = ['l2PendingTxCount']

  const queryFn = async (): Promise<number> => {
    try {
      return await bridge.getAztecPendingTxCount()
    } catch (error) {
      handleL2Error<number>(error, 'NODE')
      throw error
    }
  }

  return useQuery<number, Error>({
    queryKey,
    queryFn,
    enabled: !!aztecAddress,
    meta: {
      persist: false,
    },
  })
}

export const useL2TokenTransfer = () => {
  const { aztecAddress } = useWalletStore()
  const handleL2Error = useL2ErrorHandler()
  const walletAdapter = useWalletAdapter()

  const mutation = useMutation({
    mutationFn: async ({ amount, recipient, isPrivate }: { amount: string; recipient: string; isPrivate: boolean }) => {
      try {
        if (!aztecAddress) {
          throw new Error('Aztec address not found')
        }
        if (!walletAdapter) {
          throw new Error('Aztec wallet not connected or contracts not initialized')
        }

        const amountInWei = parseUnits(amount, L1_TOKENS[0]?.decimals ?? 6)
        const recipientAddress = AztecAddress.fromString(recipient)

        // Use wallet adapter to execute transfer
        const method = isPrivate ? 'transfer_to_private' : 'transfer'
        const args = isPrivate
          ? [AztecAddress.fromString(aztecAddress), recipientAddress, amountInWei]
          : [recipientAddress, amountInWei]

        const result = await walletAdapter.executeCall(walletAdapter.tokenAddress, method, args, {
          contractType: 'token',
        })

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
