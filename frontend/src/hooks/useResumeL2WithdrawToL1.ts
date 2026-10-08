import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useBridgeStore } from '@/stores/bridgeStore'
import type { RecoveryWithdrawalData } from '@human.tech/clean.sdk'
import { useWalletStore, requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { useToast } from './useToast'
import { dismissNotificationByKey } from '@/stores/useNotificationsStore'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent } from '@human.tech/clean.sdk'
import { BridgeEventType } from '@human.tech/clean.sdk'
import { L1_GAS_RETRY_NOTICE, verifyEncryptionDomain } from '@/utils'
import { getEtherscanUrl, L1_CHAIN_ID } from '@/config'
import { logInfo, logError, DatadogUserAction } from '@/utils/datadog'

export function useResumeL2WithdrawToL1(onSuccess?: (data: any) => void) {
  const { setProgressStep, setTransactionUrls, clearRecovery, markOperationLive, clearOperationLive } =
    useBridgeStore()
  const { waapAddress: l1Address, signWaapMessage } = useWalletStore()
  const notify = useToast()
  const bridge = useBridge()
  const queryClient = useQueryClient()

  const mutationFn = async (data: RecoveryWithdrawalData): Promise<string | undefined> => {
    // Stable, per-operation key so the resume-error feed row can be retired by
    // key the moment THIS op genuinely completes (see OPERATION_COMPLETED). Keyed
    // by operationId so completing one stuck withdrawal never clears another's
    // still-valid resume error.
    const resumeErrorKey = `l2-to-l1-resume-error-${data.operationId}`
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

    // This resume IS the thing driving the operation now, so Activity must stop
    // offering a second Resume for it while this one runs (cleared in onSettled).
    markOperationLive(data.operationId)

    const result = await bridge.resume(data.operationId, {
      l1Address: withdrawRecipient,
      l2Address: data.l2Address,
      sendTransaction: async (tx) => {
        return (await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx])) as string
      },
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        // Cached signer (not raw personal_sign): a same-session withdrawal resume
        // reuses the deterministic "Unlock My Secrets" signature instead of
        // re-prompting. Byte-identical message → matching cache key (#408 / P1).
        const sig = await signWaapMessage(msg)
        if (!sig) throw new Error('Failed to sign message')
        return sig
      },
      onStep: (step, status) => setProgressStep(step, status),
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case BridgeEventType.RECOVERY_L2_BLOCK:
            logInfo('L2→L1 resume recovered l2BlockNumber from receipt', {
              direction: 'L2_TO_L1_RESUME',
              l2TxHash: event.l2TxHash,
              l2BlockNumber: event.l2BlockNumber,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_RECOVERED_L2_BLOCK,
            })
            break
          case BridgeEventType.WITNESS_COMPUTED:
            logInfo('Resume witness computed', {
              direction: 'L2_TO_L1_RESUME',
              leafIndex: event.leafIndex,
              epoch: event.epoch,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_WITNESS_COMPUTED,
            })
            break
          case BridgeEventType.PROVEN_POLL:
            logInfo('L2→L1 resume proven poll', {
              direction: 'L2_TO_L1_RESUME',
              provenBlock: event.provenBlock,
              neededBlock: event.neededBlock,
              elapsedMs: event.elapsedMs,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_PROVEN_POLL,
            })
            notify(
              'info',
              `Waiting for L2 block to be proven on L1 (proven: ${event.provenBlock}, need: ${event.neededBlock}, ${Math.round(event.elapsedMs / 60_000)} min elapsed)...`,
              { toastId: 'resume-l2-to-l1-progress', autoClose: 15000 },
            )
            break
          case BridgeEventType.PROVEN_FALLBACK:
            logInfo('L2→L1 resume proven fallback', {
              direction: 'L2_TO_L1_RESUME',
              fixedWaitMs: event.fixedWaitMs,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_PROVEN_FALLBACK,
            })
            notify('info', `Waiting ~${Math.round(event.fixedWaitMs / 60_000)} min for block finalization...`, {
              toastId: 'resume-l2-to-l1-progress',
              autoClose: 15000,
            })
            break
          case BridgeEventType.L1_GAS_RETRY:
            notify('warn', L1_GAS_RETRY_NOTICE, { autoClose: false, toastId: 'l1-gas-retry' })
            break
          case BridgeEventType.L1_WITHDRAW_SENT:
            logInfo('Resume L1 withdraw tx sent', {
              direction: 'L2_TO_L1_RESUME',
              l1TxHash: event.l1TxHash,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_L1_WITHDRAW_SENT,
            })
            setTransactionUrls(event.l1TxUrl, data.l2TxUrl ?? null)
            break
          case BridgeEventType.ATTESTATION_FETCH:
            logInfo('Resume attestation fetch', {
              direction: 'L2_TO_L1_RESUME',
              method: event.method,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_ATTESTATION_FETCH,
            })
            break
          case BridgeEventType.ATTESTATION_FALLBACK:
            logInfo('Resume attestation fallback', {
              direction: 'L2_TO_L1_RESUME',
              from: event.from,
              to: event.to,
              reason: event.reason,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_ATTESTATION_FALLBACK,
            })
            break
          case BridgeEventType.PATCH_FAILED:
            logError(`Resume PATCH failed: ${event.label}`, {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              patchLabel: event.label,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_PATCH_FAILED,
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
          case BridgeEventType.OPERATION_COMPLETED: {
            logInfo('Resume L2→L1 withdrawal completed', {
              direction: 'L2_TO_L1_RESUME',
              operationId: event.operationId,
              l1TxHash: event.l1TxHash,
              alreadyCompleted: event.alreadyCompleted,
              l1Address: withdrawRecipient,
              userAction: DatadogUserAction.RESUME_L2_TO_L1_COMPLETED,
            })
            if (event.l1TxHash) {
              const l1Url = `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}`
              setTransactionUrls(l1Url, data.l2TxUrl ?? null)
            }
            // The op just reached its terminal 'completed' status on the backend.
            // Refetch operations so Activity re-derives it as done (no Resume, no
            // "N to finish") instead of serving the stale resumable status.
            queryClient.invalidateQueries({ queryKey: ['bridgeOperations', l1Address] })
            // Retire any lingering "Resume Error — Funds Safe" feed row for this
            // op — the withdrawal finished, so the resume affordance it pointed to
            // is gone. Mirrors round-16's dismiss of the do-not-reload banner.
            dismissNotificationByKey(resumeErrorKey)
            break
          }
          case BridgeEventType.ERROR:
            logError(
              event.error?.message ?? 'Resume error event',
              {
                direction: 'L2_TO_L1_RESUME',
                fundsAtRisk: event.fundsAtRisk,
                operationId: event.operationId,
                l1Address: withdrawRecipient,
                userAction: DatadogUserAction.RESUME_L2_TO_L1_ERROR,
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
                // Keyed so this feed row is dismissed by key on genuine completion
                // of the same op (see OPERATION_COMPLETED).
                { autoClose: false, toastId: resumeErrorKey },
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
    onSettled: (_data, _error, withdrawalData) => {
      clearOperationLive(withdrawalData?.operationId)
    },
  })
}
