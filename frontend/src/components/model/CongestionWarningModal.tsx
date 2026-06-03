import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import StyledImage from '../StyledImage'
import TextButton from '../TextButton'

interface CongestionWarningModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
}

const CongestionWarningModal: React.FC<CongestionWarningModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className='absolute inset-0 bg-latest-grey-1000 z-20 rounded-lg'>
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{
            type: 'spring',
            damping: 25,
            stiffness: 300,
          }}
          className='absolute bottom-0 right-0 left-0'>
          <div className='px-2.5 py-3 bg-white rounded-lg'>
            <div className='flex justify-between items-center mx-2.5 py-1'>
              <p className='text-latest-black-300 font-semibold text-16'>
                Network Congestion Warning
              </p>
              <motion.button
                onClick={onClose}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}>
                <StyledImage
                  src='/assets/svg/cross.svg'
                  alt=''
                  className='h-[14px] w-[14px] m-[2px]'
                />
              </motion.button>
            </div>
            <div className='mt-4 mx-2.5'>
              <p className='text-[#737373] text-14 mb-6'>
                Aztec network is busy right now.
                <br />
                Transactions might be slow or fail.
              </p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className='bg-[#E5EFFF] py-2 px-2 rounded-lg mb-6 flex items-center gap-4'>
                <img
                  src='/assets/svg/IconContainer.svg'
                  alt='Warning'
                  // className='h-10 w-10'
                />
                <p className='text-[#737373] text-14'>
                  For best results,
                  <br />
                  try again later for smoother processing
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className='grid grid-cols-[max-content_1fr] gap-2'>
                <TextButton
                  onClick={onClose}
                  className='bg-[#F5F5F5] text-black hover:bg-[#e5e5e5] w-[120px]'>
                  Cancel
                </TextButton>
                <TextButton
                  onClick={onConfirm}
                  className='flex items-center justify-center gap-2 w-full'>
                  Proceed Anyway
                  <img src='/assets/svg/white-right-arrow.svg' alt='' />
                </TextButton>
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className='flex justify-center gap-2 mt-6'>
                <StyledImage
                  src='/assets/svg/silk0.4.svg'
                  alt=''
                  className='h-4 w-[14px]'
                />
                <p className='text-12 font-medium text-latest-grey-600'>
                  Secured by human.tech
                </p>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

export default CongestionWarningModal
