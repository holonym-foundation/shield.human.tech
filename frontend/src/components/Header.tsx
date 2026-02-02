'use client'

import { Icon } from '@iconify/react'
import { useToast } from '@/hooks/useToast'
import { useWalletStore } from '@/stores/walletStore'
import { useBridgeStore } from '@/stores/bridgeStore'
import { useL1TokenBalances } from '@/hooks/useL1Operations'
import { wait } from '@/utils'
import { LOGIN_METHODS, WalletType } from '@/types/wallet'
import Image from 'next/image'
import Link from 'next/link'
import React, { useEffect, useRef, useState } from 'react'
import { Tooltip as ReactTooltip } from 'react-tooltip'
import { silkUrl } from '@/config/l1.config'

type WalletDisplayProps = {
  address?: string
  isConnected: boolean
  walletIcon: string
  networkIcon?: string
  balance?: string
  onClick?: () => void
  onDisconnect?: () => void
  walletType: WalletType
  loginMethod?: string | null
}

const WalletDisplay: React.FC<WalletDisplayProps> = ({
  address,
  isConnected,
  walletIcon,
  networkIcon,
  balance,
  onClick,
  onDisconnect,
  walletType,
  loginMethod,
}) => {
  const [showDropdown, setShowDropdown] = useState(false)
  const [copied, setCopied] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setShowDropdown(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  const handleClick = () => {
    setShowDropdown(!showDropdown)
  }

  const handleCopyAddress = () => {
    if (address) {
      // Copy the address to clipboard
      navigator.clipboard.writeText(address)

      // Show the "Copied!" tooltip
      setCopied(true)

      // Hide the tooltip after 2 seconds
      setTimeout(() => {
        setCopied(false)
        // Only close dropdown after tooltip is hidden
        setShowDropdown(false)
      }, 2000)
    }
  }

  const handleDisconnect = () => {
    if (onDisconnect) {
      onDisconnect()
    }
    setShowDropdown(false)
  }

  const handleOpenWallet = () => {
    window.open(silkUrl, '_blank', 'noopener,noreferrer')
    setShowDropdown(false)
  }

  if (!isConnected) return null

  return (
    <div className='relative' ref={dropdownRef}>
      <div
        className='flex pr-[8px] justify-center items-center gap-[12px] rounded-[8px] border border-[#D4D4D4] bg-white cursor-pointer hover:shadow-md transition-shadow duration-200'
        onClick={handleClick}
        data-tooltip-id={`tooltip-${walletType}`}>
        <div className='flex w-8 h-8 p-1 justify-center items-center rounded-[8px] bg-[#E5EFFF]'>
          <Image src={walletIcon} alt='Wallet' width={32} height={32} />
        </div>
        {networkIcon && (
          <Image src={networkIcon} alt='Network' width={20} height={20} />
        )}
        <div className='flex items-center gap-2'>
          <span className='text-sm font-medium'>
            {address
              ? `${address.substring(0, 6)}...${address.substring(
                  address.length - 4
                )}`
              : ''}
          </span>
          {balance && walletType === WalletType.WAAP && (
            <span className='text-xs text-gray-500'>
              {balance} ETH
            </span>
          )}
        </div>
        <Image
          src='/assets/svg/drop-down-logo.svg'
          alt='Dropdown'
          width={24}
          height={24}
        />
      </div>

      {showDropdown && (
        <div className='absolute right-0 mt-2 shadow-lg z-10 min-w-[180px] py-2  rounded-[12px] border border-[#D4D4D4] bg-white '>
          <div
            className='flex items-center gap-2 px-4 py-2 hover:bg-gray-100 cursor-pointer relative transition-colors duration-150 hover:bg-latest-grey-300'
            onClick={handleCopyAddress}>
            <Icon icon='ph:copy' width={20} height={20} />
            <span>{copied ? 'Copied!' : 'Copy Address'}</span>
          </div>

          {loginMethod === LOGIN_METHODS.WAAP && (
            <div
              className='flex items-center gap-2 px-4 py-2 hover:bg-gray-100 cursor-pointer relative transition-colors duration-150 hover:bg-latest-grey-300'
              onClick={handleOpenWallet}>
              <Icon icon='majesticons:open' width={20} height={20} />
              <span>Open Human Wallet</span>
            </div>
          )}

          <div
            className='flex items-center gap-2 px-4 py-2 hover:bg-gray-100 cursor-pointer text-red-500 transition-colors duration-150 hover:bg-latest-grey-300'
            onClick={handleDisconnect}>
            <Icon icon='ph:sign-out' width={20} height={20} />
            <span>Disconnect</span>
          </div>
        </div>
      )}
    </div>
  )
}

interface ConnectWalletButtonProps {
  onClick: () => void
  minimal?: boolean
}

const ConnectWalletButton: React.FC<ConnectWalletButtonProps> = ({
  onClick,
  minimal = false,
}) => {
  return (
    <button
      className={`flex justify-center items-center gap-[8px] rounded-[8px] bg-latest-grey-300 hover:bg-latest-grey-400 transition-colors duration-200 ${
        minimal ? 'p-2' : 'px-[10px] py-[5px]'
      }`}
      onClick={onClick}>
      <svg
        width='20'
        height='20'
        viewBox='0 0 24 24'
        fill='none'
        xmlns='http://www.w3.org/2000/svg'>
        <path
          d='M2 7C2 5.89543 2.89543 5 4 5H20C21.1046 5 22 5.89543 22 7V18C22 19.1046 21.1046 20 20 20H4C2.89543 20 2 19.1046 2 18V7Z'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path
          d='M16 14C16 12.8954 16.8954 12 18 12C19.1046 12 20 12.8954 20 14C20 15.1046 19.1046 16 18 16C16.8954 16 16 15.1046 16 14Z'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
        <path
          d='M2 10H22'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      </svg>
      {!minimal && <span>Connect Wallet</span>}
    </button>
  )
}

interface HeaderProps {
  credentials?: React.ReactNode
  privacyMode?: React.ReactNode
}

const Header: React.FC<HeaderProps> = ({ credentials, privacyMode }) => {
  // Get wallet state from useWalletStore
  const {
    waapAddress,
    isWaapConnected,
    connectWaapWallet,
    disconnectWaapWallet,
    aztecAddress,
    isAztecConnected,
    disconnectAztecWallet,
    connectAztecWallet,
    waapLoginMethod: loginMethod,
    waapWalletProvider: walletProvider,
    waapWalletIcon: walletIcon,
    setShowWalletModal,
  } = useWalletStore()


  // Add bridge store state for Private Payments toggle
  const { isPrivacyModeEnabled, setPrivacyModeEnabled } = useBridgeStore()

  // Get L1 token balances for native balance display
  const { data: l1TokenBalances = [] } = useL1TokenBalances()

  // Extract native token balance for Sepolia
  const sepoliaNativeTokens = l1TokenBalances.find(
    (token) => token.type === 'native' && token.network?.chainId === 11155111
  )
  const l1NativeBalance = sepoliaNativeTokens?.balance_formatted?.toString()


  // Mobile menu state
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  // Track if connect wallet button was pressed
  const [walletButtonPressed, setWalletButtonPressed] = useState(false)

  // Client-side rendering check
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])

  // Auto-connect to Aztec when WaaP wallet is connected
  useEffect(() => {
    if (isWaapConnected && !isAztecConnected && walletButtonPressed) {
      // Add a slight delay to avoid UI issues
      const timer = setTimeout(() => {
        // setShowWalletModal(true)
        // Directly connect to Azguard instead of showing modal
        connectAztecWallet('azguard')
        // Reset the button press tracker after connecting
        setWalletButtonPressed(false)
      }, 2000)

      return () => clearTimeout(timer)
    }
  }, [
    isWaapConnected,
    isAztecConnected,
    walletButtonPressed,
    connectAztecWallet,
  ])

  // Handle connect wallet click
  const handleConnectWallet = async () => {
    // Set the button pressed flag
    setWalletButtonPressed(true)
    try {
      await connectWaapWallet()
      // Aztec connection will be handled by the useEffect above
    } catch (error) {
      console.error('Failed to connect wallet:', error)
      // Reset the button press tracker if connection fails
      setWalletButtonPressed(false)
    }
    setMobileMenuOpen(false)
  }

  // Check if any wallet is connected
  const isAnyWalletConnected = isWaapConnected || isAztecConnected

  // Toggle mobile menu
  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen)
  }

  const notify = useToast()

  if (!mounted) {
    return (
      <header className='w-full px-4 flex justify-between items-center'>
        <div className='flex-shrink-0'>
          <Link
            href='/'
            className='hover:opacity-80 transition-opacity duration-200'>
            <Image
              src='/assets/svg/human.tech.logo.svg'
              alt='human.tech'
              width={120}
              height={30}
            />
          </Link>
        </div>
      </header>
    )
  }

  return (
    <header className='w-full px-4 pt-3 flex justify-between items-center relative'>
      <div className='flex-shrink-0'>
        <Link
          href='/'
          className='hover:opacity-80 transition-opacity duration-200'>
          <Image
            src='/assets/svg/human.tech.logo.svg'
            alt='human.tech'
            width={120}
            height={30}
          />
        </Link>
      </div>

      {/* Desktop Navigation */}
      <div className='hidden md:flex gap-6 items-center'>
        {credentials && (
          <div className='text-sm font-medium cursor-pointer hover:text-latest-grey-800 transition-colors duration-200'>
            {credentials}
          </div>
        )}

        <div className='flex items-center gap-4'>
          {false && (
          <div className='flex px-[3px] py-[3px] pl-[8px] justify-center items-center gap-[8px] rounded-[8px] bg-white border border-[#D4D4D4] z-10 relative privacy-mode-toggle hover:shadow-md transition-shadow duration-200'>
            <Image
              src='/assets/svg/human.aztec.svg'
              alt='Aztec'
              width={28}
              height={28}
            />
            <span className='text-[#0A0A0A] text-[14px] font-[450] leading-[20px] font-sans'>
              Privacy Mode
            </span>
            <button
              className={`flex w-[40px] h-[24px] py-[3px] px-1 items-center rounded-[8px] transition-all duration-200 border-0 focus:outline-none relative z-10 ${
                isPrivacyModeEnabled
                  ? 'bg-[#3B3B3B] justify-end pl-[19px]'
                  : 'bg-[#D4D4D4] justify-start pr-[19px]'
              }`}
              onClick={() => {
                setPrivacyModeEnabled(!isPrivacyModeEnabled)

                if (!isPrivacyModeEnabled) {
                  setTimeout(() => {
                    notify('privacy-mode', {
                      message:
                        'Private balances and transactions are used instead of public',
                      heading: 'Private mode activated',
                    })
                  }, 1500)
                } else {
                  // Dismiss the privacy mode toast when turning off privacy mode
                  notify.dismiss('privacy-mode-toastId')
                }
              }}
              aria-pressed={isPrivacyModeEnabled}
              tabIndex={0}
              style={{ border: 'none' }}>
              <span className='flex w-[18px] h-[18px] p-[1px] justify-center items-center flex-shrink-0 rounded-[6px] bg-white shadow-[0px_1px_3px_0px_rgba(0,0,0,0.25)] transition-transform duration-200'>
                <Image
                  src='/assets/svg/shield.svg'
                  alt='Shield'
                  width={14}
                  height={14}
                />
              </span>
            </button>
          </div>
          )}

          {/* Wallet Controls */}
          {!isAnyWalletConnected ? (
            <ConnectWalletButton onClick={handleConnectWallet} />
          ) : (
            <>
              <WalletDisplay
                address={waapAddress || undefined}
                isConnected={isWaapConnected}
                walletIcon={walletIcon || '/assets/wallets/wally-dark.svg'}
                networkIcon='/assets/svg/network-logo.svg'
                balance={l1NativeBalance}
                onDisconnect={disconnectWaapWallet}
                walletType={WalletType.WAAP}
                loginMethod={loginMethod}
              />

              <WalletDisplay
                address={aztecAddress || undefined}
                isConnected={isAztecConnected}
                walletIcon='/assets/svg/aztec-wallet-logo.svg'
                // networkIcon='/assets/svg/network-logo.svg'
                onDisconnect={disconnectAztecWallet}
                walletType={WalletType.AZTEC}
              />
            </>
          )}
        </div>
      </div>

      {/* Mobile Menu Button */}
      <div className='md:hidden'>
        <button
          onClick={toggleMobileMenu}
          className='p-2'
          aria-label='Toggle mobile menu'>
          {mobileMenuOpen ? (
            <svg
              width='24'
              height='24'
              viewBox='0 0 24 24'
              fill='none'
              xmlns='http://www.w3.org/2000/svg'>
              <path
                d='M18 6L6 18'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              />
              <path
                d='M6 6L18 18'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              />
            </svg>
          ) : (
            <svg
              width='24'
              height='24'
              viewBox='0 0 24 24'
              fill='none'
              xmlns='http://www.w3.org/2000/svg'>
              <path
                d='M3 12H21'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              />
              <path
                d='M3 6H21'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              />
              <path
                d='M3 18H21'
                stroke='currentColor'
                strokeWidth='2'
                strokeLinecap='round'
                strokeLinejoin='round'
              />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className='md:hidden absolute top-full left-0 right-0 bg-white z-50 shadow-lg py-4 px-6 flex flex-col gap-4'>
          {credentials && (
            <div className='text-sm font-medium cursor-pointer hover:text-latest-grey-800 transition-colors duration-200'>
              {credentials}
            </div>
          )}

          {false && (
          <div className='flex px-[3px] py-[3px] pl-[8px] w-[240px] justify-center items-center gap-[8px] rounded-[8px] bg-white border border-[#D4D4D4] z-10 relative privacy-mode-toggle hover:shadow-md transition-shadow duration-200 max-w-[190px]'>
            <Image
              src='/assets/svg/human.aztec.svg'
              alt='Aztec'
              width={28}
              height={28}
            />
            <span className='text-[#0A0A0A] text-[14px] font-[450] leading-[20px] font-sans'>
              Privacy Mode
            </span>
            <button
              className={`flex w-[40px] h-[24px] py-[3px] px-1 items-center rounded-[8px] transition-all duration-200 border-0 focus:outline-none relative z-10 ${
                isPrivacyModeEnabled
                  ? 'bg-[#3B3B3B] justify-end pl-[19px]'
                  : 'bg-[#D4D4D4] justify-start pr-[19px]'
              }`}
              onClick={() => {
                setPrivacyModeEnabled(!isPrivacyModeEnabled)

                if (!isPrivacyModeEnabled) {
                  setTimeout(() => {
                    notify('privacy-mode', {
                      message:
                        'Private balances and transactions are used instead of public',
                      heading: 'Private mode activated',
                    })
                  }, 1500)
                } else {
                  // Dismiss the privacy mode toast when turning off privacy mode
                  notify.dismiss('privacy-mode-toastId')
                }
              }}
              aria-pressed={isPrivacyModeEnabled}
              tabIndex={0}
              style={{ border: 'none' }}>
              <span className='flex w-[18px] h-[18px] p-[1px] justify-center items-center flex-shrink-0 rounded-[6px] bg-white shadow-[0px_1px_3px_0px_rgba(0,0,0,0.25)] transition-transform duration-200'>
                <Image
                  src='/assets/svg/shield.svg'
                  alt='Shield'
                  width={14}
                  height={14}
                />
              </span>
            </button>
          </div>
          )}

          <div className='flex flex-col items-start gap-3'>
            {!isAnyWalletConnected ? (
              <ConnectWalletButton onClick={handleConnectWallet} />
            ) : (
              <>
                <WalletDisplay
                  address={waapAddress || undefined}
                  isConnected={isWaapConnected}
                  walletIcon={walletIcon || '/assets/wallets/wally-dark.svg'}
                  // networkIcon='/assets/svg/network-logo.svg'
                  balance={l1NativeBalance}
                  onDisconnect={disconnectWaapWallet}
                  walletType={WalletType.WAAP}
                  loginMethod={loginMethod}
                />

                <WalletDisplay
                  address={aztecAddress || undefined}
                  isConnected={isAztecConnected}
                  walletIcon='/assets/svg/aztec-wallet-logo.svg'
                  // networkIcon='/assets/svg/network-logo.svg'
                  onDisconnect={disconnectAztecWallet}
                  walletType={WalletType.AZTEC}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* <ReactTooltip
        id='privacy-mode-tooltip'
        place='bottom'
        className='z-[100]'
        style={{
          fontSize: '12px',
          padding: '4px 8px',
        }}
      /> */}
    </header>
  )
}

export default Header
