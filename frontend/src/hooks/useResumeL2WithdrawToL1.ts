import { useMutation } from '@tanstack/react-query'
import { useBridgeStore } from '@/stores/bridgeStore'
import type { RecoveryWithdrawalData } from '@human.tech/aztec-bridge-sdk'
import { useWalletStore, requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { useToast } from './useToast'
import { useBridge } from '@/hooks/useBridge'
import type { BridgeEvent } from '@human.tech/aztec-bridge-sdk'
import { verifyEncryptionDomain } from '@/utils'
import { getEtherscanUrl, L1_CHAIN_ID } from '@/config'

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
      console.warn('[Resume L2→L1] recipientL1Address differs from connected wallet:', data.recipientL1Address, 'vs', l1Address)
    }

    // Show L2 tx URL if available
    if (data.l2TxUrl) setTransactionUrls(null, data.l2TxUrl)

    const result = await bridge.resume(data.operationId, {
      l1Address: withdrawRecipient,
      l2Address: data.l2Address,
      sendTransaction: async (tx) => {
        return await requestWaapWallet(WAAP_METHOD.eth_sendTransaction, [tx]) as string
      },
      signMessage: async (msg: string) => {
        verifyEncryptionDomain()
        return await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, withdrawRecipient]) as string
      },
      onStep: (step, status) => setProgressStep(step, status),
      onEvent: (event: BridgeEvent) => {
        switch (event.type) {
          case 'witness_computed':
            break
          case 'proven_poll':
            notify('info', `Waiting for L2 block to be proven on L1 (proven: ${event.provenBlock}, need: ${event.neededBlock}, ${Math.round(event.elapsedMs / 60_000)} min elapsed)...`, { toastId: 'resume-l2-to-l1-progress', autoClose: 15000 })
            break
          case 'proven_fallback':
            notify('info', `Waiting ~${Math.round(event.fixedWaitMs / 60_000)} min for block finalization...`, { toastId: 'resume-l2-to-l1-progress', autoClose: 15000 })
            break
          case 'l1_withdraw_sent':
            setTransactionUrls(event.l1TxUrl, data.l2TxUrl ?? null)
            break
          case 'attestation_fetch':
            console.log(`[Resume L2→L1] Fetching ${event.method} attestation...`)
            break
          case 'attestation_fallback':
            console.log(`[Resume L2→L1] ${event.from} failed, falling back to ${event.to}: ${event.reason}`)
            break
          case 'patch_failed':
            notify('warn', {
              heading: 'Backup Warning',
              message: `Could not save ${event.label} to server. Please do not close this page until the withdrawal completes.`,
            }, { autoClose: false })
            break
          case 'operation_completed': {
            if (event.l1TxHash) {
              const l1Url = `${getEtherscanUrl(L1_CHAIN_ID)}/tx/${event.l1TxHash}`
              setTransactionUrls(l1Url, data.l2TxUrl ?? null)
            }
            break
          }
          case 'error':
            if (event.fundsAtRisk) {
              notify('error', {
                heading: 'Resume Error — Funds Safe',
                message: 'Your withdrawal proof is saved. Go to Activity to try again.',
              }, { autoClose: false })
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
