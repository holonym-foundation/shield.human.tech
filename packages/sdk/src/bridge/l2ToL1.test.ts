import { describe, it, expect, vi } from 'vitest'
import { executeL1Withdraw } from './l2ToL1'

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
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn(),
    } as any,
    sendTransaction: vi.fn(async () => '0xdeadbeef'),
    // Checksummed EIP-55 addresses — viem validates these at encodeFunctionData.
    l1Address: '0x1111111111111111111111111111111111111111',
    amount: 1000n,
    epoch: 42n,
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
