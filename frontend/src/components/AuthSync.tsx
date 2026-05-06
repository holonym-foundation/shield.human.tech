// frontend/src/components/AuthSync.tsx
'use client'

import { useEffect, useRef } from 'react'
import { useWalletStore } from '@/stores/walletStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useBridge } from '@/hooks/useBridge'
import { showToast } from '@/hooks/useToast'
import { requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { L1_CHAIN_ID } from '@/config'

const MAX_AUTH_RETRIES = 2

/**
 * When both L1 (Waap) and L2 (Aztec) wallets are connected, authenticate
 * via SIWE (EIP-4361) using the SDK. Auto-retries on nonce expiry.
 */
export default function AuthSync() {
  const { waapAddress, aztecAddress, waapLoginMethod, waapWalletProvider, aztecLoginMethod } = useWalletStore()
  const { setAuth, setAuthFailed, clearAuth, user, retryAuth } = useAuthStore()
  const prevKeyRef = useRef<string | null>(null)
  const bridge = useBridge()

  const { token } = useAuthStore()

  const l1Normalized = waapAddress?.toLowerCase() ?? null
  const l2Normalized = aztecAddress?.toLowerCase().trim() ?? null
  const bothConnected = !!l1Normalized && !!l2Normalized
  const currentKey = bothConnected ? `${l1Normalized}:${l2Normalized}` : null

  const l2WalletProvider = aztecLoginMethod === 'wallet-sdk' ? 'WalletSDK' : null

  // Sync persisted JWT to bridge instance on mount/token change + verify session + drain failed patches
  useEffect(() => {
    if (!token) return
    bridge.setAuthToken(token)

    let cancelled = false

    // Verify the session is still valid (user exists, token not expired)
    bridge.verifySession().then((status) => {
      if (cancelled) return

      if (!status.valid && (status.reason === 'user_not_found' || status.reason === 'token_expired')) {
        clearAuth()
        showToast('error', {
          heading: 'Session Expired',
          message: 'Please sign again to continue.',
        })
      }
    })

    // Drain failed PATCHes from previous sessions
    bridge.retryFailedPatches().catch((err: unknown) => {
      console.warn('[AuthSync] retryFailedPatches on mount failed:', err)
    })

    // Drain failed PATCHes when connectivity resumes
    const handleOnline = () => {
      bridge.retryFailedPatches().catch((err: unknown) => {
        console.warn('[AuthSync] retryFailedPatches on online failed:', err)
      })
    }
    window.addEventListener('online', handleOnline)
    return () => {
      cancelled = true
      window.removeEventListener('online', handleOnline)
    }
  }, [token, bridge, clearAuth])

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

    async function authenticate(retryCount = 0) {
      try {
        if (cancelled) return

        setAuthFailed(false)

        const result = await bridge.authenticate({
          l1Address: waapAddress!,
          l2Address: aztecAddress!,
          domain: window.location.host,
          uri: window.location.origin,
          chainId: L1_CHAIN_ID,
          signMessage: async (msg: string) => {
            const sig = await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, waapAddress])
            return sig as string
          },
          l1LoginMethod: waapLoginMethod ?? undefined,
          l1WalletProvider: waapWalletProvider ?? undefined,
          l2LoginMethod: aztecLoginMethod ?? undefined,
          l2WalletProvider: l2WalletProvider ?? undefined,
        })

        if (cancelled || !result.token || !result.user) return
        setAuth(result.token, result.user)
        prevKeyRef.current = currentKey

        // Drain any failed PATCHes from previous sessions
        bridge.retryFailedPatches().catch((err: unknown) => {
          console.warn('[AuthSync] retryFailedPatches failed:', err)
        })
      } catch (err: any) {
        if (cancelled) return

        // BridgeApiError exposes `friendlyMessage` (status-mapped fallback +
        // JSON {reason,error} parsing). Falls back to err.message for
        // non-API errors (wallet rejection, network, etc.). Avoid `err.body`
        // as a raw string — it can be a 5KB Next.js HTML error page.
        const errorMsg: string =
          (typeof err?.friendlyMessage === 'string' && err.friendlyMessage) ||
          err?.response?.data?.reason ||
          err?.response?.data?.error ||
          err?.message ||
          'Unknown error'

        const isNonceError = /nonce|expired/i.test(errorMsg)

        // Auto-retry on nonce errors (up to MAX_AUTH_RETRIES)
        if (isNonceError && retryCount < MAX_AUTH_RETRIES) {
          showToast('info', 'Session expired — please sign again')
          authenticate(retryCount + 1)
          return
        }

        setAuthFailed(true)
        showToast('error', {
          message: `Authentication failed: ${errorMsg}`,
          heading: 'Auth Error',
        })
      }
    }

    authenticate()

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
    bridge,
    retryAuth,
  ])

  return null
}
