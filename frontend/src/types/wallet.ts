// Constants for login methods (will be updated when SDK changes from 'human' to 'waap')
export const LOGIN_METHODS = {
  WAAP: 'waap',
  WALLETCONNECT: 'walletconnect',
  INJECTED: 'injected'
} as const

// Wallet types enum
export enum WalletType {
  WAAP = 'waap',
  AZTEC = 'aztec'
}

// Login method types for WaaP (L1) wallets
export type WaapLoginMethod = 'waap' | 'injected' | 'walletconnect'

// Login method types for Aztec (L2) wallets  
export type AztecLoginMethod = 'azguard' | 'obsidion'

// Combined login method type
export type LoginMethod = WaapLoginMethod | AztecLoginMethod