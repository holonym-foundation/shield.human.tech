import { describe, it, expect } from 'vitest'
import { checkFuelSufficiency } from './fuelGasEstimate'

const FJ = 10n ** 18n

// feePerL2Gas 1e12 at the 2× public multiplier over the 2M-gas claim ceiling → 4 FJ limit;
// at the 3× private multiplier → 6 FJ.
const node = { getCurrentMinFees: async () => ({ feePerL2Gas: 10n ** 12n, feePerDaGas: 0n }) } as any

describe('checkFuelSufficiency', () => {
  it('credits the existing public balance, since the public claim pays from it', async () => {
    // The app sizes the swap to the shortfall; checking the swap alone rejected every such deposit.
    const r = await checkFuelSufficiency(node, 1n * FJ, 'public', 3n * FJ)
    expect(r.sufficient).toBe(true)
    expect(r.shortfallFj).toBeNull()
  })

  it('reports the shortfall after the existing balance', async () => {
    const r = await checkFuelSufficiency(node, 1n * FJ, 'public', 2n * FJ)
    expect(r.sufficient).toBe(false)
    expect(r.shortfallFj).toBe('1.0000')
  })

  it('ignores the existing balance for private fuel, which must self-fund its claim', async () => {
    const r = await checkFuelSufficiency(node, 1n * FJ, 'private', 100n * FJ)
    expect(r.sufficient).toBe(false)
    expect(r.shortfallFj).toBe('5.0000')
  })

  it('checks the swap output alone when no balance is given', async () => {
    expect((await checkFuelSufficiency(node, 4n * FJ, 'public')).sufficient).toBe(true)
    expect((await checkFuelSufficiency(node, 4n * FJ - 1n, 'public')).sufficient).toBe(false)
  })
})
