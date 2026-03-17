# Bridge Script — Token Bridge Deployment

Deploys all L1 and L2 contracts for the Aztec token bridge: TestERC20, TokenPortal, TokenContract, TokenBridgeContract, UniswapFuelSwap, and SwapBridgeRouter.

## Prerequisites

- Node.js v20+
- [Foundry](https://book.getfoundry.sh/) (`forge`) for compiling Solidity contracts
- A funded Sepolia wallet mnemonic

## Deployment Steps

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

| Variable | Required | Description |
|----------|----------|-------------|
| `MNEMONIC` | Yes | Sepolia wallet mnemonic (deployer + faucet) |
| `L1_URL` | No | L1 RPC URL (defaults to config value) |
| `AZTEC_ENV` | No | Set by `start-devnet` script automatically |

## Common Errors

**`NotMinter(address caller)`** — The faucet private key doesn't match the deployer. Either redeploy or call `addMinter()` on the token contract.

**`Cannot find module .../SwapBridgeRouter.json`** — Run `forge build` in `l1-contracts/` first.
