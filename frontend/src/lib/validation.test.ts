import { describe, expect, it } from 'vitest'

import {
  AuthenticateSchema,
  getClientIp,
  MAX_CIPHERTEXT_LENGTH,
  MAX_CLIENT_IP_LENGTH,
  MAX_SIBLING_PATH_ENTRIES,
  PassportAttestationSchema,
  PochAttestationSchema,
  sanitizeBoolean,
  sanitizeCiphertext,
  sanitizeEthAddress,
  sanitizeHexString,
  sanitizeInt,
  sanitizeNodeInfo,
  sanitizeNumericString,
  sanitizeSiblingPath,
  sanitizeString,
  sanitizeTxHash,
  sanitizeUrl,
} from './validation'

const ETH_ADDRESS = '0x' + 'aB'.repeat(20)
const AZTEC_ADDRESS = '0x' + '1f'.repeat(32)

describe('sanitizeString', () => {
  it('trims and truncates', () => {
    expect(sanitizeString('  hello  ')).toBe('hello')
    expect(sanitizeString('abcdef', 3)).toBe('abc')
  })

  it('rejects non-strings and blank input', () => {
    for (const value of [null, undefined, 42, {}, [], '', '   ']) {
      expect(sanitizeString(value)).toBeUndefined()
    }
  })
})

describe('sanitizeEthAddress', () => {
  it('lowercases a valid address', () => {
    expect(sanitizeEthAddress(ETH_ADDRESS)).toBe(ETH_ADDRESS.toLowerCase())
  })

  it('rejects anything that is not exactly 20 hex bytes', () => {
    for (const value of [
      ETH_ADDRESS.slice(0, -1),
      ETH_ADDRESS + 'a',
      ETH_ADDRESS.replace('0x', ''),
      '0x' + 'zz'.repeat(20),
      AZTEC_ADDRESS,
    ]) {
      expect(sanitizeEthAddress(value)).toBeUndefined()
    }
  })

  it('does not let a long input be truncated into a valid address', () => {
    // sanitizeString would cut this to 42 chars; the regex must still see the tail.
    expect(sanitizeEthAddress(ETH_ADDRESS + 'deadbeef')).toBeUndefined()
  })
})

describe('sanitizeTxHash and sanitizeHexString', () => {
  it('accepts a 32-byte hash and lowercases it', () => {
    expect(sanitizeTxHash(AZTEC_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe(AZTEC_ADDRESS)
  })

  it('rejects a hash of the wrong length', () => {
    expect(sanitizeTxHash(ETH_ADDRESS)).toBeUndefined()
  })

  it('requires the 0x prefix and at least one hex digit', () => {
    expect(sanitizeHexString('0x')).toBeUndefined()
    expect(sanitizeHexString('abcd')).toBeUndefined()
    expect(sanitizeHexString('0xAbCd')).toBe('0xabcd')
  })

  it('rejects an over-long hex string rather than returning a truncated prefix', () => {
    // A silently shortened Merkle sibling would produce a wrong-but-plausible proof.
    expect(sanitizeHexString('0x' + 'ab'.repeat(20), 10)).toBeUndefined()
  })
})

describe('sanitizeNumericString', () => {
  it('accepts a plain non-negative integer', () => {
    expect(sanitizeNumericString('0')).toBe('0')
    expect(sanitizeNumericString('1'.repeat(78))).toBe('1'.repeat(78))
  })

  it('rejects signs, decimals, exponents and hex', () => {
    for (const value of ['-1', '1.5', '1e9', '0x10', ' 1 2 ']) {
      expect(sanitizeNumericString(value)).toBeUndefined()
    }
  })

  it('rejects a number wider than uint256 instead of clipping its digits', () => {
    expect(sanitizeNumericString('9'.repeat(79))).toBeUndefined()
  })
})

describe('sanitizeUrl', () => {
  it('accepts a known explorer over https', () => {
    expect(sanitizeUrl('https://sepolia.etherscan.io/tx/0xabc')).toBe('https://sepolia.etherscan.io/tx/0xabc')
  })

  it('rejects non-https and unknown hosts', () => {
    for (const value of [
      'http://etherscan.io/tx/0xabc',
      'https://evil.example/tx/0xabc',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect(sanitizeUrl(value)).toBeUndefined()
    }
  })

  it('is not fooled by an allowed prefix appearing inside another host', () => {
    expect(sanitizeUrl('https://evil.example/?x=https://etherscan.io/')).toBeUndefined()
  })
})

describe('sanitizeInt', () => {
  it('accepts an integer inside the range', () => {
    expect(sanitizeInt(5)).toBe(5)
    expect(sanitizeInt('5')).toBe(5)
  })

  it('rejects fractions, NaN, Infinity and out-of-range values', () => {
    for (const value of [1.5, NaN, Infinity, -1, 1001, 'abc']) {
      expect(sanitizeInt(value)).toBeUndefined()
    }
  })
})

describe('sanitizeBoolean', () => {
  it('only accepts real booleans, never truthy strings', () => {
    expect(sanitizeBoolean(true)).toBe(true)
    expect(sanitizeBoolean(false)).toBe(false)
    expect(sanitizeBoolean('true')).toBeUndefined()
    expect(sanitizeBoolean(1)).toBeUndefined()
  })
})

describe('sanitizeCiphertext', () => {
  it('rejects rather than truncates an oversized payload', () => {
    // Truncating would silently destroy the AES-GCM tag and make the data unrecoverable.
    expect(sanitizeCiphertext('a'.repeat(MAX_CIPHERTEXT_LENGTH + 1))).toBeUndefined()
    expect(sanitizeCiphertext('a'.repeat(MAX_CIPHERTEXT_LENGTH))).toHaveLength(MAX_CIPHERTEXT_LENGTH)
  })
})

describe('sanitizeNodeInfo', () => {
  it('flattens a custom prototype and drops functions', () => {
    class Node {
      constructor(public url: string) {}
      exfiltrate() {}
    }

    const result = sanitizeNodeInfo(new Node('https://node.example'))

    expect(result).toEqual({ url: 'https://node.example' })
    expect(Object.getPrototypeOf(result!)).toBe(Object.prototype)
  })

  it('carries a __proto__ key through as inert data, never onto Object.prototype', () => {
    // JSON.parse makes `__proto__` an own property, so the round-trip keeps it
    // rather than stripping it — harmless here because nothing deep-merges the
    // result, but a caller that does would be the place to re-check.
    const result = sanitizeNodeInfo(JSON.parse('{"a":1,"__proto__":{"polluted":true}}'))

    expect(result!.a).toBe(1)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects arrays, primitives and unserializable objects', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const value of [[1, 2], 'x', 42, null, cyclic]) {
      expect(sanitizeNodeInfo(value)).toBeUndefined()
    }
  })
})

describe('sanitizeSiblingPath', () => {
  it('lowercases every entry of a valid path', () => {
    expect(sanitizeSiblingPath(['0xAA', '0xbb'])).toEqual(['0xaa', '0xbb'])
  })

  it('rejects the whole path when a single entry is not hex', () => {
    // A partially-sanitized Merkle path would produce a silently wrong proof.
    expect(sanitizeSiblingPath(['0xaa', 'nope'])).toBeUndefined()
  })

  it('rejects a path longer than the tree can be', () => {
    expect(sanitizeSiblingPath(Array(MAX_SIBLING_PATH_ENTRIES + 1).fill('0xaa'))).toBeUndefined()
  })

  it('rejects a non-array', () => {
    expect(sanitizeSiblingPath('0xaa')).toBeUndefined()
  })
})

describe('AuthenticateSchema', () => {
  it('accepts a normal SIWE payload', () => {
    expect(AuthenticateSchema.safeParse({ message: 'siwe', signature: '0xsig' }).success).toBe(true)
  })

  it('bounds message and signature so the verifier cannot be flooded', () => {
    expect(AuthenticateSchema.safeParse({ message: 'a'.repeat(2049), signature: '0xsig' }).success).toBe(false)
    expect(AuthenticateSchema.safeParse({ message: 'siwe', signature: '0'.repeat(257) }).success).toBe(false)
  })

  it('rejects an empty message or signature', () => {
    expect(AuthenticateSchema.safeParse({ message: '', signature: '0xsig' }).success).toBe(false)
    expect(AuthenticateSchema.safeParse({ message: 'siwe', signature: '' }).success).toBe(false)
  })
})

describe('PassportAttestationSchema', () => {
  it('requires a portalAddress so the signature cannot be replayed to another portal', () => {
    expect(PassportAttestationSchema.safeParse({}).success).toBe(false)
    expect(PassportAttestationSchema.safeParse({ portalAddress: 'not-an-address' }).success).toBe(false)
  })

  it('accepts the minimal body the SDK sends', () => {
    const parsed = PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.isPrivate).toBe(false)
  })

  it('keeps direction optional, so the route must not rely on it to gate the cap', () => {
    // Omitting `direction` once bypassed the deposit cap; the schema still allows
    // the omission, so the enforcement has to live server-side in the route.
    const parsed = PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS })

    expect(parsed.success && parsed.data.direction).toBeUndefined()
  })

  it('rejects a direction outside the bridge enum', () => {
    expect(
      PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS, direction: 'L1_TO_L1' }).success,
    ).toBe(false)
  })

  it('rejects a non-numeric or oversized amount', () => {
    expect(PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS, amount: '1.5' }).success).toBe(false)
    expect(
      PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS, amount: '9'.repeat(79) }).success,
    ).toBe(false)
  })

  it('rejects a bridgeAddress that is not an Aztec address', () => {
    expect(
      PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS, bridgeAddress: ETH_ADDRESS }).success,
    ).toBe(false)
    expect(
      PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS, bridgeAddress: AZTEC_ADDRESS }).success,
    ).toBe(true)
  })

  it('rejects a negative deadline', () => {
    expect(PassportAttestationSchema.safeParse({ portalAddress: ETH_ADDRESS, deadline: -1 }).success).toBe(false)
  })
})

describe('PochAttestationSchema', () => {
  it('accepts an empty body, since the route reads its addresses from the JWT', () => {
    const parsed = PochAttestationSchema.safeParse({})

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.isPrivate).toBe(false)
  })

  it('still rejects wrong-typed fields', () => {
    expect(PochAttestationSchema.safeParse({ isPrivate: 'yes' }).success).toBe(false)
    expect(PochAttestationSchema.safeParse({ tokenDecimals: 37 }).success).toBe(false)
  })
})

describe('getClientIp', () => {
  // The caller controls what it puts in `x-forwarded-for`, so which end of the
  // list is read decides whether the rate limit and the audit trail mean anything.
  const h = (init: Record<string, string>) => new Headers(init)

  it('does not let a forged leading entry become the caller identity', () => {
    // The proxy appends the real peer, so the caller's own value stays on the left.
    expect(getClientIp(h({ 'x-forwarded-for': '10.0.0.1, 203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('treats a single-entry list as the peer itself', () => {
    expect(getClientIp(h({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('does not make spacing part of the identity', () => {
    expect(getClientIp(h({ 'x-forwarded-for': '10.0.0.1,203.0.113.7  ' }))).toBe('203.0.113.7')
  })

  it('uses x-real-ip only when no list was set', () => {
    expect(getClientIp(h({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4')
    expect(getClientIp(h({ 'x-forwarded-for': '203.0.113.7', 'x-real-ip': '198.51.100.4' }))).toBe(
      '203.0.113.7',
    )
  })

  it('drops an oversized value rather than storing it', () => {
    expect(getClientIp(h({ 'x-forwarded-for': 'a'.repeat(MAX_CLIENT_IP_LENGTH + 1) }))).toBeUndefined()
  })

  it('accepts an IPv6 address at the length limit', () => {
    const v6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334:255.255.255.255'.slice(0, MAX_CLIENT_IP_LENGTH)
    expect(getClientIp(h({ 'x-forwarded-for': v6 }))).toBe(v6)
  })

  it('yields no identity when no usable header is present', () => {
    expect(getClientIp(h({}))).toBeUndefined()
    expect(getClientIp(h({ 'x-forwarded-for': '   ' }))).toBeUndefined()
  })

  it('differs from the left-most read the old call sites used', () => {
    const forged = '10.0.0.1, 203.0.113.7'.split(',')[0]?.trim()
    expect(forged).toBe('10.0.0.1')
    expect(getClientIp(h({ 'x-forwarded-for': '10.0.0.1, 203.0.113.7' }))).not.toBe(forged)
  })
})
