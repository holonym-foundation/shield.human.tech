import { QueryClient } from '@tanstack/react-query'
import { persistQueryClient } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { APP_VERSION } from '@/config/env.config'

/**
 * Configures localStorage persistence for React Query
 * This allows query data to persist between page refreshes and app restarts
 */
export function setupQueryPersistence(queryClient: QueryClient) {
  // Only run in browser environment
  if (typeof window === 'undefined') return

  // Create a storage persister that uses localStorage
  const localStoragePersister = createSyncStoragePersister({
    storage: window.localStorage,
    key: 'aztec-bridge-query-state', // More descriptive key for localStorage
    throttleTime: 1000, // Time (in ms) to throttle persistence to avoid excessive writes
  })

  // const sessionStoragePersister = createSyncStoragePersister({ storage: window.sessionStorage })
  try {
    // Setup persistence with the query client
    persistQueryClient({
      queryClient: queryClient as any, // Force type to avoid version mismatch
      persister: localStoragePersister,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days in milliseconds
      buster: APP_VERSION, // Cache buster based on app version
      // Only persist queries that are tagged for persistence
      // /** How to serialize the data to storage */
      // serialize?: (client: PersistedClient) => string
      // /** How to deserialize the data from storage */
      // deserialize?: (cachedString: string) => PersistedClient

      // * you can pass dehydrateOptions to PersistQueryClientProvider to tell it to exclude a certain query: ==>  https://github.com/TanStack/query/discussions/4833
      dehydrateOptions: {
        shouldDehydrateQuery: (query: any) => {
          // Define the list of query keys to persist
          const keysToCache = [
            // L1 (Ethereum) query keys
            'l1TokenBalance',
            'l1NativeBalance',
            'l1HasSoulboundToken',
            // L2 (Aztec) query keys
            'l2TokenBalance',
            'l2NativeBalance',
            'l2HasSoulboundToken',
          ]

          // Only persist queries with a persist flag or specific query keys
          return (
            query.meta?.persist === true ||
            (Array.isArray(query.queryKey) && keysToCache.includes(query.queryKey[0] as string))
          )
        },
      },
    })
  } catch (error) {
    console.error('Failed to setup query persistence:', error)
  }
}
