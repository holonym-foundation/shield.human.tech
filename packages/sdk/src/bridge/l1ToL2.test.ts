import { describe, it, expect, vi } from 'vitest'
import { Fr } from '@aztec-labs/aztec.js/fields'
import { executeL2Claim, FUEL_CLAIM_MESSAGE_GONE_ERROR } from './l1ToL2'
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

describe('executeL2Claim slow wallet approval', () => {
  it('keeps waiting on the open wallet request instead of queueing a duplicate claim', async () => {
    // Approved after two timeout windows. A second executeCall would open a second
    // approval whose tx fails once the first one has consumed the message.
    const executeCall = vi.fn(
      () => new Promise<{ txHash: string }>((resolve) => setTimeout(() => resolve({ txHash: TX_HASH }), 50)),
    )
    const { deps } = makeDeps([], executeCall)

    const result = await executeL2Claim(deps, params, { ...fastOptions, walletTimeoutMs: 20 })

    expect(result.l2TxHash).toBe(TX_HASH)
    expect(executeCall).toHaveBeenCalledTimes(1)
  })

  it('gives up with the timeout error once every attempt has waited', async () => {
    const executeCall = vi.fn(() => new Promise<{ txHash: string }>(() => {}))
    const { deps } = makeDeps([], executeCall)

    await expect(
      executeL2Claim(deps, params, { ...fastOptions, walletTimeoutMs: 5, maxAttempts: 3 }),
    ).rejects.toThrow('Wallet did not respond in time')
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

  it('does not report success for fuel claims — states only that the message was consumed', async () => {
    const executeCall = vi.fn().mockRejectedValue(messageGoneError())
    const { deps } = makeDeps([], executeCall)

    await expect(
      executeL2Claim(deps, params, {
        ...fastOptions,
        feeOption: { fee: { paymentMethod: {} } },
      }),
    ).rejects.toThrow(/does not confirm the tokens arrived/)
    expect(executeCall).toHaveBeenCalledTimes(2)
  })

  // The #2146 shape end to end: attempt 1 is mined and reverted (setup phase consumes the
  // message), attempts 2+ see the message gone and the loop throws a fresh error. That
  // fresh error must still carry the reverted tx, or the caller persists no reference.
  it('carries the reverted claim hash onto the message-gone error', async () => {
    const reverted = Object.assign(new Error(`L2 transaction reverted (reverted): ${TX_HASH}`), {
      txHash: TX_HASH,
      txOutcome: 'reverted',
    })
    const executeCall = vi
      .fn()
      .mockRejectedValueOnce(reverted)
      .mockRejectedValue(messageGoneError())
    const { deps } = makeDeps([], executeCall)

    const err = await executeL2Claim(deps, params, {
      ...fastOptions,
      feeOption: { fee: { paymentMethod: {} } },
    }).catch((e) => e)
    expect(err.message).toBe(FUEL_CLAIM_MESSAGE_GONE_ERROR)
    expect(err.txHash).toBe(TX_HASH)
    expect(err.txOutcome).toBe('reverted')
  })

  it('never claims the earlier attempt succeeded (#2146)', async () => {
    const executeCall = vi.fn().mockRejectedValue(messageGoneError())
    const { deps } = makeDeps([], executeCall)

    await expect(
      executeL2Claim(deps, params, { ...fastOptions, feeOption: { fee: { paymentMethod: {} } } }),
    ).rejects.not.toThrow(/likely|probably|succeeded|completed/i)
  })

  it('still maps consumed-message errors to already-claimed immediately', async () => {
    const executeCall = vi.fn().mockRejectedValue(new Error('message already consumed'))
    const { deps } = makeDeps([], executeCall)

    await expect(executeL2Claim(deps, params, fastOptions)).rejects.toThrow(
      'This deposit has already been claimed.',
    )
    expect(executeCall).toHaveBeenCalledTimes(1)
  })

  it('does not report a consumed fuel claim as delivered', async () => {
    // The setup phase can nullify the message while the mint reverts (#2146).
    const executeCall = vi.fn().mockRejectedValue(new Error('message has already been nullified'))
    const { deps } = makeDeps([], executeCall)

    await expect(
      executeL2Claim(deps, params, { ...fastOptions, feeOption: { fee: { paymentMethod: {} } } }),
    ).rejects.toThrow(FUEL_CLAIM_MESSAGE_GONE_ERROR)
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
    expect(isAlreadyConsumedError(FUEL_CLAIM_MESSAGE_GONE_ERROR)).toBe(false)
  })

  // Guard rail. Resume turns a match here into status 'completed'. #2146 was a mainnet
  // deposit whose message was consumed with zero tokens delivered, so a fuel claim that
  // matched would write a false completion — strictly worse than reporting the failure.
  it('the fuel message must never drift into matching', () => {
    expect(FUEL_CLAIM_MESSAGE_GONE_ERROR).not.toMatch(/already\s*(nullified|consumed)/i)
    expect(FUEL_CLAIM_MESSAGE_GONE_ERROR).not.toMatch(/deposit has already been claimed/i)
  })
})
