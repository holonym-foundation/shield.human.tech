import StyledImage from '../StyledImage'
import TextButton from '../TextButton'
import { motion, AnimatePresence } from 'framer-motion'

interface EmojiVerificationModalProps {
  isOpen: boolean
  emojis: string
  walletName?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function EmojiVerificationModal({
  isOpen,
  emojis,
  walletName,
  onConfirm,
  onCancel,
}: EmojiVerificationModalProps) {
  if (!isOpen) return null

  // Split emojis into array of individual emoji characters
  const emojiChars = [...emojis].filter((c) => c.trim().length > 0)

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
                Verify Wallet Connection
              </p>
              <motion.button
                onClick={onCancel}
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
              <p className='text-latest-grey-600 text-14 mb-4'>
                Verify these emojis match what{' '}
                <strong>{walletName || 'your wallet'}</strong> is showing
              </p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className='bg-latest-grey-200 p-6 rounded-lg mb-6'>
                <div className='grid grid-cols-3 gap-3 max-w-[180px] mx-auto'>
                  {emojiChars.slice(0, 9).map((emoji, i) => (
                    <div
                      key={i}
                      className='flex items-center justify-center text-3xl w-12 h-12 bg-white rounded-lg shadow-sm'>
                      {emoji}
                    </div>
                  ))}
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                className='flex gap-3'>
                <button
                  onClick={onCancel}
                  className='flex-1 py-3 rounded-[8px] border border-[#D4D4D4] text-latest-grey-600 font-medium hover:bg-latest-grey-200 transition-colors'>
                  Cancel
                </button>
                <TextButton onClick={onConfirm}>
                  <span>Confirm Match</span>
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
