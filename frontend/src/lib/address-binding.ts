import { prisma } from './prisma'

/**
 * Enforce 1:1 binding between L1 and L2 addresses.
 * Creates the binding on first use; rejects if either address is already bound elsewhere.
 * Returns an error string if binding is violated, null if OK.
 */
export async function enforceAddressBinding(l1Address: string, l2Address: string): Promise<string | null> {
  const existing = await prisma.addressBinding.findFirst({
    where: {
      OR: [
        { l1Address },
        { l2Address },
      ],
    },
  })

  if (!existing) {
    await prisma.addressBinding.create({
      data: { l1Address, l2Address },
    })
    return null
  }

  if (existing.l1Address === l1Address && existing.l2Address === l2Address) {
    return null
  }

  if (existing.l1Address === l1Address) {
    return `L1 address ${l1Address} is already bound to a different L2 address`
  }

  return `L2 address ${l2Address} is already bound to a different L1 address`
}

/**
 * Get the next nonce for a user+attestation type, incrementing atomically.
 * Nonces start at 1 and increase by 1 on each call.
 */
export async function getNextNonce(l1Address: string, type: 'poch' | 'passport'): Promise<number> {
  const record = await prisma.attestationNonce.upsert({
    where: { l1Address_type: { l1Address, type } },
    create: { l1Address, type, nonce: 1 },
    update: { nonce: { increment: 1 } },
  })
  return record.nonce
}
