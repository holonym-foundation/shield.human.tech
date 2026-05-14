/**
 * Cross-cutting protocol constants that must match a counterpart in an
 * external (third-party) contract. Centralised here so all in-repo callers
 * import a single canonical value, and a future change has one place to
 * update.
 */

/**
 * Poseidon2 hash domain separator used to derive the **private fuel claim
 * secret** from `(salt, l2Address)`:
 *
 *   privateFuelSecret = poseidon2HashWithSeparator([salt, l2Address], DOM_SEP)
 *
 * The L2 BridgedFPC contract (Wonderland's) uses this exact same separator
 * when it recomputes the secret inside `mint_and_pay_fee` during the L2
 * claim. If the SDK and the contract disagree on this value, the secret hash
 * the L1 portal stores will not match what the FPC computes on L2 → the
 * private-fuel claim cannot succeed.
 *
 * It is NOT a secret; it is a public protocol constant. Treat it as
 * load-bearing — do not change without a coordinated upgrade of the
 * BridgedFPC contract.
 *
 * Other in-repo copies that must stay in lockstep:
 *   - bridge-script/index-testnet-compliant.ts (test/deploy script)
 *   - docs/PR10-GUIDE.md (informational)
 */
export const BRIDGED_FPC_DOMAIN_SEPARATOR = 3952304070
