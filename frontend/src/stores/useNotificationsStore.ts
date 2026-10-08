'use client'

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// SSR-safe storage: the store module is evaluated on the server too (client
// components still render on the server), where localStorage doesn't exist.
const safeStorage = createJSONStorage(() =>
  typeof window !== 'undefined'
    ? window.localStorage
    : { getItem: () => null, setItem: () => {}, removeItem: () => {} },
)

// Persistent, in-app feed of the events that used to live only in transient
// toasts. Toasts stay for momentary confirmations; anything the user may want
// to look back on (a signature request, a claim/withdrawal/deposit outcome, an
// error) also lands here so it survives the toast's autoClose. The feed is the
// single source of truth — every meaningful toast is mirrored here (see
// useToast.ts), so nothing shown transiently is ever lost.
export type NotificationType =
  | 'signature'
  | 'claim'
  | 'withdrawal'
  | 'deposit'
  | 'error'
  | 'info'
  | 'success'
  | 'warning'

// An optional inline action carried by a message. Rendered as a small
// button inside the feed row so an interactive notification (e.g. "Deposit
// confirmed" offering a recovery-backup export) can be acted on straight from
// Messages, now that no corner toast exists to click. The onClick is a live
// function, so it is NOT persisted (partialize strips `action`); a message
// restored from storage keeps its text but loses its button. Actions that must
// survive a reload are reconstructed at render time from the message `key`
// (see NotificationsDrawer's recovery-backup download).
export interface NotificationAction {
  label: string
  onClick: () => void
}

export interface AppNotification {
  id: string
  // Optional stable identity. When present, a later push with the same key
  // updates this entry in place instead of appending a new row — this is how a
  // long-running flow (a bridge's repeating sync/claim pings, all sharing one
  // toastId) collapses to a single, live-updating feed row instead of flooding
  // the feed with a new entry every poll.
  key?: string
  type: NotificationType
  title: string
  message?: string
  action?: NotificationAction
  // Optional transaction context for a message row. `amount` is an already-formatted
  // display string (e.g. "100 USDC"); `mode` mirrors the operation's privacy mode so a
  // lifecycle row identifies the transaction the way an Activity card does.
  amount?: string
  mode?: 'public' | 'private'
  timestamp: number
  read: boolean
  // True only for rows restored from localStorage on load, before any new event
  // has fired in this session. The mini-bar ticker uses this to stay silent about
  // a prior session's error/warning on a fresh bridge — the row still lives in the
  // Messages feed, it just isn't force-surfaced in the ticker. Cleared the moment a
  // new push refreshes the row (a genuine in-session event), so live alerts show.
  rehydrated?: boolean
}

// Signal the drawer uses to fire the "genie into Messages" animation exactly
// once per genuinely-new entry (never on an in-place key update, so progress
// pings don't re-trigger it every poll).
export interface GenieSignal {
  id: string
  type: NotificationType
}

// Keep the feed bounded — old entries fall off the end so the store never grows
// without limit across a long session.
const MAX_NOTIFICATIONS = 50

// Collapse an immediate repeat of the same un-keyed event (same type/title/message
// within a short window). Re-renders and retrying flows can fire the same push
// twice; the feed should record the event once, not stutter.
const DEDUPE_WINDOW_MS = 4000

interface NotificationsState {
  notifications: AppNotification[]
  unreadCount: number
  lastGenie: GenieSignal | null
  pushNotification: (input: {
    type: NotificationType
    title: string
    message?: string
    key?: string
    action?: NotificationAction
    amount?: string
    mode?: 'public' | 'private'
  }) => void
  dismiss: (id: string) => void
  // Remove every row carrying this stable `key`. Used to retire a transient,
  // context-bound banner (e.g. a "Do not reload" safety notice) the moment its
  // window closes, so it never lingers in the feed — or, now that the feed is
  // persisted, survives a reload — after the operation has moved on.
  dismissByKey: (key: string) => void
  dismissAll: () => void
  markAllRead: () => void
}

const unread = (list: AppNotification[]) => list.filter((n) => !n.read).length

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export const useNotificationsStore = create<NotificationsState>()(
  persist(
    (set, get) => ({
  notifications: [],
  unreadCount: 0,
  lastGenie: null,

  pushNotification: ({ type, title, message, key, action, amount, mode }) => {
    set((state) => {
      // Keyed upsert — refresh the existing row in place (new text/timestamp,
      // bumped to the top) and preserve its read state so a progress row the
      // user has already seen doesn't keep re-badging on every poll. No genie.
      if (key) {
        const idx = state.notifications.findIndex((n) => n.key === key)
        if (idx !== -1) {
          const existing = state.notifications[idx]
          const updated: AppNotification = {
            ...existing,
            type,
            title,
            message,
            action,
            amount,
            mode,
            timestamp: Date.now(),
            // A fresh event fired on this row, so it is no longer a stale
            // rehydrated carryover — let the ticker surface it again.
            rehydrated: false,
          }
          const rest = state.notifications.filter((_, i) => i !== idx)
          const notifications = [updated, ...rest].slice(0, MAX_NOTIFICATIONS)
          return { notifications, unreadCount: unread(notifications) }
        }
      }

      const latest = state.notifications[0]
      if (
        latest &&
        latest.type === type &&
        latest.title === title &&
        latest.message === message &&
        Date.now() - latest.timestamp < DEDUPE_WINDOW_MS
      ) {
        return state
      }

      const next: AppNotification = {
        id: makeId(),
        key,
        type,
        title,
        message,
        action,
        amount,
        mode,
        timestamp: Date.now(),
        read: false,
      }
      const notifications = [next, ...state.notifications].slice(0, MAX_NOTIFICATIONS)
      return { notifications, unreadCount: unread(notifications), lastGenie: { id: next.id, type } }
    })
  },

  dismiss: (id) =>
    set((state) => {
      const notifications = state.notifications.filter((n) => n.id !== id)
      return { notifications, unreadCount: unread(notifications) }
    }),

  dismissByKey: (key) =>
    set((state) => {
      if (!key) return state
      const notifications = state.notifications.filter((n) => n.key !== key)
      if (notifications.length === state.notifications.length) return state
      return { notifications, unreadCount: unread(notifications) }
    }),

  dismissAll: () => set({ notifications: [], unreadCount: 0 }),

  markAllRead: () =>
    set((state) => {
      if (state.unreadCount === 0) return state
      return {
        notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
        unreadCount: 0,
      }
    }),
    }),
    {
      name: 'shield:notifications',
      storage: safeStorage,
      version: 1,
      // Rehydrated explicitly from a client effect (see ClientLayout) so the
      // server and first client render both start empty — no hydration mismatch
      // on the unread badge or feed.
      skipHydration: true,
      // Tag every restored row as `rehydrated` so the mini-bar ticker can ignore a
      // prior session's error/warning on load (it would otherwise force-surface
      // yesterday's alert on a fresh bridge). The rows stay in the Messages feed;
      // a new in-session push clears the tag (see the keyed upsert) so live alerts
      // still surface. Persisted value is harmless — it is re-set on each load.
      onRehydrateStorage: () => (state) => {
        if (!state) return
        state.notifications = state.notifications.map((n) => ({ ...n, rehydrated: true }))
      },
      // Persist only serializable fields: drop the live `action` onClick (a
      // function) and never persist the one-shot genie animation signal.
      partialize: (state) => ({
        notifications: state.notifications.map(({ action: _action, ...rest }) => rest),
        unreadCount: state.unreadCount,
      }),
    },
  ),
)

// Convenience for non-React call sites (zustand stores, event callbacks) that
// shouldn't subscribe — mirrors how showToast is used across the app.
export const pushNotification = (input: {
  type: NotificationType
  title: string
  message?: string
  key?: string
  action?: NotificationAction
  amount?: string
  mode?: 'public' | 'private'
}) => useNotificationsStore.getState().pushNotification(input)

// Non-React accessor for retiring a keyed banner from event callbacks (mirrors
// `pushNotification`). Clearing the feed row here is what makes a transient
// safety notice actually go away when the flow advances — dismissing the toast
// alone never touched the persisted feed.
export const dismissNotificationByKey = (key: string) =>
  useNotificationsStore.getState().dismissByKey(key)
