import { useQuery } from '@tanstack/react-query'
import { BASE_PATH } from '@/config'

export interface HumnPointsResult {
  totalPoints: number
  multiplier: number
  /** Per-source points (Passport stamp key → amount). */
  breakdown: Record<string, number>
}

/**
 * Live HUMN Points for a supplied L1 address — Season 1 (Human Passport)
 * points via /api/points. Keyed purely on the L1 address: no JWT and no L2
 * wallet, mirroring useL1Humanity's gating so the Header chip renders both
 * from the same connection state.
 */
export function useHumnPoints(l1Address?: string) {
  return useQuery<HumnPointsResult>({
    queryKey: ['humnPoints', l1Address],
    queryFn: async (): Promise<HumnPointsResult> => {
      const resp = await fetch(`${BASE_PATH}/api/points?address=${l1Address}`)
      if (!resp.ok) {
        throw new Error(`Points lookup failed: ${resp.status}`)
      }
      const data = await resp.json()
      return {
        totalPoints: Number(data.totalPoints) || 0,
        multiplier: Number(data.multiplier) || 1,
        breakdown: data.breakdown ?? {},
      }
    },
    enabled: !!l1Address,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
}
