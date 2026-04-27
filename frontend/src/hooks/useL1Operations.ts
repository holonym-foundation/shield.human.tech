import { useBridgeStore } from '@/stores/bridgeStore'
import {
  truncateDecimals,
  exportClaimData,
  copyToClipboard,
  decryptStorageEntry,
  verifyEncryptionDomain,
  extractErrorMessage,
} from '@/utils'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { useWalletAdapter } from './useWalletAdapter'
import { ADDRESS, getAztecscanUrl, getEtherscanUrl, L1_CHAIN_ID, L1_TOKENS, L2_CHAIN_ID } from '@/config'
import { TestERC20Abi } from '@aztec/l1-artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, encodeFunctionData } from 'viem'
import PortalSBTJson from '../constants/PortalSBT.json'
import { useToast, useToastMutation, useToastQuery } from './useToast'
import { requestWaapWallet, useWalletStore, WAAP_METHOD } from '@/stores/walletStore'
import { I_UserTokenBalance, T_AlchemyTokenBalanceResponse, T_UserTokenType } from '@/types/token.balances.types'
import { axiosErrorMessage } from './helper'
import { networkConfig } from '@/config/l1.config'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent, StepStatus } from '@human.tech/aztec-bridge-sdk'
import { STORAGE_KEYS } from '@human.tech/aztec-bridge-sdk'

// Fix the bytecode format
const PortalSBTAbi = PortalSBTJson.abi

export function useL1TokenBalance() {
  const { waapAddress: l1Address, isWaapConnected } = useWalletStore()

  const queryKey = ['l1TokenBalance', l1Address]
  const queryFn = async () => {
    if (!l1Address) return null

    const data = encodeFunctionData({
      abi: TestERC20Abi,
      functionName: 'balanceOf',
      args: [l1Address],
    })

    const balance = await requestWaapWallet(WAAP_METHOD.eth_call, [
      {
        to: L1_TOKENS[0]?.l1TokenContract ?? '',
        data,
      },
    ])

    const balanceFormat = formatUnits(BigInt(balance as string), L1_TOKENS[0]?.decimals ?? 6)
    return balanceFormat
  }

  return useQuery({
    queryKey,
    queryFn,
    enabled: !!l1Address && isWaapConnected,
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

// -----------------------------------

/**
 * Hook to get token balances for an address across multiple chains
 */
export function useL1TokenBalances() {
  const { waapAddress: l1Address } = useWalletStore()
  const notify = useToast()

  const bridge = useBridge()
  const queryKey = ['l1TokenBalances', l1Address]
  const queryFn = async () => {
    try {
      const tokens = await bridge.getL1TokenBalances(l1Address!, [L1_CHAIN_ID])

      const tokenBalnces = tokens?.map((token: T_AlchemyTokenBalanceResponse) => {
        let tokenType: T_UserTokenType

        if (!token.tokenAddress || token.tokenAddress === null) {
          tokenType = 'native'
        } else {
          tokenType = 'erc20'
        }

        const formattedBalance = formatUnits(BigInt(token.tokenBalance), token?.tokenMetadata?.decimals ?? 18)
        const balance_formatted = truncateDecimals(formattedBalance)

        const usdExchangeRate = token.tokenPrices?.find((price: any) => price.currency === 'usd')?.value || '0'

        const usdValue = Number(balance_formatted) * Number(usdExchangeRate)
        const usdValueTruncated = truncateDecimals(usdValue, 2)

        return {
          address: token.tokenAddress,
          name: token.tokenMetadata.name,
          symbol: token.tokenMetadata.symbol,
          decimals: token.tokenMetadata.decimals,
          chain: networkConfig[token.chainId]?.name || '',
          network: networkConfig[token.chainId],
          logo: token.tokenMetadata.logo || undefined,
          type: tokenType,
          balance: token.tokenBalance,
          balance_formatted: balance_formatted,
          balance_usd_value: usdValueTruncated,
          exchange_rate: Number(usdExchangeRate),
        }
      }) as I_UserTokenBalance[]

      return tokenBalnces
    } catch (error) {
      const errMsg = axiosErrorMessage(error)
      notify('error', errMsg)

      throw error
    }
  }

  return useToastQuery({
    queryKey,
    queryFn,
    enabled: !!l1Address,
    // Data stays fresh for 1 minute, then triggers a background refetch
    // This means: instant cached data for 1 minute, then auto-refresh
    // staleTime: 60 * 1000, // 1 minute
    refetchInterval: 30 * 1000, // 1 minute
    // refetchIntervalInBackground: true,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    // refetchOnReconnect: true,
    meta: {
      persist: true,
    },
  })
}

/**
 * Hook to get NFTs for an address across multiple chains
 */
// -----------------------------------

export function useL1Faucet() {
  const { waapAddress: l1Address } = useWalletStore()
  const queryClient = useQueryClient()
  const bridge = useBridge()

  // Get wallet information from useWalletStore
  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()

  // L1 (Ethereum) balances and operations
  const { data: l1TokenBalances = [], isLoading: l1BalanceLoading, refetch: refetchL1Balance } = useL1TokenBalances()

  // native token
  const sepoliaNativeTokens = l1TokenBalances.find(
    (token) => token.type === 'native' && token.network?.chainId === L1_CHAIN_ID,
  )
  const l1NativeBalance = sepoliaNativeTokens?.balance_formatted

  const l1Balance = l1TokenBalances.find(
    (token) =>
      token.type === 'erc20' &&
      token.network?.chainId === L1_CHAIN_ID &&
      token.address === L1_TOKENS[0]?.l1TokenContract,
  )?.balance_formatted

  const notify = useToast()

  const mintNativeAmount = 0.01
  const mintTokenAmount = 10

  // Helper function to check if user has gas
  const hasGas = !!l1NativeBalance && Number(l1NativeBalance || 0) > mintNativeAmount

  // Check balances - only if balance data is loaded
  const balancesLoaded = !l1BalanceLoading
  const needsGas = balancesLoaded && (!l1NativeBalance || Number(l1NativeBalance || 0) <= mintNativeAmount)
  const needsTokens = balancesLoaded && Number(l1Balance || 0) <= mintTokenAmount

  // User is eligible for faucet if they need gas OR tokens
  // Check if user has gas but still needs tokens - they should be eligible for tokens only
  const isEligibleForFaucet = balancesLoaded && (needsGas || needsTokens)
  const needsTokensOnly = balancesLoaded && !needsGas && needsTokens

  // Main faucet function - handles both gas and tokens
  const requestFaucet = async () => {
    try {
      console.log('Requesting faucet funds...')

      // Wallet information is already available from useWalletStore hook

      // Log faucet request with enhanced data
      logInfo('Internal faucet request initiated', {
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        l1Address: l1Address,
        needsGas,
        needsTokens,
        network: 'Ethereum',
        token: 'USDC',
        faucetProvider: 'Internal API',
        faucetType: 'internal',
        userAction: 'faucet_request_initiated',
      })

      if (!l1Address) throw new Error('Wallet not connected')

      console.log('Starting faucet request with state:', {
        l1NativeBalance,
        l1Balance,
        hasGas,
        needsGas,
        needsTokens,
        isEligibleForFaucet,
        needsTokensOnly,
      })

      const result: any = { gasProvided: false, tokensMinted: false }

      // Step 1: If needed, get ETH for gas (only if not using external faucet)
      if (needsGas && !needsTokensOnly) {
        try {
          // Check if we should use external faucet for ETH
          // For now, we'll skip internal ETH faucet since it's disabled
          console.log('ETH needed but internal faucet is disabled. User should get ETH from external source.')
          result.gasProvided = false // Mark as not provided by internal API
        } catch (error) {
          console.log('Error requesting gas:', error)
          // Don't throw error here, continue to token minting
          result.gasProvided = false
        }
      }

      // Step 2: If needed, mint tokens
      if (needsTokens) {
        // Always try to mint tokens if user needs them
        console.log('Checking if tokens need to be minted...')

        const currentNativeBalance = result?.balances?.recipient?.after || l1NativeBalance

        // If user only needs tokens (has gas), proceed directly
        // If user needs both gas and tokens, check if they have enough gas
        const hasEnoughGas = needsTokensOnly || Number(currentNativeBalance || 0) >= mintNativeAmount

        if (hasEnoughGas) {
          console.log('User has gas. Requesting tokens from API...')
          try {
            // notify('info', 'Getting tokens...')
            // await wait(30000) // 30 seconds

            const mintResult = await bridge.mintTestTokens(l1Address, L1_TOKENS[0]?.l1TokenContract ?? '')
            result.tokensMinted = true
            result.tokenHash = mintResult.txHash
            console.log('Tokens minted successfully via API:', mintResult)
            // await wait(30000) // 30 seconds

            await refetchL1Balance()

            // Wait for the query to complete
            // await wait(30000) // 30 seconds
          } catch (error) {
            console.error('Token minting via API failed:', error)
            throw error
          }
        } else {
          console.log('User still does not have enough gas for receiving tokens')
          throw new Error('Not enough ETH for gas to receive tokens')
        }
      }

      return { success: true }
    } catch (error) {
      console.error('Faucet request failed:', error)

      // Wallet information is already available from useWalletStore hook

      // Log faucet failure with enhanced data
      logError('Internal faucet request failed', {
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        l1Address: l1Address,
        needsGas,
        needsTokens,
        network: 'Ethereum',
        token: 'USDC',
        faucetProvider: 'Internal API',
        faucetType: 'internal',
        userAction: 'faucet_request_failed',
        // extractErrorMessage peels apart axios/wallet errors so faucet
        // failures stay actionable in Datadog. Plain `error.message` returned
        // "Unknown error" for any non-Error object (most axios shapes).
        error: extractErrorMessage(error),
      })

      throw error
    }
  }

  return {
    ...useToastMutation({
      mutationFn: requestFaucet,
      onSuccess: (data) => {
        console.log('Faucet operations completed:', data)

        // Wallet information is already available from useWalletStore hook

        // Log faucet success with enhanced data
        logInfo('Internal faucet request successful', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address || '',
          chainId: chainId,
          l1Address: l1Address,
          needsGas,
          needsTokens,
          network: 'Ethereum',
          token: 'USDC',
          faucetProvider: 'Internal API',
          faucetType: 'internal',
          userAction: 'faucet_request_successful',
          success: data?.success,
        })

        // Wait a short delay to allow the transaction to be processed
        setTimeout(() => {
          // Invalidate both native and token balances to refresh them
          queryClient.invalidateQueries({
            queryKey: ['l1NativeBalance', l1Address],
          })
          queryClient.invalidateQueries({
            queryKey: ['l1TokenBalance', l1Address],
          })
        }, 10000) // 10 seconds
      },
      toastMessages: {
        pending: 'Processing faucet and token',
        success: 'Request for Faucet funds completed successfully',
        error: 'Faucet request failed',
      },
    }),
    needsGas,
    needsTokens,
    needsTokensOnly,
    isEligibleForFaucet,
    hasGas,
    l1BalanceLoading,
    balancesLoaded,
  }
}

// -----------------------------------

export function useL1BridgeToL2(onBridgeSuccess?: (data: any) => void) {
  const {
    waapAddress: l1Address,
    isWaapConnected,
    aztecAccount,
    aztecAddress,
    aztecLoginMethod,
    signWaapMessage,
  } = useWalletStore()

  // Get wallet information from useWalletStore
  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()

  const queryClient = useQueryClient()
  const {
    setProgressStep,
    setTransactionUrls,
    isPrivacyModeEnabled,
    bridgeConfig,
    fuelEnabled,
    fuelAmount: fuelAmountStr,
    fuelType,
  } = useBridgeStore()
  const notify = useToast()

  const walletAdapter = useWalletAdapter()
  const selectedToken = bridgeConfig.from.token ?? undefined
  const bridge = useBridge()

  const mutationFn = async (params: {
    amountL1: string
    amountL2: string
    amountDisplayL1: string
    amountDisplayL2: string
  }): Promise<string | undefined> => {
    const { amountDisplayL1, amountDisplayL2 } = params

    if (!l1Address) throw new Error('Ethereum wallet not connected')
    if (!aztecAddress) throw new Error('Aztec wallet not connected')
    if (!walletAdapter) throw new Error('Aztec wallet adapter not ready')

    // Forward the user's fuel selection to the SDK. The SDK handles V4 routing,
    // slippage, and sufficiency internally — the frontend only needs to say
    // "yes, use fuel, here's how much, here's the type".
    const fuel =
      fuelEnabled && fuelAmountStr
        ? {
            enabled: true,
            amount: fuelAmountStr,
            fuelType: (isPrivacyModeEnabled ? 'private' : fuelType) as 'public' | 'private',
          }
        : undefined

    const result = await bridge.bridgeL1ToL2({
      token: selectedToken?.symbol ?? 'USDC',
      amount: amountDisplayL1,
      l1Address,
      l2Address: aztecAddress,
      isPrivate: isPrivacyModeEnabled ?? false,
      fuel,
      sendTransaction: async (tx) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx])) as string
      },
      walletAdapter: walletAdapter as any,
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        const sig = await signWaapMessage(msg)
        if (!sig) throw new Error('Failed to sign message')
        return sig
      },
      signTypedData: async (address: string, typedDataJson: string) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_signTypedData_v4, [address, typedDataJson])) as string
      },
      onStep: (step: number, status: StepStatus) => {
        setProgressStep(step, status)
      },
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case 'do_not_reload':
            // Persistent banner — stays up until deposit_sent / deposit_confirmed
            // arrives. Tab close at this point loses recovery state.
            notify(
              'warn',
              {
                heading: 'Do Not Reload',
                message:
                  'Your deposit transaction is being prepared. Closing or reloading this page now may make recovery harder.',
              },
              { autoClose: false, toastId: 'l1-to-l2-do-not-reload' },
            )
            break
          // Persist encrypted payload on secrets_generated (recovery-critical)
          case 'secrets_generated':
            console.log('[L1→L2] Secrets generated, encrypted payload persisted to localStorage via SDK')
            notify(
              'warn',
              {
                heading: 'Backup Available',
                message:
                  'Your deposit data is encrypted and backed up — only you can access it. For extra safety, click here to export a local copy — useful if you ever need to recover manually',
              },
              {
                autoClose: false,
                onClick: () => {
                  try {
                    const claims = localStorage.getItem(STORAGE_KEYS.deposits)
                    if (claims) {
                      const parsed = JSON.parse(claims)
                      const latest = parsed.filter((c: any) => !c.success).pop()
                      if (latest) exportClaimData(latest)
                    }
                  } catch (e) {
                    console.error('[L1→L2] Failed to export claim data on toast click:', e)
                  }
                },
              },
            )
            break
          // Track operation ID for correlation
          case 'operation_created':
            logInfo('Bridge operation created', {
              direction: 'L1_TO_L2',
              operationId: event.operationId,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_created',
            })
            console.log('[L1→L2] Operation created:', event.operationId)
            break
          case 'deposit_sent':
            logInfo('L1 deposit tx sent', {
              direction: 'L1_TO_L2',
              l1TxHash: event.l1TxHash,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_deposit_sent',
            })
            setTransactionUrls(event.l1TxUrl, null)
            notify(
              'warn',
              {
                heading: 'Deposit In Progress',
                message:
                  'Please keep this page open while your deposit completes. Your data is encrypted and backed up — only you can access it.',
              },
              { autoClose: false },
            )
            break
          case 'deposit_confirmed':
            logInfo('L1 deposit confirmed', {
              direction: 'L1_TO_L2',
              l1TxHash: event.l1TxHash,
              messageHash: event.messageHash,
              messageLeafIndex: event.messageLeafIndex,
              hasFuel: !!event.fuelMessageHash,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_deposit_confirmed',
            })
            setTransactionUrls(event.l1TxUrl, null)
            // Prompt user to backup their claim secret (matches old flow)
            notify(
              'warn',
              {
                heading: 'Deposit Confirmed',
                message:
                  'Your deposit is confirmed on L1. Click here to export a full backup — this includes all the data needed to resume if anything interrupts the process.',
              },
              {
                autoClose: false,
                onClick: () => {
                  try {
                    const claims = localStorage.getItem(STORAGE_KEYS.deposits)
                    if (claims) {
                      const parsed = JSON.parse(claims)
                      // Find the most recent pending claim
                      const latest = parsed.filter((c: any) => !c.success).pop()
                      if (latest) exportClaimData(latest)
                    }
                  } catch (e) {
                    console.error('[L1→L2] Failed to export claim data on toast click:', e)
                  }
                },
              },
            )
            break
          // sequencer wait between sync and claim — used to be silent for ~19 min.
          case 'l2_block_wait':
            logInfo('L1→L2 sequencer block wait', {
              direction: 'L1_TO_L2',
              elapsedSec: event.elapsedSec,
              currentBlock: event.currentBlock,
              targetBlock: event.targetBlock,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_sequencer_wait',
            })
            notify(
              'info',
              `Waiting for L2 sequencer to include message (${Math.round(event.elapsedSec / 60)}m elapsed)...`,
              { toastId: 'l1-to-l2-progress', autoClose: 15000 },
            )
            break
          // token registration observability.
          case 'token_registered':
            logInfo('Token added to wallet after bridge', {
              direction: 'L1_TO_L2',
              tokenAddressL2: event.tokenAddressL2,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'token_added_to_wallet',
            })
            break
          case 'token_registration_failed':
            logError(
              'Failed to add token to wallet after bridge',
              {
                direction: 'L1_TO_L2',
                tokenAddressL2: event.tokenAddressL2,
                l1Address,
                l2Address: aztecAddress,
                userAction: 'token_add_to_wallet_failed',
              },
              event.error,
            )
            break
          // Show sync progress to prevent users from force-closing
          case 'sync_poll':
            logInfo('L1→L2 sync poll', {
              direction: 'L1_TO_L2',
              elapsedMinutes: event.elapsedMinutes,
              synced: event.synced,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_sync_poll',
            })
            notify('info', `Waiting for L1→L2 message sync (${event.elapsedMinutes.toFixed(0)} min elapsed)...`, {
              toastId: 'l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case 'claim_attempt':
            logInfo('L2 claim attempt', {
              direction: 'L1_TO_L2',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_claim_attempt',
            })
            notify('info', `Claiming tokens on L2 (attempt ${event.attempt}/${event.maxAttempts})...`, {
              toastId: 'l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case 'claim_retry':
            logInfo('L2 claim retry', {
              direction: 'L1_TO_L2',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_l1_to_l2_claim_retry',
            })
            notify(
              'info',
              `L2 node hasn't synced this message yet. Retrying in ${Math.round(event.delayMs / 60_000)} min (${event.attempt}/${event.maxAttempts})...`,
              { toastId: 'l1-to-l2-progress', autoClose: 15000 },
            )
            break
          case 'operation_completed': {
            const l1Url = event.l1TxHash ? `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}` : null
            const l2Url = event.l2TxHash ? `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${event.l2TxHash}` : null
            setTransactionUrls(l1Url, l2Url)
            break
          }
          case 'attestation_fetch':
            logInfo('Attestation fetch', {
              direction: 'L1_TO_L2',
              method: event.method,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_attestation_fetch',
            })
            break
          case 'attestation_fallback':
            logInfo('Attestation cascade fallback', {
              direction: 'L1_TO_L2',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_attestation_fallback',
            })
            break
          case 'patch_failed':
            // Observability: PATCH failures mean server-side state drift from
            // the actual on-chain state. If these spike we need to know fast,
            // otherwise resume flows silently rely on localStorage/queue fallback.
            logError(`Bridge PATCH failed: ${event.label}`, {
              direction: 'L1_TO_L2',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address,
              l2Address: aztecAddress,
              userAction: 'bridge_patch_failed',
            })
            notify(
              'warn',
              {
                heading: 'Backup Warning',
                message:
                  'Could not save recovery data to server. Please do not close this page until the bridge completes.',
              },
              { autoClose: false },
            )
            break
          case 'error': {
            // classify the error so Datadog dashboards/alerts can segment
            // congestion vs. contract revert vs. claim failure vs. sync timeout
            // vs. funds-at-risk vs. generic. Without these tags, all bridge
            // failures collapse into a single user_action and alerting can't
            // distinguish "the network is broken" from "this user's claim failed".
            const errorMsgForLog = event.error?.message ?? 'Bridge error event'
            const isCongestion =
              errorMsgForLog.includes('"path":["revertReason","functionErrorStack",0,"functionSelector"]') ||
              (errorMsgForLog.includes('invalid_type') && errorMsgForLog.includes('functionSelector'))
            const isReloadable = errorMsgForLog.includes('0xfb8f41b2')
            const isArtifact =
              errorMsgForLog.includes('Contract artifact not found') ||
              errorMsgForLog.includes('artifact not found') ||
              (errorMsgForLog.includes('artifact') && errorMsgForLog.includes('not found'))
            // SDK now throws "L1-to-L2 message sync timeout after ..." —
            // detect it so the dedicated user_action persists.
            const isSyncTimeout =
              errorMsgForLog.includes('message sync timeout') || errorMsgForLog.includes('sync timeout after')
            let errorTag: string
            let errorUserAction: string
            if (event.fundsAtRisk) {
              errorTag = 'claim_failed'
              errorUserAction = 'bridge_l1_to_l2_claim_failed'
            } else if (isCongestion) {
              errorTag = 'congestion'
              errorUserAction = 'bridge_l1_to_l2_congestion_error'
            } else if (isReloadable) {
              errorTag = 'contract_revert'
              errorUserAction = 'bridge_l1_to_l2_contract_error'
            } else if (isArtifact) {
              errorTag = 'artifact_not_found'
              errorUserAction = 'bridge_l1_to_l2_artifact_error'
            } else if (isSyncTimeout) {
              errorTag = 'sync_timeout'
              errorUserAction = 'bridge_l1_to_l2_sync_timeout'
            } else {
              errorTag = 'unknown'
              errorUserAction = 'bridge_l1_to_l2_error'
            }
            logError(
              errorMsgForLog,
              {
                direction: 'L1_TO_L2',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address,
                l2Address: aztecAddress,
                amount: amountDisplayL1,
                isPrivacyModeEnabled,
                errorType: errorTag,
                ...(isReloadable ? { errorSignature: '0xfb8f41b2' } : {}),
                userAction: errorUserAction,
              },
              event.error,
            )
            if (event.fundsAtRisk) {
              notify(
                'warn',
                {
                  heading: 'L2 Claim Failed — Funds Are Safe',
                  message: 'Your deposit confirmed on L1 but the L2 claim did not complete. Go to Activity to resume.',
                },
                { autoClose: false },
              )
            } else {
              // Skip generic toast for backup failures — onError handler shows a more specific one
              const errorMsg = event.error?.message ?? 'Unknown error'
              if (errorMsg.includes('Failed to backup')) break

              // classify the error so the user gets actionable copy
              // instead of a raw on-chain revert string.
              const isCongestion =
                errorMsg.includes('"path":["revertReason","functionErrorStack",0,"functionSelector"]') ||
                (errorMsg.includes('invalid_type') && errorMsg.includes('functionSelector'))
              const isReloadable = errorMsg.includes('0xfb8f41b2')
              const isArtifact =
                errorMsg.includes('Contract artifact not found') ||
                errorMsg.includes('artifact not found') ||
                (errorMsg.includes('artifact') && errorMsg.includes('not found'))

              if (isCongestion) {
                notify(
                  'error',
                  'The Aztec Testnet is congested right now. Unfortunately your transaction was dropped.',
                  { autoClose: false },
                )
              } else if (isReloadable) {
                notify('error', 'Bridge transaction failed (error: 0xfb8f41b2). Please reload the page.')
              } else if (isArtifact) {
                notify('error', {
                  heading: 'Contract Artifact Not Found',
                  message:
                    'The contract artifact is not available in the public registry. Please upload it to https://testnet.aztec-registry.xyz/ to make it available for the wallet.',
                })
              } else {
                notify('error', {
                  heading: 'Deposit Failed — No Funds Moved',
                  message:
                    'The transaction was not sent. Your balance is unchanged and no recovery is needed. You can safely retry.',
                })
              }
            }
            break
          }
        }
      },
    })

    // Log completion
    logInfo('Bridge from L1 to L2 completed', {
      walletType: WalletType.WAAP,
      loginMethod,
      walletProvider,
      address: l1Address,
      chainId,
      aztecLoginMethod,
      aztecAddress,
      direction: 'L1_TO_L2',
      fromNetwork: 'Ethereum',
      toNetwork: 'Aztec',
      fromToken: selectedToken?.symbol ?? 'USDC',
      toToken: selectedToken?.pairedSymbol ?? 'cUSDC',
      amount: amountDisplayL1,
      l1Address,
      l2Address: aztecAddress,
      l1TxHash: result.l1TxHash,
      l2TxHash: result.l2TxHash,
      isPrivacyModeEnabled,
      userAction: 'bridge_l1_to_l2_completed',
    })

    return result.l2TxHash
  }

  return useMutation({
    mutationFn,
    onSuccess: (txHash) => {
      // Refresh balances (L1→L2 bridge completed)
      queryClient.invalidateQueries({
        queryKey: ['l1TokenBalances', l1Address],
      })
      queryClient.invalidateQueries({ queryKey: ['l1TokenBalance', l1Address] })
      queryClient.invalidateQueries({
        queryKey: ['l2TokenBalance', aztecAddress],
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
            heading: 'Backup Failed — Bridge Aborted',
            message: errorMessage.length > 200 ? errorMessage.slice(0, 200) + '...' : errorMessage,
          },
          { autoClose: false },
        )
      }
    },
  })
}

// -----------------------------------

/**
 * Hook to export L1→L2 claim data for backup
 *
 * This allows users to backup their claimSecret and other critical data
 * to prevent permanent fund loss if localStorage is cleared.
 */
export function useExportClaimData() {
  const notify = useToast()

  const exportClaim = (claimId: string) => {
    try {
      const existingClaims = localStorage.getItem(STORAGE_KEYS.deposits)
      if (!existingClaims) {
        notify('error', 'No claim data found')
        return
      }

      const claims = JSON.parse(existingClaims)
      const claim = claims.find((c: any) => c.id === claimId)

      if (!claim) {
        notify('error', 'Claim not found')
        return
      }

      exportClaimData(claim)
      notify('success', 'Claim data exported successfully! Save this file in a safe place.')
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      notify('error', `Failed to export claim data: ${errorMessage}`)
    }
  }

  const copyClaimSecret = async (claimId: string) => {
    try {
      const result = await decryptStorageEntry(
        STORAGE_KEYS.deposits,
        claimId,
        'claimSecret',
        async (msg, addr) => (await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, addr])) as string,
      )

      if (!result) {
        notify('error', 'Encrypted claim data not found')
        return false
      }

      logInfo('bridge.decrypt_claim_secret', {
        l1Address: result.entry.l1Address,
        operationId: result.entry.id,
        tokenSymbol: result.entry.tokenSymbol,
        amount: result.entry.amount?.toString(),
        userAction: 'copy_claim_secret',
      })

      const success = await copyToClipboard(result.value)
      if (success) {
        notify('success', 'Claim secret copied to clipboard!')
        return true
      } else {
        notify('error', 'Failed to copy to clipboard')
        return false
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      notify('error', `Failed to copy claim secret: ${errorMessage}`)
      return false
    }
  }

  const getAllPendingClaims = () => {
    try {
      const existingClaims = localStorage.getItem(STORAGE_KEYS.deposits)
      if (!existingClaims) {
        return []
      }

      const claims = JSON.parse(existingClaims)
      // Return claims that are not yet completed
      return claims.filter((c: any) => !c.success)
    } catch (error) {
      console.error('Failed to get pending claims:', error)
      return []
    }
  }

  return {
    exportClaim,
    copyClaimSecret,
    getAllPendingClaims,
  }
}

// -----------------------------------

/**
 * Hook to check if an address has a soulbound token on L1
 */
export function useL1HasSoulboundToken() {
  const { waapAddress: l1Address, isWaapConnected } = useWalletStore()
  const notify = useToast()

  const queryKey = ['l1HasSoulboundToken', l1Address]
  const queryFn = async () => {
    if (!l1Address) return false

    try {
      const data = encodeFunctionData({
        abi: PortalSBTAbi,
        functionName: 'hasSoulboundToken',
        args: [l1Address],
      })

      const hasSBT = await requestWaapWallet(WAAP_METHOD.eth_call, [
        {
          to: ADDRESS[L1_CHAIN_ID].L1.PORTAL_SBT_CONTRACT,
          data,
        },
      ])

      return Boolean(hasSBT)
    } catch (error) {
      console.error('Error checking L1 SBT status:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      // Don't toast for wallet-locked errors — user just needs to unlock
      if (!errorMessage.includes('locked')) {
        notify('error', 'Failed to check SBT status on Ethereum: ' + errorMessage)
      }
      return false
    }
  }

  return useToastQuery({
    queryKey,
    queryFn,
    enabled: !!l1Address && isWaapConnected,
    // staleTime: 60 * 1000, // 1 minute
    // toastMessages: {
    //   pending: 'Checking SBT status on Ethereum...',
    //   success: 'SBT status checked successfully on Ethereum!',
    //   error: 'Failed to check SBT status on Ethereum',
    // },
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

// -----------------------------------

/**
 * Hook to mint a soulbound token on L1
 */
export function useL1MintSoulboundToken(onSuccess: (data: any) => void) {
  const { waapAddress: l1Address } = useWalletStore()

  const notify = useToast()

  const mutationFn = async () => {
    if (!l1Address) {
      throw new Error('Wallet not connected')
    }

    try {
      // Prepare the mint transaction
      const data = encodeFunctionData({
        abi: PortalSBTAbi,
        functionName: 'mint',
        args: [],
      })

      // Send the transaction
      const txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
        {
          from: l1Address,
          to: ADDRESS[L1_CHAIN_ID].L1.PORTAL_SBT_CONTRACT,
          data,
        },
      ])

      // Wait for confirmation
      const receipt = await requestWaapWallet(WAAP_METHOD.eth_getTransactionReceipt, [txHash])
      const txHashStr = receipt?.transactionHash?.toString()

      const etherscanUrl = `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${txHashStr}`
      notify('info', `SBT minted successfully on Ethereum! Click to view on Ethereum`, {
        onClick: () => {
          window.open(etherscanUrl, '_blank')
        },
        closeOnClick: false,
        style: { cursor: 'pointer' },
      })

      console.log('SBT minted successfully on L1', { receipt })
      return receipt
    } catch (error) {
      console.log('Failed to mint SBT on L1', { error })
      throw error
    }
  }

  return useToastMutation({
    mutationFn,
    onSuccess: (data) => {
      onSuccess(data)
    },
    onError: (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      notify('error', errorMessage)
    },
    // toastMessages: {
    //   pending: 'Minting SBT on Ethereum...',
    //   success: 'SBT minted successfully on Ethereum!',
    //   error: 'Failed to mint SBT on Ethereum',
    // },
  })
}
