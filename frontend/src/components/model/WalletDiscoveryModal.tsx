import { useEffect, useState } from 'react'
import StyledImage from '../StyledImage'
import { motion, AnimatePresence } from 'framer-motion'
import { Oval } from 'react-loader-spinner'
import type { WalletProvider } from '@/utils/walletSdkConnection'
import { publicAsset } from '@/config'

interface WalletDiscoveryModalProps {
  isOpen: boolean
  wallets: Array<{ name: string; provider: WalletProvider }>
  isDiscovering: boolean
  onSelectWallet: (provider: WalletProvider) => void
  onClose: () => void
  webWalletUrl?: string
  onConnectWebWallet?: (url: string) => void
  /**
   * Re-run wallet discovery (re-posts the SDK's discovery request). Powers the
   * manual "check again" action and the auto re-detect when the user returns to
   * the tab after installing an extension. Optional so the modal degrades
   * gracefully if a caller doesn't wire it.
   */
  onRecheck?: () => void
}

const AZGUARD_URL = 'https://azguardwallet.io'

// The SDK's underlying discovery runs for up to 60s to give a user time to
// approve an already-installed wallet. That's far too long to stare at a
// spinner when nothing is installed, so cap the VISIBLE search here: after this
// long with nothing found we show the "No Aztec Wallet Found" fast path while
// discovery keeps listening in the background — a wallet that shows up later
// still surfaces (#329).
const SEARCH_TIMEOUT_MS = 6000

export default function WalletDiscoveryModal({
  isOpen,
  wallets,
  isDiscovering,
  onSelectWallet,
  onClose,
  webWalletUrl = '',
  onConnectWebWallet,
  onRecheck,
}: WalletDiscoveryModalProps) {
  const [urlInput, setUrlInput] = useState(webWalletUrl)
  const [searchTimedOut, setSearchTimedOut] = useState(false)

  const trimmedUrl = urlInput.trim()
  const isValidUrl = /^https?:\/\/.+/i.test(trimmedUrl)

  const submitWebWallet = () => {
    if (!isValidUrl || !onConnectWebWallet) return
    onConnectWebWallet(trimmedUrl)
  }

  const hasWallets = wallets.length > 0
  const isSearching = isDiscovering && !hasWallets && !searchTimedOut
  // No wallet available AND we've stopped actively looking (SDK gave up, or the
  // visible-search cap elapsed). This is the fast-path / dead-end screen.
  const showNoWallets = !hasWallets && (!isDiscovering || searchTimedOut)

  // Bounded visible search (#329): arm a timer while actively searching with
  // nothing found; if a wallet arrives (hasWallets) or discovery stops, drop
  // the timer and reset so a fresh scan starts clean.
  useEffect(() => {
    if (!isOpen || !isDiscovering || hasWallets) {
      setSearchTimedOut(false)
      return
    }
    setSearchTimedOut(false)
    const id = window.setTimeout(() => setSearchTimedOut(true), SEARCH_TIMEOUT_MS)
    return () => window.clearTimeout(id)
  }, [isOpen, isDiscovering, hasWallets])

  // Auto re-detect (#331): a newly installed extension only injects its content
  // script into the already-open tab; it never fires a passive announce event
  // this SDK could listen to (discovery is a timed request/response). The
  // realistic install flow is "user leaves to install, returns to the tab", so
  // re-run discovery whenever this stranded screen regains focus/visibility.
  useEffect(() => {
    if (!isOpen || !showNoWallets || !onRecheck) return
    const rescan = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      onRecheck()
    }
    window.addEventListener('focus', rescan)
    document.addEventListener('visibilitychange', rescan)
    return () => {
      window.removeEventListener('focus', rescan)
      document.removeEventListener('visibilitychange', rescan)
    }
  }, [isOpen, showNoWallets, onRecheck])

  if (!isOpen) return null

  const webWalletInput = onConnectWebWallet ? (
    <div className='mb-4'>
      <label className='block text-neutral-600 text-12 font-medium mb-1.5'>
        Web wallet URL
      </label>
      <div className='flex gap-2'>
        <input
          type='url'
          inputMode='url'
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitWebWallet()
          }}
          placeholder='https://your-wallet.vercel.app'
          className='flex-1 min-w-0 px-3 py-2 rounded-[8px] bg-[#F5F5F5] text-14 text-latest-black-300 outline-none focus:ring-2 focus:ring-[#81133B]'
        />
        <motion.button
          onClick={submitWebWallet}
          disabled={!isValidUrl}
          whileHover={isValidUrl ? { scale: 1.02 } : undefined}
          whileTap={isValidUrl ? { scale: 0.98 } : undefined}
          className='px-4 py-2 rounded-[8px] bg-latest-black-300 text-white text-14 font-medium disabled:opacity-40 disabled:cursor-not-allowed'>
          Connect
        </motion.button>
      </div>
      {trimmedUrl && !isValidUrl && (
        <p className='text-red-500 text-12 mt-1'>Enter a valid http(s) URL</p>
      )}
    </div>
  ) : null

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
                {showNoWallets ? 'No Aztec Wallet Found' : 'Select Aztec Wallet'}
              </p>
              <motion.button
                onClick={onClose}
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}>
                <StyledImage
                  src={publicAsset('/assets/svg/cross.svg')}
                  alt=''
                  className='h-[14px] w-[14px] m-[2px]'
                />
              </motion.button>
            </div>

            <div className='mt-4 mx-2.5'>
              {showNoWallets ? (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 }}>
                  <p className='text-neutral-600 text-14 mb-4'>
                    No Aztec wallet has answered yet. If yours asked you to unlock
                    or approve, do that and it will appear here. Otherwise install
                    Azguard, or connect a web wallet below.
                  </p>

                  <motion.a
                    href={AZGUARD_URL}
                    target='_blank'
                    rel='noopener noreferrer'
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    className='flex items-center justify-center gap-2 w-full py-3 rounded-[8px] bg-[#81133B] text-white text-14 font-semibold'>
                    <StyledImage
                      src={publicAsset('/assets/svg/aztec-wallet-logo.svg')}
                      alt=''
                      className='w-5 h-5'
                    />
                    <span>Get Azguard</span>
                  </motion.a>

                  {onRecheck && (
                    <motion.button
                      onClick={onRecheck}
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.99 }}
                      className='w-full mt-3 py-2.5 rounded-[8px] border border-[#D4D4D4] text-latest-black-300 text-14 font-medium'>
                      Check again
                    </motion.button>
                  )}

                  <div className='mt-6'>{webWalletInput}</div>
                </motion.div>
              ) : (
                <>
                  {webWalletInput}

                  {isSearching && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className='flex flex-col items-center py-8 gap-4'>
                      <Oval
                        height={36}
                        width={36}
                        color='#3B3B3B'
                        secondaryColor='#D4D4D4'
                        strokeWidth={4}
                      />
                      <p className='text-neutral-600 text-14'>
                        Searching for Aztec wallets...
                      </p>
                    </motion.div>
                  )}

                  {hasWallets && (
                    <div className='flex flex-col gap-3 mb-4'>
                      {wallets.map((w, i) => (
                        <motion.button
                          key={w.provider.id ?? i}
                          initial={{ opacity: 0, y: 10 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: i * 0.1 }}
                          onClick={() => onSelectWallet(w.provider)}
                          className='flex items-center gap-3 p-4 rounded-[8px] bg-[#F5F5F5] hover:bg-[#E5E5E5] transition-colors'
                          whileHover={{ scale: 1.01 }}
                          whileTap={{ scale: 0.99 }}>
                          <StyledImage
                            src={publicAsset('/assets/svg/aztec-wallet-logo.svg')}
                            alt={w.name}
                            className='w-8 h-8'
                          />
                          <span className='font-medium text-latest-black-300'>
                            {w.name}
                          </span>
                        </motion.button>
                      ))}
                      {isDiscovering && (
                        <p className='text-neutral-600 text-12 text-center'>
                          Still searching for more wallets...
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.4 }}
                className='flex justify-center gap-2 mt-4 mb-2'>
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
