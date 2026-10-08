import { useRef } from 'react'
import { L1_TOKENS, L1_CHAIN_ID, L2_CHAIN_ID, BRIDGED_FPC_ADDRESS, getAztecscanUrl, getEtherscanUrl } from '@/config'
import { useBridgeStore } from '@/stores/bridgeStore'
import { logInfo, logError, DatadogUserAction } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, parseUnits } from 'viem'
import { useToast, useToastMutation } from './useToast'
import { pushNotification, dismissNotificationByKey } from '@/stores/useNotificationsStore'
import {
  exportWithdrawalData,
  copyToClipboard,
  decryptStorageEntry,
  verifyEncryptionDomain,
  extractErrorMessage,
  humanizeError,
  L1_GAS_RETRY_NOTICE,
  ATTESTATION_EXPIRING_NOTICE,
} from '@/utils'
import { useL2ErrorHandler } from '@/utils/l2ErrorHandler'
import { estimateClaimFeeLimit } from '@/utils/fuelGasEstimate'
import { requestWaapWallet, WAAP_METHOD, useWalletStore } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent, StepStatus } from '@human.tech/clean.sdk'
import { getPendingWithdrawals, getWithdrawalById, getWithdrawals, BridgeEventType } from '@human.tech/clean.sdk'

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

      const userAddress = AztecAddress.fromStringUnsafe(aztecAddress)

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
    // Always refetch when a balance-displaying view (bridge / activity) mounts so
    // a completed bridge shows the credited cUSDC balance instead of the value
    // restored from the persisted cache (#230b).
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 0,
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

// v5 canonical FeeJuice protocol-contract address (was 0x5 in v4)
const FEE_JUICE_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000003'
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

      const userAddress = AztecAddress.fromStringUnsafe(aztecAddress)

      const [publicBalanceResult] = await walletAdapter.simulateViews([
        {
          contract: FEE_JUICE_ADDRESS,
          method: 'balance_of_public',
          args: [userAddress],
        },
      ])

      const publicBalance = BigInt(publicBalanceResult.result.toString())
      // Truncate to 2 decimals so the UI doesn't render 18-digit FJ values.
      const raw = formatUnits(publicBalance, FEE_JUICE_DECIMALS)
      const dot = raw.indexOf('.')
      return dot === -1 ? `${raw}.00` : raw.slice(0, dot + 3).padEnd(dot + 3, '0')
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

      if (!BRIDGED_FPC_ADDRESS) {
        throw new Error('Bridged FPC address not configured for this deployment')
      }

      const userAddress = AztecAddress.fromStringUnsafe(aztecAddress)

      // read the user's BridgedFPC balance (what they can spend on private
      // fuel via the FPC) — NOT FEE_JUICE.balance_of_private (the user's own
      // private FeeJuice notes), which is a different number.
      const [privateBalanceResult] = await walletAdapter.simulateViews([
        {
          contract: BRIDGED_FPC_ADDRESS,
          method: 'balance_of',
          args: [userAddress],
        },
      ])

      const privateBalance = BigInt(privateBalanceResult.result.toString())
      // Truncate to 2 decimals for display parity with the public balance row.
      const raw = formatUnits(privateBalance, FEE_JUICE_DECIMALS)
      const dot = raw.indexOf('.')
      return dot === -1 ? `${raw}.00` : raw.slice(0, dot + 3).padEnd(dot + 3, '0')
    } catch (error) {
      handleL2Error<string>(error, 'BALANCE')
      throw error
    }
  }

  return useQuery<string, Error>({
    queryKey,
    queryFn,
    enabled: !!aztecAddress && !!walletAdapter && !!BRIDGED_FPC_ADDRESS,
    refetchInterval: 30_000,
  })
}

// Worst-case FeeJuice needed to pay for the L2 claim (the final bridge step).
// Network-wide (not user-specific), so it runs without a wallet. Base fees move
// slowly, so a 60s refresh keeps the figure live without hammering the node.
export const useClaimFeeEstimate = (fuelType: 'public' | 'private' = 'public') => {
  return useQuery<bigint, Error>({
    queryKey: ['claimFeeEstimate', fuelType],
    queryFn: () => estimateClaimFeeLimit(fuelType),
    staleTime: 60_000,
    refetchInterval: 60_000,
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
  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const { aztecAddress, aztecLoginMethod } = useWalletStore()
  const queryClient = useQueryClient()
  const notify = useToast()
  const {
    setProgressStep,
    setTransactionUrls,
    isPrivacyModeEnabled,
    bridgeConfig,
    l2TxUrl: currentL2TxUrl,
    setCurrentOperationId,
    markOperationLive,
    clearOperationLive,
  } = useBridgeStore()

  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()
  const walletAdapter = useWalletAdapter()
  const selectedToken = bridgeConfig.from.token ?? undefined
  const bridge = useBridge()

  // Operations this hook is driving right now. Marked live so Activity shows them as
  // running instead of offering Resume on a withdrawal that is still in flight, and
  // cleared in onSettled so a finished or failed run never leaves a stale marker.
  const drivenOperationIds = useRef<string[]>([])

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

    logInfo('Withdrawal from L2 to L1 initiated', {
      direction: 'L2_TO_L1',
      fromNetwork: 'Aztec',
      toNetwork: 'Ethereum',
      fromToken: selectedToken?.symbol ?? 'cUSDC',
      toToken: selectedToken?.pairedSymbol ?? 'USDC',
      l1Address,
      l2Address: aztecAddress,
      amountL1: params.amountL1,
      amountL2: params.amountL2,
      isPrivate: isPrivacyModeEnabled ?? false,
      userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_INITIATED,
    })

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
        // Route through the CACHED signer (not a raw personal_sign) so a
        // same-session deposit + withdrawal signs the identical, deterministic
        // "Unlock My Secrets" message ONCE. The message is byte-identical to the
        // deposit path (useL1Operations), so the cache key (address+message)
        // matches and the withdrawal never re-prompts (#408 / P1).
        const sig = await signWaapMessage(msg)
        if (!sig) throw new Error('Failed to sign message')
        return sig
      },
      onStep: (step: number, status: StepStatus) => {
        setProgressStep(step, status)
      },
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case BridgeEventType.DO_NOT_RELOAD:
            // Persistent banner — stays up until burn_sent / burn_confirmed.
            // Tab close at this point loses the encrypted nonce needed to resume.
            notify(
              'warn',
              {
                heading: 'Do not reload',
                message: 'Keep this page open so your funds stay recoverable.',
              },
              { autoClose: false, toastId: 'l2-to-l1-do-not-reload' },
            )
            break
          // Persist encrypted nonce payload (recovery-critical)
          case BridgeEventType.NONCE_GENERATED:
            // Encrypted payload is persisted to localStorage by the SDK. The manual
            // "export a local copy" affordance now lives inline in the progress frame
            // (ProgressCard) instead of a persistent toast.
            console.log('[L2→L1] Nonce generated, encrypted payload persisted to localStorage via SDK')
            break
          // Track operation ID for correlation
          case BridgeEventType.OPERATION_CREATED:
            logInfo('Withdrawal operation created', {
              direction: 'L2_TO_L1',
              operationId: event.operationId,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_CREATED,
            })
            console.log('[L2→L1] Operation created:', event.operationId)
            setCurrentOperationId(event.operationId)
            drivenOperationIds.current.push(String(event.operationId))
            markOperationLive(event.operationId)
            break
          case BridgeEventType.BURN_SENT:
            logInfo('L2 burn tx sent', {
              direction: 'L2_TO_L1',
              l2TxHash: event.l2TxHash,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_BURN_SENT,
            })
            // Burn is on L2 — the "Do Not Reload" prep banner is now stale.
            notify.dismiss('l2-to-l1-do-not-reload')
            // The toast was suppressed into the persistent feed, so also drop the
            // feed row — otherwise the stale "Do not reload" warning outlives the
            // window and keeps surfacing in the header ticker (and across reloads).
            dismissNotificationByKey('l2-to-l1-do-not-reload')
            // Feed-only: the ProgressCard banner carries the live "keep this
            // page open" safety text, so the message stays concise here.
            pushNotification({
              type: 'withdrawal',
              title: 'Withdrawal in progress',
              message: 'Keep this page open while it completes.',
            })
            break
          case BridgeEventType.BURN_CONFIRMED:
            logInfo('L2 burn confirmed', {
              direction: 'L2_TO_L1',
              l2TxHash: event.l2TxHash,
              l2BlockNumber: event.l2BlockNumber,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_BURN_CONFIRMED,
            })
            setTransactionUrls(null, event.l2TxUrl)
            // Burn landed on L2 — the "Do Not Reload" prep banner is now stale.
            notify.dismiss('l2-to-l1-do-not-reload')
            // The toast was suppressed into the persistent feed, so also drop the
            // feed row — otherwise the stale "Do not reload" warning outlives the
            // window and keeps surfacing in the header ticker (and across reloads).
            dismissNotificationByKey('l2-to-l1-do-not-reload')
            // Feed-only, with the recovery-backup export carried as an inline
            // action so the user can still export from Messages now that no
            // corner toast exists to click.
            pushNotification({
              type: 'withdrawal',
              title: 'Withdrawal confirmed',
              message: 'Finalizing on Ethereum. Export a recovery backup to stay safe.',
              action: {
                label: 'Export recovery backup',
                onClick: () => {
                  try {
                    const pending = getPendingWithdrawals()
                    const latest = pending[pending.length - 1]
                    if (latest) exportWithdrawalData(latest)
                  } catch (e) {
                    console.error('[L2→L1] Failed to export withdrawal data on action click:', e)
                  }
                },
              },
            })
            break
          case BridgeEventType.RECOVERY_L2_BLOCK:
            logInfo('L2→L1 recovered l2BlockNumber from receipt', {
              direction: 'L2_TO_L1',
              l2TxHash: event.l2TxHash,
              l2BlockNumber: event.l2BlockNumber,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_RECOVERED_L2_BLOCK,
            })
            break
          // Persist witness data on witness_computed (recovery-critical)
          case BridgeEventType.WITNESS_COMPUTED:
            logInfo('L2→L1 witness computed', {
              direction: 'L2_TO_L1',
              leafIndex: event.leafIndex,
              epoch: event.epoch,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_WITNESS_COMPUTED,
            })
            console.log('[L2→L1] Witness computed: leafIndex=', event.leafIndex, 'epoch=', event.epoch)
            break
          case BridgeEventType.PROVEN_POLL:
            logInfo('L2→L1 proven poll', {
              direction: 'L2_TO_L1',
              provenBlock: event.provenBlock,
              neededBlock: event.neededBlock,
              elapsedMs: event.elapsedMs,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.BRIDGE_L2_TO_L1_PROVEN_POLL,
            })
            notify('info', `Finalizing on L1 (${Math.round(event.elapsedMs / 60_000)} min elapsed).`, {
              toastId: 'l2-to-l1-progress',
              autoClose: 15000,
            })
            break
          case BridgeEventType.PROVEN_FALLBACK:
            logInfo('L2→L1 proven fallback', {
              direction: 'L2_TO_L1',
              fixedWaitMs: event.fixedWaitMs,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.BRIDGE_L2_TO_L1_PROVEN_FALLBACK,
            })
            notify('info', `Finalizing on L1. About ${Math.round(event.fixedWaitMs / 60_000)} min left.`, {
              toastId: 'l2-to-l1-progress',
              autoClose: 15000,
            })
            break
          case BridgeEventType.ATTESTATION_EXPIRING:
            notify('warn', ATTESTATION_EXPIRING_NOTICE, { autoClose: false, toastId: 'attestation-expiring' })
            break
          case BridgeEventType.L1_GAS_RETRY:
            notify('warn', L1_GAS_RETRY_NOTICE, { autoClose: false, toastId: 'l1-gas-retry' })
            break
          case BridgeEventType.L1_WITHDRAW_SENT:
            logInfo('L1 withdraw tx sent', {
              direction: 'L2_TO_L1',
              l1TxHash: event.l1TxHash,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_L1_WITHDRAW_SENT,
            })
            setTransactionUrls(event.l1TxUrl, currentL2TxUrl)
            break
          case BridgeEventType.OPERATION_COMPLETED: {
            const l1Url = event.l1TxHash ? `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}` : null
            const l2Url = event.l2TxHash ? `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${event.l2TxHash}` : null
            setTransactionUrls(l1Url, l2Url)
            pushNotification({
              type: 'withdrawal',
              title: 'Withdrawal complete',
              message: 'Tokens withdrawn to Ethereum.',
            })
            // The op just reached its terminal 'completed' status on the backend.
            // Refetch operations so Activity re-derives it as done (no Resume, no
            // "N to finish") instead of serving the stale resumable status from the
            // 30s cache.
            queryClient.invalidateQueries({ queryKey: ['bridgeOperations', l1Address] })
            break
          }
          case BridgeEventType.ATTESTATION_FETCH:
            logInfo('Attestation fetch', {
              direction: 'L2_TO_L1',
              method: event.method,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_ATTESTATION_FETCH,
            })
            break
          case BridgeEventType.ATTESTATION_FALLBACK:
            logInfo('Attestation cascade fallback', {
              direction: 'L2_TO_L1',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_ATTESTATION_FALLBACK,
            })
            break
          case BridgeEventType.PATCH_FAILED:
            // Observability: mirrors useL1Operations — PATCH failures here
            // mean withdrawal proof state drifts from on-chain reality.
            logError(`Withdrawal PATCH failed: ${event.label}`, {
              direction: 'L2_TO_L1',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.WITHDRAWAL_PATCH_FAILED,
            })
            notify(
              'warn',
              {
                heading: 'Backup warning',
                message: 'Could not save recovery data. Keep this page open.',
              },
              { autoClose: false },
            )
            break
          case BridgeEventType.ERROR:
            // Classify so Datadog can segment L2→L1 failures the same way it
            // does L1→L2 (mirrors useL1Operations.ts:680). Without these tags,
            // every withdrawal failure collapses into a single user_action and
            // alerting can't distinguish "L1 withdraw failed after burn" from
            // "block not yet proven" from "artifact not found".
            const errorMsgRaw = event.error?.message ?? 'Unknown error'
            const isBlockNotProvenHint = /not yet proven on L1|wait the full ~40 minutes|wait .{0,5}40 minutes/i.test(
              errorMsgRaw,
            )
            const isArtifact =
              errorMsgRaw.includes('Contract artifact not found') ||
              errorMsgRaw.includes('artifact not found') ||
              (errorMsgRaw.includes('artifact') && errorMsgRaw.includes('not found'))
            let errorTag: string
            let errorUserAction: string
            if (event.fundsAtRisk) {
              errorTag = 'l1_withdraw_failed'
              errorUserAction = 'withdrawal_l2_to_l1_l1_withdraw_failed'
            } else if (isBlockNotProvenHint) {
              errorTag = 'block_not_proven'
              errorUserAction = 'withdrawal_l2_to_l1_block_not_proven'
            } else if (isArtifact) {
              errorTag = 'artifact_not_found'
              errorUserAction = 'withdrawal_l2_to_l1_artifact_error'
            } else {
              errorTag = 'unknown'
              errorUserAction = 'withdrawal_l2_to_l1_error'
            }
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
                errorType: errorTag,
                userAction: errorUserAction,
              },
              event.error,
            )
            // Feed-only: the classified message below is the single record for
            // this failure. No corner toast — the peek bubble plus feed surface it.
            if (event.fundsAtRisk) {
              pushNotification({
                type: 'error',
                title: isBlockNotProvenHint ? 'Withdrawal not ready yet' : 'Withdrawal did not finish',
                message: isBlockNotProvenHint
                  ? 'The network needs a little more time. Please try again later.'
                  : 'Your funds are safe on Aztec. You can resume this withdrawal from Activity.',
              })
              break
            }

            // Backup failures get a more specific record from the onError handler.
            if (errorMsgRaw.includes('Failed to backup')) break

            // Classify so the user gets actionable copy instead of a raw revert
            // string. registry URL must be testnet (project runs on testnet).
            if (isArtifact) {
              pushNotification({
                type: 'error',
                title: 'Bridge is temporarily unavailable',
                message: 'We could not complete your withdrawal right now. No funds moved. Please try again soon.',
              })
            } else {
              pushNotification({
                type: 'error',
                title: 'Withdrawal failed',
                message: 'No funds moved. You can try again.',
              })
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
      userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_COMPLETED,
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
        userAction: DatadogUserAction.WITHDRAWAL_L2_TO_L1_CALLBACK,
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
            heading: 'Backup failed, withdrawal stopped',
            message: 'Could not save your backup. Please try again.',
          },
          { autoClose: false },
        )
      }
    },
    onSettled: () => {
      // Nothing is driving these any more. Whatever the backend status says, Activity
      // is now the right place to resume them from.
      drivenOperationIds.current.forEach(clearOperationLive)
      drivenOperationIds.current = []
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
  const queryClient = useQueryClient()

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
          case BridgeEventType.PROVEN_POLL:
            logInfo('L2→L1 resume proven poll', {
              direction: 'L2_TO_L1_RESUME',
              provenBlock: event.provenBlock,
              neededBlock: event.neededBlock,
              elapsedMs: event.elapsedMs,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_PROVEN_POLL,
            })
            notify('info', `Finalizing on L1 (${Math.round(event.elapsedMs / 60_000)} min elapsed).`, {
              toastId: 'resume-l2-to-l1-progress',
              autoClose: false,
            })
            break
          case BridgeEventType.PROVEN_FALLBACK:
            logInfo('L2→L1 resume proven fallback', {
              direction: 'L2_TO_L1_RESUME',
              fixedWaitMs: event.fixedWaitMs,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_PROVEN_FALLBACK,
            })
            notify('info', `Finalizing on L1. About ${Math.round(event.fixedWaitMs / 60_000)} min left.`, {
              toastId: 'resume-l2-to-l1-progress',
              autoClose: false,
            })
            break
          case BridgeEventType.ATTESTATION_EXPIRING:
            notify('warn', ATTESTATION_EXPIRING_NOTICE, { autoClose: false, toastId: 'attestation-expiring' })
            break
          case BridgeEventType.L1_GAS_RETRY:
            notify('warn', L1_GAS_RETRY_NOTICE, { autoClose: false, toastId: 'l1-gas-retry' })
            break
          case BridgeEventType.L1_WITHDRAW_SENT:
            logInfo('Resume L1 withdraw tx sent', {
              direction: 'L2_TO_L1_RESUME',
              l1TxHash: event.l1TxHash,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_L1_WITHDRAW_SENT,
            })
            setTransactionUrls(event.l1TxUrl, currentL2TxUrl)
            break
          case BridgeEventType.OPERATION_COMPLETED:
            logInfo('Resume withdrawal completed', {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              l1TxHash: event.l1TxHash,
              alreadyCompleted: event.alreadyCompleted,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_COMPLETED,
            })
            if (event.l1TxHash) {
              const l1Url = `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}`
              setTransactionUrls(l1Url, null)
            }
            // Terminal 'completed' on the backend — refetch operations so Activity
            // stops offering Resume for this now-finished withdrawal.
            queryClient.invalidateQueries({ queryKey: ['bridgeOperations', l1Address] })
            break
          case BridgeEventType.PATCH_FAILED:
            logError(`Resume PATCH failed: ${event.label}`, {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address: resolvedL1Address,
              l2Address: aztecAddress,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_PATCH_FAILED,
            })
            notify(
              'warn',
              {
                heading: 'Backup warning',
                message: `Could not save ${event.label}. Keep this page open.`,
              },
              { autoClose: false },
            )
            break
          case BridgeEventType.ERROR:
            logError(
              event.error?.message ?? 'Resume error event',
              {
                direction: 'L2_TO_L1_RESUME',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address: resolvedL1Address,
                l2Address: aztecAddress,
                userAction: DatadogUserAction.RESUME_L2_TO_L1_ERROR,
              },
              event.error,
            )
            if (event.fundsAtRisk) {
              // Route through the Messages feed / peek bubble (no autoClose:false) rather than a
              // pinned corner toast, matching the L1 resume path.
              notify('warn', {
                heading: "Recovery didn't finish",
                message: 'Your withdrawal proof is saved. Resume from Activity.',
              })
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
      console.error('[export withdrawal data] failed:', e)
      logError('Export withdrawal data failed', {
        errorType: 'export_withdrawal_failed',
        error: extractErrorMessage(e),
      })
      notify('error', `Couldn't export your withdrawal backup. ${humanizeError(e)}`)
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
        userAction: DatadogUserAction.COPY_NONCE,
      })

      const ok = await copyToClipboard(result.value)
      if (ok) notify('success', 'Nonce copied to clipboard!')
      else notify('error', 'Failed to copy')
      return ok
    } catch (e) {
      console.error('[copy nonce] failed:', e)
      logError('Copy nonce failed', {
        errorType: 'copy_nonce_failed',
        error: extractErrorMessage(e),
      })
      notify('error', `Couldn't copy the nonce. ${humanizeError(e)}`)
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
        const recipientAddress = AztecAddress.fromStringUnsafe(recipient)

        // Use wallet adapter to execute transfer
        const method = isPrivate ? 'transfer_to_private' : 'transfer'
        const args = isPrivate
          ? [AztecAddress.fromStringUnsafe(aztecAddress), recipientAddress, amountInWei]
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
