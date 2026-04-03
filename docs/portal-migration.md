# Portal Migration: Handling Aztec Rollup Upgrades

## Why This Exists

Aztec upgrades their rollup periodically. Unlike a typical smart contract upgrade, **Aztec rollup upgrades do not copy L2 chain state** — user balances, notes, and contract storage on the old rollup are not automatically carried over to the new rollup.

This means:
- Users holding tokens on the old L2 must **withdraw to L1 before the old rollup is shut down**.
- New L1 deposits must be directed to **new portal contracts** that point to the new rollup.
- The old portals must enter a **withdrawals-only mode** during the migration window.

---

## The 1-Portal-Per-Version Model

Each Aztec rollup version gets its own set of L1 portal contracts (one portal per token). This is strictly preferred over maintaining a single portal that "follows" the latest rollup because:

1. **Isolation**: Old-version withdrawal proofs reference the old rollup's outbox. A shared portal would need to handle multiple outbox addresses simultaneously.
2. **Simplicity**: New portals are clean-slate deployments with fresh initialization. No migration logic needed in the contract itself.
3. **Safety**: Old portals remain live and functional for the entire withdrawal window. There is no risk of breaking in-progress operations.
4. **Auditability**: Each deployment is versioned in `bridge-script/deployments/registry.json` with a full snapshot of contract addresses.

---

## Pause Levels

`TokenPortal.sol` supports two distinct pause mechanisms:

| Function | Blocks deposits | Blocks withdrawals | When to use |
|---|---|---|---|
| `pauseDeposits()` | ✅ Yes | ❌ No | Rollup upgrade — migration window |
| `pause()` | ✅ Yes | ✅ Yes | Security emergency only |

During a migration, **always use `pauseDeposits()`**, not `pause()`. Using `pause()` during an upgrade would prevent users from withdrawing their funds, which is unacceptable.

---

## Operator Runbook

### When Aztec Announces an Upgrade

**Step 1 — Announce to users**

Communicate the timeline:
- Date deposits will be paused on the old rollup
- Date the new rollup goes live (and new deposits open)
- Deadline for users to withdraw from the old L2 (before old rollup shutdown)

**Step 2 — Pause deposits on old portals**

During the delay window, run the migration script:

```bash
cd bridge-script
node --import tsx pause-portals.ts <old-deployment-id>
```

Or to pause the currently active deployment:

```bash
node --import tsx pause-portals.ts
```

This will:
1. Call `pauseDeposits()` on every token portal in the deployment
2. Update the deployment JSON (`depositsPaused: true` per token)
3. Sync changes to the frontend

At this point, the old portals accept only withdrawals.

**Step 3 — Deploy on new rollup**

Run the main deployment script with the new Aztec version:

```bash
node --import tsx index-testnet-compliant.ts
```

This creates a new deployment entry in the registry, deploys fresh L1 portals pointing to the new rollup, deploys fresh L2 contracts (TokenBridge, TokenMinterProxy, Token), and marks the new deployment as active.

**Step 4 — Sweep collected fees from old portals**

Before decommissioning, sweep any protocol fees accumulated in old portals:

```solidity
// For each old portal (call as owner):
portal.withdrawFees();
```

**Step 5 — Monitor withdrawal completion**

Old portals remain live indefinitely (they are immutable on-chain). Monitor that the remaining L2 balance has drained via the old portals before declaring the migration complete.

---

## User Guide

### "I have tokens on the old L2 — what do I do?"

You must exit your tokens from the old L2 to L1 **before the old rollup is shut down**.

1. Go to the bridge UI and select "Withdraw" (L2 → L1 direction).
2. Initiate `exit_to_l1_public` or `exit_to_l1_private` on your L2 balance.
3. Wait for the L2→L1 message to be included in an L1 block.
4. Complete the withdrawal on L1 via the portal's `withdraw()` function.

Withdrawals work on old portals **even after deposits are paused**. There is no rush on the withdrawal itself once the L2 exit transaction is submitted.

### "I have a pending L1→L2 deposit on the old portal — what happens?"

**In-flight L1→L2 messages are at risk if you don't act quickly.** These are messages that have been sent to the old L1 inbox but have not yet been claimed on the old L2.

- The message exists on the old rollup's inbox.
- It can **only** be claimed on the old L2. It cannot be transferred to the new rollup.
- If you do not claim it before the old rollup shuts down, the tokens remain locked in the old portal.

Action: claim your L1→L2 message on the old L2 as soon as possible, then initiate a withdrawal back to L1 before the rollup shutdown deadline.

### "I deposited via SwapBridgeRouter — is my fuel swap affected?"

Yes. `SwapBridgeRouter.bridgeWithFuel()` calls `depositToAztecPrivateFor()` on the portal, which respects the deposit pause. Attempting a new bridge+fuel operation after `pauseDeposits()` has been called will revert.

Your existing in-flight deposits are unaffected — they were already sent to the L2 inbox.

---

## Nuances and Edge Cases

### `rollupVersion` is cached at portal initialization

Each portal caches the rollup version at `initialize()` time:

```solidity
rollupVersion = rollup.getVersion();
```

This version is embedded in every L1→L2 and L2→L1 message. It means:
- Old portals always reference the old rollup's outbox — withdrawal proofs from old L2 blocks are always valid against the old portal.
- New portals reference the new rollup — they cannot process messages from the old rollup.
- There is no cross-version message confusion.

### L2 Noir contracts require no source changes

`token_bridge/src/main.nr` and `token_minter_proxy/src/main.nr` have no hardcoded rollup-version dependencies. They read `config.portal` (set at constructor time) and call `context.message_portal()` — both of which work correctly across rollup versions.

For a new rollup, deploy the **same Noir source** with updated constructor arguments:
- New `token_minter_proxy` address (fresh deployment on new L2)
- New `portal` address (new L1 portal)
- Same attestation keys (`human_id_attester`, `passport_signer`)

### Emergency `pause()` vs migration `pauseDeposits()`

Do not conflate these:

| | `pauseDeposits()` | `pause()` |
|---|---|---|
| Deposits blocked | ✅ | ✅ |
| Withdrawals blocked | ❌ | ✅ |
| Use case | Rollup migration | Security incident |
| Event emitted | `DepositsBlocked` | `Paused` |
| Recovery | `unpauseDeposits()` | `unpause()` |

During a security incident affecting withdrawal logic (e.g., a compromised outbox), use `pause()`. During a planned rollup upgrade, always use `pauseDeposits()`.

### Fee accounting on decommissioned portals

Collected fees are stored in the portal contract in `collectedFees`. They are **not automatically withdrawn**. Call `withdrawFees()` as the owner before treating a portal as decommissioned. Fees can still be withdrawn at any time — there is no deadline.

### Deployment registry

The deployment registry lives at `bridge-script/deployments/registry.json`. It tracks all deployments with their `active` flag and the current `activeDeploymentId`. The `pause-portals.ts` script updates the deployment JSON in-place (sets `depositsPaused: true` per token) and runs `copyToFrontend()` to sync the state to `frontend/src/constants/deployments.json`.

Old deployment files are never deleted — they remain as historical records of contract addresses for all versions.
