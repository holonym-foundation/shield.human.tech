import React from 'react'
import StyledImage from './StyledImage'

interface TransactionBreakdownProps {
  isOpen: boolean
  onToggle: () => void
  // Portal fee deducted from the bridged token. `bridgeFee` is undefined while
  // the fee rate is still loading.
  bridgeFee?: string
  bridgeFeeUsd?: string
  receiveAmount?: string
  tokenSymbol?: string
}

const TransactionBreakdown: React.FC<TransactionBreakdownProps> = ({
  isOpen,
  onToggle,
  bridgeFee,
  bridgeFeeUsd,
  receiveAmount,
  tokenSymbol,
}) => {
  if (!isOpen) {
    return (
      <button
        className='w-full p-4 rounded-md bg-white font-semibold flex items-center justify-center'
        onClick={onToggle}>
        <span>Transaction breakdown</span>
        <StyledImage
          src='/assets/svg/buttons.svg'
          className='w-6 h-6'
          alt='open'
        />
      </button>
    )
  }
  return (
    <div className='bg-[#F5F5F5] rounded-md p-4 mt-4'>
      <div
        className='font-semibold text-lg mb-2 flex items-center justify-between cursor-pointer bg-white rounded-md p-2'
        onClick={onToggle}>
        <span>Back to Bridge</span>
        <button aria-label='Back to Bridge'>
          <StyledImage
            src='/assets/svg/buttons.svg'
            className='w-6 h-6 rotate-90'
            alt='close'
          />
        </button>
      </div>
      <div>
        <div className='mt-4 flex justify-between'>
          <p className='text-sm font-medium text-latest-grey-700'>
            Time to Aztec
          </p>
          <p className='text-latest-black-300 text-14 font-medium'>~2 mins</p>
        </div>
        <div className='mt-[14px] flex justify-between'>
          <div className='flex gap-1 items-center text-center'>
            <p className='text-sm font-medium text-latest-grey-700'>
              Bridge fee
            </p>
            <StyledImage
              src='/assets/svg/info.svg'
              alt=''
              className='h-4 w-4'
            />
          </div>
          <p className='text-latest-grey-100 text-14 font-medium'>
            {bridgeFee != null ? (
              <>
                {bridgeFeeUsd != null && <>$ {bridgeFeeUsd} </>}
                <span className='text-latest-black-300'>
                  {bridgeFee} {tokenSymbol}
                </span>
              </>
            ) : (
              <span className='text-latest-black-300'>—</span>
            )}
          </p>
        </div>
        <div className='mt-[14px] flex justify-between'>
          <p className='text-sm font-medium text-latest-grey-700'>You receive</p>
          <p className='text-latest-black-300 text-14 font-medium'>
            {receiveAmount ?? '—'} {tokenSymbol}
          </p>
        </div>
      </div>
    </div>
  )
}

export default TransactionBreakdown
