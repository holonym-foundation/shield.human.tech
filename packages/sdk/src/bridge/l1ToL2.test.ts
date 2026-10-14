import { describe, it, expect, vi } from 'vitest'
import { Fr } from '@aztec/aztec.js/fields'
import { executeL2Claim } from './l1ToL2'
import { isAlreadyConsumedError } from './utils'

/**
 * Tests for the claim retry loop's handling of a submitted-but-pending tx.
 *
 * The failure this guards against: the wallet submits the claim, its inclusion
 * wait expires ("still pending"), the tx lands anyway, and every blind
 * resubmission then fails with "No non-nullified L1 to L2 message found" even
 * though the claim succeeded. The loop must watch the submitted tx's receipt
 * instead of resubmitting, and classify the nullified-message error honestly.
 */

const TX_HASH = '0x0805fea221dfe160df577de30d12b363932f50cf983759d799ad913bb87ec2c9'
const L2_ADDRESS = '0x1a6d21ce5fd80137df0e99632a4ca17e58a42dc8f6c08191a96ca8ae907a1bc0'

const pendingError = (hash: string, { structured = true } = {}) => {
  const e = new Error(`L2 transaction is still pending and was not included in a block (${hash}).`)
  if (structured) (e as any).txHash = hash
  return e
}

const messageGoneError = () =>
  new Error(
    '"No non-nullified L1 to L2 message found for message hash 0x00e8005e6d631785c0c5fa72a186cb0dac22f773436e7506e5aa1878c13863cf"',
  )

function makeDeps(receipts: any[], executeCall: ReturnType<typeof vi.fn>) {
  const getTxReceipt = vi.fn(async () => (receipts.length > 1 ? receipts.shift() : receipts[0]))
  return {
    deps: {
      walletAdapter: { bridgeAddress: L2_ADDRESS, executeCall } as any,
      aztecAddress: L2_ADDRESS,
      isPrivacyModeEnabled: true,
      aztecNode: { getTxReceipt },
    } as any,
    getTxReceipt,
  }
}

const params = {
  amount: 1000n,
  claimSecret: Fr.fromString('0x01'),
  messageLeafIndex: 42n,
}

const fastOptions = {
  retryDelayMs: 5,
  pendingPollIntervalMs: 5,
  pendingWatchMs: 100,
  walletTimeoutMs: 10_000,
}

describe('executeL2Claim pending-tx resolution', () => {
  it('returns success with the original hash when the pending tx was mined', async () => {
    const executeCall = vi.fn().mockRejectedValue(pendingError(TX_HASH))
    const { deps } = makeDeps([{ status: 'checkpointed', executionResult: 'success' }], executeCall)

    const result = await executeL2Claim(deps, params, fastOptions)

    expect(result.l2TxHash).toBe(TX_HASH)
    expect(executeCall).toHaveBeenCalledTimes(1)
  })

  it('falls back to the hash embedded in the message when no structured txHash is attached', async () => {
    const executeCall = vi.fn().mockRejectedValue(pendingError(TX_HASH, { structured: false }))
    const { deps } = makeDeps([{ status: 'checkpointed', executionResult: 'success' }], executeCall)

    const result = await executeL2Claim(deps, params, fastOptions)

    expect(result.l2TxHash).toBe(TX_HASH)
    expect(executeCall).toHaveBeenCalledTimes(1)
  })

  it('resubmits when the pending tx was dropped', async () => {
    const executeCall = vi
      .fn()
      .mockRejectedValueOnce(pendingError(TX_HASH))
      .mockResolvedValueOnce({ txHash: '0xnew' })
    const { deps } = makeDeps([{ status: 'dropped', error: 'Tx dropped by P2P node' }], executeCall)

    const result = await executeL2Claim(deps, params, fastOptions)

    expect(result.l2TxHash).toBe('0xnew')
    expect(executeCall).toHaveBeenCalledTimes(2)
  })

  it('surfaces a reverted pending tx without resubmitting', async () => {
    const executeCall = vi.fn().mockRejectedValue(pendingError(TX_HASH))
    const { deps } = makeDeps(
      [{ status: 'checkpointed', executionResult: 'app_logic_reverted' }],
      executeCall,
    )

    await expect(executeL2Claim(deps, params, fastOptions)).rejects.toThrow(/reverted/)
    expect(executeCall).toHaveBeenCalledTimes(1)
  })

  it('reports a still-pending tx after the watch window instead of resubmitting', async () => {
    const executeCall = vi.fn().mockRejectedValue(pendingError(TX_HASH))
    const { deps } = makeDeps([{ status: 'pending' }], executeCall)

    await expect(executeL2Claim(deps, params, fastOptions)).rejects.toThrow(TX_HASH)
    expect(executeCall).toHaveBeenCalledTimes(1)
  })
})

describe('executeL2Claim nullified-message classification', () => {
  it('maps a persistent nullified-message error to already-claimed for no-fuel claims', async () => {
    const executeCall = vi.fn().mockRejectedValue(messageGoneError())
    const { deps } = makeDeps([], executeCall)

    await expect(executeL2Claim(deps, params, fastOptions)).rejects.toThrow(
      'This deposit has already been claimed.',
    )
    expect(executeCall).toHaveBeenCalledTimes(2)
  })

  it('does not report success for fuel claims — says delivery is unconfirmed', async () => {
    const executeCall = vi.fn().mockRejectedValue(messageGoneError())
    const { deps } = makeDeps([], executeCall)

    await expect(
      executeL2Claim(deps, params, {
        ...fastOptions,
        feeOption: { fee: { paymentMethod: {} } },
      }),
    ).rejects.toThrow(/was consumed.*does not confirm the tokens arrived/s)
    expect(executeCall).toHaveBeenCalledTimes(2)
  })

  it('still maps consumed-message errors to already-claimed immediately', async () => {
    const executeCall = vi.fn().mockRejectedValue(new Error('message already consumed'))
    const { deps } = makeDeps([], executeCall)

    await expect(executeL2Claim(deps, params, fastOptions)).rejects.toThrow(
      'This deposit has already been claimed.',
    )
    expect(executeCall).toHaveBeenCalledTimes(1)
  })

  it('does not retry user rejections', async () => {
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 })
    const executeCall = vi.fn().mockRejectedValue(rejection)
    const { deps } = makeDeps([], executeCall)

    await expect(executeL2Claim(deps, params, fastOptions)).rejects.toThrow('User rejected')
    expect(executeCall).toHaveBeenCalledTimes(1)
  })
})

describe('isAlreadyConsumedError — consumed vs not-ready split (Aztec 5.0 semantics)', () => {
  it('matches the user-facing already-claimed message so resume marks completion', () => {
    expect(isAlreadyConsumedError('This deposit has already been claimed.')).toBe(true)
  })

  it('matches the nullified shape', () => {
    expect(isAlreadyConsumedError('Assertion failed: message has already been nullified')).toBe(true)
  })

  it('does not match the fuel-ambiguous message — resume must treat it as resumable', () => {
    expect(
      isAlreadyConsumedError(
        'The L1→L2 message for this claim was consumed by an earlier attempt that most likely succeeded.',
      ),
    ).toBe(false)
  })
})
