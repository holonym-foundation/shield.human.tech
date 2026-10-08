import { describe, it, expect, vi } from 'vitest'
import { executeL1Withdraw, burnMayStillLand } from './l2ToL1'

/**
 * Integration tests for `executeL1Withdraw` focusing on the two fixes shipped
 * in this round:
 *   - Fix 11: happy-path catches post-revert "already consumed" errors
 *   - H5: outbox pre-check distinguishes fatal vs transient errors
 *
 * We mock `publicClient.readContract`, `sendTransaction`, and
 * `publicClient.waitForTransactionReceipt` to drive the function through
 * every code path without an RPC.
 */

function makeParams(overrides?: Partial<Parameters<typeof executeL1Withdraw>[0]>) {
  return {
    publicClient: {
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === 'getRootData' ? '0x01' : false,
      ),
      waitForTransactionReceipt: vi.fn(),
    } as any,
    sendTransaction: vi.fn(async () => '0xdeadbeef'),
    // Checksummed EIP-55 addresses — viem validates these at encodeFunctionData.
    l1Address: '0x1111111111111111111111111111111111111111',
    amount: 1000n,
    epoch: 42n,
    numCheckpointsInEpoch: 1n,
    leafIndex: '0',
    siblingPath: ['0x' + '00'.repeat(32)],
    portalAddress: '0x2222222222222222222222222222222222222222',
    chainId: 11155111,
    l2BlockNumber: 100,
    outboxAddress: '0x3333333333333333333333333333333333333333',
    ...overrides,
  }
}

describe('executeL1Withdraw — outbox pre-check (H5)', () => {
  it('returns already-consumed sentinel when pre-check says consumed', async () => {
    const params = makeParams()
    params.publicClient.readContract.mockResolvedValueOnce(true)

    const res = await executeL1Withdraw(params)
    expect(res.l1TxHash).toBe('already-consumed')
    expect(params.sendTransaction).not.toHaveBeenCalled()
  })

  it('proceeds to send tx when pre-check says not consumed', async () => {
    const params = makeParams()
    params.publicClient.readContract.mockResolvedValueOnce(false)
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: '0xabc',
      blockNumber: 123n,
    })

    const res = await executeL1Withdraw(params)
    expect(params.sendTransaction).toHaveBeenCalledOnce()
    expect(res.l1TxHash).toBe('0xabc')
  })

  it('aborts with fatal error when pre-check hits "contract does not exist"', async () => {
    const params = makeParams()
    params.publicClient.readContract.mockRejectedValueOnce(
      new Error('Contract does not exist at 0xoutbox'),
    )

    await expect(executeL1Withdraw(params)).rejects.toThrow(/pre-check failed fatally/)
    expect(params.sendTransaction).not.toHaveBeenCalled()
  })

  it('aborts with fatal error when pre-check hits "unknown function"', async () => {
    const params = makeParams()
    params.publicClient.readContract.mockRejectedValueOnce(
      new Error('Unknown function selector 0xdeadbeef'),
    )

    await expect(executeL1Withdraw(params)).rejects.toThrow(/pre-check failed fatally/)
    expect(params.sendTransaction).not.toHaveBeenCalled()
  })

  it('proceeds to tx on transient pre-check failure (RPC timeout)', async () => {
    const params = makeParams()
    // Transient error: the pre-check can't answer but a fresh tx can still succeed.
    params.publicClient.readContract.mockRejectedValueOnce(new Error('network timeout'))
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: '0xabc',
      blockNumber: 123n,
    })

    const res = await executeL1Withdraw(params)
    expect(params.sendTransaction).toHaveBeenCalledOnce()
    expect(res.l1TxHash).toBe('0xabc')
  })

  it('skips pre-check when outboxAddress is not provided', async () => {
    const params = makeParams({ outboxAddress: undefined })
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: '0xabc',
      blockNumber: 123n,
    })

    const res = await executeL1Withdraw(params)
    expect(params.publicClient.readContract).not.toHaveBeenCalled()
    expect(params.sendTransaction).toHaveBeenCalledOnce()
    expect(res.l1TxHash).toBe('0xabc')
  })
})

describe('executeL1Withdraw — receipt handling', () => {
  it('throws a recoverable error on revert status', async () => {
    const params = makeParams()
    params.publicClient.readContract.mockResolvedValueOnce(false)
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
      transactionHash: '0xdead',
      blockNumber: 123n,
    })

    await expect(executeL1Withdraw(params)).rejects.toThrow(/funds are safe/i)
  })

  it('returns hash + url + block number on success', async () => {
    const params = makeParams()
    params.publicClient.readContract.mockResolvedValueOnce(false)
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: '0xabcd',
      blockNumber: 55n,
    })

    const res = await executeL1Withdraw(params)
    expect(res.l1TxHash).toBe('0xabcd')
    expect(res.l1TxUrl).toMatch(/tx\/0xabcd/)
    expect(res.l1BlockNumber).toBe('55')
  })
})

describe('burnMayStillLand — a txHash is not proof the burn executed', () => {
  const withHash = (extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('boom'), { txHash: '0xabc', ...extra })

  it('keeps a pending burn out of failed — it may still mine', () => {
    expect(burnMayStillLand(withHash({ txOutcome: 'pending' }))).toBe(true)
  })

  it('treats an unlabelled txHash as still landing (network error reading the receipt)', () => {
    expect(burnMayStillLand(withHash())).toBe(true)
  })

  // The regression. A reverted burn recorded as confirmed writes a successful burn that
  // never happened, then strands the withdrawal on a witness for a message never emitted.
  it('does NOT treat a reverted burn as confirmed', () => {
    expect(burnMayStillLand(withHash({ txOutcome: 'reverted' }))).toBe(false)
  })

  it('does NOT treat a dropped burn as confirmed', () => {
    expect(burnMayStillLand(withHash({ txOutcome: 'dropped' }))).toBe(false)
  })

  it('is false when no transaction was ever submitted', () => {
    expect(burnMayStillLand(new Error('user rejected'))).toBe(false)
  })
})

describe('executeL1Withdraw — outbox root readiness', () => {
  const zeroRoot = '0x' + '0'.repeat(64)

  it('waits for the epoch root to appear on L1 before sending the tx', async () => {
    vi.useFakeTimers()
    try {
      const params = makeParams()
      params.publicClient.readContract
        .mockResolvedValueOnce(false) // not consumed
        .mockResolvedValueOnce(zeroRoot) // root not visible yet
      params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
        status: 'success',
        transactionHash: '0xabc',
        blockNumber: 123n,
      })

      const pending = executeL1Withdraw(params)
      await vi.advanceTimersByTimeAsync(12_000)
      const res = await pending

      expect(params.sendTransaction).toHaveBeenCalledOnce()
      expect(res.l1TxHash).toBe('0xabc')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up with a resumable error when the root never appears', async () => {
    vi.useFakeTimers()
    try {
      const params = makeParams()
      params.publicClient.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
        functionName === 'getRootData' ? zeroRoot : false,
      )

      const pending = executeL1Withdraw(params)
      const assertion = expect(pending).rejects.toThrow(/NothingToConsumeAtEpoch.*Resume/s)
      await vi.advanceTimersByTimeAsync(6 * 60_000)
      await assertion
      expect(params.sendTransaction).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('proceeds when the root read itself fails', async () => {
    const params = makeParams()
    params.publicClient.readContract
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('network timeout'))
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: '0xabc',
      blockNumber: 123n,
    })

    await executeL1Withdraw(params)
    expect(params.sendTransaction).toHaveBeenCalledOnce()
  })
})

describe('executeL1Withdraw — wallet gas retry', () => {
  // MetaMask's "Added protection" can run the first protected tx out of gas; the call itself
  // is still valid, so one resend succeeds (see l1CallStillSucceeds).
  const reverted = { status: 'reverted', transactionHash: '0xdead', blockNumber: 1n }
  const success = { status: 'success', transactionHash: '0xbeef', blockNumber: 2n }

  it('resends once when the reverted call still simulates', async () => {
    const emit = vi.fn()
    const params = makeParams({ emit })
    params.publicClient.call = vi.fn(async () => ({}))
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce(reverted).mockResolvedValueOnce(success)

    const res = await executeL1Withdraw(params)

    expect(params.sendTransaction).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenCalledWith({ type: 'l1_gas_retry', phase: 'withdraw', revertedTxHash: '0xdead' })
    expect(res.l1TxHash).toBe('0xbeef')
  })

  it('does not resend when the call itself now reverts', async () => {
    const params = makeParams()
    params.publicClient.call = vi.fn(async () => {
      throw new Error('execution reverted')
    })
    params.publicClient.waitForTransactionReceipt.mockResolvedValueOnce(reverted)

    await expect(executeL1Withdraw(params)).rejects.toThrow(/funds are safe/i)
    expect(params.sendTransaction).toHaveBeenCalledOnce()
  })

  it('gives up after one resend', async () => {
    const params = makeParams()
    params.publicClient.call = vi.fn(async () => ({}))
    params.publicClient.waitForTransactionReceipt.mockResolvedValue(reverted)

    await expect(executeL1Withdraw(params)).rejects.toThrow(/funds are safe/i)
    expect(params.sendTransaction).toHaveBeenCalledTimes(2)
  })
})
