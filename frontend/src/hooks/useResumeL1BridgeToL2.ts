import { useMutation } from '@tanstack/react-query'
import { useBridgeStore } from '@/stores/bridgeStore'
import type { RecoveryClaimData } from '@human.tech/aztec-bridge-sdk'
import { useWalletStore, requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import { useToast } from './useToast'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent } from '@human.tech/aztec-bridge-sdk'
import { BridgeEventType } from '@human.tech/aztec-bridge-sdk'
import { getAztecscanUrl, L2_CHAIN_ID } from '@/config'
import { verifyEncryptionDomain } from '@/utils'
import { logInfo, logError, DatadogUserAction } from '@/utils/datadog'

export function useResumeL1BridgeToL2(onSuccess?: (data: any) => void) {
  const { setProgressStep, setTransactionUrls, clearRecovery } = useBridgeStore()
  const { aztecAddress, aztecLoginMethod } = useWalletStore()
  const walletAdapter = useWalletAdapter()
  const notify = useToast()
  const bridge = useBridge()

  const mutationFn = async (claimData: RecoveryClaimData): Promise<string | undefined> => {
    if (!aztecAddress) throw new Error('Aztec wallet not connected')
    if (!walletAdapter) throw new Error('Aztec wallet adapter not initialized. Please wait for wallet to connect.')

    const l1Address = claimData.l1Address
    if (!l1Address)
      throw new Error('L1 address not available for decryption. Cannot resume without the original L1 wallet address.')

    // Warn if resume wallet differs from deposit wallet — decryption will fail
    const { waapAddress } = useWalletStore.getState()
    if (waapAddress && l1Address.toLowerCase() !== waapAddress.toLowerCase()) {
      console.warn('[Resume L1→L2] Connected wallet differs from deposit wallet:', waapAddress, 'vs', l1Address)
    }

    // surface the L1 tx URL upfront so the user can verify their deposit
    // confirmed on Etherscan during the long sync poll. The SDK's resume path
    // never emits 'deposit_confirmed' so the existing case in this hook only
    // ran at the very end — main set this URL right when resume began.
    if (claimData.l1TxUrl) {
      setTransactionUrls(claimData.l1TxUrl, null)
    }

    const result = await bridge.resume(claimData.operationId, {
      walletAdapter: walletAdapter as any,
      l1Address,
      l2Address: aztecAddress,
      sendTransaction: async (tx) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx])) as string
      },
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        const sig = await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, l1Address])
        return sig as string
      },
      onStep: (step, status) => setProgressStep(step, status),
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case BridgeEventType.RECOVERY_FROM_RECEIPT:
            logInfo('L1→L2 resume from receipt', {
              direction: 'L1_TO_L2_RESUME',
              l1TxHash: (event as any).l1TxHash,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_FROM_RECEIPT,
            })
            notify('info', 'Recovering from L1 receipt...', { toastId: 'resume-l1-to-l2-progress', autoClose: 15000 })
            break
          case BridgeEventType.RECOVERY_FROM_BLOCK_SCAN:
            logInfo('L1→L2 resume via block scan', {
              direction: 'L1_TO_L2_RESUME',
              l1BlockNumberBeforeTx: (event as any).l1BlockNumberBeforeTx,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_BLOCK_SCAN,
            })
            notify('info', 'Scanning L1 blocks for deposit...', {
              toastId: 'resume-l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case BridgeEventType.L2_BLOCK_WAIT:
            logInfo('L1→L2 resume sequencer block wait', {
              direction: 'L1_TO_L2_RESUME',
              elapsedSec: event.elapsedSec,
              currentBlock: event.currentBlock,
              targetBlock: event.targetBlock,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_SEQUENCER_WAIT,
            })
            notify(
              'info',
              `Waiting for L2 sequencer to include message (${Math.round(event.elapsedSec / 60)}m elapsed)...`,
              { toastId: 'resume-l1-to-l2-progress', autoClose: 15000 },
            )
            break
          case BridgeEventType.TOKEN_REGISTERED:
            logInfo('Token added to wallet after resume', {
              direction: 'L1_TO_L2_RESUME',
              tokenAddressL2: event.tokenAddressL2,
              l1Address,
              userAction: DatadogUserAction.RESUME_TOKEN_ADDED_TO_WALLET,
            })
            break
          case BridgeEventType.TOKEN_REGISTRATION_FAILED:
            logError(
              'Failed to add token to wallet after resume',
              {
                direction: 'L1_TO_L2_RESUME',
                tokenAddressL2: event.tokenAddressL2,
                l1Address,
                userAction: DatadogUserAction.RESUME_TOKEN_ADD_TO_WALLET_FAILED,
              },
              event.error,
            )
            break
          case BridgeEventType.SYNC_POLL:
            logInfo('L1→L2 resume sync poll', {
              direction: 'L1_TO_L2_RESUME',
              elapsedMinutes: event.elapsedMinutes,
              synced: event.synced,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_SYNC_POLL,
            })
            notify('info', `Waiting for L1→L2 message sync (${event.elapsedMinutes.toFixed(0)} min elapsed)...`, {
              toastId: 'resume-l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case BridgeEventType.DEPOSIT_CONFIRMED:
            if ('l1TxUrl' in event) setTransactionUrls(event.l1TxUrl, null)
            break
          case BridgeEventType.CLAIM_ATTEMPT:
            logInfo('L1→L2 resume claim attempt', {
              direction: 'L1_TO_L2_RESUME',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_CLAIM_ATTEMPT,
            })
            notify('info', `Claiming tokens on L2 (attempt ${event.attempt}/${event.maxAttempts})...`, {
              toastId: 'resume-l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case BridgeEventType.CLAIM_RETRY:
            logInfo('L1→L2 resume claim retry', {
              direction: 'L1_TO_L2_RESUME',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_CLAIM_RETRY,
            })
            notify(
              'info',
              `L2 node hasn't synced this message yet. Retrying in ${Math.round(event.delayMs / 60_000)} min (${event.attempt}/${event.maxAttempts})...`,
              { toastId: 'resume-l1-to-l2-progress', autoClose: 15000 },
            )
            break
          case BridgeEventType.OPERATION_COMPLETED:
            logInfo('L1→L2 resume completed', {
              direction: 'L1_TO_L2_RESUME',
              operationId: event.operationId,
              l2TxHash: event.l2TxHash,
              alreadyCompleted: event.alreadyCompleted,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_COMPLETED,
            })
            if ('l2TxHash' in event && event.l2TxHash) {
              const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${event.l2TxHash}`
              setTransactionUrls(claimData.l1TxUrl ?? null, l2TxUrl)
            }
            break
          case BridgeEventType.ATTESTATION_FETCH:
            logInfo('Resume attestation fetch', {
              direction: 'L1_TO_L2_RESUME',
              method: event.method,
              l1Address,
              userAction: DatadogUserAction.RESUME_ATTESTATION_FETCH,
            })
            break
          case BridgeEventType.ATTESTATION_FALLBACK:
            logInfo('Resume attestation fallback', {
              direction: 'L1_TO_L2_RESUME',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address,
              userAction: DatadogUserAction.RESUME_ATTESTATION_FALLBACK,
            })
            break
          case BridgeEventType.PATCH_FAILED:
            logError(`Resume PATCH failed: ${event.label}`, {
              direction: 'L1_TO_L2_RESUME',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address,
              userAction: DatadogUserAction.RESUME_L1_TO_L2_PATCH_FAILED,
            })
            notify(
              'warn',
              {
                heading: 'Backup Warning',
                message: `Could not save ${event.label} to server. Please do not close this page until the bridge completes.`,
              },
              { autoClose: false },
            )
            break
          case BridgeEventType.ERROR:
            logError(
              event.error?.message ?? 'Resume error event',
              {
                direction: 'L1_TO_L2_RESUME',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address,
                userAction: DatadogUserAction.RESUME_L1_TO_L2_ERROR,
              },
              event.error,
            )
            if (event.fundsAtRisk) {
              notify(
                'error',
                {
                  heading: 'Resume Error — Funds Safe',
                  message: 'Your deposit is safe on L1. Go to Activity to try again.',
                },
                { autoClose: false },
              )
            }
            break
        }
      },
    })

    clearRecovery()
    return result.l2TxHash
  }

  return useMutation({
    mutationFn,
    onSuccess: (txHash) => {
      if (onSuccess) onSuccess(txHash)
    },
  })
}
