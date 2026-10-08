'use client'
import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useL2PendingTxCount, useNetworkHealth } from '@/hooks/useL2Operations'
import { topUpDeadline, useNetworkVersions } from '@/hooks/useNetworkVersions'
import { LEGACY_MODE, publicAsset } from '@/config'

const BannerAztecTestnet = () => {
  const [isCongestionVisible, setIsCongestionVisible] = useState(true)
  const [isDownVisible, setIsDownVisible] = useState(true)
  const [isMigrationVisible, setIsMigrationVisible] = useState(true)
  const { self, current, others } = useNetworkVersions()
  const legacyVersion = others.find((v) => v.status === 'legacy')

  const { data: pendingTxCount } = useL2PendingTxCount()
  const { data: networkHealth } = useNetworkHealth()

  const isNetworkDown = networkHealth?.isNetworkDown
  const isCongested = pendingTxCount != null && pendingTxCount > 40

  return (
    <>
      {/* Network down banner — takes priority */}
      {isDownVisible && isNetworkDown && (
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 1 }}
            className='bg-[#FFF0F0] text-[#7A1A1A] relative flex items-center justify-center px-4 py-4 rounded-lg text-sm font-semibold w-full'>
            <div className='flex items-center gap-3'>
              <img src={publicAsset('/assets/svg/alert.svg')} alt='Alert' className='w-6 h-6' />
              <span>
                The Aztec network appears to be down. Bridging is temporarily
                disabled.
              </span>
            </div>
            <button
              onClick={() => setIsDownVisible(false)}
              className='absolute right-4 hover:opacity-80 transition-opacity'>
              <img src={publicAsset('/assets/svg/cross.svg')} alt='Close' className='w-4 h-4' />
            </button>
          </motion.div>
        </AnimatePresence>
      )}

      {/* Plain <a>, not next/link: version paths are root-relative and must skip this build's basePath. */}
      {!isNetworkDown && LEGACY_MODE && current && (
        <div className='bg-pink-10 text-[#17235E] flex items-center justify-center gap-3 px-4 py-4 rounded-lg text-sm font-semibold w-full'>
          <img src={publicAsset('/assets/svg/alert.svg')} alt='' className='w-6 h-6' />
          <span>
            {self?.label ?? 'This version'} is retired. Withdraw here, then deposit on{' '}
            <a href={current.path} className='text-shield underline'>
              {current.label}
            </a>
            . Gas top-ups end {topUpDeadline(self?.pauseAt)}.
          </span>
        </div>
      )}

      {isMigrationVisible && !isNetworkDown && !LEGACY_MODE && legacyVersion && (
        <div className='bg-pink-10 text-[#17235E] relative flex items-center justify-center px-4 py-4 rounded-lg text-sm font-semibold w-full'>
          <div className='flex items-center gap-3'>
            <img src={publicAsset('/assets/svg/alert.svg')} alt='' className='w-6 h-6' />
            <span>
              Funds on {legacyVersion.label}?{' '}
              <a href={legacyVersion.path} className='text-shield underline'>
                Withdraw them
              </a>
              . Gas top-ups there end {topUpDeadline(legacyVersion.pauseAt)}.
            </span>
          </div>
          <button
            onClick={() => setIsMigrationVisible(false)}
            aria-label='Dismiss'
            className='absolute right-4 hover:opacity-80 transition-opacity'>
            <img src={publicAsset('/assets/svg/cross.svg')} alt='' className='w-4 h-4' />
          </button>
        </div>
      )}

      {/* Congestion banner — shown when network is up but busy */}
      {isCongestionVisible && !isNetworkDown && isCongested && (
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 1 }}
            className='bg-[#FDE7F3] text-[#17235E] relative flex items-center justify-center px-4 py-4 rounded-lg text-sm font-semibold w-full'>
            <div className='flex items-center gap-3'>
              <img src={publicAsset('/assets/svg/alert.svg')} alt='Alert' className='w-6 h-6' />
              <span>
                The Aztec network is congested right now. Your transactions may take
                longer or may be dropped.
              </span>
            </div>
            <button
              onClick={() => setIsCongestionVisible(false)}
              className='absolute right-4 hover:opacity-80 transition-opacity'>
              <img src={publicAsset('/assets/svg/cross.svg')} alt='Close' className='w-4 h-4' />
            </button>
          </motion.div>
        </AnimatePresence>
      )}
    </>
  )
}

export default BannerAztecTestnet
