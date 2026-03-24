# Aztec Token Bridge Scripts

Deployment and testing scripts for the Aztec L1↔L2 token bridge. Includes both a standard bridge (`index-devnet.ts`) and a compliant bridge with attestation/passport support (`index-devnet-compliant.ts`).

The standard bridge deploys all L1 and L2 contracts: TestERC20, TokenPortal, TokenContract, TokenBridgeContract, UniswapFuelSwap, and SwapBridgeRouter.

## Setup

```bash
cp .env.example .env
# Edit .env with your keys and configuration
pnpm install
```

## Prerequisites

- Node.js v20+
- [Foundry](https://book.getfoundry.sh/) (`forge`) for compiling Solidity contracts
- A funded Sepolia wallet mnemonic

### 1. Compile Solidity contracts

```bash
cd l1-contracts
forge build
```

### 2. Run the deployment script

No local Aztec node or PXE is needed — the script connects directly to the remote devnet node.

```bash
cd bridge-script
MNEMONIC="your twelve word mnemonic here" pnpm start-devnet
```

The script will:
- Connect to the devnet Aztec node and read L1 chain config
- Deploy TestERC20 tokens (USDC, USDT, DAI, HUMN, GOAT, WBTC) on L1
- Use pre-existing WETH on Sepolia (`0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`)
- Deploy TokenPortal, TokenContract, TokenBridgeContract for each token
- Deploy UniswapFuelSwap and SwapBridgeRouter for fuel infrastructure
- Deploy FeeAssetHandler and configure minter permissions
- Save deployment data to `deployments/` and `../frontend/src/constants/deployments.json`

### 3. Copy deployment data to frontend

The script automatically writes to `frontend/src/constants/deployments.json`. Restart the frontend dev server to pick up the new deployment.

### 4. Faucet minting

The deployer wallet is automatically granted the minter role on all TestERC20 contracts. Set the same key as `FAUCET_PRIVATE_KEY` in `frontend/.env.local` so the faucet API can mint tokens.

## Environment Variables

See [`.env.example`](./.env.example) for all available variables. Key ones:

| Variable | Required | Description |
|---|---|---|
| `MNEMONIC` | Yes (devnet) | Wallet mnemonic for L1 account |
| `L1_URL` | Yes (devnet) | L1 RPC URL (Alchemy, Infura, etc.) |
| `AZTEC_ENV` | No | `devnet` or `sandbox` (default: `sandbox`) |
| `POCH_ATTESTER_PRIVATE_KEY` | Yes (prod) | Private key for POCH attester (compliant bridge) |
| `PASSPORT_SIGNER_PRIVATE_KEY` | Yes (prod) | Private key for passport signer (compliant bridge) |
| `FEE_BASIS_POINTS` | No | Fee on deposits in basis points (default: `500` = 5%) |
| `CLEAN_HANDS_CIRCUIT_ID` | No | Circuit ID for clean-hands attestation (default: `1`) |

## Scripts

### Standard Bridge

```bash
# Deploy all tokens + run basic bridge test
pnpm start-devnet
```

### Compliant Bridge

```bash
# Deploy all tokens + run all 11 tests
pnpm start-devnet:compliant

# Deploy all tokens, skip tests
pnpm deploy-devnet:compliant

# Deploy a specific token only, skip tests
TOKEN=USDC pnpm deploy-devnet:compliant:token

# Run tests only (against already-deployed tokens)
pnpm test-devnet:compliant
```

### Run Modes (Compliant Bridge)

The compliant script supports three env-var run modes that can also be set directly:

| Env Var | Effect |
|---|---|
| `DEPLOY_ONLY=true` | Deploy tokens but skip tests |
| `RUN_TESTS_ONLY=true` | Skip deployment, run tests against existing tokens |
| `DEPLOY_TOKEN=USDC` | Only deploy this specific token (case-insensitive) |

These can be combined, e.g.:

```bash
# Deploy only USDC, no tests
DEPLOY_ONLY=true DEPLOY_TOKEN=USDC node --import tsx index-devnet-compliant.ts

# Force redeploy USDC (set forceDeploy in TOKEN_CONFIGS or use env vars)
DEPLOY_TOKEN=USDC node --import tsx index-devnet-compliant.ts
```

### Skip-if-Deployed

Both scripts automatically skip tokens that are already in the active deployment file. To force a redeploy of a specific token, set `forceDeploy: true` on that token in `constants/tokens.ts`.

### Other Scripts

```bash
pnpm build              # Compile L1 + L2 contracts and generate TypeScript artifacts
pnpm compile            # Compile L2 Noir contracts only
pnpm compile:l1         # Compile L1 Solidity contracts only
pnpm codegen            # Generate TypeScript bindings from compiled artifacts
pnpm fees               # Fee management script
pnpm deploy-contract    # Deploy a single contract
pnpm deploy-account     # Deploy a Schnorr account
```

## Deployment Files

Deployments are saved to `deployments/<version>_<date>.json` and tracked via `deployments/registry.json`. The active deployment is automatically synced to `../frontend/src/constants/deployments.json`.

Both the standard and compliant scripts write to the **same** deployment file, matched by token symbol. If both scripts deploy the same symbol (e.g. USDC), the later one overwrites the earlier entry.

## Common Errors

**`NotMinter(address caller)`** — The faucet private key doesn't match the deployer. Either redeploy or call `addMinter()` on the token contract.

**`Cannot find module .../SwapBridgeRouter.json`** — Run `forge build` in `l1-contracts/` first.

## Compliant Bridge Tests

The compliant script runs 11 tests against the first deployed token:

1. L1 Public Deposit → L2 Public Claim
2. L1 Private Deposit (POCH) → L2 Private Claim
3. L1 Private Deposit (Passport) → L2 Private Claim
4. L2 Public Exit → L1 Withdraw
5. L2 Private Exit (POCH) → L1 Withdraw
6. L2 Private Exit (Passport) → L1 Withdraw
7. **Negative:** Public Deposit → Private Claim (should fail)
8. **Negative:** Private Deposit → Public Claim (should fail)
9. **Negative:** Wrong address can't claim_public
10. **Negative:** Wrong secret can't claim_private
11. **Negative:** Non-holder can't exit
