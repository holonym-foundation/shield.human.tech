import { BridgeDirection, BridgeOperationStatus } from '@prisma/client'
import { prisma } from './prisma'
import { getTokenPriceUsd } from '@/utils/fuelPricing'
import { getBridgeMaxDepositUsd } from './attestation'

// L1→L2 statuses where funds are locked on L1 (the deposit tx confirmed).
// Excludes 'pending' (operation row exists but no L1 deposit yet — this is the
// state of the in-flight deposit at attestation time, so excluding it avoids
// double-counting and prevents abandoned 'pending' rows from locking a user)
// and 'failed' (no funds moved).
const LOCKED_DEPOSIT_STATUSES: BridgeOperationStatus[] = [
  BridgeOperationStatus.deposited,
  BridgeOperationStatus.claimed,
  BridgeOperationStatus.submitted,
  BridgeOperationStatus.ready,
  BridgeOperationStatus.pending_finalize,
  BridgeOperationStatus.completed,
]

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
    try {
      await prisma.addressBinding.create({
        data: { l1Address, l2Address },
      })
    } catch (err: any) {
      // P2002 = unique constraint violation (concurrent request created it first).
      // Re-check to see if the binding matches or conflicts.
      if (err?.code === 'P2002') {
        return enforceAddressBinding(l1Address, l2Address)
      }
      throw err
    }
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
 * Sum a user's confirmed (funds-locked) L1→L2 deposits, in USD.
 *
 * Used by the attestation endpoints to enforce the Alpha cumulative deposit
 * cap. USDC (the only Alpha-mainnet token) is USD-pegged, so the hardcoded
 * fallback price (USDC=$1) is exact and no live price feed is needed.
 */
export async function getConfirmedDepositUsd(userId: string): Promise<number> {
  const rows = await prisma.bridgeActivity.findMany({
    where: {
      fkUserId: userId,
      direction: BridgeDirection.L1_TO_L2,
      status: { in: LOCKED_DEPOSIT_STATUSES },
    },
    select: { amountL1: true, tokenDecimalsL1: true, tokenSymbolL1: true },
  })

  let total = 0
  for (const row of rows) {
    if (!row.amountL1) continue
    const decimals = row.tokenDecimalsL1 ?? 6
    const price = getTokenPriceUsd(row.tokenSymbolL1 ?? 'USDC', null)
    total += (Number(row.amountL1) / 10 ** decimals) * price
  }
  return total
}

/** Convert a USD amount to a token's base-unit bigint (for on-chain maxAmount). */
export function usdToTokenBaseUnits(usd: number, tokenSymbol: string, decimals: number): bigint {
  const price = getTokenPriceUsd(tokenSymbol, null)
  if (price <= 0 || usd <= 0) return 0n
  return BigInt(Math.floor((usd / price) * 10 ** decimals))
}

export interface DepositLimitResult {
  /** Whether the cap is configured (BRIDGE_MAX_DEPOSIT_USD > 0). */
  enabled: boolean
  /** True when confirmed + requested would exceed the cap. */
  overLimit: boolean
  limitUsd: number
  confirmedUsd: number
  requestedUsd: number
  /** Budget left for this user (cap − confirmed), floored at 0. */
  remainingUsd: number
}

/**
 * Evaluate the Alpha cumulative deposit cap for a user's L1→L2 deposit.
 * Only meaningful for deposits — callers must not gate withdrawals with this.
 */
export async function evaluateDepositLimit(params: {
  userId: string
  amount?: string
  tokenSymbol?: string
  tokenDecimals?: number
}): Promise<DepositLimitResult> {
  const limitUsd = getBridgeMaxDepositUsd()
  if (limitUsd <= 0) {
    return { enabled: false, overLimit: false, limitUsd: 0, confirmedUsd: 0, requestedUsd: 0, remainingUsd: Infinity }
  }

  const confirmedUsd = await getConfirmedDepositUsd(params.userId)
  const decimals = params.tokenDecimals ?? 6
  const requestedUsd = params.amount
    ? (Number(params.amount) / 10 ** decimals) * getTokenPriceUsd(params.tokenSymbol ?? 'USDC', null)
    : 0
  const remainingUsd = Math.max(0, limitUsd - confirmedUsd)
  // Small epsilon so float rounding (e.g. 10.000000001) doesn't false-trigger.
  const overLimit = confirmedUsd + requestedUsd > limitUsd + 1e-6
  return { enabled: true, overLimit, limitUsd, confirmedUsd, requestedUsd, remainingUsd }
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
