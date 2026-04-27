import React, { useState } from 'react'
import TextButton from './TextButton'
import StyledImage from './StyledImage'
import { Oval } from 'react-loader-spinner'
import { BridgeDirection } from '@/types/bridge'
import { useToast } from '@/hooks/useToast'
import { extractErrorMessage } from '@/utils'
import { parseUnits } from 'viem'
import CongestionWarningModal from './model/CongestionWarningModal'
import { useL2PendingTxCount, useNetworkHealth } from '@/hooks/useL2Operations'

function LoadingContent({ label }: { label: string }) {
  return (
    <div className="flex justify-center gap-2">
      <Oval
        height="20"
        width="20"
        color="#ccc"
        visible={true}
        ariaLabel="oval-loading"
        secondaryColor="#ccc"
        strokeWidth={6}
        strokeWidthSecondary={6}
      />
      <span>{label}</span>
    </div>
  )
}

interface BridgeActionButtonProps {
  isDisabled?: boolean

  // Connection states
  isWaapConnected: boolean
  connectWaapWallet: () => void
  getWalletProvider: () => string | null
  loginMethod: string | null
  walletProvider: string | null
  isAztecConnected: boolean
  connectAztec: () => void
  inputRef: React.RefObject<HTMLInputElement | null>

  // Balance and amount states
  inputAmount: string
  l1Balance: string
  l2Balance: string
  l1BalanceLoading?: boolean
  l2BalanceLoading?: boolean
  feeJuiceLoading?: boolean

  // Bridge direction
  direction: BridgeDirection

  // Core operations
  bridgeTokensToL2: (amount: string) => void
  withdrawTokensToL1: (amount: string) => void
  requestFaucet: () => void
  useExternalFaucet?: boolean
  handleExternalFaucet?: () => void

  // Loading states
  isStateInitialized?: boolean
  requestFaucetPending?: boolean
  bridgeTokensToL2Pending?: boolean
  withdrawTokensToL1Pending?: boolean

  // Faucet related
  isEligibleForFaucet: boolean
  needsGas?: boolean
  needsTokensOnly?: boolean

  // SBT related
  hasL1SBT: boolean | unknown
  hasL2SBT: boolean | undefined
  setShowSBTModal: (show: boolean) => void
  setCurrentSBTChain: (chain: 'Ethereum' | 'Aztec') => void

  // Privacy mode / attestation
  isPrivacyModeEnabled?: boolean
  pochEligible?: boolean
  pochLoading?: boolean
  pochReason?: string
  attestationMethod?: 'poch' | 'passport' | null
  passportMaxAmount?: bigint
  passportScore?: number
  passportThreshold?: number

  // Operation completion state
  bridgeCompleted?: boolean
  l2NodeError?: boolean
  l2NodeIsReadyLoading?: boolean
  feeJuiceBalanceLoading?: boolean
}

function BridgeActionButton({
  isDisabled = false,
  isWaapConnected,
  connectWaapWallet,
  getWalletProvider,
  loginMethod,
  walletProvider,
  isAztecConnected,
  connectAztec,
  inputRef,
  inputAmount,
  l1Balance,
  l2Balance,
  l1BalanceLoading = false,
  l2BalanceLoading = false,
  feeJuiceLoading = false,
  direction,
  bridgeTokensToL2,
  withdrawTokensToL1,
  requestFaucet,
  useExternalFaucet = false,
  handleExternalFaucet,
  isStateInitialized = true,
  requestFaucetPending = false,
  bridgeTokensToL2Pending = false,
  withdrawTokensToL1Pending = false,
  isEligibleForFaucet,
  needsGas = false,
  needsTokensOnly = false,
  hasL1SBT,
  hasL2SBT,
  setShowSBTModal,
  setCurrentSBTChain,
  isPrivacyModeEnabled = false,
  pochEligible,
  pochLoading = false,
  pochReason,
  attestationMethod,
  passportMaxAmount,
  passportScore,
  passportThreshold,
  bridgeCompleted = false,
  l2NodeError = false,
  l2NodeIsReadyLoading = false,
  feeJuiceBalanceLoading = false,
}: BridgeActionButtonProps) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [isOperationPending, setIsOperationPending] = useState(false)
  const notify = useToast()
  const [showCongestionWarning, setShowCongestionWarning] = useState(false)
  const { data: pendingTxCount } = useL2PendingTxCount()
  const isCongested = pendingTxCount && pendingTxCount > 40
  const { data: networkHealth } = useNetworkHealth()
  const isNetworkDown = networkHealth?.isNetworkDown ?? false

  const bothWalletsConnected = isWaapConnected && isAztecConnected
  const balancesLoading =
    bothWalletsConnected && (!isStateInitialized || l1BalanceLoading || l2BalanceLoading || feeJuiceLoading)

  // Helper functions
  const getOperationType = (dir: BridgeDirection) => (dir === BridgeDirection.L2_TO_L1 ? 'withdrawal' : 'bridge')

  const getOperationLabel = (dir: BridgeDirection) =>
    dir === BridgeDirection.L2_TO_L1 ? 'Withdraw Tokens' : 'Bridge Tokens'

  const getSBTChainForDirection = (dir: BridgeDirection) => (dir === BridgeDirection.L2_TO_L1 ? 'Aztec' : 'Ethereum')

  // Process operations for bridging or withdrawing
  const processBridgeOperation = async () => {
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      notify('error', 'Please enter a valid amount')
      inputRef.current?.focus()
      return
    }

    setIsOperationPending(true)
    try {
      const amount = inputAmount
      if (direction === BridgeDirection.L2_TO_L1) {
        await withdrawTokensToL1(amount)
      } else {
        await bridgeTokensToL2(amount)
      }
    } catch (error) {
      const operationType = getOperationType(direction)
      const errorMsg = extractErrorMessage(error)

      if (errorMsg.includes('insufficient')) {
        notify('error', `Insufficient funds for ${operationType} operation`)
      } else if (errorMsg.includes('rejected') || errorMsg.includes('denied')) {
        notify('error', `Transaction rejected by user`)
      } else {
        notify('error', `${operationType.charAt(0).toUpperCase() + operationType.slice(1)} failed: ${errorMsg}`)
      }
    } finally {
      setIsOperationPending(false)
    }
  }

  const checkSBTRequirements = () => {
    const requiredChain = getSBTChainForDirection(direction)
    if (direction === BridgeDirection.L2_TO_L1) {
      if (!hasL2SBT) {
        setCurrentSBTChain(requiredChain)
        setShowSBTModal(true)
        return false
      }
    } else {
      if (hasL1SBT !== true) {
        setCurrentSBTChain(requiredChain)
        setShowSBTModal(true)
        return false
      }
    }
    return true
  }

  // Main action handler
  const handleButtonClick = async () => {
    // Step 1: Connect WaaP wallet
    if (!isWaapConnected) {
      setIsConnecting(true)
      setIsOperationPending(true)
      try {
        await connectWaapWallet()
      } catch (error) {
        // Error handling is done in useWalletStore
      } finally {
        setIsConnecting(false)
        setIsOperationPending(false)
      }
      return
    }

    // Step 2: Connect Aztec wallet
    if (!isAztecConnected) {
      setIsConnecting(true)
      setIsOperationPending(true)
      try {
        await connectAztec()
      } catch (error) {
        // Error handling is done in useWalletStore
      } finally {
        setIsConnecting(false)
        setIsOperationPending(false)
      }
      return
    }

    // Step 3: Faucet if needed
    if (isStateInitialized && isEligibleForFaucet) {
      if (useExternalFaucet && handleExternalFaucet && needsGas && !needsTokensOnly) {
        handleExternalFaucet()
        return
      } else {
        setIsOperationPending(true)
        try {
          await requestFaucet()
        } catch (error) {
          // handled elsewhere
        } finally {
          setIsOperationPending(false)
        }
        return
      }
    }

    // Step 4: SBT check
    if (!checkSBTRequirements()) {
      return
    }

    // Step 5: Attestation check — required for BOTH public and private flows.
    // The L1 TokenPortal and L2 TokenBridge gate every deposit/exit on POCH or
    // Passport regardless of privacy mode.
    if (pochLoading) {
      notify('info', 'Checking eligibility...')
      return
    }
    if (!pochEligible) {
      notify('error', {
        heading: 'Attestation Required',
        message: React.createElement(
          'span',
          null,
          React.createElement(
            'span',
            null,
            pochReason ? `${pochReason}. ` : 'Cannot bridge without a valid attestation. ',
          ),
          React.createElement('br'),
          React.createElement(
            'a',
            {
              href: 'https://id.human.tech/sandbox/clean-hands',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: '#2563eb', textDecoration: 'underline' },
            },
            'Mint your POCH SBT here',
          ),
          React.createElement('br'),
          React.createElement(
            'a',
            {
              href: 'https://app.passport.xyz/',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: '#2563eb', textDecoration: 'underline' },
            },
            `Build your Passport score${passportScore != null && passportThreshold != null ? ` (current: ${passportScore}/${passportThreshold} needed)` : ''}`,
          ),
        ) as unknown as string,
      })
      return
    }

    // Step 6: Validate amount
    // Step 6a: Passport amount limit check (applies to both public and private)
    if (attestationMethod === 'passport' && passportMaxAmount != null) {
      try {
        const decimals = 6 // USDC decimals
        const inputBigInt = BigInt(Math.floor(parseFloat(inputAmount || '0') * 10 ** decimals))
        if (inputBigInt > passportMaxAmount) {
          const maxFormatted = (Number(passportMaxAmount) / 10 ** decimals).toFixed(2)
          notify('error', {
            heading: 'Amount Exceeds Passport Limit',
            message: React.createElement(
              'span',
              null,
              `Passport allows up to ${maxFormatted} USDC per transaction. `,
              React.createElement(
                'a',
                {
                  href: 'https://id.human.tech/sandbox/clean-hands',
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: { color: '#2563eb', textDecoration: 'underline' },
                },
                'Mint a POCH SBT',
              ),
              ' to remove this limit.',
            ) as unknown as string,
          })
          return
        }
      } catch {
        // parseFloat failed — will be caught by the next validation step
      }
    }
    if (!inputAmount || parseFloat(inputAmount) <= 0) {
      notify('error', 'Please enter a valid amount')
      inputRef.current?.focus()
      return
    }

    // Step 7: Congestion check
    if (isCongested) {
      setShowCongestionWarning(true)
      return
    }

    // Step 8: Execute
    processBridgeOperation()
  }

  const handleConfirmBridge = () => {
    setShowCongestionWarning(false)
    processBridgeOperation()
  }

  // --- Derived UI state ---

  const isButtonDisabled =
    l2NodeIsReadyLoading ||
    l2NodeError ||
    isNetworkDown ||
    balancesLoading ||
    isConnecting ||
    requestFaucetPending ||
    withdrawTokensToL1Pending ||
    bridgeTokensToL2Pending ||
    isOperationPending ||
    bridgeCompleted

  const isOperationInFlight =
    isConnecting || requestFaucetPending || withdrawTokensToL1Pending || bridgeTokensToL2Pending || isOperationPending

  const showLoadingSpinner =
    l2NodeIsReadyLoading ||
    balancesLoading ||
    isOperationInFlight ||
    // Attestation eligibility check is required for both modes (F1).
    (pochLoading && bothWalletsConnected)

  const getLoadingText = () => {
    if (l2NodeIsReadyLoading) return 'Checking Aztec Network Status...'
    if (balancesLoading) return 'Loading balances...'
    if (isConnecting) return 'Connecting...'
    if (requestFaucetPending) return 'Getting Eth & Testnet USDC...'
    if (pochLoading) return 'Checking eligibility...'
    if (withdrawTokensToL1Pending) return 'Withdrawing Tokens...'
    if (bridgeTokensToL2Pending) return 'Bridging Tokens...'
    return 'Loading...'
  }

  const getButtonLabel = () => {
    if (l2NodeIsReadyLoading) return 'Checking Aztec Network Status...'
    if (l2NodeError) return 'Aztec Network Unavailable'
    if (isNetworkDown) return 'Aztec Network is Down'
    if (bridgeCompleted) return 'Bridge Complete!'
    if (balancesLoading) return 'Loading balances...'

    // Connection states
    if (!isWaapConnected) return 'Connect Ethereum Wallet'
    if (!isAztecConnected) return 'Connect Aztec Wallet'

    // Faucet
    if (needsGas || needsTokensOnly) {
      return needsTokensOnly ? 'Click to Get Tokens' : 'Click to Get Testnet ETH'
    }

    // SBT requirements
    const requiredChain = getSBTChainForDirection(direction)
    if (direction === BridgeDirection.L2_TO_L1) {
      if (!hasL2SBT) return `Get SBT on ${requiredChain}`
    } else {
      if (hasL1SBT !== true) return `Get SBT on ${requiredChain}`
    }

    // Attestation requirement applies to both public and private modes.
    if (pochLoading) return 'Checking eligibility...'
    if (!pochEligible) return 'Attestation Required'

    return getOperationLabel(direction)
  }

  return (
    <>
      <div className="w-full">
        <TextButton onClick={handleButtonClick} disabled={isButtonDisabled || isDisabled} className="">
          {showLoadingSpinner ? (
            <LoadingContent label={getLoadingText()} />
          ) : bridgeCompleted ? (
            <div className="flex items-center gap-2">
              <StyledImage src="/assets/svg/check-circle.svg" alt="" className="h-5 w-5" />
              <span>Bridge Complete!</span>
            </div>
          ) : (
            getButtonLabel()
          )}
        </TextButton>
      </div>

      <CongestionWarningModal
        isOpen={showCongestionWarning}
        onClose={() => setShowCongestionWarning(false)}
        onConfirm={handleConfirmBridge}
      />
    </>
  )
}

export default BridgeActionButton
