import { useQuery } from '@tanstack/react-query'
import { ACTIVE_AZTEC_ENV, AZTEC_VERSION_ID } from '@/config'

export interface NetworkVersion {
  id: string
  label: string
  path: string
  status: 'current' | 'legacy'
  /** Deployment that serves a legacy path; the root build rewrites `${path}/*` to it. */
  origin?: string
  /** ISO date the legacy version's portals stop accepting deposits, which also ends gas top-ups. */
  pauseAt?: string
}

// Pausing a legacy version's portals ends gas top-ups (withdrawals keep working), so that is the
// deadline users need: without Fee Juice they can't pay for the withdrawal.
export function topUpDeadline(pauseAt?: string): string {
  const date = pauseAt ? new Date(pauseAt) : undefined
  if (!date || Number.isNaN(date.getTime())) return 'soon'
  return `on ${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

// Fetched from the domain root, not this build's basePath: the current build owns the list, so a
// frozen legacy build still learns about versions released after it.
const REGISTRY_URL = '/networks.json'

export function useNetworkVersions() {
  const query = useQuery<NetworkVersion[]>({
    queryKey: ['networkVersions', ACTIVE_AZTEC_ENV],
    queryFn: async () => {
      const resp = await fetch(REGISTRY_URL, { cache: 'no-store' })
      if (!resp.ok) throw new Error(`networks.json ${resp.status}`)
      const registry = (await resp.json()) as Record<string, NetworkVersion[]>
      return (registry[ACTIVE_AZTEC_ENV] ?? []).filter((v) => v.status === 'current' || !!v.origin || v.id === AZTEC_VERSION_ID)
    },
    staleTime: 5 * 60_000,
  })
  const versions = query.data ?? []
  return {
    versions,
    self: versions.find((v) => v.id === AZTEC_VERSION_ID),
    current: versions.find((v) => v.status === 'current'),
    others: versions.filter((v) => v.id !== AZTEC_VERSION_ID),
  }
}
