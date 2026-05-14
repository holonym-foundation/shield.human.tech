import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    '@aztec/aztec.js',
    '@aztec/stdlib',
    '@aztec/l1-artifacts',
    '@aztec/wallet-sdk',
    '@aztec/ethereum',
    '@aztec/foundation',
    'viem',
  ],
})
