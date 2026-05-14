import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HumanTechBridge } from './client'
import { pushFailedPatch, getFailedPatches, clearFailedPatches } from './storage'
import { BridgeApiClient } from './api'

/**
 * Integration tests for `HumanTechBridge` drain wiring.
 *
 * Scope: Fix 1 (auto-drain on `setAuthToken` / `authenticate`) and the
 * `verifyNodeCompatibility` method added this round.
 *
 * We cannot exercise `authenticate()` end-to-end without a real SIWE server,
 * but we CAN verify `setAuthToken` triggers the drain — that's the same path
 * `authenticate` uses internally.
 */

// `createAztecNodeClient` hits a real URL during construction; mock it.
// The mock accepts any method and returns something sensible.
vi.mock('@aztec/aztec.js/node', () => ({
  createAztecNodeClient: (_url: string) => ({
    getNodeInfo: vi.fn(),
    isReady: vi.fn().mockResolvedValue(true),
    getPendingTxCount: vi.fn().mockResolvedValue(0),
    getBlockNumber: vi.fn().mockResolvedValue(100),
  }),
}))

function makeBridge(opts?: { l2NodeUrl?: string }) {
  return new HumanTechBridge({
    l1RpcUrl: 'https://eth-sepolia.mock',
    l2NodeUrl: opts?.l2NodeUrl ?? 'https://aztec-node.mock',
    apiUrl: 'https://bridge.mock',
    domain: 'https://bridge.mock/',
  })
}

describe('HumanTechBridge.setAuthToken — Fix 1 drain wiring', () => {
  beforeEach(() => {
    clearFailedPatches()
  })

  it('drains the failed-PATCH queue when token is set', async () => {
    // Seed the queue as if a prior session's PATCHes failed.
    pushFailedPatch({
      operationId: 1,
      data: { l1TxHash: '0xaa' },
      label: 'l1TxHash',
      timestamp: Date.now(),
    })

    // Intercept the apiClient.patch that retryFailedPatches will call.
    const patchSpy = vi.spyOn(BridgeApiClient.prototype, 'patch').mockResolvedValue({})

    const bridge = makeBridge()
    bridge.setAuthToken('fake-jwt-token')

    // drainFailedPatches is fire-and-forget — yield so the microtask runs.
    await new Promise((r) => setTimeout(r, 0))

    expect(patchSpy).toHaveBeenCalledOnce()
    expect(patchSpy).toHaveBeenCalledWith('/api/bridge/operations/1', { l1TxHash: '0xaa' })
    // Queue cleared after successful drain
    expect(getFailedPatches()).toEqual([])

    patchSpy.mockRestore()
  })

  it('does not error when queue is empty', async () => {
    const patchSpy = vi.spyOn(BridgeApiClient.prototype, 'patch').mockResolvedValue({})
    const bridge = makeBridge()
    // No pushFailedPatch calls — queue empty.
    expect(() => bridge.setAuthToken('fake-jwt-token')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(patchSpy).not.toHaveBeenCalled()
    patchSpy.mockRestore()
  })

  it('swallows drain errors (fire-and-forget) so setAuthToken never throws', async () => {
    // Simulate a backend that rejects every PATCH retry.
    pushFailedPatch({
      operationId: 42,
      data: { status: 'failed' },
      label: 'test',
      timestamp: Date.now(),
    })
    const patchSpy = vi.spyOn(BridgeApiClient.prototype, 'patch').mockRejectedValue(new Error('server down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const bridge = makeBridge()
    // Must not throw synchronously even though every drain retry fails.
    expect(() => bridge.setAuthToken('fake-jwt-token')).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))

    // Queue retains the still-failing entry for next try.
    expect(getFailedPatches()).toHaveLength(1)

    patchSpy.mockRestore()
    warnSpy.mockRestore()
  })
})

describe('HumanTechBridge.verifyNodeCompatibility', () => {
  it('returns compatible=true when rollupVersion matches and nodeVersion matches', async () => {
    const bridge = makeBridge()
    ;(bridge as any).aztecNode.getNodeInfo = vi.fn().mockResolvedValue({
      rollupVersion: (bridge as any).config.rollupVersion,
      nodeVersion: (bridge as any).config.aztecVersion,
    })

    const res = await bridge.verifyNodeCompatibility()
    expect(res.compatible).toBe(true)
    expect(res.warnings).toEqual([])
    expect(res.actualRollupVersion).toBe(res.expectedRollupVersion)
  })

  it('warns on rollupVersion mismatch', async () => {
    const bridge = makeBridge()
    const expected = (bridge as any).config.rollupVersion
    ;(bridge as any).aztecNode.getNodeInfo = vi.fn().mockResolvedValue({
      rollupVersion: expected + 1,
      nodeVersion: (bridge as any).config.aztecVersion,
    })

    const res = await bridge.verifyNodeCompatibility()
    expect(res.compatible).toBe(false)
    expect(res.warnings.some((w) => /Rollup version mismatch/.test(w))).toBe(true)
  })

  it('warns on aztecVersion mismatch but still compatible if rollupVersion matches', async () => {
    const bridge = makeBridge()
    ;(bridge as any).aztecNode.getNodeInfo = vi.fn().mockResolvedValue({
      rollupVersion: (bridge as any).config.rollupVersion,
      nodeVersion: '99.99.99-experimental',
    })

    const res = await bridge.verifyNodeCompatibility()
    expect(res.compatible).toBe(true)
    expect(res.warnings.some((w) => /Aztec version mismatch/.test(w))).toBe(true)
  })

  it('returns compatible=false + warning when node is unreachable', async () => {
    const bridge = makeBridge()
    ;(bridge as any).aztecNode.getNodeInfo = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await bridge.verifyNodeCompatibility()
    expect(res.compatible).toBe(false)
    expect(res.actualRollupVersion).toBeNull()
    expect(res.actualNodeVersion).toBeNull()
    expect(res.warnings.some((w) => /Could not fetch nodeInfo/.test(w))).toBe(true)
  })

  it('does not throw', async () => {
    const bridge = makeBridge()
    ;(bridge as any).aztecNode.getNodeInfo = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(bridge.verifyNodeCompatibility()).resolves.toBeDefined()
  })
})
