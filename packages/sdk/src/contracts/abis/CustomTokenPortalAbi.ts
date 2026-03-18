/**
 * Custom TokenPortal ABI — imported from Forge build output.
 *
 * The deployed TokenPortal has a custom `fee` field in its deposit events
 * and a custom `depositToAztecPrivate` function with attestation params.
 * The standard @aztec/l1-artifacts TokenPortalAbi does NOT match these
 * event signatures (different keccak256 hash due to extra `fee` param),
 * so we must use this custom ABI for all encoding and event extraction.
 *
 * Source: l1-contracts/out/TokenPortal.sol/TokenPortal.json
 * To update: run the deploy script, which copies Forge output into packages/sdk/src/contracts/abis/TokenPortal.json
 */
import TokenPortalAbi from './TokenPortal.json'

export const CustomTokenPortalAbi = TokenPortalAbi
