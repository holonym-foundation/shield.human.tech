import StyledImage from '../StyledImage'
import { motion, AnimatePresence } from 'framer-motion'
import { Icon } from '@iconify/react'

interface AccountSelectorModalProps {
  isOpen: boolean
  accounts: Array<{ alias: string; address: string }>
  selectedAddress?: string | null
  onSelect: (account: { alias: string; address: string }) => void
  onCancel: () => void
  title?: string
}

function truncateAddress(address: string): string {
  if (address.length <= 13) return address
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`
}

export default function AccountSelectorModal({
  isOpen,
  accounts,
  selectedAddress,
  onSelect,
  onCancel,
  title = 'Select Account',
}: AccountSelectorModalProps) {
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
                {title}
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
              {accounts.length === 0 ? (
                <p className='text-latest-grey-600 text-14 mb-4'>
                  No accounts available.
                </p>
              ) : (
                <div className='flex flex-col gap-2 mb-4'>
                  {accounts.map((account) => {
                    const isSelected = selectedAddress === account.address
                    const displayName = account.alias || truncateAddress(account.address)
                    return (
                      <motion.button
                        key={account.address}
                        onClick={() => onSelect(account)}
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                        className={`flex items-center gap-3 w-full p-3 rounded-lg border transition-colors text-left ${
                          isSelected
                            ? 'border-blue-500 bg-blue-50'
                            : 'border-[#D4D4D4] hover:bg-latest-grey-200'
                        }`}>
                        <div className='flex-1 min-w-0'>
                          <p className='text-14 font-medium text-latest-black-300 truncate'>
                            {displayName}
                          </p>
                          {account.alias && (
                            <p className='text-12 text-latest-grey-600 truncate'>
                              {truncateAddress(account.address)}
                            </p>
                          )}
                        </div>
                        {isSelected && (
                          <Icon
                            icon='ph:check-bold'
                            width={18}
                            height={18}
                            className='text-blue-500 flex-shrink-0'
                          />
                        )}
                      </motion.button>
                    )
                  })}
                </div>
              )}

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className='flex justify-center gap-2 mt-2 mb-2'>
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
