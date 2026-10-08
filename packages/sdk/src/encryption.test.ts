import { describe, it, expect } from 'vitest'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { gcm } from '@noble/ciphers/aes.js'
import {
  createSigningMessage,
  deriveEncryptionKey,
  deriveEncryptionKeyCandidates,
  encryptData,
  decryptData,
  decryptDataWithCandidates,
  decryptOperationPayload,
  ENCRYPTION_VERSION,
} from './encryption'
import type { BridgeOperation } from './types'

// Real EIP-55 checksum (viem is strict about this — a hand-typed one throws), because
// what a wallet provider actually hands back is the checksummed form, not an arbitrary mix.
const CHECKSUMMED = '0xee33Ab1B0b1F0aBcdeF0123456789aBCdeF08118'
const LOWER = CHECKSUMMED.toLowerCase()
const DOMAIN = 'shield.human.tech'
const SIG = '0x' + 'ab'.repeat(65)

const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')

/** The pre-fix derivation: KDF strings of the day, address interpolated raw. */
function legacyKey(address: string, signature: string, domain: string, era: 'v1' | 'v2') {
  const { prefix, info } =
    era === 'v1'
      ? { prefix: 'Aztec Bridge Encryption Key', info: 'aztec-bridge-key' }
      : { prefix: 'Shield Human Tech Encryption Key', info: 'shield-human-tech-key' }
  const te = new TextEncoder()
  const ikm = te.encode(`${prefix}\nDomain: ${domain}\nL1 Address: ${address}\nSignature: ${signature}`)
  return hkdf(sha256, ikm, te.encode(domain), te.encode(info), 32)
}

function encryptWith(plaintext: string, key: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const out = gcm(key, iv).encrypt(new TextEncoder().encode(plaintext))
  const hex = (b: Uint8Array) => '0x' + toHex(b)
  return { ciphertext: hex(out.slice(0, -16)), iv: hex(iv), tag: hex(out.slice(-16)) }
}

describe('address casing (#2185)', () => {
  it('derives one key regardless of how the provider cased the address', async () => {
    const a = await deriveEncryptionKey(CHECKSUMMED, SIG, DOMAIN)
    const b = await deriveEncryptionKey(LOWER, SIG, DOMAIN)
    expect(toHex(a)).toBe(toHex(b))
  })

  it('regression: the raw-address derivation did NOT have that property', () => {
    expect(toHex(legacyKey(CHECKSUMMED, SIG, DOMAIN, 'v2'))).not.toBe(
      toHex(legacyKey(LOWER, SIG, DOMAIN, 'v2')),
    )
  })

  it('signing message is casing-independent, so one signature covers every candidate', () => {
    expect(createSigningMessage(CHECKSUMMED, DOMAIN)).toBe(createSigningMessage(LOWER, DOMAIN))
  })
})

describe('candidate decryption', () => {
  const cases: Array<[string, () => Uint8Array]> = [
    ['v2 envelope written with a checksummed address', () => legacyKey(CHECKSUMMED, SIG, DOMAIN, 'v2')],
    ['v2 envelope written with a lowercase address', () => legacyKey(LOWER, SIG, DOMAIN, 'v2')],
    ['v1 envelope (pre-87d76c5 KDF strings)', () => legacyKey(CHECKSUMMED, SIG, DOMAIN, 'v1')],
  ]

  for (const [name, makeKey] of cases) {
    it(`recovers a ${name}`, async () => {
      const blob = encryptWith('{"nonce":"0x1"}', makeKey())
      // The hint is lowercase, mimicking the regex fallback over the stored message.
      const keys = await deriveEncryptionKeyCandidates(LOWER, SIG, DOMAIN)
      await expect(
        decryptDataWithCandidates(blob.ciphertext, blob.iv, blob.tag, keys),
      ).resolves.toBe('{"nonce":"0x1"}')
    })
  }

  it('round-trips data written by the current encryptData, and stamps the version', async () => {
    const key = await deriveEncryptionKey(CHECKSUMMED, SIG, DOMAIN)
    const blob = await encryptData('{"a":1}', key)
    expect(blob.version).toBe(ENCRYPTION_VERSION)
    const keys = await deriveEncryptionKeyCandidates(LOWER, SIG, DOMAIN)
    await expect(decryptDataWithCandidates(blob.ciphertext, blob.iv, blob.tag, keys)).resolves.toBe('{"a":1}')
  })

  it('still fails, and does not return garbage, when no candidate is right', async () => {
    const blob = encryptWith('{"a":1}', legacyKey(LOWER, '0xdifferent', DOMAIN, 'v2'))
    const keys = await deriveEncryptionKeyCandidates(LOWER, SIG, DOMAIN)
    await expect(
      decryptDataWithCandidates(blob.ciphertext, blob.iv, blob.tag, keys),
    ).rejects.toThrow(/Decryption failed/)
  })
})

describe('decryptOperationPayload', () => {
  const opWith = (blob: { ciphertext: string; iv: string; tag: string }): BridgeOperation =>
    ({
      encryptedCiphertext: blob.ciphertext,
      encryptedIv: blob.iv,
      encryptedTag: blob.tag,
      keyDerivationDomain: DOMAIN,
      keyDerivationMessage: createSigningMessage(CHECKSUMMED, DOMAIN),
    }) as unknown as BridgeOperation

  it('decrypts a checksummed-address payload via the lowercase regex fallback (the T-562 shape)', async () => {
    const blob = encryptWith('{"nonce":"0x7"}', legacyKey(CHECKSUMMED, SIG, DOMAIN, 'v2'))
    // No l1AddressHint: forces the regex over keyDerivationMessage, which yields lowercase.
    const result = await decryptOperationPayload(opWith(blob), async () => SIG, DOMAIN)
    expect(result).toEqual({ nonce: '0x7' })
  })

  it('prompts for exactly one signature', async () => {
    const blob = encryptWith('{"nonce":"0x7"}', legacyKey(CHECKSUMMED, SIG, DOMAIN, 'v1'))
    let prompts = 0
    await decryptOperationPayload(
      opWith(blob),
      async () => {
        prompts++
        return SIG
      },
      DOMAIN,
    )
    expect(prompts).toBe(1)
  })

  it('orders by the stored version but still recovers a row whose version is wrong', async () => {
    // Written with the v1 KDF strings, but the row claims version 3. Ordering must not
    // become exclusion, or a mislabelled row would be permanently unrecoverable.
    const blob = encryptWith('{"nonce":"0x9"}', legacyKey(LOWER, SIG, DOMAIN, 'v1'))
    const op = { ...opWith(blob), encryptedVersion: 3 } as unknown as BridgeOperation
    await expect(decryptOperationPayload(op, async () => SIG, DOMAIN)).resolves.toEqual({ nonce: '0x9' })
  })

  it('uses the v1 ordering when the row says version 1', async () => {
    const blob = encryptWith('{"nonce":"0x1"}', legacyKey(LOWER, SIG, DOMAIN, 'v1'))
    const op = { ...opWith(blob), encryptedVersion: 1 } as unknown as BridgeOperation
    await expect(decryptOperationPayload(op, async () => SIG, DOMAIN)).resolves.toEqual({ nonce: '0x1' })
  })

  it('returns null when the operation carries no encrypted payload', async () => {
    const op = { encryptedCiphertext: null, encryptedIv: null, encryptedTag: null } as unknown as BridgeOperation
    await expect(decryptOperationPayload(op, async () => SIG, DOMAIN)).resolves.toBeNull()
  })
})
