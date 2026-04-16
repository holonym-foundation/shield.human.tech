# Aztec Bridge UI — Project Rules

## Project Overview

This is the **Aztec Token Bridge** — a full-stack system for bridging ERC-20 tokens from Ethereum L1 to Aztec L2 with optional atomic fuel swaps (swap a portion of bridged tokens into FeeJuice for L2 gas).

### Architecture

```
frontend/                    — Next.js app (bridge UI)
packages/sdk/                — @human.tech/aztec-bridge-sdk (core bridge logic, env-agnostic)
bridge-script/               — Deployment & testing scripts (TypeScript + viem)
  ├── index-testnet-compliant.ts — Main deployment + test script (deploy, seed, test all flows)
  ├── seed-pools.ts          — Standalone pool seeding script (direct USDC/FJ pool primary)
  ├── test-fuel-swap.ts      — Standalone fuel swap E2E test
  ├── recover-liquidity.ts   — Recover ETH/tokens from old pool positions
  ├── constants/tokens.ts    — Token configurations (USDC, USDT, DAI, HUMN, GOAT, WBTC, WETH)
  └── deployments/           — Persisted deployment state (JSON)
l1-contracts/                — Solidity contracts (Foundry)
  ├── src/UniswapFuelSwap.sol    — Multi-hop V4 swap: ERC20 → WETH → ETH → FeeJuice
  ├── src/SwapBridgeRouter.sol   — Permit2-based atomic bridge + fuel swap
  ├── src/TokenPortal.sol        — L1↔L2 token bridging
  └── script/SeedUniswapPools.s.sol — PoolSeeder contract (idempotent pool init + liquidity)
```

### Key Flows

- **Bridge only**: User deposits ERC-20 via TokenPortal → claims on L2
- **Bridge + Fuel**: User deposits via SwapBridgeRouter → splits into token deposit + fuel swap → claims both on L2 using FeeJuice for gas
- **Fuel swap route**: `USDC → [USDC/WETH pool] → WETH → unwrap → ETH → [ETH/AZTEC pool] → FeeJuice`

### Tech Stack

- **L1**: Solidity, Uniswap V4, Permit2, Foundry
- **L2**: Aztec (Noir contracts), `@aztec/*` packages
- **Scripts**: TypeScript, viem, `@aztec/ethereum`
- **Frontend**: Next.js, React
- **Network**: Aztec Alpha (settles on Ethereum mainnet), Aztec v4.2.0-aztecnr-rc.2

### L1 Contract Addresses (Ethereum Mainnet)

- PoolManager: `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`
- WETH: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`
- AZTEC (FeeJuice): `0x35d0186d1FD53b72996475D965C5Ed171D52b986`
- FeeAssetHandler: `0xED9c5557d2E0abCc7c7FCA958eE4292199413494`
- Permit2: `0x000000000022D473030F116dDEE9F6B43aC78BA3`

## Debugging & Code Trust Rules

**NEVER trust ANY existing code when debugging — not the Solidity contracts, not the Aztec L2 contracts, not the scripts, not the frontend.** Always re-read and audit every layer from scratch. This project has L1 Solidity contracts, L2 Aztec/Noir contracts, TypeScript deployment scripts, and test files that must stay in sync. When something fails:

1. **Debug in source-of-truth order: Smart Contracts → Database → APIs → Scripts → Frontend** — Always start from the lowest, most authoritative layer. Don't assume scripts, wrappers, or helper code are correct. Read the actual implementation (Solidity contracts, DB schemas, API endpoints) before forming hypotheses. Work upward only after verifying each layer.

2. **Never trust L1 contracts (Solidity) as correct** — Always re-read `l1-contracts/src/` when debugging. Check for: incorrect settlement logic, missing edge cases in multi-hop swaps, wrong token ordering assumptions, unsafe ETH handling, reentrancy vectors, missing access controls. The contracts may have bugs too — don't assume they're correct just because they compiled.

3. **Never trust L2 contracts (Aztec/Noir) as correct** — Re-read the Aztec contract interactions when debugging L2 claims, note handling, or fee payment. Check for: incorrect secret hashing, wrong message formats, stale L2 contract registrations, missing authwit approvals.

4. **Verify on-chain state directly** — Don't infer pool state from aggregate balances. Uniswap V4's PoolManager holds assets for ALL pools globally. Use pool-specific queries (slot0, position state) to check individual pool health.

5. **Audit skip/cache logic aggressively** — Silent skips caused a multi-session bug where pool seeding was skipped because a global balance check passed. Skip logic that "optimizes" by avoiding redundant work is the #1 source of deployment bugs in this project.

6. **Trace the full execution path on errors** — `CurrencyNotSettled` doesn't mean the swap logic is wrong — it can mean the pool has no liquidity. Always trace upstream to find the real cause.

7. **Security audit every change** — Before completing any task that touches contracts or scripts, check for:
   - Reentrancy (especially in unlock callbacks and ETH transfers)
   - Access control (who can call setup/sweep/setSwapTarget?)
   - Token approval issues (Permit2 witness validation, allowance checks)
   - Integer overflow/underflow in liquidity and swap math
   - Front-running / sandwich attack vectors on swaps
   - Missing slippage protection (minOutput = 0 is dangerous on mainnet)
   - Funds stuck in contracts (can all tokens be swept/recovered?)

8. **When a fix spans multiple sessions: reset** — Re-read ALL contracts (L1 and L2) from scratch. Don't build on assumptions from previous (possibly wrong) sessions. The user's instruction "forget everything, check the real contracts" is the default approach.

9. **Recheck everything before claiming done** — Before saying work is complete, re-read every changed file with fresh eyes as if you're a new reviewer seeing it for the first time. Check consistency across all files (same values in scripts, tests, and contracts?). Verify against the original request. Run tests/builds. Never claim "done" without evidence it works.

## Project-Specific Notes

- `PoolSeeder.setup()` is idempotent — no skip logic needed, ever
- Pool keys are passed per-call to `UniswapFuelSwap.swap()` and `SwapBridgeRouter.bridgeWithFuel()` — they are NOT hardcoded in contracts
- `PoolSeeder` locks liquidity permanently (no withdraw) — use PositionManager for mainnet
- Token configs live in `bridge-script/constants/tokens.ts`
- Deployment state persists in `bridge-script/deployments/` — scripts skip already-deployed tokens

## Git & Commits
- Do NOT commit code — user reviews and commits manually
- Do NOT include `Co-Authored-By` lines in commit messages
