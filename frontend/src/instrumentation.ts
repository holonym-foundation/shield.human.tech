/**
 * Next.js server instrumentation — runs once at startup before any requests.
 *
 * Problem: @aztec/foundation/crypto/poseidon checks `typeof self !== 'undefined'`
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
 */
export async function register() {
  if (typeof globalThis.self === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).self = globalThis
  }
}
