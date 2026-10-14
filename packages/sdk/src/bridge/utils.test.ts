import { describe, it, expect } from 'vitest'
import {
  isAlreadyConsumedError,
  extractErrorString,
  assertPassportDeadlineBuffer,
  assertValidEpoch,
  isFatalContractReadError,
  assertBlockScanRange,
  classifyL2Execution,
} from './utils'
import { FUEL_CLAIM_MESSAGE_GONE_ERROR } from './l1ToL2'

describe('isAlreadyConsumedError', () => {
  it.each([
    ['already nullified', /already\s*(nullified|consumed)/i],
    ['Note already consumed', /note.*already.*consumed/i],
    ['nothing to consume', /nothing\s*to\s*consume/i],
    ['NothingToConsumeAtBlock(123, 4)', /NothingToConsumeAtBlock/i],
    ['AlreadyConsumed(0xabc)', /AlreadyConsumed/i],
    ['revert: message already consumed', /message.*already.*consumed/i],
    ['message has already been nullified', /message has already been nullified/i],
    ['This deposit has already been claimed.', /deposit has already been claimed/i],
    ['reverted with 0x945d8c59', /0x945d8c59/i],
  ])('matches "%s"', (errMsg) => {
    expect(isAlreadyConsumedError(errMsg)).toBe(true)
  })

  it('does NOT match the not-anchored-yet shapes (Aztec 5.0 split)', () => {
    // "No L1 to L2 message found" / "nonexistent L1-to-L2 message" /
    // "l1_to_l2_msg_exists" mean the message is not consumable YET — the claim
    // is still possible. Treating them as consumed marks an unclaimed deposit
    // as completed and strands the funds.
    expect(isAlreadyConsumedError('nonexistent L1-to-L2 message')).toBe(false)
    expect(isAlreadyConsumedError('Assertion failed: l1_to_l2_msg_exists')).toBe(false)
    expect(isAlreadyConsumedError('No L1 to L2 message found for message hash 0xabc')).toBe(false)
  })

  it('does NOT match generic "execution reverted"', () => {
    // This is a critical guard: generic revert patterns must not be treated as
    // "already consumed" or real failures (wrong epoch, bad proof) would be
    // silently marked as completed.
    expect(isAlreadyConsumedError('execution reverted')).toBe(false)
    expect(isAlreadyConsumedError('execution reverted: bad proof')).toBe(false)
    expect(isAlreadyConsumedError('transaction reverted')).toBe(false)
  })

  it('does NOT match empty or unrelated errors', () => {
    expect(isAlreadyConsumedError('')).toBe(false)
    expect(isAlreadyConsumedError('gas limit exceeded')).toBe(false)
    expect(isAlreadyConsumedError('network error')).toBe(false)
    expect(isAlreadyConsumedError('user rejected')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isAlreadyConsumedError('ALREADY NULLIFIED')).toBe(true)
    expect(isAlreadyConsumedError('aLrEaDy CoNsUmEd')).toBe(true)
  })
})

describe('extractErrorString', () => {
  it('returns string inputs as-is', () => {
    expect(extractErrorString('boom')).toBe('boom')
  })

  it('extracts message from Error', () => {
    expect(extractErrorString(new Error('crash'))).toBe('crash')
  })

  it('extracts common object shapes', () => {
    expect(extractErrorString({ message: 'A' })).toBe('A')
    expect(extractErrorString({ error: 'B' })).toBe('B')
    expect(extractErrorString({ reason: 'C' })).toBe('C')
    expect(extractErrorString({ shortMessage: 'D' })).toBe('D')
  })

  it('handles falsy inputs', () => {
    expect(extractErrorString(null)).toBe('Unknown error')
    expect(extractErrorString(undefined)).toBe('Unknown error')
  })

  it('never returns "[object Object]"', () => {
    const out = extractErrorString({ foo: 'bar' })
    expect(out).not.toBe('[object Object]')
  })
})

describe('assertPassportDeadlineBuffer', () => {
  it('accepts deadline=0n as "no passport attestation" and is a no-op', () => {
    // CleanHands-only path (no passport) sets deadline to 0 — must not throw.
    expect(() => assertPassportDeadlineBuffer(0n, 600n, 'test op')).not.toThrow()
  })

  it('accepts a deadline comfortably beyond the buffer', () => {
    const future = BigInt(Math.floor(Date.now() / 1000)) + 3600n // +1 hour
    expect(() => assertPassportDeadlineBuffer(future, 120n, 'test op')).not.toThrow()
  })

  it('rejects a deadline inside the buffer window', () => {
    const tight = BigInt(Math.floor(Date.now() / 1000)) + 30n // +30s, buffer=120s
    expect(() => assertPassportDeadlineBuffer(tight, 120n, 'the deposit tx')).toThrow(/too short/)
  })

  it('rejects an already-expired deadline', () => {
    const past = BigInt(Math.floor(Date.now() / 1000)) - 10n
    expect(() => assertPassportDeadlineBuffer(past, 60n, 'test op')).toThrow(/expires in 0s|too short/)
  })

  it('includes the context string in the thrown error', () => {
    const past = BigInt(Math.floor(Date.now() / 1000)) - 10n
    expect(() => assertPassportDeadlineBuffer(past, 60n, 'the withdrawal')).toThrow(/the withdrawal/)
  })

  it('rejects deadline exactly at the buffer boundary (strict >)', () => {
    // Policy: `deadline <= now + buffer` throws. Exactly-at-buffer must throw.
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    // Use a small buffer and compute deadline equal to now+buffer.
    const BUFFER = 5n
    expect(() => assertPassportDeadlineBuffer(nowSec + BUFFER, BUFFER, 'test')).toThrow(/too short/)
  })
})

describe('assertValidEpoch', () => {
  it('returns the epoch unchanged when valid', () => {
    expect(assertValidEpoch(42n, 1000)).toBe(42n)
    expect(assertValidEpoch(1n, 1000)).toBe(1n)
  })

  it('rejects null/undefined epoch', () => {
    expect(() => assertValidEpoch(null, 1000)).toThrow(/Could not determine epoch/)
    expect(() => assertValidEpoch(undefined, 1000)).toThrow(/Could not determine epoch/)
  })

  it('rejects zero epoch', () => {
    expect(() => assertValidEpoch(0n, 1000)).toThrow(/Could not determine epoch/)
  })

  it('includes l2BlockNumber in the error for debugging', () => {
    expect(() => assertValidEpoch(0n, 7890)).toThrow(/block 7890/)
    expect(() => assertValidEpoch(null, '7890')).toThrow(/block 7890/)
  })

  it('error message guides user to resume', () => {
    expect(() => assertValidEpoch(0n, 1000)).toThrow(/resume this withdrawal/)
  })
})

describe('isFatalContractReadError', () => {
  it.each([
    'Contract does not exist at address',
    'no contract deployed at 0xabc',
    'Invalid address',
    'Unknown function selector 0xdeadbeef',
    'Unknown method',
    'Unknown selector',
    'function not found',
    'Contract returned no data',
    'ContractFunctionZeroDataError: execution reverted',
  ])('flags "%s" as fatal', (msg) => {
    expect(isFatalContractReadError(msg)).toBe(true)
  })

  it.each([
    'network timeout',
    'ECONNRESET',
    'rate limit exceeded',
    'Too Many Requests',
    'fetch failed',
    '',
  ])('treats "%s" as transient (not fatal)', (msg) => {
    expect(isFatalContractReadError(msg)).toBe(false)
  })

  it('does NOT flag generic "execution reverted"', () => {
    // Execution reverts can mean anything (wrong args, contract paused, etc.);
    // they must not be treated as "contract missing."
    expect(isFatalContractReadError('execution reverted')).toBe(false)
  })
})

describe('assertBlockScanRange', () => {
  it('accepts a range within the limit', () => {
    expect(() => assertBlockScanRange(100, 1099, 1000, 'L1')).not.toThrow()
  })

  it('accepts range equal to the max', () => {
    expect(() => assertBlockScanRange(100, 1100, 1000, 'L1')).not.toThrow()
  })

  it('rejects a range that exceeds the limit', () => {
    expect(() => assertBlockScanRange(100, 1200, 1000, 'L1')).toThrow(/L1 block scan range too large/)
  })

  it('accepts BigInt inputs', () => {
    expect(() => assertBlockScanRange(100n, 500n, 1000n, 'L1')).not.toThrow()
    expect(() => assertBlockScanRange(0n, 2_000_000n, 1_000_000n, 'L1')).toThrow(/too large/)
  })

  it('treats negative range (from > to) as no-op — does not throw', () => {
    // If someone stored a stale l2BlockNumberBeforeTx ahead of current head,
    // it's better to proceed and fail elsewhere than to throw a misleading
    // "range too large" error.
    expect(() => assertBlockScanRange(5000, 100, 1000, 'L2')).not.toThrow()
  })

  it('mentions correct tx-hash hint for L1 vs L2', () => {
    expect(() => assertBlockScanRange(0, 2_000_000, 1_000_000, 'L1')).toThrow(/l1TxHash/)
    expect(() => assertBlockScanRange(0, 5000, 1000, 'L2')).toThrow(/l2TxHash/)
  })
})

describe('classifyL2Execution — every TxStatus, not just the happy one', () => {
  // TxStatus is block finalization, NOT success. All four mined statuses are decidable;
  // the two un-mined ones are not, regardless of what executionResult says.
  const MINED = ['proposed', 'checkpointed', 'proven', 'finalized']
  const NOT_MINED = ['dropped', 'pending']

  for (const status of MINED) {
    it(`${status} + success -> executed`, () => {
      expect(classifyL2Execution({ status, executionResult: 'success' })).toBe('executed')
    })
    it(`${status} + reverted -> reverted`, () => {
      expect(classifyL2Execution({ status, executionResult: 'reverted' })).toBe('reverted')
    })
    it(`${status} with no executionResult -> unknown, never a guess`, () => {
      expect(classifyL2Execution({ status })).toBe('unknown')
    })
  }

  for (const status of NOT_MINED) {
    it(`${status} -> unknown even if an executionResult is somehow present`, () => {
      expect(classifyL2Execution({ status })).toBe('unknown')
      expect(classifyL2Execution({ status, executionResult: 'success' })).toBe('unknown')
    })
  }

  it('a missing receipt is unknown, not a failure', () => {
    expect(classifyL2Execution(undefined)).toBe('unknown')
    expect(classifyL2Execution(null)).toBe('unknown')
  })

  it('never reports executed for an unrecognised executionResult', () => {
    expect(classifyL2Execution({ status: 'proven', executionResult: 'weird' })).toBe('reverted')
  })
})

describe('FUEL_CLAIM_MESSAGE_GONE_ERROR', () => {
  it('is not read as a completed deposit by resume', () => {
    expect(isAlreadyConsumedError(FUEL_CLAIM_MESSAGE_GONE_ERROR)).toBe(false)
  })

  it('still matches the UI needle that suppresses Resume', () => {
    expect(FUEL_CLAIM_MESSAGE_GONE_ERROR.toLowerCase()).toContain('was consumed')
  })
})
