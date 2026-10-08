// frontend/src/components/AuthSync.tsx
'use client'

import { useEffect, useRef } from 'react'
import { useWalletStore } from '@/stores/walletStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useBridge } from '@/hooks/useBridge'
import { showToast } from '@/hooks/useToast'
import { pushNotification } from '@/stores/useNotificationsStore'
import { requestWaapWallet, WAAP_METHOD } from '@/stores/walletStore'
import { L1_CHAIN_ID } from '@/config'

const MAX_AUTH_RETRIES = 2

// Stable toast id so the "Authenticating…" toast updates in place across
// nonce-retries instead of stacking, and so we can dismiss it deterministically
// on success/failure.
const AUTH_PENDING_TOAST_ID = 'auth-pending'

/**
 * When both L1 (Waap) and L2 (Aztec) wallets are connected, authenticate
 * via SIWE (EIP-4361) using the SDK. Auto-retries on nonce expiry.
 */
export default function AuthSync() {
  const { waapAddress, aztecAddress, waapLoginMethod, waapWalletProvider, aztecLoginMethod, aztecNetworkVerified } =
    useWalletStore()
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
          heading: 'Session expired',
          message: 'Please sign in again to continue.',
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
            // Surface a clear "this is a sign-in, not a bridge tx" message right
            // before the wallet popup so the user knows what they're signing.
            showToast(
              'info',
              {
                heading: 'Confirm it is you',
                message:
                  'Sign the message in your wallet to confirm you own these accounts. This does not authorize any transfer.',
              },
              { toastId: AUTH_PENDING_TOAST_ID, autoClose: false },
            )
            try {
              const sig = await requestWaapWallet(WAAP_METHOD.personal_sign, [msg, waapAddress])
              // Signature captured — clear the "action required" prompt the
              // instant the user signs so it never lingers in Messages. The
              // keyed upsert replaces that row in place with a neutral status.
              pushNotification({
                type: 'info',
                title: 'Verifying your accounts',
                message: 'Almost done.',
                key: AUTH_PENDING_TOAST_ID,
              })
              return sig as string
            } finally {
              showToast.dismiss(AUTH_PENDING_TOAST_ID)
            }
          },
          l1LoginMethod: waapLoginMethod ?? undefined,
          l1WalletProvider: waapWalletProvider ?? undefined,
          l2LoginMethod: aztecLoginMethod ?? undefined,
          l2WalletProvider: l2WalletProvider ?? undefined,
          l2NetworkVerified: aztecNetworkVerified,
        })

        if (cancelled || !result.token || !result.user) return
        setAuth(result.token, result.user)
        prevKeyRef.current = currentKey
        // Resolve the sign-in row promptly so it reads as done, not "action
        // required". Keyed upsert replaces the pending/verifying row in place.
        pushNotification({
          type: 'success',
          title: 'Signed in',
          message: 'Your accounts are verified.',
          key: AUTH_PENDING_TOAST_ID,
        })

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
          showToast('info', 'Sign-in request expired. Please sign again.')
          authenticate(retryCount + 1)
          return
        }

        setAuthFailed(true)
        // Keep the technical detail in the console; show the user plain copy.
        // Reuse the sign-in row's key so the error REPLACES the pending prompt
        // instead of leaving an "action required" row sitting behind the error.
        console.error('[AuthSync] authentication failed:', errorMsg, err)
        pushNotification({
          type: 'error',
          title: 'Sign in failed',
          message: 'We could not verify your wallet. Please try again.',
          key: AUTH_PENDING_TOAST_ID,
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
