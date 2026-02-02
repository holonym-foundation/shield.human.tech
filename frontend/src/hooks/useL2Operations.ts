import { aztecNode } from '@/aztec'
import {
  ADDRESS,
  getAztecscanUrl,
  L1_CHAIN_ID,
  L2_CHAIN_ID,
  L2_NODE_URL,
  L2_TOKEN_METADATA,
} from '@/config'
import { useBridgeStore } from '@/stores/bridgeStore'
import { logError, logInfo } from '@/utils/datadog'
import { WalletType } from '@/types/wallet'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging'
import { EthAddress } from '@aztec/foundation/eth-address'
import { Fr } from '@aztec/aztec.js/fields'
import { sha256ToField } from '@aztec/foundation/crypto/sha256'
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash'
import { toFunctionSelector } from 'viem'
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
import { RollupAbi, TokenPortalAbi } from '@aztec/l1-artifacts'
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

      const userAddress = AztecAddress.fromString(aztecAddress)

      // // Use wallet adapter to simulate views
      // const [privateBalanceResult, publicBalanceResult] = await Promise.all([
      //   walletAdapter.simulateView(
      //     walletAdapter.tokenAddress,
      //     'balance_of_private',
      //     [userAddress]
      //   ),
      //   walletAdapter.simulateView(
      //     walletAdapter.tokenAddress,
      //     'balance_of_public',
      //     [userAddress]
      //   ),
      // ])

      // Single simulate_views call for both balances
      const [privateBalanceResult, publicBalanceResult] =
        await walletAdapter.simulateViews([
          {
            contract: walletAdapter.tokenAddress,
            method: 'balance_of_private',
            args: [userAddress],
          },
          {
            contract: walletAdapter.tokenAddress,
            method: 'balance_of_public',
            args: [userAddress],
          },
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

// -----------------------------------

export function useL2WithdrawTokensToL1(onBridgeSuccess?: (data: any) => void) {
  const { waapAddress: l1Address } = useWalletStore()
  const { aztecAddress, aztecAccount, aztecLoginMethod } = useWalletStore()
  const queryClient = useQueryClient()
  const notify = useToast()
  const { setProgressStep, setTransactionUrls, isPrivacyModeEnabled } =
    useBridgeStore()

  // Get wallet information from useWalletStore
  const {
    waapLoginMethod: loginMethod,
    waapWalletProvider: walletProvider,
    waapChainId: chainId,
  } = useWalletStore()
  const walletAdapter = useWalletAdapter()

  const mutationFn = async (amount: bigint) => {
    try {
      if (!l1Address || !aztecAddress || !aztecAccount) {
        throw new Error('Required accounts not connected')
      }

      if (!walletAdapter) {
        throw new Error(
          'Aztec wallet not connected or contracts not initialized'
        )
      }

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

      console.log('[L2→L1] Initiating withdrawal from L2 to L1...', {
        amount: amount.toString(),
        l1Address,
        private: isPrivacyModeEnabled,
      })
      setProgressStep(1, 'active')
      const nonce = Fr.random()
      const userAddress = AztecAddress.fromString(
        aztecAccount.address.toString()
      )
      const l2BridgeAddress = ADDRESS[L2_CHAIN_ID].L2.TOKEN_BRIDGE_CONTRACT

      // Azguard batches auth to burn + exit in one tx (public: add_public_authwit + exit_to_l1_public; private: add_private_authwit + exit_to_l1_private)
      const result = isPrivacyModeEnabled
        ? await walletAdapter.executeWithdrawToL1Private(
            l1Address,
            amount,
            nonce,
            userAddress
          )
        : await walletAdapter.executeWithdrawToL1Public(
            l1Address,
            amount,
            nonce,
            userAddress
          )

      const l2TxHash = result.txHash
      let l2BlockNumber: number | undefined = result.blockNumber

      console.log(
        '[L2→L1] L2 exit tx sent, hash:',
        l2TxHash,
        'blockNumber:',
        l2BlockNumber
      )

      setProgressStep(1, 'completed')
      setProgressStep(2, 'active') // Getting proof for withdrawal (highlight during polling + witness)

      // Azguard adapter does not return blockNumber; poll for receipt so we have it for the L1 withdraw (required for leaf index)
      if (l2BlockNumber == null) {
        console.log(
          '[L2→L1] Polling for L2 block number (required for L1 withdraw leaf index)...'
        )
        for (let i = 0; i < 60; i++) {
          await wait(2000)
          const receipt = await aztecNode.getTxReceipt(
            l2TxHash as unknown as Parameters<typeof aztecNode.getTxReceipt>[0]
          )
          if (receipt?.blockNumber != null) {
            l2BlockNumber = receipt.blockNumber
            console.log('[L2→L1] L2 block number from receipt:', l2BlockNumber)
            break
          }
        }
      }

      // Final wait before continuing (like L1→L2) so the L2 block is settled before we compute the witness
      // Longer final wait so the L2 block is visible on the node Azguard uses for simulation
        const finalWaitMs = 120_000 // 2 minutes (was 30s; reduces "nonexistent L2 block" from node lag)
        console.log(
        '[L2→L1] Final wait before continuing (',
        finalWaitMs / 1000,
        's)...'
      )
      await wait(finalWaitMs)

      // Store L2 to L1 message and transaction receipt in localStorage
      const withdrawalData = {
        id: Date.now().toString(),
        l2BridgeAddress: l2BridgeAddress,
        l2TxReceipt: {
          txHash: l2TxHash,
          blockNumber: l2BlockNumber?.toString(),
        },
        timestamp: Date.now(),
        amount: amount.toString(),
        l1Address,
        l2Address: aztecAddress,
        nonce: nonce.toString(),
        success: false,
        l2TxHash: l2TxHash,
        l2TxUrl: `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`,
      }

      const existingWithdrawals = localStorage.getItem('l2ToL1Withdrawals')
      const withdrawals = existingWithdrawals
        ? JSON.parse(existingWithdrawals)
        : []
      withdrawals.push(withdrawalData)
      localStorage.setItem('l2ToL1Withdrawals', JSON.stringify(withdrawals))

      setTransactionUrls(null, withdrawalData.l2TxUrl)

      const blockNumberForProof = l2BlockNumber
      if (blockNumberForProof == null || blockNumberForProof === 0) {
        const errMsg =
          'L2 block number is required for the withdrawal proof (leaf index and merkle path). Please wait for the L2 transaction to be confirmed and try again.'
        console.error('[L2→L1]', errMsg, {
          l2TxHash,
          l2BlockNumber: blockNumberForProof,
        })
        throw new Error(errMsg)
      }

      // Get L1 addresses and rollup version from node (same pattern as Aztec NFT example)
      console.log('[L2→L1] Fetching node info (rollupVersion, L1 addresses)...')
      const nodeInfo = await aztecNode.getNodeInfo()
      const l1Addresses = nodeInfo?.l1ContractAddresses ?? null
      const rollupVersion = nodeInfo?.rollupVersion
      console.log(
        '[L2→L1] Node info: rollupVersion=',
        rollupVersion,
        'blockNumberForProof=',
        blockNumberForProof
      )
      if (rollupVersion == null) {
        throw new Error(
          'Rollup version not available from Aztec node. Cannot compute L2→L1 message leaf.'
        )
      }
      if (!l1Addresses?.outboxAddress) {
        throw new Error('L1 contract addresses not available from node.')
      }
      const rollupAddress =
        l1Addresses?.rollupAddress?.toString?.() ??
        (l1Addresses as unknown as { rollupAddress?: string })?.rollupAddress

      // Compute L2→L1 message leaf directly (TokenPortal withdraw selector + recipient + amount + caller)
      const selectorBuf = Buffer.from(
        toFunctionSelector('withdraw(address,uint256,address)').slice(2),
        'hex'
      )
      const recipient = EthAddress.fromString(l1Address)
      const callerOnL1 = EthAddress.ZERO
      const content = sha256ToField([
        selectorBuf,
        recipient.toBuffer32(),
        new Fr(amount).toBuffer(),
        callerOnL1.toBuffer32(),
      ])
      const msgLeaf = computeL2ToL1MessageHash({
        l2Sender:
          typeof l2BridgeAddress === 'string'
            ? AztecAddress.fromString(l2BridgeAddress)
            : l2BridgeAddress,
        l1Recipient: EthAddress.fromString(
          ADDRESS[L1_CHAIN_ID].L1.PORTAL_CONTRACT
        ),
        content,
        rollupVersion: new Fr(rollupVersion),
        chainId: new Fr(L1_CHAIN_ID),
      })

      console.log(
        '[L2→L1] Computing L2→L1 membership witness (blockNumber=',
        blockNumberForProof,
        ')...'
      )
      const witness = await computeL2ToL1MembershipWitness(
        aztecNode,
        Number(blockNumberForProof) as Parameters<
          typeof computeL2ToL1MembershipWitness
        >[1],
        msgLeaf
      )
      if (!witness) {
        throw new Error(
          'L2→L1 message not found in block. The block may not be finalized yet, or the message leaf does not match.'
        )
      }
      const siblingPathHex = witness!.siblingPath
        .toBufferArray()
        .map((buf: Buffer) => `0x${buf.toString('hex')}` as `0x${string}`)
      // leafIndex 0 and empty sibling path are normal when the block has only one L2→L1 message (single-leaf tree)
      console.log(
        '[L2→L1] Witness ready: leafIndex=',
        witness!.leafIndex,
        'siblingPath length=',
        siblingPathHex.length,
        siblingPathHex.length === 0
          ? '(normal for single message in block)'
          : ''
      )
      setProgressStep(2, 'completed')

      setProgressStep(3, 'active')
      // Poll L1 Rollup.getProvenCheckpointNumber() until our L2 block is proven (or fallback to fixed wait)
      const pollIntervalMs = 120_000 // 2 minutes
      const maxWaitMs = 50 * 60 * 1000 // 50 min max
      const startWait = Date.now()
      let usedPoll = false
      let blockProven = false
      if (rollupAddress) {
        try {
          console.log(
            '[L2→L1] Polling L1 Rollup for proven block (blockNumberForProof=',
            blockNumberForProof,
            ')...'
          )
          usedPoll = true
          while (Date.now() - startWait < maxWaitMs) {
            const proven = await publicClient.readContract({
              address: rollupAddress as `0x${string}`,
              abi: RollupAbi,
              functionName: 'getProvenCheckpointNumber',
            })
            const provenBlock =
              typeof proven === 'bigint' ? Number(proven) : proven
            if (provenBlock >= blockNumberForProof) {
              console.log(
                '[L2→L1] L2 block',
                blockNumberForProof,
                'is proven on L1 (proven=',
                provenBlock,
                '), proceeding.'
              )
              blockProven = true
              break
            }
            console.log(
              '[L2→L1] L2 block not yet proven (proven=',
              provenBlock,
              ', need',
              blockNumberForProof,
              '). Waiting',
              pollIntervalMs / 1000,
              's...'
            )
            await wait(pollIntervalMs)
          }
          if (!blockProven) {
            console.warn(
              '[L2→L1] Max wait reached; proceeding with L1 withdraw (may revert if block not proven).'
            )
          }
        } catch (e) {
          console.warn(
            '[L2→L1] L1 Rollup poll failed, using fixed 40 min wait:',
            e
          )
          usedPoll = false
        }
      }
      if (!blockProven && !usedPoll) {
        console.log(
          '[L2→L1] Waiting 40 minutes for L2→L1 message to be processable on L1...'
        )
        await new Promise((resolve) => setTimeout(resolve, 40 * 60 * 1000))
      }
      setProgressStep(3, 'completed')

      // Final wait before sending L1 withdraw tx (L2 block just proven on L1)
      const finalWaitBeforeWithdrawMs = 30_000 // 30 seconds
      console.log(
        '[L2→L1] Final wait before L1 withdraw (',
        finalWaitBeforeWithdrawMs / 1000,
        's)...'
      )
      await wait(finalWaitBeforeWithdrawMs)

      setProgressStep(4, 'active')
      // Use the same block number we used for the witness (required by L1 Outbox for leaf index)
      const l2BlockNumForL1 = BigInt(blockNumberForProof)
      if (l2BlockNumForL1 <= 0n) {
        throw new Error(
          'L2 block number must be positive for L1 withdraw. Block number is required for leaf index verification on L1.'
        )
      }
      console.log(
        '[L2→L1] Withdraw args: l2BlockNumber=',
        blockNumberForProof,
        'leafIndex=',
        witness!.leafIndex,
        'siblingPathLen=',
        siblingPathHex.length
      )
      try {
        console.log(
          '[L2→L1] Sending L1 withdraw tx (recipient=',
          l1Address,
          'amount=',
          amount.toString(),
          ')...'
        )
        const withdrawData = encodeFunctionData({
          abi: TokenPortalAbi,
          functionName: 'withdraw',
          args: [
            l1Address,
            amount,
            false, // _withCaller
            l2BlockNumForL1,
            witness!.leafIndex,
            siblingPathHex,
          ],
        })

        const txHash = await requestWaapWallet(
          WAAP_METHOD.eth_sendTransaction,
          [
            {
              from: l1Address,
              to: ADDRESS[L1_CHAIN_ID].L1.PORTAL_CONTRACT,
              data: withdrawData,
            },
          ]
        )
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
        })
        console.log(
          '[L2→L1] L1 withdraw tx confirmed:',
          receipt.transactionHash
        )

        const l1TxUrl = `https://sepolia.etherscan.io/tx/${receipt.transactionHash}`
        const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`
        setTransactionUrls(l1TxUrl, l2TxUrl)

        // Update withdrawal data with success
        const updatedWithdrawalData = {
          ...withdrawalData,
          success: true,
          completedAt: Date.now(),
          l1TxHash: receipt.transactionHash,
          l1TxUrl,
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
      setProgressStep(4, 'completed')

      setProgressStep(5, 'active')
      const txHash = l2TxHash
      const aztecscanUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${txHash}`

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
      setProgressStep(5, 'completed')

      return txHash
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error'

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

      // Show error notification; hint if L1 Outbox reverted (block not proven / block number required for leaf index)
      const isBlockNotProven =
        /BlockNotProven|NothingToConsumeAtBlock|block.*required|required.*block/i.test(
          errorMessage
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
      console.log('[L2→L1] Withdrawal mutation onSuccess', { txHash, hasOnBridgeSuccess: !!onBridgeSuccess })
      // Refresh balances (L2→L1 withdrawal completed)
      queryClient.invalidateQueries({ queryKey: ['l1TokenBalances', l1Address] })
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
        console.log('[L2→L1] Calling onBridgeSuccess (handleBridgeSuccess)')
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
