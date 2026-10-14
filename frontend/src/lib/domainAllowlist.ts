import { AUTH_EXPECTED_DOMAIN } from '@/config/env.config'
import { AZTEC_ENV, type AztecEnv } from '@/config'

/**
 * The host this deployment identifies as, keyed off the network it actually
 * serves. A signed domain is the only thing a user sees before approving a
 * wallet signature, so it has to denote exactly one environment: a mainnet
 * build must never honour a signature the user approved for testnet.
 */
const ENV_HOST: Record<AztecEnv, string> = {
  mainnet: 'shield.human.tech',
  testnet: 'testnet.shield.human.tech',
  devnet: 'testnet.shield.human.tech',
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, '')
}

export function getAllowedAppHosts(): Set<string> {
  const hosts = new Set([ENV_HOST[AZTEC_ENV]])
  for (const part of AUTH_EXPECTED_DOMAIN.split(',')) {
    const host = normalizeHost(part)
    if (host) hosts.add(host)
  }
  return hosts
}

export function getAllowedAppOrigins(): Set<string> {
  return new Set(Array.from(getAllowedAppHosts(), (host) => `https://${host}`))
}

export function isAllowedAppOrigin(origin: string): boolean {
  return getAllowedAppOrigins().has(normalizeOrigin(origin))
}

export function normalizeAppOrigin(origin: string): string {
  return normalizeOrigin(origin)
}

/**
 * Whether a host or origin is a local development address, outside production
 * only. Matches the parsed hostname exactly — a prefix test would accept
 * `localhost.attacker.example`, and the port varies between dev servers.
 */
export function isLocalDevHost(hostOrOrigin: string): boolean {
  if (process.env.NODE_ENV === 'production') return false
  try {
    const { hostname } = new URL(`https://${normalizeHost(hostOrOrigin)}`)
    return hostname === 'localhost' || hostname === '127.0.0.1'
  } catch {
    return false
  }
}
