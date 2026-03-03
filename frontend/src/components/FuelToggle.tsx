'use client'

import React from 'react'
import { computeFuelOutput, formatFjAmount, getFeeJuicePriceUsd } from '@/utils/fuelPricing'

interface FuelToggleProps {
  fuelEnabled: boolean
  fuelAmount: string
  bridgeAmount: string
  tokenSymbol: string
  tokenDecimals: number
  onToggle: (enabled: boolean) => void
  onAmountChange: (amount: string) => void
  feeJuiceBalance?: string
}

const PRESETS = ['1', '5', '10']

const FuelToggle: React.FC<FuelToggleProps> = ({
  fuelEnabled,
  fuelAmount,
  bridgeAmount,
  tokenSymbol,
  tokenDecimals,
  onToggle,
  onAmountChange,
  feeJuiceBalance,
}) => {
  const bridgeNum = Number(bridgeAmount) || 0
  const fuelNum = Number(fuelAmount) || 0
  const isValid = fuelNum > 0 && fuelNum < bridgeNum
  const netBridge = bridgeNum - fuelNum

  return (
    <div className='bg-[#F5F5F5] rounded-md p-3 mt-3'>
      {/* Toggle row */}
      <label className='flex items-center justify-between cursor-pointer'>
        <span className='text-sm font-medium text-latest-grey-700'>
          Fund your Aztec gas account
        </span>
        <div className='relative'>
          <input
            type='checkbox'
            className='sr-only peer'
            checked={fuelEnabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <div className='w-9 h-5 bg-gray-300 peer-checked:bg-blue-500 rounded-full transition-colors' />
          <div className='absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform' />
        </div>
      </label>
      <p className='text-xs text-latest-grey-500 mt-1'>
        Current gas balance: {feeJuiceBalance ?? '--'} FJ
      </p>

      {fuelEnabled && (
        <div className='mt-3 space-y-2'>
          {/* Amount input + presets */}
          <div className='flex items-center gap-2'>
            <input
              type='text'
              inputMode='decimal'
              placeholder='Amount'
              value={fuelAmount}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || !isNaN(Number(v))) onAmountChange(v)
              }}
              className='flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500'
            />
            {PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => onAmountChange(preset)}
                className={`px-2 py-1 text-xs rounded border ${
                  fuelAmount === preset
                    ? 'border-blue-500 bg-blue-50 text-blue-600'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          {/* Breakdown */}
          {fuelAmount && (
            <div className='text-xs text-latest-grey-700 space-y-0.5'>
              {isValid ? (
                <>
                  {(() => {
                    const fjOutput = computeFuelOutput(fuelAmount, tokenDecimals, tokenSymbol)
                    const fjDisplay = formatFjAmount(fjOutput)
                    const usdValue = (Number(fjOutput) / 1e18) * getFeeJuicePriceUsd()
                    return (
                      <>
                        <p>
                          Swapping {fuelNum.toFixed(2)} {tokenSymbol} → ~{fjDisplay} FJ (~${usdValue.toFixed(2)})
                        </p>
                        <p>
                          You&apos;ll receive: {netBridge.toFixed(2)} {tokenSymbol} + ~{fjDisplay} Fee Juice
                        </p>
                      </>
                    )
                  })()}
                </>
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
