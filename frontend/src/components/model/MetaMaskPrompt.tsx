import StyledImage from '../StyledImage'
import TextButton from '../TextButton'
import { motion, AnimatePresence } from 'framer-motion'
import { publicAsset } from '@/config'

export default function MetaMaskPrompt({ onClose }: { onClose: () => void }) {
  const handleInstallClick = () => {
    window.open(
      'https://chrome.google.com/webstore/detail/metamask/nkbihfbeogaeaoehlefnkodbefgpgknn',
      '_blank'
    )
  }

  return (
    <AnimatePresence>
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className='absolute inset-0 bg-latest-grey-1000 z-20 rounded-lg'
      >
        <motion.div 
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ 
            type: "spring",
            damping: 25,
            stiffness: 300
          }}
          className='absolute bottom-0 right-0 left-0'
        >
          <div className='px-2.5 py-3 bg-white rounded-lg'>
            <div className='flex justify-between items-center mx-2.5 py-1'>
              <p className='text-latest-black-300 font-semibold text-16'>
                {' '}
                Install MetaMask to Continue
              </p>
              <motion.button 
                onClick={onClose}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
              >
                <StyledImage src={publicAsset('/assets/svg/cross.svg')} alt='' className='h-[14px] w-[14px] m-[2px]' />
              </motion.button>
            </div>
            <div className='mt-4 mx-2.5'>
              <p className='text-[#737373] text-14 mb-6'>
                To use our app seamlessly, please install MetaMask Wallet
              </p>

              <motion.div 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className='bg-[#F5F5F5] p-2 rounded-lg mb-6 flex items-center gap-4'
              >
                <img src={publicAsset('/assets/svg/metamask.svg')} alt='MetaMask' />
                <p className='text-neutral-600 text-14'>
                  MetaMask is the world&apos;s most secure and flexible crypto wallet,
                  trusted by millions of users to buy, sell, and swap digital
                  assets.
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
              >
                <TextButton onClick={handleInstallClick}>
                  <StyledImage
                    src={publicAsset('/assets/svg/chrome.svg')}
                    alt='Chrome'
                    className='h-6 w-6'
                  />
                  <span>Go to Chrome Web Store</span>
                </TextButton>
              </motion.div>

              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className='flex justify-center gap-2 mt-6'
              >
                <StyledImage
                  src={publicAsset('/assets/svg/silk0.4.svg')}
                  alt=''
                  className='h-4 w-[14px]'
                />
                <p className='text-12 font-medium text-neutral-600'>
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
