import { PrismaClient } from '@prisma/client'

/**
 * A second client, separate from `src/lib/prisma`'s singleton, so a test can
 * seed and inspect rows without going through the handlers it is exercising.
 * Both point at the same DATABASE_URL.
 */
export const db = new PrismaClient()

/** Wipe every table between tests. Order matters: BridgeActivity FKs to User. */
export async function resetDb() {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE bridge_activities, attestation_reservations, address_bindings, auth_nonces, users RESTART IDENTITY CASCADE',
  )
}

let holdSeq = 0

/**
 * Record a charge the way the compliance caps actually see one: a hold the
 * server signed, past its deposit window. Deposit rows are client-authored and
 * are not counted — the hold ledger is the whole of the accounting.
 */
export async function settleHold(
  user: { userId: string },
  usd: number,
  extra: { method?: string; createdAt?: Date } = {},
) {
  const createdAt = extra.createdAt ?? new Date(Date.now() - 60_000)
  return db.attestationReservation.create({
    data: {
      fkUserId: user.userId,
      nonce: String(++holdSeq),
      amountUsd: usd,
      method: extra.method ?? 'passport',
      // Past its window, so the charge is committed until the on-chain resolver
      // proves the nonce was never used.
      expiresAt: new Date(createdAt.getTime() + 1_000),
      createdAt,
    },
  })
}

/** A hold still inside its signed window: the deposit may yet land or be abandoned. */
export async function liveHold(user: { userId: string }, usd: number, extra: { method?: string } = {}) {
  return db.attestationReservation.create({
    data: {
      fkUserId: user.userId,
      nonce: String(++holdSeq),
      amountUsd: usd,
      method: extra.method ?? 'passport',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  })
}

/** Record a settled L1→L2 deposit, the way the bridge flow does once it confirms. */
export async function settleDeposit(
  user: { userId: string },
  usdc: number,
  extra: { attestationNonce?: string; createdAt?: Date; status?: string } = {},
) {
  return db.bridgeActivity.create({
    data: {
      fkUserId: user.userId,
      direction: 'L1_TO_L2',
      status: (extra.status ?? 'deposited') as any,
      encryptedCiphertext: 'x',
      encryptedIv: 'x',
      encryptedTag: 'x',
      keyDerivationMessage: 'x',
      keyDerivationDomain: 'x',
      amountL1: String(BigInt(Math.round(usdc * 1e6))),
      tokenDecimalsL1: 6,
      tokenSymbolL1: 'USDC',
      ...(extra.attestationNonce ? { attestationNonce: extra.attestationNonce } : {}),
      ...(extra.createdAt ? { createdAt: extra.createdAt } : {}),
    },
  })
}
