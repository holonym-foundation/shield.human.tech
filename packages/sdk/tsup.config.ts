import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    '@aztec-labs/aztec.js',
    '@aztec-labs/stdlib',
    '@aztec-foundation/l1-artifacts',
    '@aztec-labs/wallet-sdk',
    '@aztec-labs/ethereum',
    '@aztec-labs/foundation',
    'viem',
  ],
})
