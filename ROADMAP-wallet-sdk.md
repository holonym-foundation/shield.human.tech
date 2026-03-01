# Wallet-SDK Improvements Roadmap

Post-migration improvements for the Aztec wallet-sdk integration.
Each item includes research findings, user flow design, and implementation plan.

---

## 1. Separate Connection Verification from Account Selection

### Problem

Currently, confirming the emoji grid does two things in one step:
1. Validates the secure channel (anti-MITM) between dApp and wallet extension
2. Immediately selects the first account and connects

These are conceptually different actions. The emoji verification says "yes, I'm talking to the right wallet extension" — it does NOT mean "use this account for everything". This conflation skips the user's ability to choose which account to use.

### How the SDK Actually Works

```
Discovery ──> Secure Channel ──> Emoji Verify ──> confirm() ──> Wallet object
                                                                     │
                                                  requestCapabilities() ← grants accounts
                                                  getAccounts()         ← lists accounts
```

- `PendingConnection.confirm()` returns a `Wallet` — a proxy to the extension. This is a **session**, not an account selection.
- `wallet.requestCapabilities()` returns `GrantedAccountsCapability.accounts: Aliased<AztecAddress>[]` — the wallet tells us which accounts it grants.
- `wallet.getAccounts()` returns `Aliased<AztecAddress>[]` — all accounts available.

The `Wallet` object is wallet-scoped, not account-scoped. You can call `getAccounts()` multiple times and interact with any granted account.

### Proposed User Flow

```
┌─────────────────────────────────────────────────────────┐
│  CURRENT FLOW (conflated)                                │
│                                                          │
│  Discover → Select Wallet → Verify Emojis → Connected   │
│              (if >1)         (+ auto-pick account[0])    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  PROPOSED FLOW (separated)                               │
│                                                          │
│  Discover → Select Wallet → Verify Emojis → Channel OK  │
│              (if >1)         (MITM check)     │          │
│                                               ▼          │
│                              Request Capabilities        │
│                                               │          │
│                                               ▼          │
│                              Select Account → Connected  │
│                              (if >1 account)             │
│                              (show aliases)              │
└─────────────────────────────────────────────────────────┘
```

### New Connection Phases

```typescript
export type WalletConnectionPhase =
  | 'idle'
  | 'discovering'     // scanning for wallet extensions
  | 'selecting'       // user picks which wallet (if >1)
  | 'verifying'       // emoji grid — verifying secure channel
  | 'requesting'      // NEW — requestCapabilities in progress
  | 'account-select'  // NEW — user picks which account (if >1)
  | 'connected'       // done — wallet + account selected
```

### Files Modified

| File | Changes |
|------|---------|
| `stores/walletStore.ts` | Add `'requesting'` and `'account-select'` phases. Split `confirmWalletConnection()` into `confirmChannel()` + `selectAccount()`. Store `grantedAccounts: Aliased<AztecAddress>[]` in state. |
| `components/model/EmojiVerificationModal.tsx` | Update button text from "Confirm Match" to "Verify Connection". Update subtitle to clarify this is a security check, not account selection. |
| `components/model/AccountSelectorModal.tsx` | **NEW** — Shows account list with aliases. Auto-selects if only 1 account. |
| `app/page.tsx` | Add rendering for `'requesting'` (spinner) and `'account-select'` (new modal) phases. |
| `utils/walletSdkConnection.ts` | No changes needed — connection primitives stay the same. |

### Implementation Steps

1. Add new phases to `WalletConnectionPhase` type
2. Add `grantedAccounts` to wallet store state
3. Refactor `confirmWalletConnection()`:
   - After `confirm()`, move to `'requesting'` phase
   - After `requestCapabilities()`, if >1 account → `'account-select'`, else auto-select
4. Create `AccountSelectorModal` component (show alias + truncated address)
5. Create `selectAccount(account)` action that completes connection with chosen account
6. Update `EmojiVerificationModal` copy to clarify it's a security verification
7. Wire new phases into `page.tsx` rendering

### Considerations

- Single-account wallets should feel seamless — no extra click required
- The `'requesting'` phase may be instant if the wallet auto-grants; show a brief spinner with "Requesting permissions..."
- If `requestCapabilities()` fails, fall back to `getAccounts()` (already implemented)

---

## 2. Account Selector & Alias Display

### Problem

After establishing a secure connection, the app blindly takes `accounts[0]`. Users with multiple accounts have no way to choose which one to use. Additionally, we display raw hex addresses everywhere instead of leveraging the `alias` field that the wallet-sdk provides.

### What the SDK Provides

```typescript
type Aliased<T> = {
  alias: string    // Human-readable name, e.g. "Main Account", "Trading"
  item: T          // The actual AztecAddress
}

wallet.getAccounts(): Promise<Aliased<AztecAddress>[]>
// Also available from requestCapabilities → GrantedAccountsCapability.accounts
```

### Proposed User Flow

**Connection-time account selection** (covered in Item 1 above):
- After emoji verification + capabilities, show account picker if >1 account
- Each row: alias name + truncated address + copy button

**Post-connection account switching** (Header dropdown):
```
┌──────────────────────────────┐
│  🔵 Main Account             │  ← current, shown in header
│     0x1a2b...f4e5            │
├──────────────────────────────┤
│  Copy Address                │
│  Switch Account  ►           │  ← NEW: opens account list
│  Disconnect                  │
└──────────────────────────────┘

        │ "Switch Account" opens:
        ▼
┌──────────────────────────────┐
│  Select Account              │
├──────────────────────────────┤
│  ✓ Main Account              │  ← current
│    0x1a2b...f4e5             │
│                              │
│    Trading                   │
│    0x9c8d...b3a2             │
│                              │
│    DeFi Vault                │
│    0x7e6f...d1c0             │
└──────────────────────────────┘
```

**Display changes** (everywhere we show the L2 address):
- Primary display: **alias** (e.g., "Main Account")
- Secondary/tooltip: truncated address
- "Copy Address" still copies the full hex address

### Files Modified

| File | Changes |
|------|---------|
| `stores/walletStore.ts` | Store `aztecAlias: string \| null`, `availableAccounts: Aliased<AztecAddress>[]`. Add `switchAztecAccount(account)` action. |
| `components/Header.tsx` | Show alias instead of address in `WalletDisplay`. Add "Switch Account" to dropdown when `availableAccounts.length > 1`. |
| `components/model/AccountSelectorModal.tsx` | **NEW** — Reusable account list (used both at connection time and from Header). |
| `app/page.tsx` | Render `AccountSelectorModal` when phase is `'account-select'`. |
| `hooks/useWalletAdapter.ts` | Update queryKey to include selected account address (adapter must be rebuilt on account switch). |
| `utils/walletAdapters.ts` | `createWalletAdapter()` should accept the selected account address, not always use `accounts[0]`. |

### Implementation Steps

1. Add `aztecAlias`, `availableAccounts` to wallet store state
2. Store all accounts from `requestCapabilities`/`getAccounts` response
3. Create `AccountSelectorModal` component:
   - Props: `accounts: Aliased<AztecAddress>[]`, `selectedAddress: string`, `onSelect`, `onClose`
   - Show alias as primary text, truncated address as secondary
   - Highlight current selection with checkmark
4. Update `confirmWalletConnection` to store alias alongside address
5. Update `Header.tsx` `WalletDisplay`:
   - Show alias as primary label (fall back to truncated address if no alias)
   - Add "Switch Account" option to dropdown (visible when >1 account)
6. Add `switchAztecAccount(account: Aliased<AztecAddress>)` store action:
   - Updates `aztecAddress`, `aztecAlias`, rebuilds `connectedAccount`
   - Does NOT re-establish secure channel (wallet session persists)
   - Invalidates wallet adapter query (triggers rebuild with new account)
7. Update `createWalletAdapter` to accept explicit account address
8. Ensure `useWalletAdapter` queryKey includes account address for proper cache invalidation

### Considerations

- Account switching should NOT require re-discovery or re-verification — the `Wallet` object persists
- The `WalletAdapter` holds a specific `AztecAddress` for `from:` in simulate/send calls — it MUST be rebuilt when switching accounts
- All React Query caches keyed by `aztecAddress` will auto-invalidate when the address changes
- Consider persisting the selected account alias in localStorage alongside `aztecLoginMethod`

---

## 3. Least-Privilege Capability Manifest

### Problem

The current `requestCapabilities()` call uses wildcards (`'*'`) for contracts, simulation, and transactions:

```typescript
// CURRENT — overly permissive
capabilities: [
  { type: 'accounts', canGet: true, canCreateAuthWit: true },
  { type: 'contracts', contracts: '*', canRegister: true },
  { type: 'simulation', transactions: { scope: '*' }, utilities: { scope: '*' } },
  { type: 'transaction', scope: '*' },
]
```

This is equivalent to "let this app do anything with any contract" — far more permission than needed.

### What We Actually Do

**Token contract** (`L1_TOKENS[i].l2TokenContract`):
| Method | Type | Usage |
|--------|------|-------|
| `balance_of_private` | simulate (utility) | Query private balance |
| `balance_of_public` | simulate (utility) | Query public balance |
| `transfer` | transaction | Public token transfer |
| `transfer_to_private` | transaction | Private token transfer |
| `burn_public` | auth witness (bridge calls this) | L2→L1 public withdrawal |
| `burn_private` | auth witness (bridge calls this) | L2→L1 private withdrawal |

**Bridge contract** (`L1_TOKENS[i].l2BridgeContract`):
| Method | Type | Usage |
|--------|------|-------|
| `claim_public` | transaction | Claim L1→L2 deposited tokens (public) |
| `claim_private` | transaction | Claim L1→L2 deposited tokens (private) |
| `exit_to_l1_public` | transaction | Initiate L2→L1 withdrawal (public) |
| `exit_to_l1_private` | transaction | Initiate L2→L1 withdrawal (private) |

**Contract registration**: We register both token and bridge contracts with the wallet PXE.

### Proposed Capability Manifest

```typescript
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { L1_TOKENS } from '@/config'

function buildCapabilityManifest() {
  // Collect all L2 contract addresses we interact with
  const tokenAddresses = L1_TOKENS.map(t => AztecAddress.fromString(t.l2TokenContract))
  const bridgeAddresses = L1_TOKENS.map(t => AztecAddress.fromString(t.l2BridgeContract))
  const allContracts = [...tokenAddresses, ...bridgeAddresses]

  return {
    version: '1.0' as const,
    metadata: {
      name: 'Aztec Bridge',
      version: '1.0.0',
      description: 'Bridge assets between L1 and Aztec L2',
      url: typeof window !== 'undefined' ? window.location.origin : '',
    },
    capabilities: [
      // Accounts: need to get accounts and create auth witnesses for withdrawals
      { type: 'accounts', canGet: true, canCreateAuthWit: true },

      // Contracts: register only the specific token + bridge contracts
      { type: 'contracts', contracts: allContracts, canRegister: true },

      // Simulation: only balance queries on token contracts
      {
        type: 'simulation',
        transactions: { scope: [] },  // we don't simulate transactions
        utilities: {
          scope: tokenAddresses.map(addr => ({
            contract: addr,
            methods: ['balance_of_private', 'balance_of_public'],
          })),
        },
      },

      // Transactions: specific methods on token + bridge contracts
      {
        type: 'transaction',
        scope: [
          ...tokenAddresses.map(addr => ({
            contract: addr,
            methods: ['transfer', 'transfer_to_private', 'burn_public', 'burn_private'],
          })),
          ...bridgeAddresses.map(addr => ({
            contract: addr,
            methods: ['claim_public', 'claim_private', 'exit_to_l1_public', 'exit_to_l1_private'],
          })),
        ],
      },
    ],
  }
}
```

### Files Modified

| File | Changes |
|------|---------|
| `stores/walletStore.ts` | Replace inline capabilities object with call to `buildCapabilityManifest()`. |
| `utils/walletCapabilities.ts` | **NEW** — `buildCapabilityManifest()` function. Imports `L1_TOKENS` from config. |
| `config/index.ts` | No changes — already exports `L1_TOKENS` with `l2TokenContract` and `l2BridgeContract`. |

### Implementation Steps

1. **Research**: Verify `ContractFunctionPattern` type structure in SDK — confirm it accepts `{ contract: AztecAddress, methods: string[] }` format (check `@aztec/aztec.js/wallet/capabilities.d.ts`)
2. Create `utils/walletCapabilities.ts` with `buildCapabilityManifest()`:
   - Dynamically reads contract addresses from `L1_TOKENS` config
   - Builds scoped patterns for simulation and transaction capabilities
3. Update `confirmWalletConnection()` in `walletStore.ts` to use `buildCapabilityManifest()`
4. Test that the wallet extension accepts the scoped manifest (some wallets may reject unfamiliar scope formats — need a `'*'` fallback)
5. Add a fallback: if scoped `requestCapabilities()` throws, retry with wildcard scope and log a warning

### Considerations

- The `ContractFunctionPattern` type may require exact `AztecAddress` objects, not strings — verify against SDK types
- If future tokens are added (multi-token bridge), the manifest auto-adapts because it reads from `L1_TOKENS` config
- Some wallet extensions may not support scoped capabilities yet (spec is new) — keep the wildcard fallback
- The `simulation.transactions` scope is empty because we use `simulateUtility` (view functions), not `simulateTx` for balance queries
- Auth witness creation is gated by the `accounts` capability's `canCreateAuthWit: true`, not by the transaction scope

---

## Execution Priority

| Priority | Item | Reason |
|----------|------|--------|
| 1 | Item 3 — Least-privilege capabilities | Smallest change, no UI work, immediate security improvement |
| 2 | Item 1 + 2 — Connection flow + accounts | These are intertwined and should be done together |

Items 1 and 2 share the `AccountSelectorModal` component and the wallet store refactor, so they should be implemented as a single feature branch.

---

## Pre-Implementation Research Checklist

Before starting implementation, verify these with the actual SDK:

- [ ] `ContractFunctionPattern` type — does it accept `{ contract: AztecAddress, methods: string[] }` or a different shape?
- [ ] Does the demo-wallet / Aztec Keychain extension support scoped capabilities, or does it only handle `'*'`?
- [ ] Can `wallet.getAccounts()` be called multiple times after `confirm()`? (Needed for account switching)
- [ ] Does switching the `from: account` in `simulateView` / `sendTx` work without re-establishing the secure channel?
- [ ] What happens if a wallet has 0 accounts granted via `requestCapabilities` — does `getAccounts()` still return accounts?
