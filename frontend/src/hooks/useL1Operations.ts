import { useBridgeStore } from '@/stores/bridgeStore'
import { truncateDecimals, wait } from '@/utils'
import axios from 'axios'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { computeSecretHash } from '@aztec/aztec.js/crypto'
import { useWalletAdapter } from './useWalletAdapter'
import { ADDRESS, getAztecscanUrl, L2_TOKEN_METADATA } from '@/config'
import { getL1ContractAddresses } from '@/utils/aztecHelpers'

// Generate a claim secret and its hash
async function generateClaimSecret(): Promise<[Fr, Fr]> {
  const claimSecret = Fr.random()
  const claimSecretHash = await computeSecretHash(claimSecret)
  return [claimSecret, claimSecretHash]
}
import { TestERC20Abi, TokenPortalAbi } from '@aztec/l1-artifacts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  formatUnits,
  getContract,
  encodeFunctionData,
  createPublicClient,
  http,
} from 'viem'
import { sepolia } from 'viem/chains'
import PortalSBTJson from '../constants/PortalSBT.json'
import { useToast, useToastMutation, useToastQuery } from './useToast'
import { extractEvent } from '@aztec/ethereum/utils'
import { requestWaapWallet, useWalletStore, WAAP_METHOD } from '@/stores/walletStore'
import {
  I_UserTokenBalance,
  T_AlchemyTokenBalanceResponse,
  T_UserTokenType,
} from '@/types/token.balances.types'
import { axiosErrorMessage } from './helper'
import { networkConfig, silkUrl } from '@/config/l1.config'

// Fix the bytecode format
const PortalSBTAbi = PortalSBTJson.abi

// Create a public client for transaction receipt polling
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(),
})

export function useL1NativeBalance() {
  const { waapAddress: l1Address } = useWalletStore()

  const queryKey = ['l1NativeBalance', l1Address]
  const queryFn = async () => {
    if (!l1Address) return null

    const chainIds = [11155111]

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
        to: ADDRESS[11155111].L1.TOKEN_CONTRACT,
        data,
      },
    ])

    // TODO: this should come from token
    const balanceFormat = formatUnits(BigInt(balance as string), 6)
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
          chains: [11155111], // Sepolia testnet
        }
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
            token?.tokenMetadata?.decimals ?? 18
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
        }
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
  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()

  // L1 (Ethereum) balances and operations
  const {
    data: l1TokenBalances = [],
    isLoading: l1BalanceLoading,
    refetch: refetchL1Balance,
  } = useL1TokenBalances()

  // native token
  const sepoliaNativeTokens = l1TokenBalances.find(
    (token) => token.type === 'native' && token.network?.chainId === 11155111
  )
  const l1NativeBalance = sepoliaNativeTokens?.balance_formatted

  const l1Balance = l1TokenBalances.find(
    (token) =>
      token.type === 'erc20' &&
      token.network?.chainId === 11155111 &&
      token.address === ADDRESS[11155111].L1.TOKEN_CONTRACT
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

        const currentNativeBalance =
          result?.balances?.recipient?.after || l1NativeBalance

        // If user only needs tokens (has gas), proceed directly
        // If user needs both gas and tokens, check if they have enough gas
        const hasEnoughGas = needsTokensOnly || Number(currentNativeBalance || 0) >= mintNativeAmount

        if (hasEnoughGas) {
          console.log('User has gas. Requesting tokens from API...')
          try {
            // notify('info', 'Getting tokens...')
            // await wait(30000) // 30 seconds

            // Call our mint-tokens API endpoint
            const response = await fetch('/api/mint-tokens', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ address: l1Address }),
            })

            if (!response.ok) {
              const errorData = await response.json()
              throw new Error(
                errorData.error || 'Failed to mint tokens via API'
              )
            }

            const mintResult = await response.json()
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
            'User still does not have enough gas for receiving tokens'
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
        'Not enough ETH for gas. Please get ETH from the faucet first.'
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
        to: ADDRESS[11155111].L1.TOKEN_CONTRACT,
        data,
      },
    ])
    console.log('Mint transaction sent, hash:', txHash)

    // Wait for confirmation
    const receipt = await requestWaapWallet(
      WAAP_METHOD.eth_getTransactionReceipt,
      [txHash]
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
    azguardClient,
  } = useWalletStore()

  // Get wallet information from useWalletStore
  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()

  const queryClient = useQueryClient()
  const { setProgressStep, setTransactionUrls, isPrivacyModeEnabled } =
    useBridgeStore()
  const notify = useToast()

  const walletAdapter = useWalletAdapter()

  const mutationFn = async (amount: bigint): Promise<string | undefined> => {
    try {
      if (!l1Address || !aztecAddress || !aztecAccount?.aztecNode) {
        console.log({
          l1Address,
          aztecAddress,
          hasAztecNode: !!aztecAccount?.aztecNode,
        })
        throw new Error('Required accounts not connected')
      }

      // Get L1 contract addresses (needed for bridging)
      const l1Addresses = await getL1ContractAddresses(aztecAccount)
      if (!l1Addresses?.outboxAddress) {
        throw new Error(
          'L1 contract addresses not initialized. Please wait for contract initialization to complete.'
        )
      }

      // Ensure wallet adapter is initialized (contracts will be initialized by adapter)
      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized. Please wait for wallet initialization to complete.'
        )
      }

      setProgressStep(1, 'active')
      console.log('Initiating bridge tokens to L2...')
      
      // Wallet information is already available from useWalletStore hook
      
      logInfo('Bridge from L1 to L2 initiated', {
        // WaaP (L1) wallet information
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        // Aztec (L2) wallet information
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress || '',
        // Bridge operation details
        direction: 'L1_TO_L2',
        fromNetwork: 'Ethereum',
        toNetwork: 'Aztec',
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: amount.toString(),
        l1Address: l1Address,
        l2Address: aztecAddress,
        userAction: 'bridge_l1_to_l2_initiated',
      })

      const l1TokenAddress = ADDRESS[11155111].L1.TOKEN_CONTRACT
      const l1PortalAddress = ADDRESS[11155111].L1.PORTAL_CONTRACT

      // Check allowance
      const allowanceData = encodeFunctionData({
        abi: TestERC20Abi,
        functionName: 'allowance',
        args: [l1Address as `0x${string}`, l1PortalAddress as `0x${string}`],
      })

      const allowance = await requestWaapWallet(WAAP_METHOD.eth_call, [
        {
          to: l1TokenAddress,
          data: allowanceData,
        },
      ])

      // Approve tokens if necessary
      if (BigInt(allowance as string) < amount) {
        const approveData = encodeFunctionData({
          abi: TestERC20Abi,
          functionName: 'approve',
          args: [l1PortalAddress as `0x${string}`, amount],
        })

        const approveTxHash = await requestWaapWallet(
          WAAP_METHOD.eth_sendTransaction,
          [
            {
              from: l1Address as `0x${string}`,
              to: l1TokenAddress,
              data: approveData,
            },
          ]
        )

        // OLD CODE: const approveReceipt = await requestWaapWallet(WAAP_METHOD.eth_getTransactionReceipt, [approveTxHash])
        // ISSUE: eth_getTransactionReceipt returns null if transaction hasn't been mined yet
        // SOLUTION: Use viem's waitForTransactionReceipt which polls until transaction is confirmed
        // Wait for approve transaction to be mined using viem polling
        console.log('Waiting for approve transaction to be mined...')
        const approveReceipt = await publicClient.waitForTransactionReceipt({
          hash: approveTxHash,
        })
      }

      const [claimSecret, claimSecretHash] = await generateClaimSecret()
      // TODO: store these at this point in the local storage 
      // TODO: WE NEED TO STORE THE CLAIM SECRET AND CLAIM SECRET HASH BACKEND with ENCRYPTION

      // Bridge tokens - use different function based on privacy mode
      const functionName = isPrivacyModeEnabled
        ? 'depositToAztecPrivate'
        : 'depositToAztecPublic'
      const args = isPrivacyModeEnabled
        ? ([amount, claimSecretHash.toString()] as const)
        : ([
            aztecAddress as `0x${string}`,
            amount,
            claimSecretHash.toString(),
          ] as const)

      const bridgeData = encodeFunctionData({
        abi: TokenPortalAbi,
        functionName,
        args,
      })

      const txHash = await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [
        {
          from: l1Address as `0x${string}`,
          to: l1PortalAddress,
          data: bridgeData,
        },
      ])

      // OLD CODE: const txReceipt = await requestWaapWallet(WAAP_METHOD.eth_getTransactionReceipt, [txHash])
      // ISSUE: eth_getTransactionReceipt returns null if transaction hasn't been mined yet
      // SOLUTION: Use viem's waitForTransactionReceipt which polls until transaction is confirmed
      // Wait for bridge transaction to be mined using viem polling
      console.log('Waiting for bridge transaction to be mined...')
      const txReceipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
      })

      const l1TxHash = txReceipt?.transactionHash?.toString()
      const l1TxUrl = `https://sepolia.etherscan.io/tx/${l1TxHash}`

      setTransactionUrls(l1TxUrl, null)

      // Extract the event to get the message hash and leaf index - use different event based on privacy mode
      const eventName = isPrivacyModeEnabled
        ? 'DepositToAztecPrivate'
        : 'DepositToAztecPublic'

      // Create filter functions for cleaner code
      const privateEventFilter = (log: any) =>
        log.args.amount === amount &&
        log.args.secretHashForL2MessageConsumption ===
          claimSecretHash.toString()

      const publicEventFilter = (log: any) =>
        log.args.secretHash === claimSecretHash.toString() &&
        log.args.amount === amount &&
        log.args.to === aztecAddress

      const eventFilter = isPrivacyModeEnabled
        ? privateEventFilter
        : publicEventFilter

      const log = extractEvent(
        txReceipt.logs,
        l1PortalAddress as `0x${string}`,
        TokenPortalAbi,
        eventName,
        eventFilter
      )

      const messageHash = log.args.key
      const messageLeafIndex = log.args.index
      const claimAmount = amount

      // Store claim data in localStorage
      const claimData = {
        id: Date.now().toString(), // Unique identifier for this attempt
        claimAmount: claimAmount.toString(),
        claimSecret: claimSecret.toString(),
        claimSecretHash: claimSecretHash.toString(),
        messageHash: messageHash,
        messageLeafIndex: messageLeafIndex.toString(),
        timestamp: Date.now(),
        l1Address,
        l2Address: aztecAddress,
        success: false, // Initial state
        l1TxHash: l1TxHash,
        l1TxUrl: l1TxUrl,
        isPrivacyModeEnabled: isPrivacyModeEnabled,
      }

      // Get existing claims or initialize empty array
      const existingClaims = localStorage.getItem('l1ToL2Claims')
      const claims = existingClaims ? JSON.parse(existingClaims) : []

      // Add new claim to array
      claims.push(claimData)
      localStorage.setItem('l1ToL2Claims', JSON.stringify(claims))

      // Step 2: Waiting for L1-to-L2 message to be available
      setProgressStep(1, 'completed')
      setProgressStep(2, 'active')
      console.log('Waiting for L1-to-L2 message to be available...')

      // Poll for L1-to-L2 message sync status every 2 minutes
      let messageSynced = false
      let attempts = 0
      const maxAttempts = 10 // Maximum 20 minutes of waiting
      const pollInterval = 120000 // 2 minutes in milliseconds

      while (!messageSynced && attempts < maxAttempts) {
        try {
          console.log(`Checking L1-to-L2 message sync status (attempt ${attempts + 1}/${maxAttempts})...`, {
            messageHash: messageHash.toString(),
            messageLeafIndex: messageLeafIndex.toString(),
          })

          // Create Fr from the message hash
          const messageHashFr = Fr.fromString(messageHash.toString())
          
          // Check if the L1-to-L2 message is synced
          messageSynced = await aztecAccount?.aztecNode.isL1ToL2MessageSynced(messageHashFr)
          
          if (messageSynced) {
            console.log('L1-to-L2 message is ready for claiming')
            break
          } else {
            console.log(`L1-to-L2 message not yet synced, waiting ${pollInterval / 1000} seconds before next check...`)
            attempts++
            
            if (attempts < maxAttempts) {
              await wait(pollInterval)
            }
          }
        } catch (error) {
          console.error(`Error checking L1-to-L2 message sync (attempt ${attempts + 1}):`, error)
          attempts++
          
          if (attempts < maxAttempts) {
            console.log(`Retrying in ${pollInterval / 1000} seconds...`)
            await wait(pollInterval)
          }
        }
      }

      if (!messageSynced) {
        const errorMessage = `L1-to-L2 message sync timeout after ${maxAttempts} attempts (${(maxAttempts * pollInterval) / 1000 / 60} minutes)`
        console.error(errorMessage)
        
        // Wallet information is already available from useWalletStore hook
        
        logError('L1-to-L2 message sync timeout', {
          // WaaP (L1) wallet information
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address || '',
          chainId: chainId,
          // Aztec (L2) wallet information
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress || '',
          // Error details
          messageHash: messageHash.toString(),
          messageLeafIndex: messageLeafIndex.toString(),
          attempts: maxAttempts,
          totalWaitTime: (maxAttempts * pollInterval) / 1000 / 60,
          userAction: 'bridge_l1_to_l2_sync_timeout',
        })
        
        throw new Error(errorMessage)
      }

      // Wait for the final poll interval before claiming
      console.log('Waiting for the final poll interval before claiming...')
      await wait(pollInterval)

      // Step 3: Claiming tokens on Aztec Network
      setProgressStep(2, 'completed')
      setProgressStep(3, 'active')

      try {
        console.log('isPrivacyModeEnabled ', isPrivacyModeEnabled)
        
        if (!walletAdapter) {
          throw new Error('Aztec wallet not connected or bridge contract not initialized')
        }

        // Use wallet adapter to execute claim
        const method = isPrivacyModeEnabled ? 'claim_private' : 'claim_public'
        const result = await walletAdapter.executeCall(
          walletAdapter.bridgeAddress,
          method,
          [
            AztecAddress.fromString(aztecAddress),
            amount,
            claimSecret,
            messageLeafIndex,
          ],
          {
            contractType: 'bridge',
            autoRegister: true,
          }
        )

        const l2TxHash = result.txHash
        const l2TxUrl = `${getAztecscanUrl(1674512022)}/tx-effects/${l2TxHash}`

        setTransactionUrls(l1TxUrl, l2TxUrl)

        // Update claim data with success and L2 transaction info
        const updatedClaimData = {
          ...claimData,
          success: true,
          l2TxHash: l2TxHash,
          l2TxUrl: l2TxUrl,
          completedAt: Date.now(),
        }

        // Update the specific claim in the array
        const updatedClaims = claims.map((c: any) =>
          c.id === claimData.id ? updatedClaimData : c
        )
        localStorage.setItem('l1ToL2Claims', JSON.stringify(updatedClaims))

        // Step 4: Bridge Complete
        setProgressStep(3, 'completed')
        setProgressStep(4, 'active')

        // Wallet information is already available from useWalletStore hook
        
        logInfo('Bridge from L1 to L2 completed', {
          // WaaP (L1) wallet information
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address || '',
          chainId: chainId,
          // Aztec (L2) wallet information
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress || '',
          // Bridge operation details
          direction: 'L1_TO_L2',
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: 'USDC',
          toToken: 'USDC',
          amount: amount?.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress?.toString(),
          txHash: l2TxHash,
          aztecscanUrl: l2TxUrl,
          userAction: 'bridge_l1_to_l2_completed',
        })

        await wait(3000)
        setProgressStep(4, 'completed')

        // Add token to wallet after successful bridge
        if (aztecLoginMethod && walletAdapter) {
          try {
            await walletAdapter.registerToken(walletAdapter.tokenAddress)
            
            notify('success', 'Token registered successfully in wallet')
            
            logInfo('Token added to wallet after bridge', {
              walletType: WalletType.AZTEC,
              loginMethod: aztecLoginMethod,
              address: aztecAddress || '',
              tokenAddress: ADDRESS[1674512022].L2.TOKEN_CONTRACT,
              tokenName: L2_TOKEN_METADATA.name,
              tokenSymbol: L2_TOKEN_METADATA.symbol,
              userAction: 'token_added_to_wallet',
            })
          } catch (error) {
            console.error('Failed to add token to wallet:', error)
            // Don't throw here as the bridge was successful
            // Wallet information is already available from useWalletStore hook
            
            logError('Failed to add token to wallet after bridge', {
              walletType: WalletType.WAAP,
              loginMethod: loginMethod,
              walletProvider: walletProvider,
              address: l1Address || '',
              chainId: chainId,
              error: error instanceof Error ? error.message : 'Unknown error',
              tokenAddress: ADDRESS[1674512022].L2.TOKEN_CONTRACT,
              userAction: 'token_add_to_wallet_failed',
            })
          }
        }

        return l2TxHash
      } catch (error) {
        // If claim fails, keep the data in localStorage
        console.error('Claim failed:', error)
        throw error
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)

      if (
        errorMessage.includes(
          '"path":["revertReason","functionErrorStack",0,"functionSelector"]'
        ) ||
        (errorMessage.includes('invalid_type') &&
          errorMessage.includes('functionSelector'))
      ) {
        notify(
          'error',
          'The Aztec Testnet is congested right now. Unfortunately your transaction was dropped.',
          {
            autoClose: false,
          }
        )

        // Wallet information is already available from useWalletStore hook
        
        logError('Bridge from L1 to L2 failed due to network congestion', {
          // WaaP (L1) wallet information
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address || '',
          chainId: chainId,
          // Aztec (L2) wallet information
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress || '',
          // Bridge operation details
          direction: 'L1_TO_L2',
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: 'USDC',
          toToken: 'USDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress?.toString(),
          error: 'Network congestion caused transaction to be dropped',
          errorType: 'congestion',
          userAction: 'bridge_l1_to_l2_congestion_error',
        })

        throw new Error(
          'The Aztec Testnet is congested right now. Unfortunately your transaction was dropped.'
        )
      } else if (errorMessage.includes('0xfb8f41b2')) {
        notify(
          'error',
          'Bridge transaction failed (error: 0xfb8f41b2). Please reload the page '
        )

        // Wallet information is already available from useWalletStore hook
        
        logError('Bridge from L1 to L2 failed with contract error', {
          // WaaP (L1) wallet information
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address || '',
          chainId: chainId,
          // Aztec (L2) wallet information
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress || '',
          // Bridge operation details
          direction: 'L1_TO_L2',
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: 'USDC',
          toToken: 'USDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress?.toString(),
          error:
            'Contract reverted with signature 0xfb8f41b2. Recommend reload.',
          errorSignature: '0xfb8f41b2',
          userAction: 'bridge_l1_to_l2_contract_error',
        })
      } else {
        // For any other errors, show a generic error message
        notify('error', `Bridge transaction failed: ${errorMessage}`)

        // Wallet information is already available from useWalletStore hook
        
        logError('Bridge from L1 to L2 failed', {
          // WaaP (L1) wallet information
          walletType: WalletType.WAAP,
          loginMethod: loginMethod,
          walletProvider: walletProvider,
          address: l1Address || '',
          chainId: chainId,
          // Aztec (L2) wallet information
          aztecLoginMethod: aztecLoginMethod,
          aztecAddress: aztecAddress || '',
          // Bridge operation details
          direction: 'L1_TO_L2',
          fromNetwork: 'Ethereum',
          toNetwork: 'Aztec',
          fromToken: 'USDC',
          toToken: 'USDC',
          amount: amount.toString(),
          l1Address: l1Address,
          l2Address: aztecAddress?.toString(),
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
      console.log('Refetching balances after successful mint')
      queryClient.invalidateQueries({ queryKey: [l1Address] })
      queryClient.invalidateQueries({ queryKey: [aztecAddress] })

      if (onBridgeSuccess) {
        onBridgeSuccess(txHash)
      }
    },
  })
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
          to: ADDRESS[11155111].L1.PORTAL_SBT_CONTRACT,
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
          to: ADDRESS[11155111].L1.PORTAL_SBT_CONTRACT,
          data,
        },
      ])

      // Wait for confirmation
      const receipt = await requestWaapWallet(
        WAAP_METHOD.eth_getTransactionReceipt,
        [txHash]
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
        }
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
