import React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Icon } from '@iconify/react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import StyledImage from './StyledImage'
import { publicAsset } from '@/config'

interface TransactionBreakdownProps {
  isOpen: boolean
  onToggle: () => void
  // Portal fee deducted from the bridged token. `bridgeFee` is undefined while
  // the fee rate is still loading.
  bridgeFee?: string
  bridgeFeeUsd?: string
  // Portal fee as a percentage of the fee base (e.g. "2.54"). Undefined while loading.
  bridgeFeePercent?: string
  receiveAmount?: string
  tokenSymbol?: string
  // Fee-juice carve-out summary (deposit + fuel only). `fuelReserveToken` is the token
  // amount swapped to gas; `fuelReserveFj` is the resulting FeeJuice (already formatted).
  fuelReserveToken?: string
  fuelReserveFj?: string
}

// Motion values mirrored from the human-tech design system (docs/tokens.css):
// --dur-normal / --ease-default for the inline detail accordion reveal.
const DS_DUR_NORMAL = 0.28
const DS_EASE_DEFAULT: [number, number, number, number] = [0.4, 0, 0.2, 1]

// True in-place accordion — the header stays put and the detail expands/collapses
// below it, so the From/To section above never has to unmount to make room.
const TransactionBreakdown: React.FC<TransactionBreakdownProps> = ({
  isOpen,
  onToggle,
  bridgeFee,
  bridgeFeeUsd,
  bridgeFeePercent,
  receiveAmount,
  tokenSymbol,
  fuelReserveToken,
  fuelReserveFj,
}) => {
  const shouldReduceMotion = useReducedMotion()
  const showFuel = !!fuelReserveToken && !!fuelReserveFj

  return (
    <div className='mt-1.5 bg-[#F5F5F5] rounded-md overflow-hidden'>
      <button
        type='button'
        className='w-full px-3 py-2 flex items-center justify-between font-semibold text-sm text-latest-black-100'
        onClick={onToggle}
        aria-expanded={isOpen}
        aria-controls='transaction-breakdown-detail'
      >
        <span>Transaction breakdown</span>
        <StyledImage
          src={publicAsset('/assets/svg/buttons.svg')}
          className={`w-5 h-5 transition-transform ${isOpen ? '-rotate-90' : 'rotate-90'}`}
          alt=''
        />
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            id='transaction-breakdown-detail'
            key='breakdown-detail'
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : DS_DUR_NORMAL, ease: DS_EASE_DEFAULT }}
            className='overflow-hidden'
          >
            <div className='px-3 pb-3 space-y-[14px]'>
              <div className='flex justify-between'>
                <p className='text-sm font-medium text-latest-grey-700'>
                  Time to Aztec
                </p>
                <p className='text-latest-black-300 text-14 font-medium'>~2 mins</p>
              </div>
              <div className='flex justify-between'>
                <div className='flex gap-1 items-center text-center'>
                  <p className='text-sm font-medium text-latest-grey-700'>
                    Bridge fee
                  </p>
                  <span
                    className='inline-flex cursor-help'
                    data-tooltip-id='bridge-fee-tooltip'
                    aria-label='How the bridge fee is calculated'
                  >
                    <StyledImage
                      src={publicAsset('/assets/svg/info.svg')}
                      alt=''
                      className='h-4 w-4'
                    />
                  </span>
                </div>
                <p className='text-latest-grey-100 text-14 font-medium'>
                  {bridgeFee != null ? (
                    <>
                      {bridgeFeeUsd != null && <>$ {bridgeFeeUsd} </>}
                      <span className='text-latest-black-300'>
                        {bridgeFee} {tokenSymbol}
                      </span>
                      {bridgeFeePercent != null && (
                        <span className='text-latest-grey-100'> ({bridgeFeePercent}%)</span>
                      )}
                    </>
                  ) : (
                    <span className='text-latest-black-300'>—</span>
                  )}
                </p>
              </div>
              <ReactTooltip
                id='bridge-fee-tooltip'
                place='top'
                className='z-[100] max-w-[240px]'
                style={{ fontSize: '11px', padding: '6px 8px' }}
                render={() => (
                  <span>
                    The bridge charges{' '}
                    {bridgeFeePercent != null ? (
                      <span className='font-semibold'>{bridgeFeePercent}%</span>
                    ) : (
                      'a percentage'
                    )}{' '}
                    of the amount you bridge
                    {bridgeFee != null && (
                      <>
                        {' '}
                        —{' '}
                        <span className='font-semibold'>
                          {bridgeFee} {tokenSymbol}
                        </span>{' '}
                        on this deposit
                      </>
                    )}
                    . It is deducted from the tokens delivered on Aztec.
                  </span>
                )}
              />
              {showFuel && (
                <div className='flex justify-between gap-3'>
                  <div className='flex gap-1 items-center'>
                    <Icon icon='ph:gas-pump-fill' width={14} height={14} className='shrink-0 text-[#17235E]' />
                    <p className='text-sm font-medium text-latest-grey-700'>Fee juice (L2 gas)</p>
                  </div>
                  <p className='text-latest-black-300 text-14 font-medium text-right'>
                    {fuelReserveToken} {tokenSymbol}
                    <span className='text-latest-grey-100'> → ~{fuelReserveFj} FJ</span>
                  </p>
                </div>
              )}
              {showFuel && (
                <p className='text-[11px] leading-[15px] text-latest-grey-500 -mt-2'>
                  Swapped to Fee Juice for gas on Aztec — not a fee. You keep this as your L2 gas balance.
                </p>
              )}
              <div className='flex justify-between'>
                <p className='text-sm font-medium text-latest-grey-700'>You receive</p>
                <p className='text-latest-black-300 text-14 font-medium'>
                  {receiveAmount ?? '—'} {tokenSymbol}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default TransactionBreakdown
