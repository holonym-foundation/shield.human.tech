import { describe, expect, it } from 'vitest'
import { humanizeError } from './index'

describe('humanizeError', () => {
  it.each([
    'Error 400 {"code":-32601,"message":"method is not available"}',
    'HTTP request failed. Status: 429',
    'Too Many Requests',
    'Failed to load the balance - Temporary internal error',
    'the method node_getL1ContractAddresses does not exist/is not available',
  ])('maps RPC throttling to a busy message without the raw payload: %s', (raw) => {
    const msg = humanizeError(new Error(raw))
    expect(msg).toBe('The Aztec network is busy. Please try again in a moment.')
    expect(msg).not.toContain('-32601')
  })

  it('does not treat an unrelated number containing 429 as throttling', () => {
    expect(humanizeError(new Error('block 14290000 reverted'))).not.toMatch(/busy/)
  })

  it('still maps an unreachable node to the unavailable message', () => {
    expect(humanizeError(new Error('fetch failed'))).toMatch(/temporarily unavailable/)
  })

  it('never returns the raw string for an unknown error', () => {
    expect(humanizeError(new Error('Auth Error: Authentication failed: Invalid signature'))).toBe(
      'Something went wrong. Please try again in a moment.',
    )
  })
})
