# Security Audit Report — Aztec Bridge & Fuel Swap Contracts

**Date:** 2026-03-25
**Scope:** All L1 Solidity contracts, L2 Aztec Noir contracts, and deployment scripts

---

## Scope

| Layer | Contracts Audited |
|-------|------------------|
| **L1 Core** | SwapBridgeRouter, UniswapFuelSwap, TokenPortal |
| **L1 Scripts** | PoolSeeder, DeployUniswapFuelSwap, DeploySwapBridgeRouter, DeployTokenPortalWithForwarder, SetTrustedForwarderAllPortals |
| **L2 Aztec** | TokenBridge (token_bridge/main.nr), TokenMinterProxy (token_minter_proxy/main.nr) |

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 12 |
| High | 7 |
| Medium | 14 |
| Low | 12 |
| Info | ~14 |
| **Missing functions (High+ priority)** | **12** |

---

## Critical Findings (12)

### SwapBridgeRouter

1. **Trusted forwarder not registered for private deposits** — `depositToAztecPrivateWithFuel()` calls `tokenPortal.depositToAztecPrivate()` which requires the caller to be a trusted forwarder. If SwapBridgeRouter isn't registered as a trusted forwarder on every TokenPortal, private fuel deposits silently fail or revert.

2. **Portal fee silently reduces L2 credit** — The portal deducts a fee from the deposited amount, so the L2 recipient receives less than `_depositAmount`. The user/UI has no on-chain way to predict the exact L2 credit, which can cause downstream failures if the fuel swap expects an exact amount.

### TokenPortal

3. **Nonce burned on invalid signature** — If `verifyCleanHandsSignature` fails after the nonce is consumed, the nonce is permanently burned. An attacker can grief users by front-running with an invalid signature, permanently locking that nonce.

4. **Withdraw fee mismatch with L2 message** — The L2 message content hash includes the original amount, but TokenPortal sends `amount - fee` to the recipient. If the L2 contract validates the full amount, withdrawals can be bricked.

### PoolSeeder / Deploy Scripts

5. **`unlockCallback` exploitable by third-party** — `PoolSeeder.unlockCallback()` is callable by anyone who triggers `poolManager.unlock()` with PoolSeeder as the callback target. A malicious actor could craft callback data to drain PoolSeeder's token approvals.

6. **`transfer()` for ETH sweep** — Uses `.transfer()` which has a 2300 gas stipend. Will fail if the recipient is a contract with a non-trivial `receive()`. Should use `.call{value:}("")`.

7. **Multi-hop settlement delta** — In multi-hop swaps, intermediate currency deltas may not fully settle if rounding or fee accumulation creates dust amounts, triggering `CurrencyNotSettled()`.

### Aztec L2 Contracts

8. **Clean-hands nonce burned on invalid signature (L2 mirror)** — Same pattern as L1: nonce consumed before signature validation, enabling grief attacks.

9. **Incomplete Grumpkin curve point check** — The bridge accepts Grumpkin points without full subgroup validation. A malformed point could lead to funds locked in an unspendable note.

10. **`exit_to_l1_public` has no compliance gate** — Public exits bypass CleanHands verification entirely. A sanctioned address can freely exit to L1 through the public path.

11. **Immutable proxy owner in TokenMinterProxy** — The `owner` is set once in the constructor with no transfer mechanism. If the owner key is lost or compromised, the proxy is permanently bricked or controlled by the attacker.

12. **Immutable token address in TokenMinterProxy** — The `token` address cannot be updated. If the token contract is redeployed, a new proxy must also be deployed.

---

## High Findings (7)

| # | Contract | Finding |
|---|----------|---------|
| 1 | SwapBridgeRouter | Unvalidated `tokenPortal` parameter — caller can pass a malicious portal contract |
| 2 | SwapBridgeRouter | Mutable `swapTarget` not included in witness/signature — admin can swap target between user approval and execution |
| 3 | SwapBridgeRouter | Balance-mismatch check uses return value from swap instead of actual balance delta |
| 4 | UniswapFuelSwap | Arbitrary `hooks` field in PoolKey — user can specify a malicious hooks contract |
| 5 | TokenPortal | `initialize()` front-runnable — no access control on initialization |
| 6 | TokenPortal | `rescueToken()` can drain underlying token — admin can extract deposited user funds |
| 7 | TokenPortal | Stale rollup reference — if rollup is upgraded, portal holds a stale address with no refresh mechanism |

---

## Medium Findings (14)

| Contract | Finding |
|----------|---------|
| SwapBridgeRouter | No slippage protection on the fuel swap leg |
| SwapBridgeRouter | No deadline/expiry on deposits |
| SwapBridgeRouter | Re-entrancy surface via external swap call |
| SwapBridgeRouter | No event for fuel swap execution |
| SwapBridgeRouter | Admin can change swap target without timelock |
| UniswapFuelSwap | No deadline parameter on swaps |
| UniswapFuelSwap | No intermediate hop continuity validation (tokenOut of hop N ≠ tokenIn of hop N+1) |
| UniswapFuelSwap | Case C WETH validation incomplete |
| UniswapFuelSwap | Unrestricted `receive()` — anyone can send ETH |
| TokenPortal | CleanHands signature has no domain separation (replay across chains) |
| TokenPortal | Passport deadline edge case (block.timestamp == deadline passes) |
| TokenPortal | `verifyCleanHandsSignature` is public (should be internal) |
| TokenPortal | `msg.sender` inconsistency between deposit variants |
| TokenPortal | Fee changes take effect immediately (no timelock) |

---

## Missing Functions / Future Needs

### L1 Contracts

| Contract | Missing Function | Priority |
|----------|-----------------|----------|
| SwapBridgeRouter | `pause()` / `unpause()` emergency circuit breaker | **High** |
| SwapBridgeRouter | Portal whitelist (prevent arbitrary portal addresses) | **High** |
| SwapBridgeRouter | Sweep event for stuck tokens | Medium |
| SwapBridgeRouter | `version()` view function | Low |
| UniswapFuelSwap | `pause()` mechanism | **High** |
| UniswapFuelSwap | Deadline parameter on all swaps | **High** |
| UniswapFuelSwap | Per-hop `sqrtPriceLimit` for tighter slippage | Medium |
| UniswapFuelSwap | `swapExactOutput()` variant | Medium |
| UniswapFuelSwap | `validateRoute()` view for UI pre-validation | Medium |
| UniswapFuelSwap | Hooks allowlist | Low |
| TokenPortal | `refreshRollup()` to update stale rollup reference | **High** |
| TokenPortal | Fee change timelock | **High** |
| TokenPortal | Emergency withdraw for stuck deposits | Medium |
| TokenPortal | `getDepositInfo()` view function | Low |
| TokenPortal | Surplus fee sweep | Low |
| TokenPortal | Batch withdraw | Low |
| PoolSeeder | `removeLiquidity()` for pool migration | **High** |
| PoolSeeder | `adjustLiquidity()` to rebalance without redeploy | Medium |
| Deploy Scripts | Mainnet address checklist / verification | **High** |
| Deploy Scripts | `pauseAllPortals` emergency script | **High** |

### L2 Aztec Contracts

| Contract | Missing Function | Priority |
|----------|-----------------|----------|
| TokenMinterProxy | Ownership transfer (`transferOwnership`) | **Critical** |
| TokenMinterProxy | Mutable token address (`setToken`) | **High** |
| TokenBridge | CleanHands on public claims and exits | **Critical** |
| TokenBridge | Emergency token recovery | Medium |
| TokenBridge | Cumulative spend tracking per epoch | Medium |
| TokenBridge | Event emissions for all state changes | Low |

---

## Top 5 Actions Before Mainnet

1. **Add pause/unpause to all L1 contracts** — No emergency stop exists on any contract
2. **Fix nonce-burning-on-invalid-signature** on both L1 TokenPortal and L2 TokenBridge — validate before consuming
3. **Add ownership transfer to TokenMinterProxy** — currently a single point of failure
4. **Add CleanHands compliance to `exit_to_l1_public`** — sanctioned addresses can bypass compliance via the public exit path
5. **Restrict `unlockCallback` on PoolSeeder** — currently exploitable by anyone who can trigger the callback
