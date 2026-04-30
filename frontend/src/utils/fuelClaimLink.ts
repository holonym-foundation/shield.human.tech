/**
 * Encode/decode the third-party fuel-claim payload that the bridger hands to the recipient.
 *
 * The payload contains everything the recipient needs to mint their FeeJuice on L2:
 *   - recipient L2 address (encoded in the L1→L2 message; the recipient also reads this to verify
 *     the link matches the wallet they're connecting)
 *   - claim amount, claim secret (preimage), message leaf index
 *
 * Anyone holding the claim secret can submit the L2 claim transaction, but the FJ always mints to
 * the recipient address that was set at L1 deposit time. So the secret is bearer-token-style:
 * sharing the link in the wrong place lets a stranger spend gas to submit the claim, but they
 * cannot redirect the funds.
 *
 * Always pass the encoded payload via URL fragment (`#data=...`) so the secret never appears in
 * server logs or referrer headers.
 */

const PAYLOAD_VERSION = 1

export interface FuelClaimPayload {
  /** L2 address that will receive the FeeJuice (must match the wallet the recipient connects). */
  recipient: string
  /** FJ amount in smallest units (matches the L1→L2 message). */
  claimAmount: string
  /** Claim secret preimage as a hex Fr field — recipient supplies this to the L2 claim function. */
  claimSecret: string
  /** Leaf index of the L1→L2 message in the Aztec message tree. */
  messageLeafIndex: string
  /** Original fuel-message hash from the BridgeWithFuel L1 event — used for display + sanity-check only. */
  fuelMessageHash: string
  /** L1 transaction hash — display only. */
  l1TxHash?: string
  /** Schema version for forward compatibility. */
  v: number
}

function toBase64Url(input: string): string {
  if (typeof window === 'undefined') {
    return Buffer.from(input, 'utf-8').toString('base64url')
  }
  const b64 = btoa(unescape(encodeURIComponent(input)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
  if (typeof window === 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf-8')
  }
  return decodeURIComponent(escape(atob(padded)))
}

export function encodeFuelClaimPayload(
  data: Omit<FuelClaimPayload, 'v'>,
): string {
  const payload: FuelClaimPayload = { ...data, v: PAYLOAD_VERSION }
  return toBase64Url(JSON.stringify(payload))
}

export function decodeFuelClaimPayload(encoded: string): FuelClaimPayload {
  let raw: string
  try {
    raw = fromBase64Url(encoded)
  } catch {
    throw new Error('Claim link is malformed (could not decode)')
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Claim link is malformed (could not parse)')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Claim link payload has the wrong shape')
  }
  const required: (keyof FuelClaimPayload)[] = [
    'recipient',
    'claimAmount',
    'claimSecret',
    'messageLeafIndex',
    'fuelMessageHash',
  ]
  for (const key of required) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) {
      throw new Error(`Claim link is missing required field "${String(key)}"`)
    }
  }
  if (parsed.v !== PAYLOAD_VERSION) {
    throw new Error(
      `Claim link is from a different version (expected v${PAYLOAD_VERSION}, got v${parsed.v}). Update the bridge UI and try again.`,
    )
  }
  return parsed as FuelClaimPayload
}

export function buildFuelClaimUrl(origin: string, data: Omit<FuelClaimPayload, 'v'>): string {
  const trimmed = origin.replace(/\/+$/, '')
  return `${trimmed}/claim-fuel#data=${encodeFuelClaimPayload(data)}`
}

export function readFuelClaimDataFromHash(hash: string): FuelClaimPayload | null {
  if (!hash) return null
  const stripped = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(stripped)
  const data = params.get('data')
  if (!data) return null
  return decodeFuelClaimPayload(data)
}
