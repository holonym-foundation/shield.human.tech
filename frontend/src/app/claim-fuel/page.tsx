'use client'

import React, { useEffect, useMemo, useState } from 'react'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { Fr } from '@aztec/aztec.js/fields'
import RootStyle from '@/components/RootStyle'
import BridgeHeader from '@/components/BridgeHeader'
import AztecWalletConnectionModals from '@/components/AztecWalletConnectionModals'
import { useWalletStore } from '@/stores/walletStore'
import { useWalletAdapter } from '@/hooks/useWalletAdapter'
import { useToast } from '@/hooks/useToast'
import { decodeFuelClaimPayload, type FuelClaimPayload } from '@/utils/fuelClaimLink'
import { L2_CHAIN_ID, getAztecscanUrl } from '@/config'

function shortenAztec(addr: string): string {
  if (!addr) return ''
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

function formatFj(amountStr: string): string {
  try {
    const n = BigInt(amountStr)
    // FeeJuice uses 18 decimals
    const whole = n / 10n ** 18n
    const frac = n % 10n ** 18n
    if (frac === 0n) return whole.toString()
    const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '')
    return `${whole.toString()}.${fracStr.slice(0, 6)}`
  } catch {
    return amountStr
  }
}

type ClaimStatus = 'idle' | 'submitting' | 'success' | 'error'

export default function ClaimFuelPage() {
  const notify = useToast()
  const {
    aztecAddress,
    isAztecConnected,
    connectAztecWallet,
    isAztecConnecting,
  } = useWalletStore()
  const walletAdapter = useWalletAdapter()

  const [payload, setPayload] = useState<FuelClaimPayload | null>(null)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [status, setStatus] = useState<ClaimStatus>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [l2TxHash, setL2TxHash] = useState<string | null>(null)

  // Decode payload from URL fragment on mount. Using the fragment (#) keeps the secret out of
  // server logs, referrers, and analytics — it's only ever readable client-side.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash || !hash.includes('data=')) {
      setDecodeError('No claim data found in this link.')
      return
    }
    try {
      const stripped = hash.startsWith('#') ? hash.slice(1) : hash
      const params = new URLSearchParams(stripped)
      const data = params.get('data')
      if (!data) {
        setDecodeError('Claim link is missing the data parameter.')
        return
      }
      const decoded = decodeFuelClaimPayload(data)
      setPayload(decoded)
    } catch (err) {
      setDecodeError(err instanceof Error ? err.message : 'Failed to decode claim link.')
    }
  }, [])

  const recipientMatches = useMemo(() => {
    if (!payload || !aztecAddress) return false
    try {
      const expected = AztecAddress.fromString(payload.recipient).toString().toLowerCase()
      return expected === aztecAddress.toLowerCase()
    } catch {
      return false
    }
  }, [payload, aztecAddress])

  const handleClaim = async () => {
    if (!payload || !walletAdapter || !aztecAddress) return
    setStatus('submitting')
    setErrorMsg(null)
    try {
      const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee')
      const { buildClaimGasSettings } = await import('@/utils/fuelGasEstimate')

      const gasSettings = await buildClaimGasSettings()
      const paymentMethod = new FeeJuicePaymentMethodWithClaim(AztecAddress.fromString(aztecAddress), {
        claimAmount: BigInt(payload.claimAmount),
        claimSecret: Fr.fromString(payload.claimSecret),
        messageLeafIndex: BigInt(payload.messageLeafIndex),
      })

      // Empty BatchCall: setup phase runs claim_and_end_setup (mints the FJ to recipient + ends
      // setup); app phase has no calls. Net effect: tx mints FJ, pays its own gas from the freshly
      // claimed balance, and leaves the rest in the recipient's account.
      const { txHash } = await walletAdapter.executeBatch([], {
        fee: { paymentMethod, gasSettings },
      })

      console.log('[ClaimFuel] Claim tx submitted:', txHash)
      setL2TxHash(txHash)
      setStatus('success')
      notify('success', 'Fee Juice claimed successfully')
    } catch (err) {
      console.error('[ClaimFuel] Claim failed:', err)
      const msg = err instanceof Error ? err.message : 'Failed to claim Fee Juice'
      setErrorMsg(msg)
      setStatus('error')
    }
  }

  return (
    <RootStyle className='overflow-y-auto'>
      <AztecWalletConnectionModals />
      <div className='px-5 pt-5 pb-5 flex flex-col h-full max-w-2xl mx-auto'>
        <div className='flex items-center gap-4'>
          <BridgeHeader />
        </div>
        <h2 className='text-lg font-semibold mt-4'>Claim Fee Juice</h2>

        {decodeError && (
          <div className='mt-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-800'>
            <p className='font-semibold'>Invalid claim link</p>
            <p className='mt-1'>{decodeError}</p>
            <p className='mt-2 text-red-600'>
              Ask the sender to copy the link again. Make sure you opened the full URL including everything after the #.
            </p>
          </div>
        )}

        {payload && (
          <div className='mt-4 space-y-3'>
            <div className='rounded-md bg-[#F5F5F5] p-3 space-y-2 text-sm'>
              <div className='flex justify-between'>
                <span className='text-latest-grey-500'>Amount</span>
                <span className='font-semibold'>{formatFj(payload.claimAmount)} FJ</span>
              </div>
              <div className='flex justify-between'>
                <span className='text-latest-grey-500'>Recipient</span>
                <span className='font-mono text-xs' title={payload.recipient}>
                  {shortenAztec(payload.recipient)}
                </span>
              </div>
              {payload.l1TxHash && (
                <div className='flex justify-between'>
                  <span className='text-latest-grey-500'>Origin tx</span>
                  <span className='font-mono text-xs' title={payload.l1TxHash}>
                    {payload.l1TxHash.slice(0, 10)}…{payload.l1TxHash.slice(-6)}
                  </span>
                </div>
              )}
            </div>

            {!isAztecConnected && (
              <div className='rounded-md border border-gray-200 p-3 space-y-2 text-sm'>
                <p>Connect the Aztec wallet for{' '}
                  <span className='font-mono'>{shortenAztec(payload.recipient)}</span> to claim.
                </p>
                <button
                  type='button'
                  disabled={isAztecConnecting}
                  onClick={() => connectAztecWallet().catch(() => undefined)}
                  className='w-full py-2 rounded-md bg-black text-white font-medium disabled:opacity-50'
                >
                  {isAztecConnecting ? 'Connecting…' : 'Connect Aztec wallet'}
                </button>
              </div>
            )}

            {isAztecConnected && aztecAddress && !recipientMatches && (
              <div className='rounded-md bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800'>
                <p className='font-semibold'>Wrong wallet connected</p>
                <p className='mt-1'>
                  This claim is for <span className='font-mono'>{shortenAztec(payload.recipient)}</span> but
                  you&apos;re connected as <span className='font-mono'>{shortenAztec(aztecAddress)}</span>.
                  Switch to the correct account before claiming — Fee Juice is non-transferable, so we can&apos;t
                  redirect it after the claim.
                </p>
              </div>
            )}

            {isAztecConnected && recipientMatches && status !== 'success' && (
              <div className='rounded-md border border-gray-200 p-3 space-y-2 text-sm'>
                <p className='text-latest-grey-700'>
                  Click below to submit the L2 claim. The transaction pays for its own gas from the Fee Juice
                  it mints — you don&apos;t need any L2 balance to start.
                </p>
                <button
                  type='button'
                  disabled={status === 'submitting' || !walletAdapter}
                  onClick={handleClaim}
                  className='w-full py-2 rounded-md bg-black text-white font-medium disabled:opacity-50'
                >
                  {status === 'submitting' ? 'Claiming…' : 'Claim Fee Juice'}
                </button>
                {status === 'error' && errorMsg && (
                  <p className='text-red-600 text-xs whitespace-pre-wrap'>{errorMsg}</p>
                )}
              </div>
            )}

            {status === 'success' && l2TxHash && (
              <div className='rounded-md bg-green-50 border border-green-200 p-3 text-sm space-y-2'>
                <p className='text-green-800 font-semibold'>Claim submitted</p>
                <p className='text-green-700'>
                  {formatFj(payload.claimAmount)} FJ is on its way to{' '}
                  <span className='font-mono'>{shortenAztec(payload.recipient)}</span>. Balance will appear
                  after the L2 tx is mined.
                </p>
                <a
                  href={`${getAztecscanUrl(L2_CHAIN_ID)}/tx-effects/${l2TxHash}`}
                  target='_blank'
                  rel='noreferrer noopener'
                  className='text-green-700 underline break-all'
                >
                  View on aztecscan
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </RootStyle>
  )
}
