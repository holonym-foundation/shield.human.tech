import { beforeEach, describe, expect, it, vi } from 'vitest'

const { env } = vi.hoisted(() => ({
  env: { AUTH_EXPECTED_DOMAIN: '', AZTEC_ENV: 'testnet' as 'devnet' | 'testnet' | 'mainnet' },
}))

// Only AUTH_EXPECTED_DOMAIN is under test. Spread the real module for the rest:
// domainAllowlist now resolves the deployment's own network, so its module graph
// pulls in `@/config`, which reads a dozen other env exports at import time — a
// hand-listed mock would break again the next time one is added.
vi.mock('@/config/env.config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config/env.config')>()),
  get AUTH_EXPECTED_DOMAIN() {
    return env.AUTH_EXPECTED_DOMAIN
  },
}))

// The allowlist is keyed off the network the deployment serves, so which network
// that is has to be steerable from a test — otherwise the cross-environment case
// below can only ever be asserted in one direction.
vi.mock('@/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/config')>()),
  get AZTEC_ENV() {
    return env.AZTEC_ENV
  },
}))

import { getAllowedAppHosts, getAllowedAppOrigins, isAllowedAppOrigin, normalizeAppOrigin } from './domainAllowlist'

const MAINNET_HOST = 'shield.human.tech'
const TESTNET_HOST = 'testnet.shield.human.tech'

beforeEach(() => {
  env.AUTH_EXPECTED_DOMAIN = ''
  env.AZTEC_ENV = 'testnet'
})

describe('getAllowedAppHosts', () => {
  it('pins the host to the network this deployment serves', () => {
    expect(getAllowedAppHosts()).toEqual(new Set([TESTNET_HOST]))

    env.AZTEC_ENV = 'mainnet'
    expect(getAllowedAppHosts()).toEqual(new Set([MAINNET_HOST]))
  })

  it('serves devnet under the testnet host rather than inventing a third one', () => {
    env.AZTEC_ENV = 'devnet'

    expect(getAllowedAppHosts()).toEqual(new Set([TESTNET_HOST]))
  })

  it('adds every configured domain, stripping scheme and trailing slash', () => {
    env.AUTH_EXPECTED_DOMAIN = 'https://preview.shield.human.tech/, localhost:3000'

    expect(getAllowedAppHosts()).toContain('preview.shield.human.tech')
    expect(getAllowedAppHosts()).toContain('localhost:3000')
  })

  it('ignores empty segments from a trailing or doubled comma', () => {
    env.AUTH_EXPECTED_DOMAIN = 'a.example,, '

    expect(getAllowedAppHosts()).toEqual(new Set([TESTNET_HOST, 'a.example']))
  })
})

describe('isAllowedAppOrigin', () => {
  it('accepts an allowed origin with or without a trailing slash', () => {
    expect(isAllowedAppOrigin(`https://${TESTNET_HOST}`)).toBe(true)
    expect(isAllowedAppOrigin(`https://${TESTNET_HOST}/`)).toBe(true)
  })

  it('does not honour the other environment’s domain in either direction', () => {
    // A signed domain is all the user sees before approving a wallet signature,
    // so it has to denote exactly one environment. If both hosts were always
    // allowed, a signature approved on testnet would replay against mainnet.
    expect(isAllowedAppOrigin(`https://${MAINNET_HOST}`)).toBe(false)

    env.AZTEC_ENV = 'mainnet'
    expect(isAllowedAppOrigin(`https://${MAINNET_HOST}`)).toBe(true)
    expect(isAllowedAppOrigin(`https://${TESTNET_HOST}`)).toBe(false)
  })

  it('rejects http, a subdomain, and a lookalike host', () => {
    for (const origin of [
      'http://shield.human.tech',
      'https://evil.shield.human.tech',
      'https://shield.human.tech.evil.example',
      'https://shieldhuman.tech',
    ]) {
      expect(isAllowedAppOrigin(origin)).toBe(false)
    }
  })

  it('rejects an origin carrying a path, so a match cannot be smuggled in one', () => {
    expect(isAllowedAppOrigin('https://evil.example/https://shield.human.tech')).toBe(false)
  })

  it('always derives origins over https, even for a plain-host config entry', () => {
    env.AUTH_EXPECTED_DOMAIN = 'preview.shield.human.tech'

    expect(getAllowedAppOrigins()).toContain('https://preview.shield.human.tech')
    expect(isAllowedAppOrigin('http://preview.shield.human.tech')).toBe(false)
  })
})

describe('normalizeAppOrigin', () => {
  it('drops trailing slashes only', () => {
    expect(normalizeAppOrigin('https://shield.human.tech///')).toBe('https://shield.human.tech')
    expect(normalizeAppOrigin('https://shield.human.tech')).toBe('https://shield.human.tech')
  })
})
