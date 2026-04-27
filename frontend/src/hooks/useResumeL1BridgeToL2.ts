import { useMutation } from '@tanstack/react-query'
import { useBridgeStore } from '@/stores/bridgeStore'
import type { RecoveryClaimData } from '@human.tech/aztec-bridge-sdk'
import { useWalletStore, requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { useWalletAdapter } from './useWalletAdapter'
import { useToast } from './useToast'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent } from '@human.tech/aztec-bridge-sdk'
import { getAztecscanUrl, L2_CHAIN_ID } from '@/config'
import { verifyEncryptionDomain } from '@/utils'
import { logInfo, logError } from '@/utils/datadog'

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
          case 'recovery_from_receipt':
            logInfo('L1→L2 resume from receipt', {
              direction: 'L1_TO_L2_RESUME',
              l1TxHash: (event as any).l1TxHash,
              l1Address,
              userAction: 'resume_l1_to_l2_from_receipt',
            })
            notify('info', 'Recovering from L1 receipt...', { toastId: 'resume-l1-to-l2-progress', autoClose: 15000 })
            break
          case 'recovery_from_block_scan':
            logInfo('L1→L2 resume via block scan', {
              direction: 'L1_TO_L2_RESUME',
              l1BlockNumberBeforeTx: (event as any).l1BlockNumberBeforeTx,
              l1Address,
              userAction: 'resume_l1_to_l2_block_scan',
            })
            notify('info', 'Scanning L1 blocks for deposit...', {
              toastId: 'resume-l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case 'sync_poll':
            logInfo('L1→L2 resume sync poll', {
              direction: 'L1_TO_L2_RESUME',
              elapsedMinutes: event.elapsedMinutes,
              synced: event.synced,
              l1Address,
              userAction: 'resume_l1_to_l2_sync_poll',
            })
            notify('info', `Waiting for L1→L2 message sync (${event.elapsedMinutes.toFixed(0)} min elapsed)...`, {
              toastId: 'resume-l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case 'deposit_confirmed':
            if ('l1TxUrl' in event) setTransactionUrls(event.l1TxUrl, null)
            break
          case 'claim_attempt':
            logInfo('L1→L2 resume claim attempt', {
              direction: 'L1_TO_L2_RESUME',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              l1Address,
              userAction: 'resume_l1_to_l2_claim_attempt',
            })
            notify('info', `Claiming tokens on L2 (attempt ${event.attempt}/${event.maxAttempts})...`, {
              toastId: 'resume-l1-to-l2-progress',
              autoClose: 15000,
            })
            break
          case 'claim_retry':
            logInfo('L1→L2 resume claim retry', {
              direction: 'L1_TO_L2_RESUME',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              l1Address,
              userAction: 'resume_l1_to_l2_claim_retry',
            })
            notify(
              'info',
              `L2 node hasn't synced this message yet. Retrying in ${Math.round(event.delayMs / 60_000)} min (${event.attempt}/${event.maxAttempts})...`,
              { toastId: 'resume-l1-to-l2-progress', autoClose: 15000 },
            )
            break
          case 'operation_completed':
            logInfo('L1→L2 resume completed', {
              direction: 'L1_TO_L2_RESUME',
              operationId: event.operationId,
              l2TxHash: event.l2TxHash,
              alreadyCompleted: event.alreadyCompleted,
              l1Address,
              userAction: 'resume_l1_to_l2_completed',
            })
            if ('l2TxHash' in event && event.l2TxHash) {
              const l2TxUrl = `${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${event.l2TxHash}`
              setTransactionUrls(claimData.l1TxUrl ?? null, l2TxUrl)
            }
            break
          case 'attestation_fetch':
            logInfo('Resume attestation fetch', {
              direction: 'L1_TO_L2_RESUME',
              method: event.method,
              l1Address,
              userAction: 'resume_attestation_fetch',
            })
            break
          case 'attestation_fallback':
            logInfo('Resume attestation fallback', {
              direction: 'L1_TO_L2_RESUME',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address,
              userAction: 'resume_attestation_fallback',
            })
            break
          case 'patch_failed':
            logError(`Resume PATCH failed: ${event.label}`, {
              direction: 'L1_TO_L2_RESUME',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address,
              userAction: 'resume_l1_to_l2_patch_failed',
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
          case 'error':
            logError(
              event.error?.message ?? 'Resume error event',
              {
                direction: 'L1_TO_L2_RESUME',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address,
                userAction: 'resume_l1_to_l2_error',
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
