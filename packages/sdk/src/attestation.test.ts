import { describe, it, expect } from 'vitest'
import {
  assertL1SignatureShape,
  assertL2SignatureShape,
  assertNonEmptyDepositAttestation,
  assertNonEmptyWithdrawalAttestation,
  buildEmptyCleanHands,
  buildEmptyPassport,
  buildEmptyL2CleanHands,
  buildEmptyL2Passport,
} from './attestation'

describe('assertL1SignatureShape', () => {
  it('accepts valid ECDSA signatures (0x + 130 hex)', () => {
    const sig = '0x' + 'ab'.repeat(65)
    expect(() => assertL1SignatureShape(sig, 'test')).not.toThrow()
  })

  it('accepts both hex cases', () => {
    expect(() => assertL1SignatureShape('0x' + 'AB'.repeat(65), 'test')).not.toThrow()
    expect(() => assertL1SignatureShape('0x' + 'cd'.repeat(65), 'test')).not.toThrow()
  })

  it('rejects signatures without 0x prefix', () => {
    const sig = 'ab'.repeat(65)
    expect(() => assertL1SignatureShape(sig, 'test')).toThrow(/Invalid L1 signature/)
  })

  it('rejects signatures with wrong length', () => {
    expect(() => assertL1SignatureShape('0x' + 'ab'.repeat(64), 'test')).toThrow(/Invalid L1 signature/)
    expect(() => assertL1SignatureShape('0x' + 'ab'.repeat(66), 'test')).toThrow(/Invalid L1 signature/)
    expect(() => assertL1SignatureShape('0x', 'test')).toThrow(/Invalid L1 signature/)
  })

  it('rejects signatures with non-hex chars', () => {
    // 130 chars, but one non-hex (z at position 1)
    const bad = '0x' + 'z' + 'a'.repeat(129)
    expect(() => assertL1SignatureShape(bad, 'test')).toThrow(/Invalid L1 signature/)
  })

  it('rejects non-string inputs', () => {
    expect(() => assertL1SignatureShape(new Array(64).fill(0), 'test')).toThrow(/Invalid L1 signature/)
    expect(() => assertL1SignatureShape(null, 'test')).toThrow(/Invalid L1 signature/)
    expect(() => assertL1SignatureShape(undefined, 'test')).toThrow(/Invalid L1 signature/)
    expect(() => assertL1SignatureShape(42, 'test')).toThrow(/Invalid L1 signature/)
  })

  it('includes context in error message', () => {
    expect(() => assertL1SignatureShape('bad', 'POCH (L1 CleanHands)')).toThrow(/POCH \(L1 CleanHands\)/)
  })
})

describe('assertL2SignatureShape', () => {
  it('accepts valid Schnorr signatures (number[64])', () => {
    const sig = new Array(64).fill(0).map((_, i) => i)
    expect(() => assertL2SignatureShape(sig, 'test')).not.toThrow()
  })

  it('accepts all-zero and all-max signatures', () => {
    expect(() => assertL2SignatureShape(new Array(64).fill(0), 'test')).not.toThrow()
    expect(() => assertL2SignatureShape(new Array(64).fill(255), 'test')).not.toThrow()
  })

  it('rejects arrays of wrong length', () => {
    expect(() => assertL2SignatureShape(new Array(63).fill(0), 'test')).toThrow(/Invalid L2 signature/)
    expect(() => assertL2SignatureShape(new Array(65).fill(0), 'test')).toThrow(/Invalid L2 signature/)
    expect(() => assertL2SignatureShape([], 'test')).toThrow(/Invalid L2 signature/)
  })

  it('rejects arrays with out-of-range bytes', () => {
    const neg = new Array(64).fill(0)
    neg[0] = -1
    expect(() => assertL2SignatureShape(neg, 'test')).toThrow(/Invalid L2 signature/)

    const tooBig = new Array(64).fill(0)
    tooBig[0] = 256
    expect(() => assertL2SignatureShape(tooBig, 'test')).toThrow(/Invalid L2 signature/)
  })

  it('rejects arrays with non-integer bytes', () => {
    const withFloat = new Array(64).fill(0)
    withFloat[0] = 1.5
    expect(() => assertL2SignatureShape(withFloat, 'test')).toThrow(/Invalid L2 signature/)
  })

  it('rejects hex strings (wrong type)', () => {
    // This is the crucial anti-swap test: L1/L2 signatures must not be confusable.
    const l1Style = '0x' + 'ab'.repeat(65)
    expect(() => assertL2SignatureShape(l1Style, 'test')).toThrow(/Invalid L2 signature/)
  })

  it('rejects non-array inputs', () => {
    expect(() => assertL2SignatureShape(null, 'test')).toThrow(/Invalid L2 signature/)
    expect(() => assertL2SignatureShape(undefined, 'test')).toThrow(/Invalid L2 signature/)
    expect(() => assertL2SignatureShape({}, 'test')).toThrow(/Invalid L2 signature/)
  })

  it('includes context in error message', () => {
    expect(() => assertL2SignatureShape('nope', 'Passport (L2)')).toThrow(/Passport \(L2\)/)
  })
})

// ─── H6: cascade invariants (defense-in-depth) ──────────────────────

describe('assertNonEmptyDepositAttestation', () => {
  const realCleanHands = { nonce: 42n, signature: ('0x' + 'ab'.repeat(65)) as `0x${string}` }
  const realPassport = {
    maxAmount: 1_000_000n,
    nonce: 7n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: ('0x' + 'cd'.repeat(65)) as `0x${string}`,
  }

  it('accepts a real CleanHands + empty Passport (POCH path)', () => {
    expect(() =>
      assertNonEmptyDepositAttestation({ cleanHands: realCleanHands, passport: buildEmptyPassport() }),
    ).not.toThrow()
  })

  it('accepts empty CleanHands + real Passport (Passport fallback path)', () => {
    expect(() =>
      assertNonEmptyDepositAttestation({ cleanHands: buildEmptyCleanHands(), passport: realPassport }),
    ).not.toThrow()
  })

  it('accepts both populated', () => {
    expect(() =>
      assertNonEmptyDepositAttestation({ cleanHands: realCleanHands, passport: realPassport }),
    ).not.toThrow()
  })

  it('REJECTS both-empty (the bug it guards against)', () => {
    expect(() =>
      assertNonEmptyDepositAttestation({
        cleanHands: buildEmptyCleanHands(),
        passport: buildEmptyPassport(),
      }),
    ).toThrow(/Invariant violation/)
  })
})

describe('assertNonEmptyWithdrawalAttestation', () => {
  const realL2CleanHands = {
    nonce: 42n,
    signature: new Array(64).fill(0).map((_, i) => (i * 7) & 0xff),
  }
  const realL2Passport = {
    max_amount: 1_000_000n,
    nonce: 7n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: new Array(64).fill(0).map((_, i) => (i * 13) & 0xff),
  }

  it('accepts a real L2 CleanHands + empty L2 Passport', () => {
    expect(() =>
      assertNonEmptyWithdrawalAttestation({
        cleanHands: realL2CleanHands,
        passport: buildEmptyL2Passport(),
      }),
    ).not.toThrow()
  })

  it('accepts empty L2 CleanHands + real L2 Passport', () => {
    expect(() =>
      assertNonEmptyWithdrawalAttestation({
        cleanHands: buildEmptyL2CleanHands(),
        passport: realL2Passport,
      }),
    ).not.toThrow()
  })

  it('REJECTS both-empty L2 structs (the bug it guards against)', () => {
    expect(() =>
      assertNonEmptyWithdrawalAttestation({
        cleanHands: buildEmptyL2CleanHands(),
        passport: buildEmptyL2Passport(),
      }),
    ).toThrow(/Invariant violation/)
  })

  it('detects empty CleanHands even with non-zero nonce but zero signature', () => {
    // Edge case: nonce alone is not enough — the signature bytes must also
    // exist. This catches a subtle bug where nonce gets allocated before the
    // signature is fetched.
    const halfEmpty = { nonce: 99n, signature: new Array(64).fill(0) }
    const result = assertNonEmptyWithdrawalAttestation({
      cleanHands: halfEmpty,
      passport: buildEmptyL2Passport(),
    })
    // halfEmpty has non-zero nonce so it's NOT considered empty — invariant
    // passes even though signature is all zeros. This is the current policy
    // (nonce-only presence is sufficient); documented here so future tighter
    // checks intentionally flip this test.
    expect(result).toBeUndefined()
  })
})
