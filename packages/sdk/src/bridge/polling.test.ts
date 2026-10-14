import { describe, it, expect, vi } from 'vitest'
import { pollL1ToL2MessageSync } from './polling'

const HASH = '0x00a5d9c845588bb424c2288d300fed126cdc266af2c2de40585646319aa8fa01'
const fast = { pollIntervalMs: 1, maxWaitMs: 50 }

describe('pollL1ToL2MessageSync', () => {
  it('is synced once the node returns a membership witness at the latest block', async () => {
    const getL1ToL2MessageMembershipWitness = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([1n, []])
    const result = await pollL1ToL2MessageSync({ getL1ToL2MessageMembershipWitness }, HASH, fast)
    expect(result.synced).toBe(true)
    expect(getL1ToL2MessageMembershipWitness).toHaveBeenCalledWith('latest', expect.anything())
  })

  it('does not need the checkpoint method that dRPC does not serve', async () => {
    const node = {
      getL1ToL2MessageCheckpoint: vi.fn().mockRejectedValue(new Error('method is not available')),
      getL1ToL2MessageMembershipWitness: vi.fn().mockResolvedValue([1n, []]),
    }
    const result = await pollL1ToL2MessageSync(node, HASH, fast)
    expect(result.synced).toBe(true)
    expect(node.getL1ToL2MessageCheckpoint).not.toHaveBeenCalled()
  })

  it('reports the last node error on timeout instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const node = { getL1ToL2MessageMembershipWitness: vi.fn().mockRejectedValue(new Error('code -32601')) }
    const result = await pollL1ToL2MessageSync(node, HASH, fast)
    expect(result.synced).toBe(false)
    expect(result.lastError).toBe('code -32601')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('has no error to report when the message is simply not included yet', async () => {
    const node = { getL1ToL2MessageMembershipWitness: vi.fn().mockResolvedValue(undefined) }
    const result = await pollL1ToL2MessageSync(node, HASH, fast)
    expect(result).toMatchObject({ synced: false, lastError: undefined })
  })
})
