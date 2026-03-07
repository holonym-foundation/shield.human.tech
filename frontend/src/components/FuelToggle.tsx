'use client'

import React from 'react'
import { computeFuelOutput, formatFjAmount, getFeeJuicePriceUsd, usdToTokenAmount } from '@/utils/fuelPricing'
import { BRIDGED_FPC_ADDRESS } from '@/config'

interface FuelToggleProps {
  fuelEnabled: boolean
  fuelAmount: string
  bridgeAmount: string
  tokenSymbol: string
  tokenDecimals: number
  onToggle: (enabled: boolean) => void
  onAmountChange: (amount: string) => void
  feeJuiceBalance?: string
  privateFeeJuiceBalance?: string
  fuelType: 'public' | 'private'
  onFuelTypeChange: (type: 'public' | 'private') => void
}

const USD_PRESETS = [1, 5, 10]

function FuelBreakdown({ fuelAmount, fuelNum, netBridge, tokenDecimals, tokenSymbol }: {
  fuelAmount: string; fuelNum: number; netBridge: number; tokenDecimals: number; tokenSymbol: string
}) {
  const fjOutput = computeFuelOutput(fuelAmount, tokenDecimals, tokenSymbol)
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
        <p>Public FJ: {feeJuiceBalance ?? '--'}</p>
        {hasBridgedFpc && (
          <p>Private wFJ: {privateFeeJuiceBalance ?? '--'}</p>
        )}
      </div>

      {fuelEnabled && (
        <div className='mt-3 space-y-2'>
          {hasBridgedFpc && (
            <div className='flex rounded-md overflow-hidden border border-gray-300 text-xs'>
              <button
                onClick={() => onFuelTypeChange('public')}
                className={`flex-1 py-1.5 px-3 font-medium transition-colors ${
                  fuelType === 'public'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Public FJ
              </button>
              <button
                onClick={() => onFuelTypeChange('private')}
                className={`flex-1 py-1.5 px-3 font-medium transition-colors ${
                  fuelType === 'private'
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                Private wFJ
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
                <FuelBreakdown fuelAmount={fuelAmount} fuelNum={fuelNum} netBridge={netBridge} tokenDecimals={tokenDecimals} tokenSymbol={tokenSymbol} />
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
