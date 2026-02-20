# Upgrading the Bridge

## 1) Prep

1. Open the workspace at `aztec-ui.code-workspace`.
2. Pull the latest `aztec-starter` from GitHub.
3. Compare `aztec-starter` vs `bridge-script` imports/syntax and update `bridge-script` accordingly.

## 2) Aztec sandbox version

Check current version:

```
aztec --version
```

Expected current version:

```
aztec-up 3.0.0-devnet.6-patch.1
```

Upgrade to latest (pulls Docker image):

```
aztec-up 4.0.0-devnet.2-patch.0
```

Note: You can delete the old Docker image from Docker Desktop to free up space.

## 3) Update devnet config

Update `bridge-script/config/devnet.json` to the latest version and devnet URL.

## 4) Start Aztec sandbox (latest)

Run this in the main project root where the `.env` file exists with `L1_URL`, `BOOTNODE`, and `L1_CHAIN_ID`.

Get the bootnode URL from:
https://docs.aztec.network/developers/getting_started_on_devnet#step-1-set-up-your-environment

```
source .env
aztec start --local-network --port 8081 --pxe --pxe.nodeUrl=$BOOTNODE --pxe.proverEnabled true --l1-chain-id $L1_CHAIN_ID
```

## 5) Update `bridge-script/package.json` Aztec dependencies

Reference: https://www.npmjs.com/package/@aztec/accounts?activeTab=versions

Use the following versions:

```
"@aztec/accounts": "4.0.0-devnet.2-patch.0",
"@aztec/aztec.js": "4.0.0-devnet.2-patch.0",
"@aztec/ethereum": "4.0.0-devnet.2-patch.0",
"@aztec/foundation": "4.0.0-devnet.2-patch.0",
"@aztec/kv-store": "^4.0.0-devnet.2-patch.0",
"@aztec/l1-artifacts": "4.0.0-devnet.2-patch.0",
"@aztec/noir-contracts.js": "4.0.0-devnet.2-patch.0",
"@aztec/protocol-contracts": "4.0.0-devnet.2-patch.0",
"@aztec/pxe": "4.0.0-devnet.2-patch.0",
"@aztec/stdlib": "4.0.0-devnet.2-patch.0",
"@aztec/test-wallet": "4.0.0-devnet.2-patch.0",
```

## 6) Install packages and deploy contracts

Install dependencies and deploy the contracts using the updated versions.

## 6.1) If contract JSON changes, upload artifacts

If the compiled contract JSON changes, upload the updated contract artifact to the Aztec registry so wallets (Azguard) can register and simulate it correctly:

https://devnet.aztec-registry.xyz/

## 6.2) Verify deployment on AztecScan

Check the deployed contract transaction effects on AztecScan:

https://devnet.aztecscan.xyz/tx-effects/0x0aa2cd8f8be0fd235cfcdbc7cc5f5ae833d404745e7f01b6b1198272c4465913

## 7) Update frontend after deployment

1. Remove `node_modules` and `.next` from `frontend`.
2. Run `pnpm install` in `frontend`.
3. Update frontend contract addresses.
4. Update Aztec packages in `frontend/package.json`.
5. Update node URL in `frontend/src/aztec.ts`.

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


