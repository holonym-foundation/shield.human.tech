'use client'

import { useEffect, useRef } from 'react'
import { useWalletStore } from '@/stores/walletStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { api } from '@/lib/api'
import { showToast } from '@/hooks/useToast'

/**
 * When both L1 (Waap) and L2 (Aztec) wallets are connected, authenticate with the backend.
 * Sends L1/L2 addresses and login method + provider for each. When either disconnects, clear auth.
 */
export default function AuthSync() {
  const {
    waapAddress,
    aztecAddress,
    waapLoginMethod,
    waapWalletProvider,
    aztecLoginMethod,
  } = useWalletStore()
  const { setAuth, clearAuth, user } = useAuthStore()
  const prevKeyRef = useRef<string | null>(null)

  const l1Normalized = waapAddress?.toLowerCase() ?? null
  const l2Normalized = aztecAddress?.toLowerCase().trim() ?? null
  const bothConnected = !!l1Normalized && !!l2Normalized
  const currentKey = bothConnected ? `${l1Normalized}:${l2Normalized}` : null

  const l2WalletProvider =
    aztecLoginMethod === 'wallet-sdk'
      ? 'WalletSDK'
      : null

  useEffect(() => {
    if (!bothConnected) {
      if (prevKeyRef.current !== null) {
        clearAuth()
        prevKeyRef.current = null
      }
      return
    }

    if (user?.l1Address === l1Normalized && user?.l2Address === l2Normalized) {
      prevKeyRef.current = currentKey
      return
    }

    let cancelled = false
    api
      .post<{
        success: boolean
        token: string
        user: {
          id: string
          l1Address: string
          l2Address: string
          l1LoginMethod: string | null
          l1WalletProvider: string | null
          l2LoginMethod: string | null
          l2WalletProvider: string | null
        }
      }>('/api/auth/authenticate', {
        l1Address: waapAddress,
        l2Address: aztecAddress,
        l1LoginMethod: waapLoginMethod ?? undefined,
        l1WalletProvider: waapWalletProvider ?? undefined,
        l2LoginMethod: aztecLoginMethod ?? undefined,
        l2WalletProvider: l2WalletProvider ?? undefined,
      })
      .then((res) => {
        if (cancelled || !res.data?.token || !res.data?.user) return
        setAuth(res.data.token, res.data.user)
        prevKeyRef.current = currentKey
      })
      .catch((err) => {
        if (!cancelled) {
          const msg = err?.response?.data?.error || err?.message || 'Unknown error'
          console.warn('[AuthSync] authenticate failed:', msg, err)
          showToast('warn', {
            message: `Authentication failed: ${msg}`,
            heading: 'Auth Error',
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [
    bothConnected,
    currentKey,
    waapAddress,
    aztecAddress,
    waapLoginMethod,
    waapWalletProvider,
    aztecLoginMethod,
    l2WalletProvider,
    user?.l1Address,
    user?.l2Address,
    setAuth,
    clearAuth,
    l1Normalized,
    l2Normalized,
  ])

  return null
}
