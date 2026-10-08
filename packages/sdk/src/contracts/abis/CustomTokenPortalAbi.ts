/**
 * Custom TokenPortal ABI — imported from Forge build output.
 *
 * The deployed TokenPortal has a custom `fee` field in its deposit events
 * and a custom `depositToAztecPrivate` function with attestation params.
 * The standard @aztec-foundation/l1-artifacts TokenPortalAbi does NOT match these
 * event signatures (different keccak256 hash due to extra `fee` param),
 * so we must use this custom ABI for all encoding and event extraction.
 *
 * TokenPortal.json is generated — do not hand-edit. It is copied verbatim from the Forge
 * build output (l1-contracts/out/TokenPortal.sol/TokenPortal.json) by `pnpm run sync:artifacts`
 * in bridge-script, which runs after `forge build --force` as part of `pnpm build`. Regenerate
 * and commit it whenever TokenPortal.sol changes.
 */
import TokenPortalJson from './TokenPortal.json'

export const CustomTokenPortalAbi = TokenPortalJson.abi
