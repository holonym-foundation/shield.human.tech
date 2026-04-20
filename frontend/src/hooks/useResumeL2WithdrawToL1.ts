import { useMutation } from '@tanstack/react-query'
import { useBridgeStore } from '@/stores/bridgeStore'
import type { RecoveryWithdrawalData } from '@human.tech/aztec-bridge-sdk'
import { useWalletStore, requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { useToast } from './useToast'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent } from '@human.tech/aztec-bridge-sdk'
import { verifyEncryptionDomain } from '@/utils'
import { getEtherscanUrl, L1_CHAIN_ID } from '@/config'
import { logInfo, logError } from '@/utils/datadog'

export function useResumeL2WithdrawToL1(onSuccess?: (data: any) => void) {
  const { setProgressStep, setTransactionUrls, clearRecovery } = useBridgeStore()
  const { waapAddress: l1Address } = useWalletStore()
  const notify = useToast()
  const bridge = useBridge()

  const mutationFn = async (data: RecoveryWithdrawalData): Promise<string | undefined> => {
    // Require explicit recipientL1Address — falling back to connected wallet
    // could withdraw funds to the wrong L1 address if the user switched wallets.
    const withdrawRecipient = data.recipientL1Address || l1Address
    if (!withdrawRecipient) throw new Error('L1 address not available for withdrawal')
    if (data.recipientL1Address && l1Address && data.recipientL1Address.toLowerCase() !== l1Address.toLowerCase()) {
      console.warn(
        '[Resume L2→L1] recipientL1Address differs from connected wallet:',
        data.recipientL1Address,
        'vs',
        l1Address,
      )
    }

    // Show L2 tx URL if available
    if (data.l2TxUrl) setTransactionUrls(null, data.l2TxUrl)

    const result = await bridge.resume(data.operationId, {
      l1Address: withdrawRecipient,
      l2Address: data.l2Address,
      sendTransaction: async (tx) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx])) as string
      },
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        return (await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, withdrawRecipient])) as string
      },
      onStep: (step, status) => setProgressStep(step, status),
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case 'witness_computed':
            logInfo('Resume witness computed', {
              direction: 'L2_TO_L1_RESUME',
              leafIndex: event.leafIndex,
              epoch: event.epoch,
              l1Address: withdrawRecipient,
              userAction: 'resume_l2_to_l1_witness_computed',
            })
            break
          case 'proven_poll':
            notify(
              'info',
              `Waiting for L2 block to be proven on L1 (proven: ${event.provenBlock}, need: ${event.neededBlock}, ${Math.round(event.elapsedMs / 60_000)} min elapsed)...`,
              { toastId: 'resume-l2-to-l1-progress', autoClose: 15000 },
            )
            break
          case 'proven_fallback':
            notify('info', `Waiting ~${Math.round(event.fixedWaitMs / 60_000)} min for block finalization...`, {
              toastId: 'resume-l2-to-l1-progress',
              autoClose: 15000,
            })
            break
          case 'l1_withdraw_sent':
            logInfo('Resume L1 withdraw tx sent', {
              direction: 'L2_TO_L1_RESUME',
              l1TxHash: event.l1TxHash,
              l1Address: withdrawRecipient,
              userAction: 'resume_l2_to_l1_l1_withdraw_sent',
            })
            setTransactionUrls(event.l1TxUrl, data.l2TxUrl ?? null)
            break
          case 'attestation_fetch':
            logInfo('Resume attestation fetch', {
              direction: 'L2_TO_L1_RESUME',
              method: event.method,
              l1Address: withdrawRecipient,
              userAction: 'resume_attestation_fetch',
            })
            break
          case 'attestation_fallback':
            logInfo('Resume attestation fallback', {
              direction: 'L2_TO_L1_RESUME',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address: withdrawRecipient,
              userAction: 'resume_attestation_fallback',
            })
            break
          case 'patch_failed':
            logError(`Resume PATCH failed: ${event.label}`, {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address: withdrawRecipient,
              userAction: 'resume_l2_to_l1_patch_failed',
            })
            notify(
              'warn',
              {
                heading: 'Backup Warning',
                message: `Could not save ${event.label} to server. Please do not close this page until the withdrawal completes.`,
              },
              { autoClose: false },
            )
            break
          case 'operation_completed': {
            logInfo('Resume L2→L1 withdrawal completed', {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              l1TxHash: event.l1TxHash,
              alreadyCompleted: event.alreadyCompleted,
              l1Address: withdrawRecipient,
              userAction: 'resume_l2_to_l1_completed',
            })
            if (event.l1TxHash) {
              const l1Url = `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}`
              setTransactionUrls(l1Url, data.l2TxUrl ?? null)
            }
            break
          }
          case 'error':
            logError(
              event.error?.message ?? 'Resume error event',
              {
                direction: 'L2_TO_L1_RESUME',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address: withdrawRecipient,
                userAction: 'resume_l2_to_l1_error',
              },
              event.error,
            )
            if (event.fundsAtRisk) {
              notify(
                'error',
                {
                  heading: 'Resume Error — Funds Safe',
                  message: 'Your withdrawal proof is saved. Go to Activity to try again.',
                },
                { autoClose: false },
              )
            }
            break
        }
      },
    })

    clearRecovery()
    return result.l1TxHash
  }

  return useMutation({
    mutationFn,
    onSuccess: (txHash) => {
      if (onSuccess) onSuccess(txHash)
    },
  })
}
