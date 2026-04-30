'use client'

import React from 'react'
import { Oval } from 'react-loader-spinner'
import EmojiVerificationModal from '@/components/model/EmojiVerificationModal'
import AccountSelectorModal from '@/components/model/AccountSelectorModal'
import WalletDiscoveryModal from '@/components/model/WalletDiscoveryModal'
import { useWalletStore } from '@/stores/walletStore'

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
  } = useWalletStore()

  return (
    <>
      {showWalletInstallPrompt && (
        <WalletDiscoveryModal
          isOpen={true}
          wallets={[]}
          isDiscovering={false}
          onSelectWallet={() => {}}
          onClose={() => setShowWalletInstallPrompt(false)}
        />
      )}
      {(walletConnectionPhase === 'discovering' || walletConnectionPhase === 'selecting') && (
        <WalletDiscoveryModal
          isOpen={true}
          wallets={discoveredWallets}
          isDiscovering={walletConnectionPhase === 'discovering'}
          onSelectWallet={selectWallet}
          onClose={cancelWalletConnection}
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
      {walletConnectionPhase === 'requesting' && (
        <div className='absolute inset-0 bg-latest-grey-1000 z-20 rounded-lg flex flex-col items-center justify-center gap-4'>
          <Oval height={40} width={40} color='#3b82f6' secondaryColor='#93c5fd' strokeWidth={4} />
          <p className='text-latest-grey-600 text-14 font-medium'>Requesting permissions...</p>
        </div>
      )}
      {walletConnectionPhase === 'account-select' && (
        <AccountSelectorModal
          isOpen={true}
          accounts={availableAccounts}
          onSelect={selectAccount}
          onCancel={cancelWalletConnection}
          title='Select Account'
        />
      )}
    </>
  )
}

export default AztecWalletConnectionModals
