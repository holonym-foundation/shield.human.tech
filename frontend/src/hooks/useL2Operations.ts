import { ADDRESS } from '@/config'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useContractStore } from '@/stores/contractStore'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { logger } from '@/utils/logger'
import { AztecAddress, EthAddress, Fr, IntentAction } from '@aztec/aztec.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { formatUnits, parseUnits, encodeFunctionData, http, createPublicClient } from 'viem'
import { usePublicClient, useWalletClient } from 'wagmi'
import { useToast, useToastMutation } from './useToast'
import { wait } from '@/utils'
import { useL2ErrorHandler } from '@/utils/l2ErrorHandler'
import { useMutation } from '@tanstack/react-query'
import { requestWaapWallet, useWalletStore } from '@/stores/walletStore'
import { SILK_METHOD } from '@silk-wallet/silk-wallet-sdk'
import PortalSBTJson from '../constants/PortalSBT.json'
import { TokenPortalAbi } from '@aztec/l1-artifacts'
import { sepolia } from 'viem/chains'
import { BatchCall } from '@nemi-fi/wallet-sdk/eip1193'

// Create a public client for transaction receipt polling
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(),
})

// Define types for balance queries
export interface L2TokenBalanceData {
  publicBalance: string
  privateBalance: string
}

export const useL2NativeBalance = () => {
  const { aztecAddress, isAztecConnected } = useWalletStore()

  const queryKey = ['l2NativeBalance', aztecAddress]
  const queryFn = async () => {
    return 0
  }

  return useQuery({
    queryKey,
    queryFn,
    enabled: !!isAztecConnected,
  })
}

// -----------------------------------

export const useL2TokenBalance = () => {
  const { aztecAddress, isAztecConnected } = useWalletStore()
  const { l2TokenContract, l2TokenMetadata } = useContractStore()
  const handleL2Error = useL2ErrorHandler()

  // Create a stable query key that doesn't change with renders
  const queryKey = ['l2TokenBalance', aztecAddress]

  // Query function without tracking state
  const queryFn = async (): Promise<L2TokenBalanceData> => {
    try {
      if (!l2TokenContract) {
        throw new Error('L2 token contract not found')
      }
      if (!aztecAddress) {
        throw new Error('Aztec address not found')
      }
      if (!l2TokenMetadata) {
        throw new Error('L2 token metadata not found')
      }

      // console.log('Fetching L2 balances...')

      console.time('l2TokenBalance')

      const [privateBalance, publicBalance] = await Promise.all([
        l2TokenContract.methods
          .balance_of_private(AztecAddress.fromString(aztecAddress))
          .simulate(),
        l2TokenContract.methods
          .balance_of_public(AztecAddress.fromString(aztecAddress))
          .simulate(),
      ])

      const publicBalanceFormat = formatUnits(
        publicBalance as bigint,
        l2TokenMetadata.decimals
      )
      const privateBalanceFormat = formatUnits(
        privateBalance as bigint,
        l2TokenMetadata.decimals
      )

      console.log('publicBalanceFormat: ', publicBalanceFormat)
      console.log('privateBalanceFormat: ', privateBalanceFormat)
      console.timeEnd('l2TokenBalance')

      return {
        publicBalance: publicBalanceFormat,
        privateBalance: privateBalanceFormat,
      }
    } catch (error) {
      handleL2Error<L2TokenBalanceData>(error, 'BALANCE')
      console.log('error ', error)
      throw error
    }
  }

  // Use regular React Query instead of toast query
  return useQuery<L2TokenBalanceData, Error>({
    queryKey,
    queryFn,
    enabled: !!aztecAddress && !!l2TokenContract && !!l2TokenMetadata,
    meta: {
      persist: true, // Mark this query for persistence
    },
  })
}

export function useL1ContractAddresses() {
  const { aztecAccount, isAztecConnected } = useWalletStore()

  const queryKey = ['l1ContractAddresses']
  const queryFn = async () => {
    if (!aztecAccount?.aztecNode) return null
    return await aztecAccount.aztecNode.getL1ContractAddresses()
  }
  return useQuery({
    queryKey,
    queryFn,
    enabled: isAztecConnected,
  })
}

export function useL2NodeInfo() {
  const { aztecAccount, isAztecConnected } = useWalletStore()
  const queryKey = ['nodeInfo']
  const queryFn = async () => {
    if (!aztecAccount?.aztecNode) return null
    return await aztecAccount.aztecNode.getNodeInfo()
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

export function useL2TokenInfo() {
  const { aztecAccount, isAztecConnected } = useWalletStore()

  const queryKey = ['l2TokenInfo']
  const queryFn = async () => {}

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
  const { waapLoginMethod: loginMethod, waapWalletProvider: walletProvider, waapChainId: chainId } = useWalletStore()

  const { l1ContractAddresses, l2TokenContract, l2BridgeContract } =
    useContractStore()

  const mutationFn = async (amount: bigint) => {
    try {
      if (!l1Address || !aztecAddress || !aztecAccount?.aztecNode) {
        throw new Error('Required accounts not connected')
      }

      if (!l2BridgeContract) {
        throw new Error('L2 bridge contract not connected')
      }
      if (!l2TokenContract) {
        throw new Error('L2 token contract not connected')
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

      // Step 1: Setting up authorization for withdrawal
      setProgressStep(1, 'active')
      console.log('Setting up authorization for withdrawal...')
      const nonce = Fr.random()

      // Give approval to bridge to burn owner's funds:
      const authwitRequests = await aztecAccount.setPublicAuthWit(
        {
          caller: l2BridgeContract.address,
          action: await l2TokenContract.methods
            .burn_public(
              AztecAddress.fromString(aztecAccount.address.toString()),
              amount,
              nonce
            )
            .request(),
        },
        true
      )

      await authwitRequests.send().wait({ timeout: 120000 })
      setProgressStep(1, 'completed')

      // Step 2: Preparing withdrawal message
      setProgressStep(2, 'active')
      console.log('Getting L2 bridge address...')

      // Get the L2 bridge address using the portal contract
      // const messageData = encodeFunctionData({
      //   abi: TokenPortalAbi,
      //   functionName: 'l2Bridge',
      //   args: []
      // })
      // const l2BridgeAddress = await requestWaapWallet(SILK_METHOD.eth_call, [{
      //   to: ADDRESS[11155111].L1.PORTAL_CONTRACT,
      //   data: messageData
      // }, 'latest'])
      const l2BridgeAddress = ADDRESS[1337].L2.TOKEN_BRIDGE_CONTRACT

      console.log('Retrieved L2 bridge address: ', l2BridgeAddress.toString())
      setProgressStep(2, 'completed')

      // Step 3: Initiating exit to Ethereum
      setProgressStep(3, 'active')
      console.log('Initiating exit to L1...')

      // let authwitRequests: IntentAction[] | undefined = undefined
      //   authwitRequests = [
      //     {
      //       caller: l2BridgeContract.address,
      //       action: await l2TokenContract.methods
      //         .burn_public(
      //           AztecAddress.fromString(aztecAccount.address.toString()),
      //           amount,
      //           nonce
      //         )
      //         .request(),
      //     },
      //   ]
      
      // console.log('authwitRequests: ', authwitRequests)


      const l2TxReceipt = await l2BridgeContract.methods
        .exit_to_l1_public(
          EthAddress.fromString(l1Address),
          amount,
          EthAddress.ZERO,
          nonce,
          // { authWitnesses: authwitRequests }
        )
        .send()
        .wait({
          timeout: 200000,
        })

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
        l2BridgeAddress: l2BridgeAddress.toString(),
        l2TxReceipt: {
          txHash: l2TxReceipt.txHash.toString(),
          blockNumber: l2TxReceipt.blockNumber?.toString(),
        },
        timestamp: Date.now(),
        amount: amount.toString(),
        l1Address,
        l2Address: aztecAddress,
        nonce: nonce.toString(),
        success: false, // Initial state
        l2TxHash: l2TxReceipt.txHash.toString(),
        l2TxUrl: `https://aztecscan.xyz/tx-effects/${l2TxReceipt.txHash.toString()}`,
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
        txReceipt: l2TxReceipt,
      })
      setProgressStep(3, 'completed')

      // Step 4: Getting proof for Ethereum withdrawal
      setProgressStep(4, 'active')
      console.log('Getting L2 to L1 message membership witness...')
      const [l2ToL1MessageIndex, siblingPath] =
        await aztecAccount.aztecNode.getL2ToL1MessageMembershipWitness(
          Number(l2TxReceipt.blockNumber!),
          l2BridgeAddress
        )
      console.log('Retrieved membership witness', {
        messageIndex: l2ToL1MessageIndex,
        siblingPath: siblingPath.toString(),
      })
      setProgressStep(4, 'completed')

      // Step 5: Waiting for Ethereum confirmation
      setProgressStep(5, 'active')
      console.log('Waiting for L1 confirmation (40 minutes)...')
      await new Promise((resolve) => setTimeout(resolve, 40 * 60 * 1000))
      setProgressStep(5, 'completed')

      // Step 6: Claiming tokens on Ethereum
      setProgressStep(6, 'active')
      console.log('Initiating withdrawal on L1...')
      try {
        // Prepare the withdrawal transaction
        const withdrawData = encodeFunctionData({
          abi: TokenPortalAbi,
          functionName: 'withdraw',
          args: [
            l1Address,
            amount,
            false, // _withCaller
            BigInt(l2TxReceipt.blockNumber!),
            l2ToL1MessageIndex,
            siblingPath,
          ],
        })

        // Send the withdrawal transaction
        const txHash = await requestWaapWallet(
          SILK_METHOD.eth_sendTransaction,
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
        //   SILK_METHOD.eth_getTransactionReceipt,
        //   [txHash]
        // )
        // ISSUE: eth_getTransactionReceipt returns null if transaction hasn't been mined yet
        // SOLUTION: Use viem's waitForTransactionReceipt which polls until transaction is confirmed
        // Wait for approve transaction to be mined using viem polling
        console.log('Waiting for approve transaction to be mined...')
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

        notify('error', `Failed to withdraw tokens. ${errorMessage}`)
        throw error
      }
      setProgressStep(6, 'completed')

      // Step 7: Withdrawal Complete
      setProgressStep(7, 'active')
      console.log('Withdrawal completed successfully')

      const txHash = l2TxReceipt.txHash.toString()
      console.log('txHash ', txHash)

      // Create an Aztecscan URL for the transaction
      const aztecscanUrl = `https://aztecscan.xyz/tx-effects/${txHash}`
      console.log('View transaction on Aztecscan:', aztecscanUrl)

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
      console.log('🚀MMM - ~ mutationFn ~ error:', error)
      const errorMessage =error instanceof Error ? error.message : 'Unknown error'
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
  const { l2TokenContract, l2TokenMetadata } = useContractStore()
  const handleL2Error = useL2ErrorHandler()

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
        if (!l2TokenContract) {
          throw new Error('L2 token contract not found')
        }
        if (!aztecAddress) {
          throw new Error('Aztec address not found')
        }
        if (!l2TokenMetadata) {
          throw new Error('L2 token metadata not found')
        }

        console.log('Transferring L2 token...')

        const amountInWei = parseUnits(amount, l2TokenMetadata.decimals)
        const recipientAddress = AztecAddress.fromString(recipient)

        let tx
        if (isPrivate) {
          tx = await l2TokenContract.methods
            .transfer_to_private(recipientAddress, amountInWei)
            .send()
            .wait()
        } else {
          tx = await l2TokenContract.methods
            .transfer(recipientAddress, amountInWei)
            .send()
            .wait()
        }

        console.log('Transfer tx:', tx)

        return tx
      } catch (error) {
        handleL2Error<null>(error, 'TRANSACTION')
        throw error
      }
    },
  })

  return mutation
}
