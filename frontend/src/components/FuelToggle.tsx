'use client'

import React, { useEffect, useState } from 'react'
import { formatFjAmount, getFeeJuicePriceUsd, usdToTokenAmount } from '@/utils/fuelPricing'
import { buildSwapRoute, getV4Quote } from '@/utils/fuelPricing'
import { BRIDGED_FPC_ADDRESS } from '@/config'

interface FuelToggleProps {
  fuelEnabled: boolean
  fuelAmount: string
  bridgeAmount: string
  tokenSymbol: string
  tokenDecimals: number
  tokenAddress: string
  onToggle: (enabled: boolean) => void
  onAmountChange: (amount: string) => void
  feeJuiceBalance?: string
  privateFeeJuiceBalance?: string
  fuelType: 'public' | 'private'
  onFuelTypeChange: (type: 'public' | 'private') => void
}

const USD_PRESETS = [1, 5, 10]

/**
 * Hook that fetches a real V4 on-chain quote, debounced by 500ms.
 */
function useV4FuelQuote(
  fuelAmount: string,
  tokenAddress: string,
  tokenDecimals: number,
): { fjOutput: bigint | null; loading: boolean; error: string | null } {
  const [fjOutput, setFjOutput] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const amount = Number(fuelAmount)
    if (!fuelAmount || amount <= 0 || !tokenAddress) {
      setFjOutput(null)
      setError(null)
      return
    }

    const inputRaw = BigInt(Math.floor(amount * 10 ** tokenDecimals))
    if (inputRaw <= 0n) {
      setFjOutput(null)
      return
    }

    setLoading(true)
    setError(null)

    const timeout = setTimeout(async () => {
      try {
        const { poolKeys, zeroForOnes } = buildSwapRoute(tokenAddress as `0x${string}`)
        const output = await getV4Quote({
          poolKeys,
          zeroForOnes,
          inputAmount: inputRaw,
          l1RpcUrl: process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL ?? '',
        })
        setFjOutput(output)
        setError(null)
      } catch (err) {
        console.error('[FuelToggle] V4 quote failed:', err)
        setFjOutput(null)
        setError('Quote failed')
      } finally {
        setLoading(false)
      }
    }, 500)

    return () => clearTimeout(timeout)
  }, [fuelAmount, tokenAddress, tokenDecimals])

  return { fjOutput, loading, error }
}

function FuelBreakdown({ fuelNum, netBridge, tokenSymbol, fjOutput, loading, error }: {
  fuelNum: number; netBridge: number; tokenSymbol: string
  fjOutput: bigint | null; loading: boolean; error: string | null
}) {
  if (loading) {
    return <p>Fetching quote...</p>
  }
  if (error) {
    return <p className='text-red-500'>Failed to get V4 quote</p>
  }
  if (!fjOutput) {
    return null
  }

  const fjDisplay = formatFjAmount(fjOutput)
  const usdValue = (Number(fjOutput) / 1e18) * getFeeJuicePriceUsd()
  return (
    <>
      <p>Swapping {fuelNum} {tokenSymbol} → ~{fjDisplay} FJ (~${usdValue.toFixed(2)})</p>
      <p>You&apos;ll receive: {netBridge} {tokenSymbol} + ~{fjDisplay} Fee Juice</p>
    </>
  )
}

const FuelToggle: React.FC<FuelToggleProps> = ({
  fuelEnabled,
  fuelAmount,
  bridgeAmount,
  tokenSymbol,
  tokenDecimals,
  tokenAddress,
  onToggle,
  onAmountChange,
  feeJuiceBalance,
  privateFeeJuiceBalance,
  fuelType,
  onFuelTypeChange,
}) => {
  const bridgeNum = Number(bridgeAmount) || 0
  const fuelNum = Number(fuelAmount) || 0
  const isValid = fuelNum > 0 && fuelNum < bridgeNum
  const netBridge = bridgeNum - fuelNum
  const hasBridgedFpc = !!BRIDGED_FPC_ADDRESS

  const { fjOutput, loading, error } = useV4FuelQuote(
    isValid ? fuelAmount : '',
    tokenAddress,
    tokenDecimals,
  )

  // Check which USD preset is currently selected (if any)
  const activePreset = USD_PRESETS.find(
    (usd) => fuelAmount === usdToTokenAmount(usd, tokenSymbol)
  )

  return (
    <div className='bg-[#F5F5F5] rounded-md p-3 mt-3'>
      <div
        className='flex items-center justify-between cursor-pointer'
        onClick={() => onToggle(!fuelEnabled)}
      >
        <span className='text-sm font-medium text-latest-grey-700'>
          Top up gas balance
        </span>
        <div className='relative'>
          <div
            className='w-9 h-5 rounded-full transition-colors'
            style={{ backgroundColor: fuelEnabled ? '#3b82f6' : '#d1d5db' }}
          />
          <div
            className='absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform'
            style={{ transform: fuelEnabled ? 'translateX(1rem)' : 'translateX(0)' }}
          />
        </div>
      </div>
      <div className='text-xs text-latest-grey-500 mt-1 space-y-0.5'>
        <div className='flex justify-between'>
          <span>Public Fee Juice:</span>
          <span className='font-semibold'>{feeJuiceBalance ?? '--'}</span>
        </div>
        {hasBridgedFpc && (
          <div className='flex justify-between'>
            <span>Private Fee Juice:</span>
            <span className='font-semibold'>{privateFeeJuiceBalance ?? '--'}</span>
          </div>
        )}
      </div>

      {fuelEnabled && (
        <div className='mt-3 space-y-2'>
          {hasBridgedFpc && (
            <div className='flex rounded-md overflow-hidden border border-gray-200 text-xs'>
              <button
                onClick={() => onFuelTypeChange('public')}
                className={`flex-1 py-1.5 px-3 font-medium transition-colors ${
                  fuelType === 'public'
                    ? 'bg-black text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Public
              </button>
              <button
                onClick={() => onFuelTypeChange('private')}
                className={`flex-1 py-1.5 px-3 font-medium transition-colors ${
                  fuelType === 'private'
                    ? 'bg-black text-white'
                    : 'bg-white text-gray-500 hover:bg-gray-50'
                }`}
              >
                Private
              </button>
            </div>
          )}

          <div className='flex items-center gap-2'>
            <input
              type='text'
              inputMode='decimal'
              placeholder={`Amount in ${tokenSymbol}`}
              value={fuelAmount}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || !isNaN(Number(v))) onAmountChange(v)
              }}
              className='flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500'
            />
            {USD_PRESETS.map((usd) => {
              const tokenEquiv = usdToTokenAmount(usd, tokenSymbol)
              return (
                <button
                  key={usd}
                  onClick={() => onAmountChange(tokenEquiv)}
                  title={`${tokenEquiv} ${tokenSymbol}`}
                  className={`px-2 py-1 text-xs rounded border ${
                    activePreset === usd
                      ? 'border-blue-500 bg-blue-50 text-blue-600'
                      : 'border-gray-300 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  ${usd}
                </button>
              )
            })}
          </div>

          {fuelAmount && (
            <div className='text-xs text-latest-grey-700 space-y-0.5'>
              {isValid ? (
                <FuelBreakdown fuelNum={fuelNum} netBridge={netBridge} tokenSymbol={tokenSymbol} fjOutput={fjOutput} loading={loading} error={error} />
              ) : fuelNum >= bridgeNum ? (
                <p className='text-red-500'>
                  Gas amount must be less than bridge amount
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default FuelToggle
