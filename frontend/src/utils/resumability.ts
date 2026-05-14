interface ResumableFields {
  direction: string
  status: string
  messageHash?: string | null
  l1TxHash?: string | null
  l1BlockNumberBeforeTx?: string | null
  l2TxHash?: string | null
}

/** True for statuses where the user's funds are locked and can be resumed */
export function isResumable(op: ResumableFields): boolean {
  if (op.direction === 'L1_TO_L2') {
    return (
      (op.status === 'deposited' || op.status === 'claimed') &&
      (!!op.messageHash || !!op.l1TxHash || !!op.l1BlockNumberBeforeTx)
    )
  }
  if (op.direction === 'L2_TO_L1') {
    return (
      op.status === 'submitted' ||
      op.status === 'ready' ||
      op.status === 'pending_finalize'
    )
  }
  return false
}

/**
 * True if an entry has status 'pending' but a tx hash exists,
 * indicating the session died after tx send but before status update.
 * Funds may be locked on-chain.
 */
export function hasPossibleLockedFunds(op: {
  status: string
  l1TxHash?: string | null
  l2TxHash?: string | null
}): boolean {
  return op.status === 'pending' && (!!op.l1TxHash || !!op.l2TxHash)
}
