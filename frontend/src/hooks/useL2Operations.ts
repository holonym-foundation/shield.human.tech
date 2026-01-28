import { ADDRESS, getAztecscanUrl, L2_CHAIN_ID, L2_TOKEN_METADATA } from '@/config'
import { useBridgeStore } from '@/stores/bridgeStore'
import { getL1ContractAddresses } from '@/utils/aztecHelpers'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  formatUnits,
  parseUnits,
  encodeFunctionData,
  http,
  createPublicClient,
} from 'viem'
import { useToast, useToastMutation } from './useToast'
import { wait } from '@/utils'
import { useL2ErrorHandler } from '@/utils/l2ErrorHandler'
import {
  requestWaapWallet,
  useWalletStore,
  WAAP_METHOD,
} from '@/stores/walletStore'
import { TokenPortalAbi } from '@aztec/l1-artifacts'
import { sepolia } from 'viem/chains'
import { useWalletAdapter } from './useWalletAdapter'

const L1_RPC_URL = process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL

// Create a public client for transaction receipt polling
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(L1_RPC_URL),
})

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

  // Create a stable query key that doesn't change with renders
  const queryKey = ['l2TokenBalance', aztecAddress]

  // Query function without tracking state
  const queryFn = async (): Promise<L2TokenBalanceData> => {
    try {
      if (!aztecAddress) {
        throw new Error('Aztec address not found')
      }
      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized'
        )
      }

      console.time('l2TokenBalance')

      const userAddress = AztecAddress.fromString(aztecAddress)

      // Use wallet adapter to simulate views
      const [privateBalanceResult, publicBalanceResult] = await Promise.all([
        walletAdapter.simulateView(
          walletAdapter.tokenAddress,
          'balance_of_private',
          [userAddress]
        ),
        walletAdapter.simulateView(
          walletAdapter.tokenAddress,
          'balance_of_public',
          [userAddress]
        ),
      ])

      const privateBalance = BigInt(privateBalanceResult.result.toString())
      const publicBalance = BigInt(publicBalanceResult.result.toString())

      const publicBalanceFormat = formatUnits(
        publicBalance,
        L2_TOKEN_METADATA.decimals
      )
      const privateBalanceFormat = formatUnits(
        privateBalance,
        L2_TOKEN_METADATA.decimals
      )

      console.timeEnd('l2TokenBalance')

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

export function useL1ContractAddresses() {
  const { aztecAccount, isAztecConnected } = useWalletStore()

  const queryKey = ['l1ContractAddresses']
  const queryFn = async () => {
    return await getL1ContractAddresses(aztecAccount)
  }
  return useQuery({
    queryKey,
    queryFn,
    enabled: isAztecConnected,
  })
}

export function useL2NodeIsReady() {
  const { aztecAccount, isAztecConnected } = useWalletStore()
  const queryKey = ['nodeIsReady']
  const queryFn = async () => {
    if (!aztecAccount?.aztecNode) return null
    return await aztecAccount.aztecNode.isReady()
  }
  return useQuery({
    queryKey,
    queryFn,
    enabled: isAztecConnected,
  })
}

// -----------------------------------

export function useL2WithdrawTokensToL1(onBridgeSuccess?: (data: any) => void) {
  const { waapAddress: l1Address } = useWalletStore()
  const { aztecAddress, aztecAccount, aztecLoginMethod } = useWalletStore()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { setProgressStep, setTransactionUrls } = useBridgeStore()

  // Get wallet information from useWalletStore
  const {
    waapLoginMethod: loginMethod,
    waapWalletProvider: walletProvider,
    waapChainId: chainId,
  } = useWalletStore()
  const walletAdapter = useWalletAdapter()

  const mutationFn = async (amount: bigint) => {
    try {
      if (!l1Address || !aztecAddress || !aztecAccount?.aztecNode) {
        throw new Error('Required accounts not connected')
      }

      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized'
        )
      }

      // Wallet information is already available from useWalletStore hook

      // Log withdrawal initiation with enhanced data
      logInfo('Withdrawal from L2 to L1 initiated', {
        // WaaP (L1) wallet information
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        // Aztec (L2) wallet information
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress || '',
        // Withdrawal operation details
        direction: 'L2_TO_L1',
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: amount.toString(),
        l1Address: l1Address,
        l2Address: aztecAddress,
        userAction: 'withdrawal_l2_to_l1_initiated',
      })

      // Wallet adapter is already declared at function level
      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized'
        )
      }

      // Step 1: Setting up authorization for withdrawal
      setProgressStep(1, 'active')
      const nonce = Fr.random()

      const userAddress = AztecAddress.fromString(
        aztecAccount.address.toString()
      )

      // Use wallet adapter to execute authwit
      await walletAdapter.executeCallWithAuthWit(
        userAddress,
        walletAdapter.bridgeAddress,
        walletAdapter.tokenAddress,
        'burn_public',
        [userAddress, amount, nonce]
      )
      setProgressStep(1, 'completed')

      // Step 2: Preparing withdrawal message
      setProgressStep(2, 'active')
      setProgressStep(2, 'completed')

      // Step 3: Initiating exit to Ethereum
      setProgressStep(3, 'active')

      // Use wallet adapter to execute exit to L1
      const result = await walletAdapter.executeCall(
        walletAdapter.bridgeAddress,
        'exit_to_l1_public',
        [EthAddress.fromString(l1Address), amount, EthAddress.ZERO, nonce],
        {
          contractType: 'bridge',
          autoRegister: true,
        }
      )

      const l2TxHash = result.txHash
      const l2BlockNumber = result.blockNumber

      // const batchedTx = new BatchCall(aztecAccount, [
      //   setPublicAuthWit,
      //   exit_to_l1_public,
      // ])

      // const batchedTxHash = await batchedTx.send().wait({
      //   timeout: 200000,
      // })

      // const l2TxReceipt = await l2BridgeContract.methods
      //   .exit_to_l1_public(
      //     EthAddress.fromString(l1Address),
      //     amount,
      //     EthAddress.ZERO,
      //     nonce
      //   )
      //   .send()
      //   .wait({
      //     timeout: 200000,
      //   })

      // Store L2 to L1 message and transaction receipt in localStorage
      const withdrawalData = {
        id: Date.now().toString(), // Unique identifier for this attempt
        l2BridgeAddress: walletAdapter.bridgeAddress,
        l2TxReceipt: {
          txHash: l2TxHash,
          blockNumber: l2BlockNumber?.toString(),
        },
        timestamp: Date.now(),
        amount: amount.toString(),
        l1Address,
        l2Address: aztecAddress,
        nonce: nonce.toString(),
        success: false, // Initial state
        l2TxHash: l2TxHash,
        l2TxUrl: `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`,
      }

      // Get existing withdrawals or initialize empty array
      const existingWithdrawals = localStorage.getItem('l2ToL1Withdrawals')
      const withdrawals = existingWithdrawals
        ? JSON.parse(existingWithdrawals)
        : []

      // Add new withdrawal to array
      withdrawals.push(withdrawalData)
      localStorage.setItem('l2ToL1Withdrawals', JSON.stringify(withdrawals))

      console.log('Exit to L1 transaction completed', {
        txHash: l2TxHash,
        blockNumber: l2BlockNumber,
      })
      setProgressStep(3, 'completed')

      // Step 4: Getting proof for Ethereum withdrawal
      setProgressStep(4, 'active')
      console.log('Getting L2 to L1 message membership witness...')

      // For Azguard, we need to get the block number from the transaction
      // If blockNumber is not available, we might need to poll for it
      const blockNumberForProof = l2BlockNumber
      if (!blockNumberForProof && aztecAccount?.aztecNode) {
        // Try to get the latest block number as fallback
        // Note: This is a workaround - ideally we should wait for the transaction to be included
        console.warn(
          'Block number not available, using latest block as fallback'
        )
        // We'll need to handle this case differently - for now, throw an error
        throw new Error(
          'Block number is required for L2 to L1 message proof. Please wait for transaction confirmation.'
        )
      }

      const [l2ToL1MessageIndex, siblingPath] =
        await aztecAccount.aztecNode.getL2ToL1MessageMembershipWitness(
          Number(blockNumberForProof!),
          walletAdapter.bridgeAddress
        )
      setProgressStep(4, 'completed')

      // Step 5: Waiting for Ethereum confirmation
      setProgressStep(5, 'active')
      await new Promise((resolve) => setTimeout(resolve, 40 * 60 * 1000))
      setProgressStep(5, 'completed')

      // Step 6: Claiming tokens on Ethereum
      setProgressStep(6, 'active')
      try {
        // Prepare the withdrawal transaction
        const withdrawData = encodeFunctionData({
          abi: TokenPortalAbi,
          functionName: 'withdraw',
          args: [
            l1Address,
            amount,
            false, // _withCaller
            BigInt(l2BlockNumber!),
            l2ToL1MessageIndex,
            siblingPath,
          ],
        })

        // Send the withdrawal transaction
        const txHash = await requestWaapWallet(
          WAAP_METHOD.eth_sendTransaction,
          [
            {
              from: l1Address,
              to: ADDRESS[11155111].L1.PORTAL_CONTRACT,
              data: withdrawData,
            },
          ]
        )

        // // Wait for transaction receipt
        // const receipt = await requestWaapWallet(
        //   WAAP_METHOD.eth_getTransactionReceipt,
        //   [txHash]
        // )
        // ISSUE: eth_getTransactionReceipt returns null if transaction hasn't been mined yet
        // SOLUTION: Use viem's waitForTransactionReceipt which polls until transaction is confirmed
        // Wait for approve transaction to be mined using viem polling
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        })

        // Update withdrawal data with success
        const updatedWithdrawalData = {
          ...withdrawalData,
          success: true,
          completedAt: Date.now(),
          l1TxHash: receipt.transactionHash,
          l1TxUrl: `https://sepolia.etherscan.io/tx/${receipt.transactionHash}`,
        }

        // Update the specific withdrawal in the array
        const updatedWithdrawals = withdrawals.map((w: any) =>
          w.id === withdrawalData.id ? updatedWithdrawalData : w
        )
        localStorage.setItem(
          'l2ToL1Withdrawals',
          JSON.stringify(updatedWithdrawals)
        )

        // Clear withdrawal data from localStorage on success
        localStorage.removeItem('l2ToL1Withdrawals')
      } catch (error) {
        // If withdrawal fails, keep the data in localStorage
        const errorMessage =
          error instanceof Error ? error.message : String(error)

        // Check if error is about contract artifact not found
        const isArtifactError =
          errorMessage.includes('Contract artifact not found') ||
          errorMessage.includes('artifact not found') ||
          errorMessage.includes('Contract artifact') ||
          (errorMessage.includes('artifact') &&
            errorMessage.includes('not found'))

        if (isArtifactError) {
          // Show special error message with link to artifact registry
          notify('error', {
            heading: 'Contract Artifact Not Found',
            message: `The contract artifact is not available in the public registry. Please upload it to https://devnet.aztec-registry.xyz/ to make it available for Azguard wallet.`,
          })
        } else {
          notify('error', `Failed to withdraw tokens. ${errorMessage}`)
        }
        throw error
      }
      setProgressStep(6, 'completed')

      // Step 7: Withdrawal Complete
      setProgressStep(7, 'active')
      const txHash = l2TxHash
      const aztecscanUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${txHash}`

      // Set transaction URLs in the store
      setTransactionUrls(null, aztecscanUrl)

      // Wallet information is already available from useWalletStore hook

      // Log successful withdrawal with enhanced data
      logInfo('Withdrawal from L2 to L1 completed', {
        // WaaP (L1) wallet information
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        // Aztec (L2) wallet information
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress || '',
        // Withdrawal operation details
        direction: 'L2_TO_L1',
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: amount.toString(),
        l1Address: l1Address,
        l2Address: aztecAddress?.toString(),
        txHash: txHash,
        aztecscanUrl,
        userAction: 'withdrawal_l2_to_l1_completed',
      })

      await wait(3000)
      setProgressStep(7, 'completed')

      return txHash
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'
      // Wallet information is already available from useWalletStore hook

      // Log withdrawal failure with enhanced data
      logError('Withdrawal from L2 to L1 failed', {
        // WaaP (L1) wallet information
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        // Aztec (L2) wallet information
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress || '',
        // Withdrawal operation details
        direction: 'L2_TO_L1',
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: 'USDC',
        toToken: 'USDC',
        amount: amount.toString(),
        l1Address: l1Address,
        l2Address: aztecAddress?.toString(),
        error: errorMessage,
        userAction: 'withdrawal_l2_to_l1_failed',
      })

      // Show error notification
      notify('error', `Failed to withdraw tokens. ${errorMessage}`)
      throw error
    }
  }

  return useToastMutation({
    mutationFn,
    onSuccess: (txHash) => {
      // Refresh balances
      queryClient.invalidateQueries({ queryKey: ['l1TokenBalance', l1Address] })
      queryClient.invalidateQueries({
        queryKey: ['l2TokenBalance', aztecAddress],
      })

      // Wallet information is already available from useWalletStore hook

      // Log successful withdrawal completion with enhanced data
      logInfo('Withdrawal from L2 to L1 callback', {
        // WaaP (L1) wallet information
        walletType: WalletType.WAAP,
        loginMethod: loginMethod,
        walletProvider: walletProvider,
        address: l1Address || '',
        chainId: chainId,
        // Aztec (L2) wallet information
        aztecLoginMethod: aztecLoginMethod,
        aztecAddress: aztecAddress || '',
        // Withdrawal operation details
        direction: 'L2_TO_L1',
        fromNetwork: 'Aztec',
        toNetwork: 'Ethereum',
        fromToken: 'USDC',
        toToken: 'USDC',
        l1Address: l1Address,
        l2Address: aztecAddress?.toString(),
        userAction: 'withdrawal_l2_to_l1_callback',
        txHash: typeof txHash === 'string' ? txHash : 'completed',
      })

      if (onBridgeSuccess) {
        onBridgeSuccess(txHash)
      }
    },
    // toastMessages: {
    //   pending: 'Withdrawing tokens to L1...',
    //   success: 'Tokens successfully withdrawn to L1!',
    //   error: 'Failed to withdraw tokens',
    // },
  })
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
  const queryKey = ['l2PendingTxCount', aztecAddress]

  // Query function without tracking state
  const queryFn = async (): Promise<number> => {
    try {
      if (!aztecAddress) {
        throw new Error('Aztec address not found')
      }

      const response = await fetch(
        'https://aztec-alpha-testnet-fullnode.zkv.xyz',
        {
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
        }
      )

      const data = await response.json()
      return data.result as number
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
            'Aztec wallet not connected or contracts not initialized'
          )
        }

        console.log('Transferring L2 token...')

        const amountInWei = parseUnits(amount, L2_TOKEN_METADATA.decimals)
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
          {
            contractType: 'token',
            autoRegister: true,
          }
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
