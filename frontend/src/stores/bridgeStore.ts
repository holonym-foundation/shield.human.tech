'use client'

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { BridgeDirection, BridgeState, Network, Token } from '@/types/bridge'
import { L1_NETWORKS, L2_NETWORKS, L1_TOKENS, L2_TOKENS } from '@/config'

// Types
export interface LoadingStep {
  id: number
  label: string
  status: 'pending' | 'active' | 'completed' | 'error'
}

interface StepState {
  headerStep: number
  progressStep: number
  walletSteps: LoadingStep[]
  l1ToL2Steps: LoadingStep[]
  l2ToL1Steps: LoadingStep[]
}

interface BridgeConfigState {
  bridgeConfig: BridgeState
}

interface TransactionState {
  l1TxUrl: string | null
  l2TxUrl: string | null
}

/** Data needed to resume an incomplete L1→L2 bridge operation */
export interface RecoveryClaimData {
  operationId: string
  claimSecret: string
  claimSecretHash: string
  messageHash: string | null
  messageLeafIndex: string | null
  amount: string
  l1Address: string
  l2Address: string
  l1TxHash: string | null
  l1TxUrl: string | null
  l1BlockNumberBeforeTx: string | null
  isPrivacyModeEnabled: boolean
  nodeInfo: Record<string, unknown> | null
  status: string
  currentStep: number | null
  // Recovery-critical contract snapshot (multi-token support)
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  tokenAddressL1: string | null
  tokenAddressL2: string | null
  // Fuel recovery fields (from decrypted blob — secrets needed to claim FeeJuice on L2)
  fuelSecret: string | null
  privateFuelSalt: string | null
  privateFuelSecret: string | null
  // Fuel receipt fields (from DB — extracted from BridgeWithFuel event)
  fuelMessageHash: string | null
  fuelMessageLeafIndex: string | null
  fuelAmount: string | null
}

/** Data needed to resume an incomplete L2→L1 withdrawal */
export interface RecoveryWithdrawalData {
  operationId: string
  amount: string
  l1Address: string
  l2Address: string
  l2TxHash: string | null
  l2TxUrl: string | null
  l2BlockNumber: string | null
  l2BlockNumberBeforeTx: string | null
  l2ToL1MessageIndex: string | null
  siblingPath: string[] | null
  recipientL1Address: string | null
  // Recovery-critical contract & version snapshot
  rollupVersion: number | null
  chainIdL1: number | null
  portalAddressL1: string | null
  bridgeAddressL2: string | null
  l1RollupAddress: string | null
  l1OutboxAddress: string | null
  isPrivacyModeEnabled: boolean
  nodeInfo: Record<string, unknown> | null
  status: string
  currentStep: number | null
}

interface RecoveryState {
  recoveryOperationId: string | null
  recoveryClaimData: RecoveryClaimData | null
  recoveryWithdrawalData: RecoveryWithdrawalData | null
}

interface BridgeStoreState
  extends StepState,
    BridgeConfigState,
    TransactionState,
    RecoveryState {
  direction: BridgeDirection

  // Privacy Mode toggle
  isPrivacyModeEnabled: boolean
  setPrivacyModeEnabled: (enabled: boolean) => void

  // Fuel (gas funding) state
  fuelEnabled: boolean
  fuelAmount: string
  fuelType: 'public' | 'private'
  setFuelEnabled: (enabled: boolean) => void
  setFuelAmount: (amount: string) => void
  setFuelType: (type: 'public' | 'private') => void

  // Step actions
  setHeaderStep: (
    step: number,
    status?: 'pending' | 'active' | 'completed' | 'error'
  ) => void
  setProgressStep: (
    step: number,
    status?: 'pending' | 'active' | 'completed' | 'error'
  ) => void
  getHeaderSteps: () => LoadingStep[]
  getProgressSteps: () => LoadingStep[]

  // Bridge configuration actions
  setDirection: (direction: BridgeDirection) => void
  setBridgeConfig: (config: BridgeState) => void
  updateNetwork: (section: 'from' | 'to', network: Network) => void
  updateToken: (section: 'from' | 'to', token: Token) => void
  swapDirection: () => void
  setTransactionUrls: (l1TxUrl: string | null, l2TxUrl: string | null) => void

  // Recovery actions
  setRecovery: (operationId: string, claimData: RecoveryClaimData) => void
  setWithdrawalRecovery: (operationId: string, withdrawalData: RecoveryWithdrawalData) => void
  clearRecovery: () => void

  // Reset
  resetStepState: () => void
  reset: () => void
}

// Initial states (default amount '1' so /progress can be used directly for development)
const DEFAULT_BRIDGE_STATE: BridgeState = {
  from: { network: L1_NETWORKS[0], token: L1_TOKENS[0] },
  to: { network: L2_NETWORKS[0], token: L2_TOKENS[0] },
  direction: BridgeDirection.L1_TO_L2,
  amount: '1',
}

const initialStepState: StepState = {
  headerStep: 0,
  progressStep: 0,
  walletSteps: [
    { id: 1, label: 'Connect Ethereum Wallet', status: 'pending' as const },
    { id: 2, label: 'Connect Aztec Wallet', status: 'pending' as const },
  ],
  l1ToL2Steps: [
    {
      id: 1,
      label: 'Sending tokens to Aztec Portal',
      status: 'pending' as const,
    },
    {
      id: 2,
      label: 'Waiting for Ethereum confirmation',
      status: 'pending' as const,
    },
    {
      id: 3,
      label: 'Claiming tokens on Aztec Network',
      status: 'pending' as const,
    },
    { id: 4, label: 'Bridge Complete', status: 'pending' as const },
  ],
  l2ToL1Steps: [
    {
      id: 1,
      label: 'Exiting from Aztec (auth to burn + exit)',
      status: 'pending' as const,
    },
    {
      id: 2,
      label: 'Getting proof for withdrawal',
      status: 'pending' as const,
    },
    {
      id: 3,
      label: 'Waiting for Ethereum confirmation',
      status: 'pending' as const,
    },
    {
      id: 4,
      label: 'Withdrawing on Ethereum',
      status: 'pending' as const,
    },
    { id: 5, label: 'Withdrawal complete', status: 'pending' as const },
  ],
}

const initialBridgeConfigState: BridgeConfigState = {
  bridgeConfig: DEFAULT_BRIDGE_STATE,
}

const initialTransactionState: TransactionState = {
  l1TxUrl: null,
  l2TxUrl: null,
}

// Helper to safely get privacy mode from localStorage (SSR-safe)
const getInitialPrivacyMode = (): boolean => {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return false
  }
  try {
    return localStorage.getItem('privacyModeEnabled') === 'true'
  } catch {
    return false
  }
}

const initialRecoveryState: RecoveryState = {
  recoveryOperationId: null,
  recoveryClaimData: null,
  recoveryWithdrawalData: null,
}

const initialState = {
  ...initialStepState,
  ...initialBridgeConfigState,
  ...initialTransactionState,
  ...initialRecoveryState,
  isPrivacyModeEnabled: getInitialPrivacyMode(),
  fuelEnabled: false,
  fuelAmount: '',
  fuelType: 'public' as const,
} as const

const bridgeStore = create<BridgeStoreState>((set, get) => ({
  ...initialState,
  direction: BridgeDirection.L1_TO_L2,

  // Privacy Mode toggle
  isPrivacyModeEnabled: getInitialPrivacyMode(),
  setPrivacyModeEnabled: (enabled: boolean) => {
    if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('privacyModeEnabled', enabled.toString())
      } catch {
        // Ignore localStorage errors
      }
    }
    set({ isPrivacyModeEnabled: enabled })
  },

  // Fuel (gas funding) actions
  fuelEnabled: false,
  fuelAmount: '',
  fuelType: 'public' as const,
  setFuelEnabled: (enabled: boolean) => set({ fuelEnabled: enabled, fuelAmount: '' }),
  setFuelAmount: (amount: string) => set({ fuelAmount: amount }),
  setFuelType: (type: 'public' | 'private') => set({ fuelType: type }),

  // Step actions
  setHeaderStep: (
    step: number,
    status: 'pending' | 'active' | 'completed' | 'error' = 'active'
  ) => {
    set((state) => {
      // Update header steps (wallet connection)
      const updatedWalletSteps = state.walletSteps.map((s, index) => {
        if (index === step - 1) {
          // Convert to 0-based index
          return { ...s, status }
        }
        return s // Keep other steps unchanged
      })

      return {
        headerStep: step,
        walletSteps: updatedWalletSteps,
      }
    })
  },

  setProgressStep: (
    step: number,
    status: 'pending' | 'active' | 'completed' | 'error' = 'active'
  ) => {
    set((state) => {
      const steps =
        state.direction === BridgeDirection.L1_TO_L2
          ? state.l1ToL2Steps
          : state.l2ToL1Steps

      const updatedSteps = steps.map((s, index) => {
        if (index === step - 1) {
          // Convert to 0-based index
          return { ...s, status }
        }
        return s // Keep other steps unchanged
      })

      return {
        progressStep: step,
        ...(state.direction === BridgeDirection.L1_TO_L2
          ? { l1ToL2Steps: updatedSteps }
          : { l2ToL1Steps: updatedSteps }),
      }
    })
  },

  getHeaderSteps: () => {
    const { direction, walletSteps, l1ToL2Steps, l2ToL1Steps } = get()
    return [
      ...walletSteps,
      ...(direction === BridgeDirection.L1_TO_L2 ? l1ToL2Steps : l2ToL1Steps),
    ]
  },

  getProgressSteps: () => {
    const { direction, l1ToL2Steps, l2ToL1Steps, progressStep } = get()
    const steps =
      direction === BridgeDirection.L1_TO_L2
        ? [...l1ToL2Steps]
        : [...l2ToL1Steps]

    return steps
  },

  // Bridge configuration actions
  setDirection: (direction) => {
    set((state) => ({
      direction,
      bridgeConfig: {
        ...state.bridgeConfig,
        direction,
      },
    }))
  },

  setBridgeConfig: (config) => set({ bridgeConfig: config }),

  updateNetwork: (section, network) =>
    set((state) => ({
      bridgeConfig: {
        ...state.bridgeConfig,
        [section]: { ...state.bridgeConfig[section], network },
      },
    })),

  updateToken: (section, token) =>
    set((state) => ({
      bridgeConfig: {
        ...state.bridgeConfig,
        [section]: { ...state.bridgeConfig[section], token },
      },
    })),

  swapDirection: () =>
    set((state) => {
      const newDirection =
        state.direction === BridgeDirection.L1_TO_L2
          ? BridgeDirection.L2_TO_L1
          : BridgeDirection.L1_TO_L2

      return {
        bridgeConfig: {
          from: state.bridgeConfig.to,
          to: state.bridgeConfig.from,
          direction: newDirection,
          amount: '',
        },
        direction: newDirection,
        progressStep: 0, // Reset progress step when swapping
      }
    }),

  setTransactionUrls: (l1TxUrl, l2TxUrl) => set({ l1TxUrl, l2TxUrl }),

  // Recovery actions
  setRecovery: (operationId: string, claimData: RecoveryClaimData) =>
    set({ recoveryOperationId: operationId, recoveryClaimData: claimData, recoveryWithdrawalData: null }),
  setWithdrawalRecovery: (operationId: string, withdrawalData: RecoveryWithdrawalData) =>
    set({ recoveryOperationId: operationId, recoveryWithdrawalData: withdrawalData, recoveryClaimData: null }),
  clearRecovery: () =>
    set({ recoveryOperationId: null, recoveryClaimData: null, recoveryWithdrawalData: null }),

  // Reset
  resetStepState: () => set({ ...initialStepState }),
  reset: () => set((state) => ({
    ...initialState,
    direction: BridgeDirection.L1_TO_L2,
    isPrivacyModeEnabled: state.isPrivacyModeEnabled,
    recoveryOperationId: null,
    recoveryClaimData: null,
    recoveryWithdrawalData: null,
    fuelEnabled: false,
    fuelAmount: '',
    fuelType: 'public' as const,
  })),
}))

// Export main store with all state and actions
// Step state
export const useBridgeStore = () =>
  bridgeStore(
    useShallow((state) => ({
      // Step state
      headerStep: state.headerStep,
      progressStep: state.progressStep,
      walletSteps: state.walletSteps,
      l1ToL2Steps: state.l1ToL2Steps,
      l2ToL1Steps: state.l2ToL1Steps,

      // Step actions
      setHeaderStep: state.setHeaderStep,
      setProgressStep: state.setProgressStep,
      getHeaderSteps: state.getHeaderSteps,
      getProgressSteps: state.getProgressSteps,

      // Bridge configuration state
      direction: state.direction,
      bridgeConfig: state.bridgeConfig,
      inputAmount: state.bridgeConfig.amount,

      // Transaction state
      l1TxUrl: state.l1TxUrl,
      l2TxUrl: state.l2TxUrl,

      // Bridge configuration actions
      setDirection: state.setDirection,
      setBridgeConfig: state.setBridgeConfig,
      updateNetwork: state.updateNetwork,
      updateToken: state.updateToken,
      swapDirection: state.swapDirection,
      setTransactionUrls: state.setTransactionUrls,

      // Reset
      resetStepState: state.resetStepState,
      reset: state.reset,

      // Privacy Mode toggle
      isPrivacyModeEnabled: state.isPrivacyModeEnabled,
      setPrivacyModeEnabled: state.setPrivacyModeEnabled,

      // Fuel (gas funding)
      fuelEnabled: state.fuelEnabled,
      fuelAmount: state.fuelAmount,
      fuelType: state.fuelType,
      setFuelEnabled: state.setFuelEnabled,
      setFuelAmount: state.setFuelAmount,
      setFuelType: state.setFuelType,

      // Recovery
      recoveryOperationId: state.recoveryOperationId,
      recoveryClaimData: state.recoveryClaimData,
      recoveryWithdrawalData: state.recoveryWithdrawalData,
      setRecovery: state.setRecovery,
      setWithdrawalRecovery: state.setWithdrawalRecovery,
      clearRecovery: state.clearRecovery,
    }))
  )
