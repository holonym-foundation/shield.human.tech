# Upgrading the Bridge

## Version History

| Date | From | To | Network | Notes |
|------|------|----|---------|-------|
| 2026-04-01 | `4.0.0-devnet.2-patch.3` | `4.2.0-aztecnr-rc.2` | devnet → testnet | Full SDK upgrade + testnet migration |

## 1) Prep

1. Open the workspace at `aztec-ui.code-workspace`.
2. Check the Aztec migration notes for breaking changes between your current and target version:
   - **Testnet**: https://docs.aztec.network/developers/testnet/docs/resources/migration_notes
   - **Alpha Mainnet**: https://docs.aztec.network/developers/docs/resources/migration_notes
3. Check the Aztec networks page for current node URLs and chain IDs: https://docs.aztec.network/networks

> **SDK vs Node versions**: The SDK version (e.g. `4.2.0-aztecnr-rc.2`) does NOT need to match the node version (e.g. `4.1.2`). Aztec explicitly supports this — the SDK handles protocol differences internally.

## 2) Aztec CLI version

Check current version:

```
aztec --version
```

Install/upgrade (dockerless since v4.0.0):

```
VERSION=4.2.0-aztecnr-rc.2 bash -i <(curl -sL https://install.aztec.network/4.2.0-aztecnr-rc.2)
```

Or use `aztec-up` as a version manager:

```
aztec-up install 4.2.0-aztecnr-rc.2
aztec-up use 4.2.0-aztecnr-rc.2
```

> **Node.js requirement**: v24.12.0+ (upgraded from v22 in 4.1.0).

## 3) Update package dependencies

### bridge-script/package.json

Reference: https://www.npmjs.com/package/@aztec/accounts?activeTab=versions

Update all `@aztec/*` packages to match the target version:

```json
"@aztec/accounts": "4.2.0-aztecnr-rc.2",
"@aztec/aztec.js": "4.2.0-aztecnr-rc.2",
"@aztec/ethereum": "4.2.0-aztecnr-rc.2",
...
```

### Wonderland fee-payment package rename (4.0 → 4.2)

The package was renamed and published to npm:

```
# Old (GitHub tgz):
"@defi-wonderland/aztec-fee-payment": "https://github.com/defi-wonderland/aztec-fee-payment/releases/..."

# New (npm):
"@wonderland/aztec-fee-payment": "4.2.0-aztecnr-rc.2"
```

**Import renames required:**
- `@defi-wonderland/aztec-fee-payment` → `@wonderland/aztec-fee-payment`
- `registerBridgedContract(wallet)` → `registerPrivateContract(wallet, Fr.ZERO)`
- `BridgedFPCContractArtifact` → `PrivateFPCContractArtifact`
- `BridgedMintAndPayFeePaymentMethod` → `PrivateMintAndPayFeePaymentMethod`

### frontend/package.json

Same `@aztec/*` version updates, plus the wonderland rename above.

## 4) Breaking API Changes (4.0 → 4.2)

### `.send()` returns `{ receipt }` instead of receipt directly

```typescript
// Before (4.0):
const receipt = await contract.methods.foo().send(opts);
const txHash = receipt.txHash;

// After (4.2):
const { receipt } = await contract.methods.foo().send(opts);
const txHash = receipt.txHash;
```

### `.simulate()` returns `{ result }` instead of bare value

```typescript
// Before (4.0):
const value = await contract.methods.foo().simulate({ from: sender });

// After (4.2):
const { result } = await contract.methods.foo().simulate({ from: sender });
```

### `.deploy().send()` returns `{ contract, receipt }`

```typescript
// Before (4.0):
const contract = await MyContract.deploy(wallet).send(opts);

// After (4.2):
const { contract } = await MyContract.deploy(wallet).send(opts);
```

### `getL1ToL2MessageBlock` → `getL1ToL2MessageCheckpoint`

```typescript
// Before (4.0):
const block = await aztecNode.getL1ToL2MessageBlock(messageHash);

// After (4.2):
const checkpoint = await aztecNode.getL1ToL2MessageCheckpoint(messageHash);
```

### `computeL2ToL1MembershipWitness` signature changed

```typescript
// Before (4.0):
const witness = await computeL2ToL1MembershipWitness(node, epochNumber, msgLeaf);

// After (4.2) — epoch resolved internally from txHash:
const witness = await computeL2ToL1MembershipWitness(node, msgLeaf, txHash);
// witness.epochNumber is now on the return object
```

### `NO_FROM` sentinel for account deployment

Use `NO_FROM` (not `AztecAddress.ZERO`) when bypassing account contract entrypoints:

```typescript
import { NO_FROM } from '@aztec/aztec.js/account';

await deployMethod.send({
  from: NO_FROM,  // bypasses SchnorrAccount entrypoint simulation
  fee: { paymentMethod: sponsoredPaymentMethod },
});
```

### SponsoredFPC must be registered with PXE

Before using SponsoredFPC for fee payment, register it with the PXE:

```typescript
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';

const sponsoredFPC = await getSponsoredFPCInstance();
await pxe.registerContract({ instance: sponsoredFPC, artifact: SponsoredFPCContractArtifact });
```

### Block → Checkpoint terminology on L1

L1 contract events and functions renamed:
- `L2BlockProposed` → `CheckpointProposed`
- `getProvenBlockNumber()` → `getProvenCheckpointNumber()`
- `getEpochForBlock()` → `getEpochForCheckpoint()`

### Fee model inverted

- `feeAssetPerEth` → `ethPerFeeAsset` (1e12 precision)
- `getCurrentBaseFees()` → `getCurrentMinFees()`
- Price modifier now in basis points (-100 to +100 BPS)

## 5) Additional changes in 4.2 (alpha mainnet only, not in 4.1 testnet)

These changes are in `4.2.0-aztecnr-rc.2` but NOT in `4.1.0-rc.2` (testnet). They won't affect you unless you use these features:

| Change | Detail |
|--------|--------|
| Capsule scope parameter | All capsule ops require `scope: AztecAddress` |
| `process_message` removed | Use `offchain_receive` instead |
| `isContractInitialized` | Now tri-state enum: `INITIALIZED`, `UNINITIALIZED`, `UNKNOWN` |
| Dual init nullifiers | Separate private/public initialization nullifiers |
| Log emission tags | Domain-separated tag prepended at `fields[0]` |
| `attempt_note_discovery` | Separate `compute_note_hash` + `compute_note_nullifier` args |

## 6) Environment setup

### .env file (bridge-script)

```env
# ─── L1 RPC URLs ─────────────────────────────────────────────────────
L1_RPC_SEPOLIA=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
L1_RPC_MAINNET=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# ─── Aztec Node URLs ─────────────────────────────────────────────────
AZTEC_NODE_DEVNET=https://v4-devnet-2.aztec-labs.com
AZTEC_NODE_TESTNET=https://rpc.testnet.aztec-labs.com
AZTEC_NODE_MAINNET=https://aztec-mainnet.drpc.org

# ─── Wallet ──────────────────────────────────────────────────────────
MNEMONIC=your twelve word mnemonic here
# or: L1_PRIVATE_KEY=0x...

# ─── Attestation Keys (required for compliant script) ────────────────
POCH_ATTESTER_PRIVATE_KEY=0x...
PASSPORT_SIGNER_PRIVATE_KEY=0x...
L2_POCH_ATTESTER_PRIVATE_KEY=0x...
L2_PASSPORT_SIGNER_PRIVATE_KEY=0x...
```

### config.ts

`bridge-script/config/config.ts` reads `AZTEC_ENV` to select the environment. The env var is baked into `package.json` scripts:

```json
"start-testnet": "AZTEC_ENV=testnet LOG_LEVEL='silent;info:bridge' node --import tsx index-testnet-compliant.ts",
"deploy-testnet:compliant": "AZTEC_ENV=testnet DEPLOY_ONLY=true LOG_LEVEL='silent;info:bridge' ...",
```

## 7) Compile Solidity contracts

```
cd l1-contracts
forge build
```

This generates the `out/` directory with contract artifacts (SwapBridgeRouter, UniswapFuelSwap, TokenPortal, etc.).

## 8) Deploy contracts

### Testnet (compliant — with attestation/compliance)

```bash
cd bridge-script
pnpm run deploy-testnet:compliant
```

This uses custom codegen'd contracts (`./artifacts/TokenBridge.js`, `./artifacts/TokenMinterProxy.js`) which include attestation parameters and work with the testnet node.

> **Do NOT use standard `@aztec/noir-contracts.js/TokenBridge`** — it has a struct incompatibility with testnet node 4.1.2 (`Undefined argument token of type struct`).

### Available scripts

```bash
pnpm run deploy-testnet:compliant              # Deploy only
pnpm run test-testnet:compliant                 # Run tests only
pnpm run test-testnet:compliant:fuel-only       # Run fuel swap tests only
pnpm run e2e-testnet:compliant                  # Force redeploy + test
pnpm run redeploy-testnet:compliant:swaps       # Redeploy swap infra only
pnpm run reseed-testnet:compliant:pools         # Reseed Uniswap pools only
```

### What the deploy script does

1. Deploys a Schnorr account (using `NO_FROM` + SponsoredFPC)
2. For each token (USDC, etc.):
   - Deploys L1 ERC20 + FeeAssetHandler + custom TokenPortal
   - Deploys L2 TokenMinterProxy + Wonderland Token + custom TokenBridge
   - Wires proxy → token → bridge together
3. Deploys fuel swap infrastructure (UniswapFuelSwap, SwapBridgeRouter, BridgedFPC)
4. Seeds Uniswap V4 pools (ETH/FeeJuice + token/WETH)
5. Sets trusted forwarders on portals
6. Saves deployment data to `deployments/` and syncs to `frontend/src/constants/deployments.json`

## 9) If contract JSON changes, upload artifacts

Upload updated contract artifacts to the Aztec registry so wallets can register and simulate correctly:

- **Testnet**: https://testnet.aztec-registry.xyz/
- **Devnet**: https://devnet.aztec-registry.xyz/

## 10) Verify deployment on AztecScan

- **Testnet**: https://testnet.aztecscan.xyz/
- **Devnet**: https://devnet.aztecscan.xyz/

## 11) Update frontend after deployment

1. Remove `.next` from `frontend` (stale cache).
2. Run `pnpm install` in `frontend`.
3. Deployment addresses are written automatically by the deploy script to `frontend/src/constants/deployments.json`.
4. Update Aztec packages in `frontend/package.json` if needed (same version as bridge-script).
5. Apply the API changes from Section 4 (`.send()` destructuring, `.simulate()` destructuring, etc.).
6. Update devnet → testnet references (Aztecscan URLs, chain names, registry URLs).
7. Restart with `pnpm dev` (use `--webpack` flag, not Turbopack).

## 12) (Optional) Run a local PXE connected to testnet

Only needed for local development — NOT required for deployment or the frontend.

```bash
export L1_CHAIN_ID=11155111
export BOOTNODE=https://rpc.testnet.aztec-labs.com

aztec start --port 8081 --pxe --pxe.nodeUrl=$BOOTNODE --pxe.proverEnabled true --l1-chain-id $L1_CHAIN_ID
```

## Useful References

- **Aztec Networks** (node URLs, chain IDs): https://docs.aztec.network/networks
- **Migration Notes (testnet)**: https://docs.aztec.network/developers/testnet/docs/resources/migration_notes
- **Migration Notes (alpha mainnet)**: https://docs.aztec.network/developers/docs/resources/migration_notes
- **npm versions**: https://www.npmjs.com/package/@aztec/accounts?activeTab=versions

## Troubleshooting

### `Undefined argument token of type struct`

**Cause**: Using standard `@aztec/noir-contracts.js/TokenBridge` which has a struct incompatibility with testnet node 4.1.2.

**Solution**: Use the compliant deploy script (`deploy-testnet:compliant`) which uses custom codegen'd contracts from `./artifacts/`.

### L2 token deployed at `undefined`

**Cause**: Same struct incompatibility — L2 token deploy returns `undefined` address when using standard contracts.

**Solution**: Use Wonderland's `TokenContract` with `deployWithOpts({ method: 'constructor_with_minter' })` as the compliant script does.

### `No L1 to L2 message found`

**Cause**: The L1→L2 message hasn't been picked up by the Aztec node yet. Takes a few epochs to sync.

**Solution**: Wait and retry. This is a timing issue, not a code bug. The testnet processes L1 messages every few minutes.

### SchnorrAccount entrypoint simulation error

**Error**: `Cannot read properties of undefined (reading 'name')` at `PrivateExecutionOracle.deriveCallContext`

**Solution**: Use `NO_FROM` for the `from` parameter and register SponsoredFPC with PXE before use:

```typescript
import { NO_FROM } from '@aztec/aztec.js/account';
await pxe.registerContract({ instance: sponsoredFPC, artifact: SponsoredFPCContractArtifact });
await deployMethod.send({ from: NO_FROM, fee: { paymentMethod } });
```

### Package path export error

If you see `ERR_PACKAGE_PATH_NOT_EXPORTED`, the package version likely changed its export map. Check the package's `package.json` exports field and update your imports accordingly.

### Frontend `buf.writeBigUInt64BE` error (Web)

**Error**: `buf.writeBigUInt64BE is not a function`

**Cause**: Turbopack bundles Node polyfills incorrectly for Aztec/bb.js in the browser.

**Solution**: Force Webpack:

1. In `frontend/package.json`:
```
"dev": "next dev --webpack"
```

2. In `frontend/next.config.ts`, keep the webpack polyfills (`buffer`, `crypto`, `stream`, `util`, etc.).
