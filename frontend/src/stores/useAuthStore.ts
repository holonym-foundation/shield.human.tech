'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AuthUser {
  id: number
  l1Address: string
  l2Address: string
  l1LoginMethod: string | null
  l1WalletProvider: string | null
  l2LoginMethod: string | null
  l2WalletProvider: string | null
}

interface AuthState {
  token: string | null
  user: AuthUser | null
  authFailed: boolean
  retryAuth: number
  setAuth: (token: string, user: AuthUser) => void
  setAuthFailed: (failed: boolean) => void
  triggerRetryAuth: () => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      authFailed: false,
      retryAuth: 0,
      setAuth: (token, user) => set({ token, user, authFailed: false }),
      setAuthFailed: (failed) => set({ authFailed: failed }),
      triggerRetryAuth: () => set((state) => ({ authFailed: false, retryAuth: state.retryAuth + 1 })),
      clearAuth: () => set({ token: null, user: null, authFailed: false, retryAuth: 0 }),
    }),
    {
      name: 'aztec-bridge-auth',
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
)