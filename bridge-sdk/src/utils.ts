import { Fr } from '@aztec/aztec.js/fields'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { EthAddress } from '@aztec/foundation/eth-address'

export const toFr = (value: Fr | string): Fr => {
  return typeof value === 'string' ? Fr.fromString(value) : value
}

export const toAztecAddress = (value: string): AztecAddress => {
  return AztecAddress.fromString(value)
}

export const toEthAddress = (value: string): EthAddress => {
  return EthAddress.fromString(value)
}

export const toBigInt = (value: bigint | number | string): bigint => {
  return typeof value === 'bigint' ? value : BigInt(value)
}

export const getSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value.toString()
  return String(value)
}
