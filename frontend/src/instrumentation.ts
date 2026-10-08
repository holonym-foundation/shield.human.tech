/**
 * Next.js server instrumentation — runs once at startup before any requests.
 *
 * Problem: @aztec-labs/foundation/crypto/poseidon checks `typeof self !== 'undefined'`
 * to decide which Barretenberg backend to use:
 *   - browser (self defined): BarretenbergSync — loads WASM only, no CRS download
 *   - server (self undefined): Barretenberg    — downloads ~70MB CRS to ~/.bb-crs
 *
 * In Vercel's sandbox, ~/.bb-crs can't be created (home dir doesn't exist) and
 * the CRS download would time out anyway. BarretenbergSync already works fine on
 * Vercel (Schnorr signing uses it without issues).
 *
 * Fix: define globalThis.self before any Aztec modules load so poseidon2 takes
 * the BarretenbergSync path, matching what Schnorr already does.
 *
 * Also force LOG_JSON before @aztec-labs/foundation's logger initializes. Its logger
 * is built at import time and, unless LOG_JSON is truthy, configures a pino
 * worker-thread transport targeting `pino-pretty`. Vercel's file tracer never
 * copies pino-pretty into the lambda (it's referenced only as a dynamic string
 * target, so NFT can't see it), so pino throws "unable to determine transport
 * target for pino-pretty" the moment any route imports an Aztec module. With
 * LOG_JSON set it uses the `pino/file` transport instead, which lives inside
 * the (traced) pino package and resolves fine.
 */
export async function register() {
  if (typeof globalThis.self === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).self = globalThis
  }
  process.env.LOG_JSON ||= 'true'
}
