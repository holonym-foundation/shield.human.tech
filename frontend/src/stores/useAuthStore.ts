'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface AuthUser {
  id: string
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
  setAuth: (token: string, user: AuthUser) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      clearAuth: () => set({ token: null, user: null }),
    }),
    {
      name: 'aztec-bridge-auth',
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
)