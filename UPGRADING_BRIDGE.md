# Upgrading the Bridge

## 1) Prep

1. Open the workspace at `aztec-ui.code-workspace`.
2. Pull the latest `aztec-starter` from GitHub.
3. Compare `aztec-starter` vs `bridge-script` imports/syntax and update `bridge-script` accordingly.

## 2) Aztec CLI version

Check current version:

```
aztec --version
```

Upgrade to latest:

```
aztec-up 4.0.0-devnet.2-patch.3
```

## 3) Update `bridge-script/package.json` Aztec dependencies

Reference: https://www.npmjs.com/package/@aztec/accounts?activeTab=versions

Update all `@aztec/*` packages to match the new version. Also update `frontend/package.json` Aztec dependencies.

## 4) Compile Solidity contracts

```
cd l1-contracts
forge build
```

This generates the `out/` directory with contract artifacts (BridgeAndFuel, MockFuelSwap, etc.) needed by the deployment script.

## 5) Deploy contracts to devnet

**No local Aztec node or PXE is needed** — the deployment script connects directly to the remote devnet node.

```
cd bridge-script
MNEMONIC="your twelve word mnemonic here" pnpm start-devnet
```

The script will:
- Deploy TestERC20 tokens (USDC, USDT, DAI, HUMN, GOAT, WBTC) on L1
- Use pre-existing WETH on Sepolia
- Deploy TokenPortal, TokenContract, TokenBridgeContract for each token
- Deploy BridgeAndFuel, MockFuelSwap, and FeeAssetHandler
- Save deployment data to `deployments/` and `frontend/src/constants/deployments.json`

## 6) If contract JSON changes, upload artifacts

If the compiled Noir contract JSON changes, upload the updated contract artifact to the Aztec registry so wallets can register and simulate it correctly:

https://devnet.aztec-registry.xyz/

## 7) Verify deployment on AztecScan

Check the deployed contract transaction effects on AztecScan:

https://devnet.aztecscan.xyz/

## 8) Update frontend after deployment

1. Remove `.next` from `frontend` (stale cache).
2. Run `pnpm install` in `frontend`.
3. Deployment addresses are written automatically by the deploy script to `frontend/src/constants/deployments.json`.
4. Update Aztec packages in `frontend/package.json` if needed.
5. Restart with `pnpm dev` (use `--webpack` flag, not Turbopack).

## 9) (Optional) Run a local PXE connected to devnet

Only needed for local development — NOT required for deployment or the frontend.

```
export L1_CHAIN_ID=11155111
export BOOTNODE=https://v4-devnet-2.aztec-labs.com

aztec start --port 8081 --pxe --pxe.nodeUrl=$BOOTNODE --pxe.proverEnabled true --l1-chain-id $L1_CHAIN_ID
```

## Troubleshooting

### Package path export error

If you see this error, paste it to the AI so we can fix the package path exports.

```
pn start-devnet

> src@1.0.0 start-devnet /Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script
> node --import tsx index-devnet.ts

node:internal/modules/run_main:123
    triggerUncaughtException(
    ^
Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in /Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script/node_modules/@aztec/ethereum/package.json imported from /Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script/index-devnet.ts
    at exportsNotFound (node:internal/modules/esm/resolve:314:10)
    at packageExportsResolve (node:internal/modules/esm/resolve:661:9)
    at packageResolve (node:internal/modules/esm/resolve:774:12)
    at moduleResolve (node:internal/modules/esm/resolve:854:18)
    at defaultResolve (node:internal/modules/esm/resolve:984:11)
    at nextResolve (node:internal/modules/esm/hooks:748:28)
    at resolveBase (file:///Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/esm/index.mjs?1769538730174:2:3744)
    at resolveDirectory (file:///Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/esm/index.mjs?1769538730174:2:4243)
    at resolveTsPaths (file:///Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/esm/index.mjs?1769538730174:2:4984)
    at resolve (file:///Users/muzzamil/Developer/holonym-foundation/aztec/aztec-ui/bridge-script/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/esm/index.mjs?1769538730174:2:5361) {
  code: 'ERR_PACKAGE_PATH_NOT_EXPORTED'
}

Node.js v22.16.0
 ELIFECYCLE  Command failed with exit code 1.
```

### Frontend `buf.writeBigUInt64BE` error (Web)

**Error**
```
buf.writeBigUInt64BE is not a function
```

**Cause**
Turbopack bundles Node polyfills incorrectly for Aztec/bb.js in the browser.

**Solution**
Force Webpack and keep Buffer polyfills enabled:

1. In `frontend/package.json`:
```
"dev": "next dev --webpack"
```

2. In `frontend/next.config.ts`, keep the webpack polyfills:
- `buffer`, `crypto`, `stream`, `util`, etc.


