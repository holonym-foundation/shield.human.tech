# Mainnet Deployment Plan: Fuel Swap Infrastructure

**Date:** 2026-03-25
**Status:** Draft

## Overview

The fuel swap infrastructure allows users to bridge ERC-20 tokens (e.g. USDC) from L1 to Aztec L2 while atomically swapping a portion for FeeJuice to pay L2 gas. On devnet, we deploy test tokens and create pools from scratch. Mainnet is fundamentally different — real tokens, real money, existing liquidity.

## Architecture Recap

```
User (L1)
  │
  ├── USDC (via Permit2) ──→ SwapBridgeRouter
  │                              │
  │                              ├── fuelAmount ──→ UniswapFuelSwap
  │                              │                     │
  │                              │   USDC ──→ [USDC/WETH pool] ──→ WETH
  │                              │   WETH ──→ unwrap ──→ ETH
  │                              │   ETH  ──→ [ETH/AZTEC pool] ──→ FeeJuice
  │                              │                     │
  │                              │   FeeJuice ──→ FeeJuicePortal.depositToAztecPublic()
  │                              │
  │                              └── remainder ──→ TokenPortal.depositToAztecPublic()
  │
  └── L2: claim tokens + FeeJuice
```

## What's Deployed Once (Contracts)

These contracts are deployed once and serve all users:

| Contract | Immutable Config | Governance |
|---|---|---|
| `UniswapFuelSwap` | `poolManager`, `feeJuice` (AZTEC token), `weth` | None — stateless |
| `SwapBridgeRouter` | `permit2`, `feeJuicePortal` | `owner` can call `setSwapTarget()` to update the swap contract |

**Pool keys are NOT hardcoded.** Both contracts receive the swap route (`PoolKey[]` path + `bool[]` zeroForOnes) as per-call arguments from the frontend/SDK. This means:

- No contract redeployment needed when pools change
- The frontend/SDK controls which pools to route through
- Multiple route strategies can coexist (different fee tiers, different intermediaries)

## What Changes Between Devnet and Mainnet

| Aspect | Devnet | Mainnet |
|---|---|---|
| USDC | TestERC20 (free mint) | Real USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) |
| WETH | Sepolia WETH | Mainnet WETH (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) |
| PoolManager | Sepolia V4 | Mainnet V4 (check Uniswap docs for address) |
| USDC/WETH pool | Created by us (tiny liquidity) | **Already exists** — deep market liquidity |
| ETH/AZTEC pool | Created by us (tiny liquidity) | **Must be bootstrapped** (see below) |
| FeeJuice | Minted free via FeeAssetHandler | Must be obtained (protocol allocation or market) |
| Liquidity tool | PoolSeeder (locks funds permanently) | PositionManager (withdrawable, manageable) |
| ETH cost | Testnet ETH (free) | Real ETH |

## Mainnet Deployment Steps

### Phase 1: Contract Deployment

Deploy the two core contracts. No pool creation needed at this step.

```
1. Deploy UniswapFuelSwap(mainnetPoolManager, mainnetAZTEC, mainnetWETH)
2. Deploy SwapBridgeRouter(mainnetPermit2, mainnetFeeJuicePortal, uniswapFuelSwapAddress)
3. Set trusted forwarder on each TokenPortal: portal.setTrustedForwarder(swapBridgeRouterAddress)
```

These are identical to devnet deployment — only the constructor args change.

### Phase 2: USDC/WETH Pool (No Action Needed)

Uniswap V4 mainnet will have existing USDC/WETH pools with deep liquidity from professional market makers. You just need to identify the correct pool key:

```ts
// Find the active USDC/WETH pool on V4 mainnet
const usdcWethKey = {
  currency0: USDC_ADDRESS,   // or WETH if WETH < USDC numerically
  currency1: WETH_ADDRESS,
  fee: 3000,                 // 0.3% — most common for major pairs
  tickSpacing: 60,
  hooks: ZERO_ADDRESS,       // no hooks for standard pools
}
```

Verify on-chain that this pool has sufficient liquidity before going live. If V4 doesn't have a deep USDC/WETH pool yet (early days), you may need to use a different fee tier or wait for migration from V3.

### Phase 3: ETH/AZTEC Pool (Requires Bootstrapping)

This is the critical step. AZTEC (FeeJuice) is protocol-specific, so there won't be organic market maker liquidity initially.

#### Option A: Protocol-Funded Liquidity via PositionManager (Recommended)

Use Uniswap V4's official `PositionManager` contract to add liquidity. Unlike `PoolSeeder`, positions created via PositionManager are:
- **Withdrawable** — can remove liquidity later
- **Manageable** — can adjust tick ranges, collect fees
- **Standard** — uses the official NFT position system

```
1. Determine target price: e.g. 1 ETH = 10,000 FeeJuice
2. Calculate sqrtPriceX96 for that ratio
3. Choose tick range (e.g. +-50% around target price)
4. Call PositionManager.mint() with desired liquidity
5. Fund from protocol treasury (ETH + FeeJuice allocation)
```

**Suggested initial liquidity:**
- Start with enough depth to support typical fuel swaps (0.01-1 USDC worth)
- Example: $5,000-$10,000 worth on each side
- Can be increased over time as usage grows

#### Option B: Incentivized Liquidity

Create the pool and incentivize external LPs:
- Protocol initializes the pool at target price
- Offer LP rewards (AZTEC token incentives) for providing ETH/AZTEC liquidity
- Market makers handle the rest

#### Option C: Single-Sided Seeding + Market Making

If the protocol has large FeeJuice reserves but limited ETH:
1. Initialize pool at target price
2. Add single-sided FJ liquidity below current price
3. Let arbitrageurs bring ETH in to balance the pool

### Phase 4: Frontend/SDK Configuration

The frontend needs the correct pool keys for mainnet routing:

```ts
// SDK/frontend config for mainnet
const MAINNET_FUEL_ROUTE = {
  pools: [usdcWethKey, ethAztecKey],
  zeroForOnes: [usdcIsToken0, true],  // depends on token ordering
}
```

This is passed per-call to `SwapBridgeRouter.bridgeWithFuel()` — no contract changes needed.

### Phase 5: Testing on Mainnet Fork

Before going live, run the E2E Foundry test against a mainnet fork:

```bash
MAINNET_RPC_URL=<url> forge test --match-contract E2EPoolSeedAndSwap -vvv --fork-url $MAINNET_RPC_URL
```

This verifies the swap route works with real mainnet pool state.

## Mainnet Checklist

```
[ ] Confirm Uniswap V4 PoolManager address on mainnet
[ ] Confirm AZTEC/FeeJuice token address on mainnet
[ ] Confirm FeeJuicePortal address on mainnet
[ ] Deploy UniswapFuelSwap with mainnet addresses
[ ] Deploy SwapBridgeRouter with mainnet addresses
[ ] Set trusted forwarder on all TokenPortals
[ ] Identify existing USDC/WETH pool key on V4 mainnet
[ ] Create ETH/AZTEC pool via PositionManager (not PoolSeeder)
[ ] Fund ETH/AZTEC pool from protocol treasury
[ ] Update SDK/frontend with mainnet pool keys and contract addresses
[ ] Run E2E fork test against mainnet state
[ ] Test with small real amounts before full launch
[ ] Set up monitoring for pool depth and swap success rate
```

## Risk Considerations

### Liquidity Risk
- If ETH/AZTEC pool depth is too low, large fuel swaps will fail or get bad rates
- Monitor pool depth vs typical fuel swap sizes
- Set appropriate `minFuelOutput` in the SDK to protect users from slippage

### Price Oracle Risk
- The swap uses spot price with no TWAP oracle
- MEV bots could sandwich fuel swaps on mainnet
- Mitigation: keep fuel amounts small, set reasonable `minFuelOutput`

### Pool Migration Risk
- If pools move to different fee tiers or V4 hooks are added, routes need updating
- `SwapBridgeRouter.setSwapTarget()` allows updating the swap contract
- Pool keys are per-call, so route changes only require SDK updates

### Key Difference: PoolSeeder vs PositionManager

| Feature | PoolSeeder (devnet) | PositionManager (mainnet) |
|---|---|---|
| Withdraw liquidity | No (locked forever) | Yes |
| Collect fees | No | Yes |
| Adjust position | No | Yes (increase/decrease) |
| NFT position | No | Yes (ERC-721) |
| Complexity | Simple (one-shot) | Standard V4 flow |
| Use case | Throwaway testnet pools | Production liquidity |

**Do NOT use PoolSeeder on mainnet** — it permanently locks funds with no way to recover them.

## Summary

The contracts are ready for mainnet as-is. The only mainnet-specific work is:
1. Deploy contracts with mainnet addresses (trivial)
2. Bootstrap the ETH/AZTEC pool via PositionManager (requires treasury funding)
3. Configure the SDK with mainnet pool keys (config change only)

No script needs to "run on mainnet" — the seed-pools script is a devnet convenience tool.
