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

## Uniswap V4 Pool Seeding

The deployment script (`pnpm start-devnet`) automatically seeds two Uniswap V4 pools on Sepolia so the fuel swap quoter works. If automatic seeding fails, you can run it manually:

```bash
cd l1-contracts
PRIVATE_KEY=0x... ERC20_TOKEN=<erc20-address> \
  forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
  --rpc-url $L1_URL --broadcast -vvv
```

> **Note:** `L1_URL` must be set to your Sepolia RPC endpoint (e.g. Alchemy or Infura). Either `export L1_URL=https://...` beforehand or pass the URL directly with `--rpc-url https://...`.

### Pools Created

| Pool | Fee | Price Ratio | Default Seed |
|------|-----|-------------|--------------|
| ETH / FeeJuice (AZTEC) | 0.3% | ~10,000 FJ per ETH | 0.3 ETH + 100k FJ |
| ERC20 / WETH | 0.3% | ~2,100 USDC per WETH | 5,000 USDC + 1.5 WETH |

The ERC20/WETH pool is only created if `ERC20_TOKEN` is set (the deployment script passes the first deployed token automatically).

To seed only the ERC20/WETH pool separately (e.g. after the initial deployment):

```bash
cd l1-contracts
PRIVATE_KEY=0x... ERC20_TOKEN=<usdc-address> \
  forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
  --rpc-url $L1_URL --broadcast -vvv
```

### Pool Seeding Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIVATE_KEY` | — | **(Required)** Deployer private key |
| `ERC20_TOKEN` | `address(0)` | ERC20 token address for the ERC20/WETH pool. Skipped if not set |
| `ERC20_DECIMALS` | `6` | Decimals for the ERC20 token |
| `SKIP_ETH_AZTEC` | `false` | Skip the ETH/AZTEC pool |
| `FEE_MINT_COUNT` | `100` | Number of `FeeAssetHandler.mint()` calls (each mints 1,000 FJ) |
| `ETH_SEED` | `0.3 ether` | ETH deposited into the ETH/AZTEC pool |
| `ETH_AZTEC_LIQUIDITY` | `1e18` | Liquidity delta for ETH/AZTEC pool |
| `ERC20_AMOUNT` | `5000 × 10^decimals` | ERC20 amount to seed |
| `WETH_SEED` | `1.5 ether` | ETH wrapped to WETH for ERC20/WETH pool |
| `ERC20_WETH_LIQUIDITY` | `6e13` | Liquidity delta for ERC20/WETH pool |

### Key Addresses (Sepolia)

| Contract | Address |
|----------|---------|
| Uniswap V4 PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |
| AZTEC (FeeJuice) | `0x35d0186d1FD53b72996475D965C5Ed171D52b986` |
| FeeAssetHandler | `0xED9c5557d2E0abCc7c7FCA958eE4292199413494` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

## Deployment Files

Deployments are saved to `deployments/<version>_<date>.json` and tracked via `deployments/registry.json`. The active deployment is automatically synced to `../frontend/src/constants/deployments.json`.

Both the standard and compliant scripts write to the **same** deployment file, matched by token symbol. If both scripts deploy the same symbol (e.g. USDC), the later one overwrites the earlier entry.

## Topping Up Pool Liquidity

If you see **"Swap amount exceeds pool liquidity — try a smaller amount"** in the fuel toggle, the V4 pools are drained or were never seeded for your token. You need to add more liquidity to both pools (USDC swaps go through two hops: `USDC → WETH → ETH → FeeJuice`).

### Quick command (uses defaults)

```bash
cd l1-contracts

PRIVATE_KEY=0x<your_deployer_key> \
ERC20_TOKEN=<your_USDC_L1_address> \
  forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
  --rpc-url <your_sepolia_rpc> --broadcast -vvv
```

This seeds both pools with defaults: 5,000 USDC + 1.5 WETH + 0.3 ETH + 100k FeeJuice.

Find your USDC L1 address in `bridge-script/deployments/<active>.json` under `tokens[0].l1TokenContract`.

### With more liquidity

```bash
cd l1-contracts

PRIVATE_KEY=0x<your_deployer_key> \
ERC20_TOKEN=<your_USDC_L1_address> \
ERC20_AMOUNT=50000000000 \
WETH_SEED=5000000000000000000 \
ETH_SEED=1000000000000000000 \
FEE_MINT_COUNT=500 \
  forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
  --rpc-url <your_sepolia_rpc> --broadcast -vvv
```

| Env var | What it does | Value above |
|---|---|---|
| `ERC20_AMOUNT` | USDC to seed (raw units, 6 decimals) | 50,000 USDC |
| `WETH_SEED` | ETH to wrap into WETH (wei) | 5 ETH |
| `ETH_SEED` | ETH for the ETH/FeeJuice pool (wei) | 1 ETH |
| `FEE_MINT_COUNT` | FeeJuice mints (1,000 FJ each) | 500k FJ |

### Seed only one pool

```bash
# Only ETH/FeeJuice pool (skip ERC20/WETH)
PRIVATE_KEY=0x... \
  forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
  --rpc-url <rpc> --broadcast -vvv
# (omitting ERC20_TOKEN skips pool 2)

# Only ERC20/WETH pool (skip ETH/FeeJuice)
PRIVATE_KEY=0x... ERC20_TOKEN=<addr> SKIP_ETH_AZTEC=true \
  forge script script/SeedUniswapPools.s.sol:SeedUniswapPools \
  --rpc-url <rpc> --broadcast -vvv
```

### Requirements

- Your deployer wallet needs **Sepolia ETH** (at least ~2 ETH for WETH wrap + ETH seed + gas)
- Pool initialization is idempotent — if the pool already exists, only liquidity is added
- The script deploys a temporary `PoolSeeder` helper contract each run (it sweeps leftover tokens back to you)

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
