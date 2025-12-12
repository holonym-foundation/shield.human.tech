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

interface BridgeStoreState
  extends StepState,
    BridgeConfigState,
    TransactionState {
  direction: BridgeDirection

  // Privacy Mode toggle
  isPrivacyModeEnabled: boolean
  setPrivacyModeEnabled: (enabled: boolean) => void

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

  // Reset
  resetStepState: () => void
  reset: () => void
}

// Initial states
const DEFAULT_BRIDGE_STATE: BridgeState = {
  from: { network: L1_NETWORKS[0], token: L1_TOKENS[0] },
  to: { network: L2_NETWORKS[0], token: L2_TOKENS[0] },
  direction: BridgeDirection.L1_TO_L2,
  amount: '',
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
      label: 'Setting up authorization for withdrawal',
      status: 'pending' as const,
    },
    {
      id: 2,
      label: 'Preparing withdrawal message',
      status: 'pending' as const,
    },
    { id: 3, label: 'Initiating exit to Ethereum', status: 'pending' as const },
    {
      id: 4,
      label: 'Getting proof for Ethereum withdrawal',
      status: 'pending' as const,
    },
    {
      id: 5,
      label: 'Waiting for Ethereum confirmation (40 minutes)',
      status: 'pending' as const,
    },
    { id: 6, label: 'Claiming tokens on Ethereum', status: 'pending' as const },
    { id: 7, label: 'Withdrawal Complete', status: 'pending' as const },
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

const initialState = {
  ...initialStepState,
  ...initialBridgeConfigState,
  ...initialTransactionState,
  isPrivacyModeEnabled: getInitialPrivacyMode(),
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

  // Reset
  resetStepState: () => set({ ...initialStepState }),
  reset: () => set((state) => ({ 
    ...initialState, 
    direction: BridgeDirection.L1_TO_L2,
    isPrivacyModeEnabled: state.isPrivacyModeEnabled 
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
    }))
  )
