import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resume } from './resume'
import { pushFailedPatch, getFailedPatches, clearFailedPatches } from '../storage'

/**
 * Integration test for `resume()` top-level drain wiring (Fix 2).
 *
 * We do NOT exercise the full recovery machinery — that requires mocking an
 * Aztec node, wallet adapter, viem public client, etc. Instead we verify the
 * single behavior the fix introduces:
 *
 *   Before fetching the operation from the backend, `resume()` must drain the
 *   queued failed-PATCH backlog so the DB reflects the latest known state
 *   (otherwise block-scan fallbacks run against stale data).
 *
 * We stop the flow early by making `getOperation` (the first real network call
 * after drain) reject with a distinctive error, then assert the drain still
 * happened.
 */

function makeApi() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  return {
    get: vi.fn(async (path: string) => {
      calls.push({ method: 'GET', path })
      throw new Error('STOP_AFTER_DRAIN')
    }),
    patch: vi.fn(async (path: string, body: unknown) => {
      calls.push({ method: 'PATCH', path, body })
      return {}
    }),
    post: vi.fn(),
    calls,
  } as any
}

const minimalConfig = {
  deploymentId: 'test',
  l1ChainId: 11155111,
  l2ChainId: 1,
  l1RpcUrl: 'http://unused',
  l2NodeUrl: 'http://unused',
  rollupVersion: 1,
  aztecVersion: 'test',
  tokens: [],
  l1ContractAddresses: {
    rollupAddress: '0x0000000000000000000000000000000000000001',
    registryAddress: '0x0',
    inboxAddress: '0x0',
    outboxAddress: '0x0',
  },
  swapBridgeRouterAddress: '0x0',
  uniswapFuelSwapAddress: '0x0',
  bridgedFpcAddress: '0x0',
  permit2Address: '0x0',
  wethAddress: '0x0',
  feeJuicePortalAddress: '0x0',
  feeJuiceAddress: '0x0',
  sponsoredFeeAddress: '0x0',
} as any

describe('resume() — Fix 2 top-level drain wiring', () => {
  beforeEach(() => clearFailedPatches())

  it('drains queued failed PATCHes BEFORE fetching the operation', async () => {
    // Seed a stale queued PATCH that should be retried.
    pushFailedPatch({
      operationId: 99,
      data: { l1TxHash: '0xstale' },
      label: 'l1TxHash',
      timestamp: Date.now(),
    })

    const apiClient = makeApi()
    const aztecNode = {} as any
    const params = {
      l1Address: '0x1111111111111111111111111111111111111111',
      signMessage: async () => '0xsig',
    } as any

    // Flow must throw (we're not providing a real operation) — catch the
    // sentinel error to confirm we got as far as getOperation.
    await expect(
      resume(minimalConfig, apiClient, aztecNode, 'https://bridge.mock/', 123, params),
    ).rejects.toThrow(/STOP_AFTER_DRAIN/)

    // Verify order: PATCH (drain) happened before GET (fetch op).
    const firstPatchIdx = apiClient.calls.findIndex((c: any) => c.method === 'PATCH')
    const firstGetIdx = apiClient.calls.findIndex((c: any) => c.method === 'GET')
    expect(firstPatchIdx).toBeGreaterThanOrEqual(0)
    expect(firstGetIdx).toBeGreaterThan(firstPatchIdx)

    // Drain target matches the queued entry
    expect(apiClient.calls[firstPatchIdx].path).toBe('/api/bridge/operations/99')
    expect(apiClient.calls[firstPatchIdx].body).toEqual({ l1TxHash: '0xstale' })
    // Queue is cleared after successful drain
    expect(getFailedPatches()).toEqual([])
  })

  it('continues to recovery even if drain itself fails (silently)', async () => {
    // Seed a queued PATCH...
    pushFailedPatch({
      operationId: 50,
      data: { foo: 'bar' },
      label: 'test',
      timestamp: Date.now(),
    })

    // ...but the apiClient now rejects PATCHes AND the subsequent GET.
    const apiClient = {
      get: vi.fn(async () => {
        throw new Error('STOP_AFTER_DRAIN')
      }),
      patch: vi.fn(async () => {
        throw new Error('server down')
      }),
      post: vi.fn(),
    } as any
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      resume(
        minimalConfig,
        apiClient,
        {} as any,
        'https://bridge.mock/',
        1,
        { l1Address: '0x1', signMessage: async () => '0xsig' } as any,
      ),
    ).rejects.toThrow(/STOP_AFTER_DRAIN/)

    // Drain was attempted but failed; flow continued to getOperation anyway.
    expect(apiClient.patch).toHaveBeenCalled()
    expect(apiClient.get).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('no-ops cleanly when queue is empty', async () => {
    const apiClient = makeApi()
    await expect(
      resume(
        minimalConfig,
        apiClient,
        {} as any,
        'https://bridge.mock/',
        1,
        { l1Address: '0x1', signMessage: async () => '0xsig' } as any,
      ),
    ).rejects.toThrow(/STOP_AFTER_DRAIN/)

    // Only the GET should have been made — no PATCH calls.
    const patchCalls = apiClient.calls.filter((c: any) => c.method === 'PATCH')
    expect(patchCalls).toHaveLength(0)
  })
})
