import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { useBridgeStore } from '@/stores/bridgeStore'
import {
  truncateDecimals,
  wait,
  exportClaimData,
  copyToClipboard,
} from '@/utils'
import axios from 'axios'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { useWalletAdapter } from './useWalletAdapter'
import {
  ADDRESS,
  getAztecscanUrl,
  L1_CHAIN_ID,
  L1_TOKENS,
  L2_CHAIN_ID,
} from '@/config'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { TestERC20Abi } from '@aztec/l1-artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { formatUnits, encodeFunctionData } from 'viem'
import PortalSBTJson from '../constants/PortalSBT.json'
import { useToast, useToastMutation, useToastQuery } from './useToast'
import {
  requestWaapWallet,
  useWalletStore,
  WAAP_METHOD,
} from '@/stores/walletStore'
import {
  I_UserTokenBalance,
  T_AlchemyTokenBalanceResponse,
  T_UserTokenType,
} from '@/types/token.balances.types'
import { axiosErrorMessage } from './helper'
import { networkConfig, silkUrl } from '@/config/l1.config'
import {
  LS_KEY_BRIDGE_DEPOSITS,
  patchOperationAsync,
  updateLocalStorageItem,
} from './bridge/bridgeUtils'
import {
  pollL1ToL2MessageSync,
  executeL2Claim,
} from './bridge/bridgeL1ToL2'
import {
  validateAndCaptureBlocks,
  generateAndBackupClaimSecret,
  checkAndApproveAllowance,
  sendL1DepositTransaction,
  waitForReceiptAndExtractEvent,
  persistReceiptToBackend,
  finalizeLocalStorageAfterDeposit,
  type FuelParams,
  type PrivateFuelParams,
} from './bridge/bridgeL1ToL2'
import {
  BRIDGE_AND_FUEL_ADDRESS,
  BRIDGED_FPC_ADDRESS,
  MOCK_FUEL_SWAP_ADDRESS,
} from '@/config'
import { getMockFuelQuote } from '@/utils/fuelQuote'

// Fix the bytecode format
const PortalSBTAbi = PortalSBTJson.abi

export function useL1NativeBalance() {
  const { waapAddress: l1Address } = useWalletStore()

  const queryKey = ['l1NativeBalance', l1Address]
  const queryFn = async () => {
    if (!l1Address) return null

    const chainIds = [L1_CHAIN_ID]

    try {
      const url = `${silkUrl}/api/alchemy/tokens-balances`

      const response = await axios.post<T_AlchemyTokenBalanceResponse[]>(url, {
        address: l1Address,
        chains: chainIds,
      })

      const tokens = response?.data
    } catch (error) {
      // Error handled silently - return 0 balance
    }

    return 0
  }

  return useQuery({
    queryKey,
    queryFn,
    enabled: !!l1Address,
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

// -----------------------------------

export function useL1TokenBalance() {
  const { waapAddress: l1Address } = useWalletStore()

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
    enabled: !!l1Address,
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

  const queryKey = ['l1TokenBalances', l1Address]
  const queryFn = async () => {
    try {
      const response = await axios.post<T_AlchemyTokenBalanceResponse[]>(
        '/api/alchemy/tokens-balances',
        {
          address: l1Address,
          chains: [L1_CHAIN_ID], // Sepolia testnet
        },
      )

      const tokens = response?.data

      const tokenBalnces = tokens?.map(
        (token: T_AlchemyTokenBalanceResponse) => {
          let tokenType: T_UserTokenType

          if (!token.tokenAddress || token.tokenAddress === null) {
            tokenType = 'native'
          } else {
            tokenType = 'erc20'
          }

          const formattedBalance = formatUnits(
            BigInt(token.tokenBalance),
            token?.tokenMetadata?.decimals ?? 18,
          )
          const balance_formatted = truncateDecimals(formattedBalance)

          const usdExchangeRate =
            token.tokenPrices?.find((price: any) => price.currency === 'usd')
              ?.value || '0'

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
        },
      ) as I_UserTokenBalance[]

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

  // Get wallet information from useWalletStore
  const {
    waapLoginMethod: loginMethod,
    waapWalletProvider: walletProvider,
    waapChainId: chainId,
  } = useWalletStore()

  // L1 (Ethereum) balances and operations
  const {
    data: l1TokenBalances = [],
    isLoading: l1BalanceLoading,
    refetch: refetchL1Balance,
  } = useL1TokenBalances()

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
  const hasGas =
    !!l1NativeBalance && Number(l1NativeBalance || 0) > mintNativeAmount

  // Check balances - only if balance data is loaded
  const balancesLoaded = !l1BalanceLoading
  const needsGas =
    balancesLoaded &&
    (!l1NativeBalance || Number(l1NativeBalance || 0) <= mintNativeAmount)
  const needsTokens =
    balancesLoaded && Number(l1Balance || 0) <= mintTokenAmount

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
          console.log(
            'ETH needed but internal faucet is disabled. User should get ETH from external source.',
          )
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

        const currentNativeBalance =
          result?.balances?.recipient?.after || l1NativeBalance

        // If user only needs tokens (has gas), proceed directly
        // If user needs both gas and tokens, check if they have enough gas
        const hasEnoughGas =
          needsTokensOnly ||
          Number(currentNativeBalance || 0) >= mintNativeAmount

        if (hasEnoughGas) {
          console.log('User has gas. Requesting tokens from API...')
          try {
            // notify('info', 'Getting tokens...')
            // await wait(30000) // 30 seconds

            // Call our mint-tokens API endpoint with the first token address
            const { data: mintResult } = await axios.post<{ txHash?: string }>(
              '/api/mint-tokens',
              { address: l1Address, tokenAddress: L1_TOKENS[0]?.l1TokenContract },
            )
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
          console.log(
            'User still does not have enough gas for receiving tokens',
          )
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
        error: error instanceof Error ? error.message : 'Unknown error',
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
export function useL1MintTokens() {
  const { waapAddress: l1Address } = useWalletStore()
  const queryClient = useQueryClient()
  const { data: nativeBalance } = useL1NativeBalance()
  const { data: tokenBalance } = useL1TokenBalance()

  // Check if user has enough gas for minting
  const hasGas = !!nativeBalance && Number(nativeBalance) > 0.01

  // Check if user already has tokens
  const hasTokens = !!tokenBalance && Number(tokenBalance) > 0

  // User is eligible to mint tokens if they have gas but no tokens
  const isEligibleForTokens = hasGas && !hasTokens

  const mutationFn = async () => {
    if (!l1Address) throw new Error('Wallet not connected')

    // Check eligibility
    if (!hasGas) {
      throw new Error(
        'Not enough ETH for gas. Please get ETH from the faucet first.',
      )
    }

    const mintAmount = BigInt(1000000000000000000)

    console.log('Minting tokens for address:', l1Address)

    // Prepare the transaction data
    const data = encodeFunctionData({
      abi: TestERC20Abi,
      functionName: 'mint',
      args: [l1Address, mintAmount],
    })

    // Send the transaction
    const txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
      {
        from: l1Address,
        to: L1_TOKENS[0]?.l1TokenContract ?? '',
        data,
      },
    ])
    console.log('Mint transaction sent, hash:', txHash)

    // Wait for confirmation
    const receipt = await requestWaapWallet(
      WAAP_METHOD.eth_getTransactionReceipt,
      [txHash],
    )
    console.log('Mint transaction confirmed, receipt:', receipt)
    return receipt
  }

  return {
    ...useToastMutation({
      mutationFn,
      onSuccess: () => {
        console.log('Refetching balances after successful mint')
        // Invalidate both balances to refresh them
        queryClient.invalidateQueries({
          queryKey: ['l1TokenBalance', l1Address],
        })
        queryClient.invalidateQueries({
          queryKey: ['l1NativeBalance', l1Address],
        })
      },
      toastMessages: {
        pending: 'Minting tokens...',
        success: 'Tokens successfully minted!',
        error: 'Failed to mint tokens',
      },
    }),
    hasGas,
    hasTokens,
    isEligibleForTokens,
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
  const {
    waapLoginMethod: loginMethod,
    waapWalletProvider: walletProvider,
    waapChainId: chainId,
  } = useWalletStore()

  const queryClient = useQueryClient()
  const { setProgressStep, setTransactionUrls, isPrivacyModeEnabled, bridgeConfig, fuelEnabled, fuelAmount: fuelAmountStr, fuelType } =
    useBridgeStore()
  const notify = useToast()

  const walletAdapter = useWalletAdapter()
  const selectedToken = bridgeConfig.from.token ?? undefined

  const mutationFn = async (params: {
    amountL1: string
    amountL2: string
    amountDisplayL1: string
    amountDisplayL2: string
  }): Promise<string | undefined> => {
    const { amountL1, amountL2, amountDisplayL1, amountDisplayL2 } = params
    const amount = BigInt(amountL1)

    // Build fuel params if fuel is enabled (public L1→L2 only)
    let fuel: FuelParams | undefined
    let privateFuel: PrivateFuelParams | undefined
    if (fuelEnabled && !isPrivacyModeEnabled && fuelAmountStr) {
      const fuelAmountTokenUnits = BigInt(
        Math.floor(Number(fuelAmountStr) * 10 ** (selectedToken?.decimals ?? 6))
      )
      if (fuelAmountTokenUnits > 0n && fuelAmountTokenUnits < amount) {
        if (fuelType === 'private' && BRIDGED_FPC_ADDRESS && BRIDGE_AND_FUEL_ADDRESS && MOCK_FUEL_SWAP_ADDRESS) {
          // Private fuel (BridgedFPC): swap via BridgeAndFuel, FJ deposited to FPC, then claim+mint on L2
          const fuelQuote = getMockFuelQuote({
            mockFuelSwapAddress: MOCK_FUEL_SWAP_ADDRESS,
            bridgeTokenAddress: (selectedToken?.l1TokenContract ?? '') as `0x${string}`,
            fuelAmount: fuelAmountTokenUnits,
            inputDecimals: selectedToken?.decimals ?? 6,
          })
          fuel = { fuelAmount: fuelAmountTokenUnits, fuelQuote }
          privateFuel = { fuelAmount: fuelAmountTokenUnits, fpcAddress: BRIDGED_FPC_ADDRESS }
          console.log('[L1→L2] Private fuel (BridgedFPC) enabled:', { fuelAmount: fuelAmountTokenUnits.toString(), fpcAddress: BRIDGED_FPC_ADDRESS, expectedOutput: fuelQuote.expectedOutput.toString() })
        } else if (fuelType === 'public' && BRIDGE_AND_FUEL_ADDRESS && MOCK_FUEL_SWAP_ADDRESS) {
          // Public fuel: swap tokens → FJ via BridgeAndFuel
          const fuelQuote = getMockFuelQuote({
            mockFuelSwapAddress: MOCK_FUEL_SWAP_ADDRESS,
            bridgeTokenAddress: (selectedToken?.l1TokenContract ?? '') as `0x${string}`,
            fuelAmount: fuelAmountTokenUnits,
            inputDecimals: selectedToken?.decimals ?? 6,
          })
          fuel = { fuelAmount: fuelAmountTokenUnits, fuelQuote }
          console.log('[L1→L2] Public fuel enabled:', { fuelAmount: fuelAmountTokenUnits.toString(), expectedOutput: fuelQuote.expectedOutput.toString() })
        }
      }
    }
    if (!l1Address) {
      throw new Error('Ethereum wallet not connected')
    }
    if (!aztecAddress) {
      throw new Error('Aztec wallet not connected')
    }

    let operationId: string | undefined
    // 🔒 Track whether L1 deposit has been confirmed (funds are locked on L1).
    // If true, the outer catch must NEVER mark the operation as 'failed' — it stays
    // 'deposited' so the user can Resume the L2 claim from the activity page.
    let depositConfirmed = false
    // Track receipt data for error logging
    let receiptData: { messageHashStr?: string; messageLeafIndexStr?: string; l1TxHash?: string } = {}
    try {
      // ─── Step 1: Validate wallets and capture block numbers ──────────
      setProgressStep(1, 'active')
      console.log('Initiating bridge tokens to L2...')

      const { nodeInfo, l1BlockNumberBeforeTx, l2BlockNumberBeforeTx } =
        await validateAndCaptureBlocks(l1Address, aztecAddress, walletAdapter, {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          amount: amount.toString(),
        }, selectedToken)

      // ─── Step 2: Generate secret, encrypt, backup to server ─────────
      const backup = await generateAndBackupClaimSecret({
        l1Address,
        aztecAddress,
        amountL1,
        amountL2,
        amountDisplayL1,
        amountDisplayL2,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? false,
        l1BlockNumberBeforeTx,
        l2BlockNumberBeforeTx,
        nodeInfo,
        signWaapMessage,
        selectedToken,
        fuel,
        privateFuel,
      })
      operationId = backup.operationId

      // ─── Step 3: Check allowance and approve ────────────────────────
      await checkAndApproveAllowance(l1Address, amount, selectedToken, fuel)

      // ─── Step 4: Send L1 deposit transaction ────────────────────────
      // ═══ DANGER ZONE: tokens are locked on L1 after this ═══
      notify('warn', {
        heading: 'Do Not Reload',
        message: 'Your deposit is in progress. Please do not reload or close this page until it completes, or it may be difficult to recover your funds.',
      }, { autoClose: false })

      const deposit = await sendL1DepositTransaction({
        l1Address,
        aztecAddress,
        amount,
        claimSecretHash: backup.claimSecretHash,
        claimSecret: backup.claimSecret,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? false,
        operationId: backup.operationId,
        selectedToken,
        // Public fuel: needs fuelSecretHash from backup (random secret).
        // Private fuel: fuel is passed for the swap quote, but fuelSecretHash is a dummy
        // (overridden by privateFuel.secretHash in sendL1DepositTransaction).
        fuel: fuel ? {
          ...fuel,
          fuelSecretHash: backup.fuelSecretHash ?? backup.privateFuelSecretHash!,
        } : undefined,
        privateFuel: privateFuel && backup.privateFuelSecretHash ? {
          ...privateFuel,
          secretHash: backup.privateFuelSecretHash,
        } : undefined,
      })
      // 🔒 Funds are now POTENTIALLY locked on L1 — from this point, the outer catch must
      // NEVER mark the operation as 'failed'.
      depositConfirmed = true

      // ─── Step 5: Wait for receipt and extract event ─────────────────
      const receipt = await waitForReceiptAndExtractEvent({
        txHash: deposit.txHash,
        amount,
        claimSecretHash: backup.claimSecretHash,
        claimSecret: backup.claimSecret,
        aztecAddress,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? false,
        l1Address,
        selectedToken,
        fuel,
      })
      receiptData = receipt
      setTransactionUrls(receipt.l1TxUrl, null)

      // ─── Step 6: Persist receipt to backend ─────────────────────────
      const receiptPatchSucceeded = await persistReceiptToBackend(operationId, receipt)
      if (!receiptPatchSucceeded) {
        notify(
          'warn',
          {
            heading: 'Backup Warning',
            message:
              'Could not save recovery data to server. Please do not close this page until the bridge completes. If you must leave, export your claim secret first.',
          },
          { autoClose: false },
        )
      }

      // ─── Step 7: Update localStorage with full deposit details ──────
      const { updatedClaim, wasExisting } = finalizeLocalStorageAfterDeposit({
        claimSecret: backup.claimSecret,
        claimSecretHash: backup.claimSecretHash,
        claimAmount: amount,
        l1Address,
        aztecAddress,
        messageHashStr: receipt.messageHashStr,
        messageLeafIndexStr: receipt.messageLeafIndexStr,
        l1TxHash: receipt.l1TxHash,
        l1TxUrl: receipt.l1TxUrl,
        l1BlockNumberBeforeTx,
        nodeInfo,
        isPrivacyModeEnabled: isPrivacyModeEnabled ?? false,
      })

      if (wasExisting && updatedClaim) {
        notify(
          'warn',
          {
            heading: '⚠️ Backup Your Claim Secret!',
            message:
              'Your tokens are now locked. If you lose your claim secret, your funds will be permanently lost. Please export or copy your claim secret now.',
          },
          {
            autoClose: false,
            onClick: () => {
              exportClaimData(updatedClaim)
            },
          },
        )
      }

      // ─── Step 8: Poll for L1→L2 message sync ───────────────────────
      setProgressStep(1, 'completed')
      setProgressStep(2, 'active')

      // Poll for all messages in parallel (token + fuel + private fuel)
      const syncPromises: Promise<any>[] = [
        pollL1ToL2MessageSync(receipt.messageHash.toString()),
      ]
      if (receipt.fuelMessageHash) {
        syncPromises.push(pollL1ToL2MessageSync(receipt.fuelMessageHash.toString()))
      }
      const syncResults = await Promise.all(syncPromises)
      const syncResult = syncResults[0]

      if (!syncResult.synced) {
        const errorMessage = `L1-to-L2 message sync timeout after ${syncResult.elapsedMinutes.toFixed(1)} minutes`
        console.error(errorMessage)

        logError('L1-to-L2 message sync timeout', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          messageHash: receipt.messageHash.toString(),
          messageLeafIndex: receipt.messageLeafIndex.toString(),
          elapsedMinutes: syncResult.elapsedMinutes,
          maxWaitMinutes: 20,
          userAction: 'bridge_l1_to_l2_sync_timeout',
        })

        throw new Error(errorMessage)
      }

      // Extra buffer so the message is visible on the wallet's node
      console.log('[L1→L2] Final wait before claiming (2 min)...')
      await wait(120_000)

      // ─── Step 9: Claim on L2 ───────────────────────────────────────
      setProgressStep(2, 'completed')
      setProgressStep(3, 'active')
      patchOperationAsync(operationId, { currentStep: 3 })

      try {
        if (!walletAdapter) {
          throw new Error(
            'Aztec wallet not connected or bridge contract not initialized',
          )
        }

        // Build fee payment method for the L2 claim transaction:
        // - Public fuel: FeeJuicePaymentMethodWithClaim (claim FJ to user, pay gas)
        // - Private fuel: BridgedMintAndPayFeePaymentMethod (FeeJuice.claim + mint_and_pay_fee, all private)
        let feeOption: { fee: { paymentMethod: any; gasSettings?: any } } | undefined
        if (privateFuel && backup.privateFuelSecret && backup.privateFuelSalt && receipt.fuelMessageLeafIndex != null && receipt.fuelAmount) {
          try {
            const { BridgedMintAndPayFeePaymentMethod, REASONABLE_GAS_LIMITS, maxFeesPerGasFromBaseFees, maxGasCostFor } =
              await import('@defi-wonderland/aztec-fee-payment')
            const { Fr: FieldFr } = await import('@aztec/aztec.js/fields')
            const { Gas, GasFees } = await import('@aztec/stdlib/gas')
            const { aztecNode } = await import('@/aztec')

            // Query current base fees and compute gas settings
            // (mirrors getGasSetup in aztec-fee-payment tests)
            const baseFees = await aztecNode.getCurrentMinFees()
            const maxFeesPerGas = maxFeesPerGasFromBaseFees(baseFees)
            const gasLimits = REASONABLE_GAS_LIMITS
            const teardownGasLimits = Gas.from({ l2Gas: 0, daGas: 0 }) // no teardown for pay_fee

            const estimatedMaxGasCost = maxGasCostFor(maxFeesPerGas, gasLimits)
            console.log('[L1→L2] Gas diagnostics:', {
              baseFees: { feePerDaGas: baseFees.feePerDaGas.toString(), feePerL2Gas: baseFees.feePerL2Gas.toString() },
              maxFeesPerGas: { feePerDaGas: maxFeesPerGas.feePerDaGas.toString(), feePerL2Gas: maxFeesPerGas.feePerL2Gas.toString() },
              gasLimits: { daGas: gasLimits.daGas.toString(), l2Gas: gasLimits.l2Gas.toString() },
              teardownGasLimits: { daGas: teardownGasLimits.daGas.toString(), l2Gas: teardownGasLimits.l2Gas.toString() },
              estimatedMaxGasCost: estimatedMaxGasCost.toString(),
              fuelAmount: receipt.fuelAmount.toString(),
              sufficient: receipt.fuelAmount >= estimatedMaxGasCost,
            })

            const paymentMethod = new BridgedMintAndPayFeePaymentMethod(
              AztecAddress.fromString(privateFuel.fpcAddress),
              receipt.fuelAmount,
              backup.privateFuelSecret,
              backup.privateFuelSalt,
              new FieldFr(BigInt(receipt.fuelMessageLeafIndexStr!)),
            )
            feeOption = { fee: { paymentMethod, gasSettings: { gasLimits, teardownGasLimits, maxFeesPerGas, maxPriorityFeesPerGas: GasFees.empty() } } }
            console.log('[L1→L2] Using BridgedMintAndPayFeePaymentMethod with explicit gasSettings (private fuel)')
          } catch (err) {
            console.warn('[L1→L2] Failed to create BridgedMintAndPayFeePaymentMethod, falling back to default:', err)
          }
        } else if (fuel && !privateFuel && backup.fuelSecret && receipt.fuelMessageLeafIndex != null && receipt.fuelAmount) {
          try {
            const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')
            const paymentMethod = new FeeJuicePaymentMethodWithClaim(AztecAddress.fromString(aztecAddress), {
              claimAmount: receipt.fuelAmount,
              claimSecret: backup.fuelSecret,
              messageLeafIndex: BigInt(receipt.fuelMessageLeafIndexStr!),
            })
            feeOption = { fee: { paymentMethod } }
            console.log('[L1→L2] Using FeeJuicePaymentMethodWithClaim for L2 claim (public fuel)')
          } catch (err) {
            console.warn('[L1→L2] Failed to create FeeJuicePaymentMethodWithClaim, falling back to default:', err)
          }
        }

        const claimResult = await executeL2Claim(
          { walletAdapter, aztecAddress, isPrivacyModeEnabled: isPrivacyModeEnabled ?? false },
          {
            amount: fuel ? amount - fuel.fuelAmount : amount,
            claimSecret: backup.claimSecret,
            messageLeafIndex: BigInt(receipt.messageLeafIndexStr),
          },
          {
            onAttempt: (attempt, maxAttempts) => {
              notify('info', `Claiming tokens on L2 (attempt ${attempt}/${maxAttempts})...`)
            },
            onRetry: (attempt, maxAttempts, delayMs) => {
              notify('info', `L2 node hasn't synced this message yet. Retrying in ${Math.round(delayMs / 60_000)} min (${attempt}/${maxAttempts})...`)
            },
            feeOption,
          },
        )

        const l2TxHash = claimResult.l2TxHash
        const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`

        setTransactionUrls(receipt.l1TxUrl, l2TxUrl)

        // Update localStorage with claim success
        updateLocalStorageItem(
          LS_KEY_BRIDGE_DEPOSITS,
          (c: any) => c.claimSecret === backup.claimSecret.toString() && c.l1Address === l1Address,
          (c: any) => ({
            ...c,
            success: true,
            status: BridgeOperationStatus.completed,
            l2TxHash,
            l2TxUrl,
            completedAt: Date.now(),
          }),
        )
        console.log('✅ L2 claim success stored (status=completed, l2TxHash)')

        // 🔒 PATCH: mark operation as completed on server
        patchOperationAsync(operationId, {
          status: 'completed',
          l2TxHash,
          l2TxUrl,
          completedAt: new Date().toISOString(),
          currentStep: 4,
        })

        // ─── Step 10: Bridge Complete ─────────────────────────────────
        setProgressStep(3, 'completed')
        setProgressStep(4, 'active')

        logInfo('Bridge from L1 to L2 completed', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          direction: BridgeDirection.L1_TO_L2,
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: selectedToken?.symbol ?? 'USDC',
          toToken: selectedToken?.pairedSymbol ?? 'cUSDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress,
          txHash: l2TxHash,
          aztecscanUrl: l2TxUrl,
          userAction: 'bridge_l1_to_l2_completed',
        })

        await wait(3000)
        setProgressStep(4, 'completed')

        // Add token to wallet after successful bridge
        if (aztecLoginMethod && walletAdapter) {
          try {
            const l2TokenAddr = selectedToken?.l2TokenContract ?? walletAdapter.tokenAddress
            await walletAdapter.registerToken(l2TokenAddr)

            logInfo('Token added to wallet after bridge', {
              walletType: WalletType.AZTEC,
              loginMethod: aztecLoginMethod,
              address: aztecAddress || '',
              tokenAddress: l2TokenAddr,
              tokenName: `Clean ${selectedToken?.symbol ?? 'USDC'}`,
              tokenSymbol: selectedToken?.pairedSymbol ?? 'cUSDC',
              userAction: 'token_added_to_wallet',
            })
          } catch (error) {
            console.error('Failed to add token to wallet:', error)
            logError('Failed to add token to wallet after bridge', {
              walletType: WalletType.WAAP,
              loginMethod: loginMethod,
              walletProvider: walletProvider,
              address: l1Address,
              chainId: chainId,
              error: error instanceof Error ? error.message : 'Unknown error',
              tokenAddress: selectedToken?.l2TokenContract ?? '',
              userAction: 'token_add_to_wallet_failed',
            })
          }
        }

        return l2TxHash
      } catch (error) {
        // If claim fails, keep data in localStorage — operation stays 'deposited' for recovery
        const claimErrorMessage =
          error instanceof Error ? error.message : String(error)
        console.error('Claim failed:', error)

        if (typeof operationId === 'string') {
          patchOperationAsync(operationId, {
            lastErrorMessage: `Claim failed: ${claimErrorMessage}`.slice(0, 500),
          })
        }

        logError('L2 claim step failed (Bridge L1 to L2)', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          direction: BridgeDirection.L1_TO_L2,
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress,
          l1TxHash: receiptData.l1TxHash ?? null,
          messageHash: receiptData.messageHashStr ?? null,
          messageLeafIndex: receiptData.messageLeafIndexStr ?? null,
          error: claimErrorMessage,
          userAction: 'bridge_l1_to_l2_claim_failed',
        })
        throw error
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      console.error('[L1→L2] Bridge transaction failed:', errorMessage, error)

      // 🔒 CRITICAL: Only mark as 'failed' if deposit has NOT been confirmed (no funds at risk).
      // If deposit was confirmed, status stays 'deposited' so user can Resume the L2 claim.
      if (typeof operationId === 'string') {
        const patchData: Record<string, unknown> = {
          lastErrorMessage: errorMessage.slice(0, 500),
        }
        if (!depositConfirmed) {
          patchData.status = 'failed'
        }
        patchOperationAsync(operationId, patchData)
      }

      if (
        errorMessage.includes(
          '"path":["revertReason","functionErrorStack",0,"functionSelector"]',
        ) ||
        (errorMessage.includes('invalid_type') &&
          errorMessage.includes('functionSelector'))
      ) {
        console.error('[L1→L2] Bridge failed (congestion):', error)
        notify(
          'error',
          'The Aztec Testnet is congested right now. Unfortunately your transaction was dropped.',
          {
            autoClose: false,
          },
        )

        logError('Bridge from L1 to L2 failed due to network congestion', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          direction: BridgeDirection.L1_TO_L2,
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: selectedToken?.symbol ?? 'USDC',
          toToken: selectedToken?.pairedSymbol ?? 'cUSDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress,
          error: 'Network congestion caused transaction to be dropped',
          errorType: 'congestion',
          userAction: 'bridge_l1_to_l2_congestion_error',
        })

        throw new Error(
          'The Aztec Testnet is congested right now. Unfortunately your transaction was dropped.',
        )
      } else if (errorMessage.includes('0xfb8f41b2')) {
        console.error('[L1→L2] Bridge failed (contract 0xfb8f41b2):', error)
        notify(
          'error',
          'Bridge transaction failed (error: 0xfb8f41b2). Please reload the page ',
        )

        logError('Bridge from L1 to L2 failed with contract error', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          direction: BridgeDirection.L1_TO_L2,
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: selectedToken?.symbol ?? 'USDC',
          toToken: selectedToken?.pairedSymbol ?? 'cUSDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress,
          error:
            'Contract reverted with signature 0xfb8f41b2. Recommend reload.',
          errorSignature: '0xfb8f41b2',
          userAction: 'bridge_l1_to_l2_contract_error',
        })
      } else {
        const isArtifactError =
          errorMessage.includes('Contract artifact not found') ||
          errorMessage.includes('artifact not found') ||
          errorMessage.includes('Contract artifact') ||
          (errorMessage.includes('artifact') &&
            errorMessage.includes('not found'))

        if (isArtifactError) {
          console.error('[L1→L2] Bridge failed (artifact not found):', error)
          notify('error', {
            heading: 'Contract Artifact Not Found',
            message: `The contract artifact is not available in the public registry. Please upload it to https://devnet.aztec-registry.xyz/ to make it available for the wallet.`,
          })
        } else {
          notify('error', `Bridge transaction failed: ${errorMessage}`)
        }

        logError('Bridge from L1 to L2 failed', {
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address,
          chainId: chainId,
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress,
          direction: BridgeDirection.L1_TO_L2,
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: selectedToken?.symbol ?? 'USDC',
          toToken: selectedToken?.pairedSymbol ?? 'cUSDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress,
          error: error instanceof Error ? error.message : 'Unknown error',
          userAction: 'bridge_l1_to_l2_failed',
        })

        throw error
      }
    }
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
      const existingClaims = localStorage.getItem(LS_KEY_BRIDGE_DEPOSITS)
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
      notify(
        'success',
        'Claim data exported successfully! Save this file in a safe place.',
      )
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      notify('error', `Failed to export claim data: ${errorMessage}`)
    }
  }

  const copyClaimSecret = async (claimId: string) => {
    try {
      const existingClaims = localStorage.getItem(LS_KEY_BRIDGE_DEPOSITS)
      if (!existingClaims) {
        notify('error', 'No claim data found')
        return false
      }

      const claims = JSON.parse(existingClaims)
      const claim = claims.find((c: any) => c.id === claimId)

      if (!claim || !claim.claimSecret) {
        notify('error', 'Claim secret not found')
        return false
      }

      const success = await copyToClipboard(claim.claimSecret)
      if (success) {
        notify('success', 'Claim secret copied to clipboard!')
        return true
      } else {
        notify('error', 'Failed to copy to clipboard')
        return false
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      notify('error', `Failed to copy claim secret: ${errorMessage}`)
      return false
    }
  }

  const getAllPendingClaims = () => {
    try {
      const existingClaims = localStorage.getItem(LS_KEY_BRIDGE_DEPOSITS)
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
  const { waapAddress: l1Address } = useWalletStore()
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
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      notify('error', 'Failed to check SBT status on Ethereum: ' + errorMessage)
      return false
    }
  }

  return useToastQuery({
    queryKey,
    queryFn,
    enabled: !!l1Address,
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
      const receipt = await requestWaapWallet(
        WAAP_METHOD.eth_getTransactionReceipt,
        [txHash],
      )
      const txHashStr = receipt?.transactionHash?.toString()

      const etherscanUrl = `https://sepolia.etherscan.io/tx/${txHashStr}`
      notify(
        'info',
        `SBT minted successfully on Ethereum! Click to view on Ethereum`,
        {
          onClick: () => {
            window.open(etherscanUrl, '_blank')
          },
          closeOnClick: false,
          style: { cursor: 'pointer' },
        },
      )

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
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      notify('error', errorMessage)
    },
    // toastMessages: {
    //   pending: 'Minting SBT on Ethereum...',
    //   success: 'SBT minted successfully on Ethereum!',
    //   error: 'Failed to mint SBT on Ethereum',
    // },
  })
}
