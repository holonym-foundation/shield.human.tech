'use client'

import React, { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Icon } from '@iconify/react'
import { Oval } from 'react-loader-spinner'
import StyledImage from '@/components/StyledImage'
import EmojiVerificationModal from '@/components/model/EmojiVerificationModal'
import WalletDiscoveryModal from '@/components/model/WalletDiscoveryModal'
import { useWalletStore } from '@/stores/walletStore'
import {
  accountLabel,
  useBindingStatus,
  useSessionLinkedL2,
  shortAddr,
} from '@/hooks/useBindingStatus'
import { publicAsset } from '@/config'

/** Accounts per page in the selector before pagination kicks in. */
const ACCOUNTS_PER_PAGE = 4

function truncateAddress(address: string): string {
  if (address.length <= 13) return address
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`
}

interface Account {
  alias: string
  address: string
  index?: number
}

interface PaginatedAccountModalProps {
  isOpen: boolean
  accounts: Account[]
  onSelect: (account: Account) => void
  onCancel: () => void
  /**
   * L2 account the SERVER has disclosed as the connected EVM wallet's pair
   * (authoritative — never localStorage). null/undefined when nothing has been
   * disclosed yet, in which case no "linked" badge is shown (no guessing).
   */
  linkedAddress?: string | null
  /** Connected EVM address, used only to label the linked row. */
  linkedEvmAddress?: string | null
  title?: string
}

/**
 * Account picker for the wallet-sdk connection flow. Replaces the plain
 * scrolling list with:
 *  - readable labels (Azguard alias, else a stable "Account N" — issue #97),
 *  - a "linked to your EVM wallet" marker on the known-pair account (issue #98),
 *  - prev/next pagination instead of a scroll when there are many accounts
 *    (issue #99), matching the app's no-scroll direction.
 */
function PaginatedAccountModal({
  isOpen,
  accounts,
  onSelect,
  onCancel,
  linkedAddress,
  linkedEvmAddress,
  title = 'Select Account',
}: PaginatedAccountModalProps) {
  const [page, setPage] = useState(0)

  const pageCount = Math.max(1, Math.ceil(accounts.length / ACCOUNTS_PER_PAGE))
  // Clamp in case the account list shrank between renders.
  const safePage = Math.min(page, pageCount - 1)
  const paged = useMemo(
    () => accounts.slice(safePage * ACCOUNTS_PER_PAGE, safePage * ACCOUNTS_PER_PAGE + ACCOUNTS_PER_PAGE),
    [accounts, safePage],
  )
  const showPagination = accounts.length > ACCOUNTS_PER_PAGE

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
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className='absolute bottom-0 right-0 left-0'>
          <div className='px-2.5 py-3 bg-white rounded-lg'>
            <div className='flex justify-between items-center mx-2.5 py-1'>
              <p className='text-latest-black-300 font-semibold text-16'>{title}</p>
              <motion.button onClick={onCancel} whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }}>
                <StyledImage src={publicAsset('/assets/svg/cross.svg')} alt='' className='h-[14px] w-[14px] m-[2px]' />
              </motion.button>
            </div>

            <div className='mt-4 mx-2.5'>
              {accounts.length === 0 ? (
                <p className='text-neutral-600 text-14 mb-4'>No accounts available.</p>
              ) : (
                <div className='flex flex-col gap-2 mb-3'>
                  {paged.map((account, i) => {
                    const label = accountLabel(account, safePage * ACCOUNTS_PER_PAGE + i)
                    const isLinked =
                      !!linkedAddress && account.address.toLowerCase() === linkedAddress.toLowerCase()
                    return (
                      <motion.button
                        key={account.address}
                        onClick={() => onSelect(account)}
                        whileHover={{ scale: 1.01 }}
                        whileTap={{ scale: 0.99 }}
                        className={`flex items-center gap-3 w-full p-3 rounded-lg border transition-colors text-left ${
                          isLinked ? 'border-pink-40 bg-pink-5' : 'border-[#D4D4D4] hover:bg-latest-grey-200'
                        }`}>
                        <div className='flex-1 min-w-0'>
                          <p className='text-14 font-medium text-latest-black-300 truncate'>{label}</p>
                          <p className='text-12 text-neutral-600 truncate'>{truncateAddress(account.address)}</p>
                        </div>
                        {isLinked && (
                          <span
                            className='flex items-center gap-1 text-pink-90 text-[11px] font-medium flex-shrink-0'
                            title={
                              linkedEvmAddress
                                ? `Linked to your EVM wallet ${shortAddr(linkedEvmAddress)}`
                                : 'Linked to your EVM wallet'
                            }>
                            <Icon icon='ph:link-simple' width={14} height={14} />
                            {linkedEvmAddress ? `Linked to EVM ${shortAddr(linkedEvmAddress)}` : 'Linked'}
                          </span>
                        )}
                      </motion.button>
                    )
                  })}
                </div>
              )}

              {/* No linked account is known yet (nothing disclosed by the server
                  this session and nothing persisted from a prior one), so we
                  can't flag a row. Reassure the user that picking "wrong" is safe
                  — the button-guard blocks bridging a mismatched pair regardless. */}
              {accounts.length > 0 && !linkedAddress && (
                <p className='text-12 text-neutral-600 leading-snug mb-3 px-1'>
                  Not sure which to pick? Choose any — we&apos;ll flag it before you bridge and won&apos;t
                  let you bridge the wrong pair.
                </p>
              )}

              {showPagination && (
                <div className='flex items-center justify-between mb-3'>
                  <button
                    type='button'
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    aria-label='Previous accounts'
                    className={`flex items-center justify-center w-8 h-8 rounded-full border border-[#D4D4D4] transition-colors ${
                      safePage === 0 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-latest-grey-200 cursor-pointer'
                    }`}>
                    <Icon icon='ph:caret-left' width={16} height={16} className='text-latest-black-300' />
                  </button>

                  <div className='flex items-center gap-1.5'>
                    {Array.from({ length: pageCount }).map((_, i) => (
                      <span
                        key={i}
                        className={`h-1.5 rounded-full transition-all duration-200 ${
                          i === safePage ? 'w-4 bg-pink-90' : 'w-1.5 bg-latest-grey-300'
                        }`}
                      />
                    ))}
                  </div>

                  <button
                    type='button'
                    onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={safePage >= pageCount - 1}
                    aria-label='Next accounts'
                    className={`flex items-center justify-center w-8 h-8 rounded-full border border-[#D4D4D4] transition-colors ${
                      safePage >= pageCount - 1 ? 'opacity-40 cursor-not-allowed' : 'hover:bg-latest-grey-200 cursor-pointer'
                    }`}>
                    <Icon icon='ph:caret-right' width={16} height={16} className='text-latest-black-300' />
                  </button>
                </div>
              )}

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.2 }}
                className='flex justify-center gap-2 mt-2 mb-2'>
                <StyledImage src={publicAsset('/assets/svg/silk0.4.svg')} alt='' className='h-4 w-[14px]' />
                <p className='text-12 font-medium text-neutral-600'>Secured by human.tech</p>
              </motion.div>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

/**
 * Renders the Aztec wallet connection flow's modals based on `walletConnectionPhase`. Drop this
 * component once on any page that calls `connectAztecWallet()` so the user has UI to drive the
 * discovery → verification → account-select sequence.
 *
 * All state comes from the wallet store; the component is pure UI glue and takes no props.
 */
export function AztecWalletConnectionModals() {
  const {
    walletConnectionPhase,
    discoveredWallets,
    selectWallet,
    cancelWalletConnection,
    verificationEmojis,
    confirmWalletConnection,
    isAztecConnecting,
    availableAccounts,
    selectAccount,
    showWalletInstallPrompt,
    setShowWalletInstallPrompt,
    startWalletDiscovery,
    webWalletUrl,
    setWebWalletUrl,
    waapAddress,
  } = useWalletStore()

  // SERVER TRUTH ONLY (issue #124): the picker marks an account as "linked" only
  // when the server has actually disclosed the connected EVM wallet's bound L2
  // counterpart — never from device-local storage. useBindingStatus feeds any
  // disclosure into the in-memory session store; useSessionLinkedL2 then reads it
  // back, so the badge persists across modal reopens within the session and shows
  // even after the transient conflict response has cleared. null (no badge, no
  // guessing) until something has actually been disclosed.
  useBindingStatus()
  const linkedAddress = useSessionLinkedL2(waapAddress)

  // Single source of truth for "the wallet discovery/install modal is open".
  // The "No Aztec Wallet Found" (install prompt) and "Select Aztec Wallet"
  // (discovery) screens are two STATES of one modal instance, never two
  // simultaneously-mounted modals (#332). The modal picks its own state from
  // `isDiscovering` + `wallets`; mounting it a second time while it's already
  // open is impossible because there is only one render site.
  const isWalletDiscoveryOpen =
    showWalletInstallPrompt ||
    walletConnectionPhase === 'discovering' ||
    walletConnectionPhase === 'selecting'

  return (
    <>
      {isWalletDiscoveryOpen && (
        <WalletDiscoveryModal
          isOpen={true}
          wallets={discoveredWallets}
          isDiscovering={walletConnectionPhase === 'discovering'}
          onSelectWallet={selectWallet}
          onClose={() => {
            cancelWalletConnection()
            setShowWalletInstallPrompt(false)
          }}
          onRecheck={() => {
            void startWalletDiscovery()
          }}
          webWalletUrl={webWalletUrl}
          onConnectWebWallet={setWebWalletUrl}
        />
      )}
      {walletConnectionPhase === 'verifying' && verificationEmojis && (
        <EmojiVerificationModal
          isOpen={true}
          emojis={verificationEmojis}
          isConfirming={isAztecConnecting}
          onConfirm={confirmWalletConnection}
          onCancel={cancelWalletConnection}
        />
      )}
      {/* Secure-channel handshake runs between picking a wallet and the emoji
          check. Hold a loading state here so the modal never blinks out and
          looks like the click did nothing. */}
      {walletConnectionPhase === 'verifying' && !verificationEmojis && (
        <div className='fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4'>
          <div className='flex flex-col items-center gap-4 rounded-2xl bg-white px-8 py-7 shadow-xl'>
            <Oval height={40} width={40} color='#81133B' secondaryColor='#FA8FC4' strokeWidth={4} />
            <p className='text-neutral-600 text-14 font-medium'>Connecting to wallet...</p>
          </div>
        </div>
      )}
      {walletConnectionPhase === 'requesting' && (
        <div className='fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4'>
          <div className='flex flex-col items-center gap-4 rounded-2xl bg-white px-8 py-7 shadow-xl'>
            <Oval height={40} width={40} color='#81133B' secondaryColor='#FA8FC4' strokeWidth={4} />
            <p className='text-neutral-600 text-14 font-medium'>Requesting permissions...</p>
          </div>
        </div>
      )}
      {walletConnectionPhase === 'account-select' && (
        <PaginatedAccountModal
          isOpen={true}
          accounts={availableAccounts}
          onSelect={selectAccount}
          onCancel={cancelWalletConnection}
          linkedAddress={linkedAddress}
          linkedEvmAddress={waapAddress}
          title='Select Account'
        />
      )}
    </>
  )
}

export default AztecWalletConnectionModals
