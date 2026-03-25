# PR #10: Wallet-SDK + Uniswap V4 Fuel Swap + Witness-Bound Permit2

A complete guide to the three major features introduced in this PR.

---

## What Is This Project? (Start Here)

Imagine you have dollars (USDC) in a bank (Ethereum) and you want to move them to a private vault (Aztec). That's what a **bridge** does — it moves your money from one blockchain to another.

But there's a catch: the private vault (Aztec) uses its own currency for fees, called **FeeJuice**. It's like going to a foreign country — you need local currency to do anything. If you arrive with only dollars and zero local currency, you're stuck. You can't even pick up your own suitcase (claim your tokens).

**This PR solves three problems:**

1. **Wallet Connection** (Wallet-SDK) — How does the website talk to your Aztec wallet? Think of it like plugging in a USB cable between the website and your wallet app. Before this PR, only one specific wallet brand worked. Now, any wallet brand can plug in.

2. **Gas Top-Up** (Fuel Swap) — When you bridge your dollars, a small portion is automatically converted into local currency (FeeJuice) so you can actually use your money when you arrive. It's like an airport currency exchange booth built right into the bridge.

3. **Tamper-Proof Signatures** (Witness-Bound Permit2) — When you sign a permission slip saying "move my money," the signature locks in EVERY detail: where it goes, how much is exchanged, who receives it. Nobody can change anything after you sign. It's like signing a check where the amount, recipient, and purpose are all written in permanent ink.

---

## How Everything Connects (The Simple Version)

```
YOU have 100 USDC on Ethereum
    |
    | "I want to bridge 100 USDC to Aztec, keep $5 as gas money"
    |
    v
[1] WALLET CONNECTION (Wallet-SDK)
    Your browser connects to your Aztec wallet app.
    Like pairing a Bluetooth device — they verify each other with matching emojis.
    |
    v
[2] SIGN PERMISSION (Permit2 + Witness)
    You sign ONE message that says:
    "Take 100 USDC from me. Send 95 to my Aztec address. Convert 5 to gas."
    Every detail is locked in — nobody can change it.
    |
    v
[3] MONEY MOVES (Fuel Swap + Bridge)
    One transaction on Ethereum does everything:
    - 5 USDC → swapped to FeeJuice (gas) via Uniswap pools
    - 95 USDC → locked in a vault (TokenPortal) for Aztec to pick up
    - Both are sent as messages to Aztec
    |
    v
[4] ARRIVE ON AZTEC
    ~20 minutes later, Aztec processes the messages.
    You click "Claim" and your wallet uses the gas (FeeJuice) to claim your 95 USDC.
    |
    v
[5] DONE!
    You now have: 95 USDC + leftover gas on Aztec.
    You can send, trade, or use your tokens privately.
```

---

## Table of Contents

- [Quick Start: Full Flow from Zero to Working Bridge](#quick-start-full-flow-from-zero-to-working-bridge)
- [Glossary](#glossary)
- [Feature 1: Wallet-SDK Migration](#feature-1-wallet-sdk-migration)
- [Feature 2: Uniswap V4 Fuel Swap](#feature-2-uniswap-v4-fuel-swap)
- [Feature 3: Witness-Bound Permit2](#feature-3-witness-bound-permit2)
- [How All Three Features Work Together](#how-all-three-features-work-together)
- [Recovery Architecture](#recovery-architecture)
- [Deployment & Setup Guide](#deployment--setup-guide)
- [Liquidity Pool Seeding Guide](#liquidity-pool-seeding-guide)
- [All Scripts Reference](#all-scripts-reference)
- [PR vs Local Audit Report](#pr-vs-local-audit-report)
- [Key Files Reference](#key-files-reference)

---

## Quick Start: Full Flow from Zero to Working Bridge

This section walks you through the entire process, from a fresh checkout to a fully working bridge where users can deposit tokens from Ethereum to Aztec with automatic gas top-up. Read this first if you're new.

### The Big Picture

```
┌─────────────────────────────────────────────────────────────────┐
│                    What You're Building                          │
│                                                                 │
│  User has USDC on Ethereum (L1)                                 │
│       │                                                         │
│       ▼                                                         │
│  [Bridge UI] ── "Bridge 100 USDC with $5 gas top-up"           │
│       │                                                         │
│       ├── 95 USDC ──────────────────────► L2: 95 USDC          │
│       │                                                         │
│       └── 5 USDC ── Uniswap V4 swap ──► L2: FeeJuice (gas)    │
│                                                                 │
│  User arrives on L2 with tokens + gas to use them               │
└─────────────────────────────────────────────────────────────────┘
```

Without gas top-up, users land on L2 with tokens but **no way to spend them** (every L2 action needs FeeJuice gas). The fuel swap solves this chicken-and-egg problem.

---

### Prerequisites

Before starting, make sure you have:

| What | Why |
|------|-----|
| **Node.js 18+** | Runs the TypeScript deploy scripts |
| **pnpm** | Package manager (used across all packages) |
| **Foundry (forge)** | Compiles L1 Solidity contracts |
| **An Aztec node running** | The deploy script connects to it for L2 deploys |
| **Sepolia ETH in a wallet** | Pool seeding needs ~0.2 ETH (0.05 for ETH/FJ pool + 0.15 wrapped to WETH for USDC/WETH pool), plus gas for all deploy txns. **~0.5 ETH recommended minimum.** |
| **A private key** | The deployer account (set as `L1_PRIVATE_KEY` env var) |

#### Pool Seed Amounts

The script seeds two Uniswap V4 pools with these amounts:

| Pool | Asset 1 | Asset 2 | Deployer Cost |
|------|---------|---------|---------------|
| ETH / FeeJuice | 0.05 ETH | 15,000 FJ (minted via FeeAssetHandler) | 0.05 ETH |
| USDC / WETH | 500 USDC (minted by TestERC20) | 0.15 WETH (wrapped from ETH) | 0.15 ETH |

> FeeJuice and USDC are minted on-chain (testnet tokens), so they don't cost real ETH. The deployer only needs **~0.2 ETH + gas** in their Sepolia wallet.
>
> **Liquidity cannot be withdrawn.** The PoolSeeder is a one-shot deploy-and-seed helper contract — it has no remove-liquidity function. V4 liquidity withdrawal requires a PositionManager, which we don't use. This is why the seed amounts are kept small on testnet.

#### Topping Up Liquidity Later

The initial seed is done automatically by `pnpm start-devnet`. To add more liquidity later (e.g. pools are running low), use the standalone `seed-pools` script:

```bash
cd bridge-script
AZTEC_ENV=devnet L1_PRIVATE_KEY=0x... pnpm seed-pools
```

This is **idempotent** — if the pool already exists, it skips pool creation and just adds more liquidity on top.

You can customize amounts per run via env vars:

```bash
# Top up ETH/FeeJuice pool with more liquidity
ETH_SEED=100000000000000000 FEE_MINT_COUNT=30 pnpm seed-pools

# Top up only one ERC20 pool, skip ETH/FeeJuice
SKIP_ETH_AZTEC=true ERC20_TOKEN=0x<token_address> pnpm seed-pools
```

Check current pool levels anytime:

```bash
pnpm check-pools
```

| Command | What it does |
|---------|-------------|
| `pnpm start-devnet` | Initial deploy + seed (runs once) |
| `pnpm seed-pools` | Top up existing pools (run anytime) |
| `pnpm check-pools` | Read-only check of pool balances |

---

### Step-by-Step Flow

#### Step 0: Install & Build

```bash
# 1. Install all dependencies
pnpm install

# 2. Build the L1 Solidity contracts (creates the ABI JSON files)
cd l1-contracts
forge build
cd ..

# 3. Compile L2 Aztec contracts + generate TypeScript bindings
cd bridge-script
pnpm run build    # compiles L2 contracts + codegen
cd ..
```

> **Why `forge build` first?** The TypeScript scripts import ABI files from `l1-contracts/out/`. Without building, you get `Cannot find module` errors.

---

#### Step 1: Deploy Everything (The One-Command Option)

The fastest path — one script deploys all L1 contracts, L2 contracts, swap infrastructure, and seeds the pools:

```bash
cd bridge-script

AZTEC_ENV=devnet \
L1_PRIVATE_KEY=0xYOUR_PRIVATE_KEY \
pnpm start-devnet
```

**What this does (in order):**

| # | What happens | Where |
|---|-------------|-------|
| 1 | Connects to Aztec node, reads L1 addresses (Registry, Rollup, FeeJuice, etc.) | L1 + L2 |
| 2 | Deploys a Schnorr account on L2 (your deployer identity) | L2 |
| 3 | Creates deployment file (`deployments/<version>_<date>.json`) | Local |
| 4 | **For each token** (USDC, USDT, DAI, HUMN, GOAT, WBTC, WETH): | |
|   | → Deploys L1 TestERC20 (or uses real WETH) | L1 |
|   | → Deploys L1 FeeAssetHandler | L1 |
|   | → Deploys L1 TokenPortal | L1 |
|   | → Deploys L2 Token contract | L2 |
|   | → Deploys L2 TokenBridge contract | L2 |
|   | → Sets bridge as minter on L2 token | L2 |
|   | → Initializes L1 portal (wires token ↔ bridge ↔ registry) | L1 |
| 5 | Deploys **UniswapFuelSwap** (the on-chain swap executor) | L1 |
| 6 | Deploys **SwapBridgeRouter** (the user-facing entry point) | L1 |
| 7 | Registers **BridgedFPC** on L2 (private fee payment) | L2 |
| 8 | **Seeds Uniswap V4 pools** with liquidity | L1 |
|   | → Pool 1: ETH / FeeJuice (~0.05 ETH + 15k FeeJuice) | |
|   | → Pool 2: USDC / WETH (~500 USDC + 0.15 WETH) | |
| 9 | **Sets trusted forwarders** on all token portals (SwapBridgeRouter → allowed) | L1 |
| 10 | Copies deployment JSON to `frontend/src/constants/` | Local |
| 11 | Runs a test bridge (L1→L2 deposit of first token) | L1→L2 |

After this completes, you have a fully working bridge. Trusted forwarders are set automatically as part of step 8.

> **If you need to re-run trusted forwarder setup separately** (e.g. after adding a new token portal), use: `pnpm set-trusted-forwarders`. Must use the same private key that deployed the portals.

---

#### Step 2: Verify Pools Have Liquidity

```bash
cd bridge-script
pnpm check-pools
```

You should see output like:
```
PoolManager ETH balance: 0.30 ETH
PoolManager AZTEC balance: 100000.00 FJ
PoolManager WETH balance: 1.50 WETH
USDC: 5000.00 in PoolManager ✅
```

If any pool shows `❌ NO LIQUIDITY`, re-seed:
```bash
AZTEC_ENV=devnet L1_PRIVATE_KEY=0x... pnpm seed-pools
```

---

#### Step 3: Start the Frontend

```bash
cd frontend
pnpm install
pnpm dev
```

The frontend reads contract addresses from `frontend/src/constants/deployments.json` (copied in Step 1). Users can now:

1. Connect their Aztec wallet (via Wallet-SDK)
2. Pick a token (USDC, WETH, etc.)
3. Enable "Top up gas balance" toggle
4. Sign one Permit2 message
5. Bridge tokens + gas in a single L1 transaction

---

### What If I Only Need to Redeploy Part of It?

| Scenario | What to run |
|----------|-------------|
| **Fresh start** (no contracts exist) | `pnpm start-devnet` (Step 1 above) |
| **Just redeploy a portal + bridge** (contract upgrade) | `pnpm redeploy-permit2` — deploys fresh portal + bridge, keeps swap infra |
| **Just add more liquidity** | `pnpm seed-pools` — adds tokens to existing pools |
| **Deploy swap infra only** (fuel swap + router) | `pnpm deploy-fuel-swap` then `pnpm deploy-swap-router` |
| **Add a new token** | Add to `constants/tokens.ts`, re-run `pnpm start-devnet` (skips existing tokens) |
| **Trusted forwarder not set** | `pnpm set-trusted-forwarders` |
| **Check if pools are healthy** | `pnpm check-pools` |

---

### Common Gotchas for Beginners

| Problem | What it means | Fix |
|---------|--------------|-----|
| `Cannot find module .../SwapBridgeRouter.json` | L1 contracts not compiled | Run `cd l1-contracts && forge build` |
| "Swap amount exceeds pool liquidity" | V4 pools are empty or drained | Run `pnpm seed-pools` or use a smaller fuel amount |
| `NotTrustedForwarder` error | Router not allowlisted on portal | Run `pnpm set-trusted-forwarders` |
| "OwnableUnauthorizedAccount" | Wrong private key for portal owner | Use the same key that ran the initial deploy |
| Pool seeding fails with nonce errors | Forge batches txns, RPC rejects | Use `pnpm seed-pools` (TS version) instead of Forge |
| Token deploy skipped | Already in deployment file | Set `forceDeploy: true` in `constants/tokens.ts` |
| L2 deploy hangs | Aztec node not synced or unreachable | Check `AZTEC_ENV` and node URL in config |

---

### Architecture Diagram (What Contracts Exist After Deployment)

```
ETHEREUM (L1)                                    AZTEC (L2)
─────────────────────────────────────────────────────────────────

┌──────────────┐    ┌────────────────┐
│  TestERC20   │    │  TokenPortal   │◄─── initialized with
│  (USDC)      │    │  (per token)   │     registry + token + L2 bridge
└──────┬───────┘    └───────┬────────┘
       │                    │
       │              deposit/withdraw
       │                    │
       │                    ▼                    ┌──────────────┐
       │            ┌───────────────┐            │ TokenBridge  │
       │            │ L1↔L2 Message │◄──────────►│ (per token)  │
       │            │   Passing     │            └──────┬───────┘
       │            └───────────────┘                   │
       │                                          mints/burns
       │                                                │
       │                                                ▼
       │                                         ┌──────────────┐
       │                                         │ Token (L2)   │
       │                                         │ (per token)  │
       │                                         └──────────────┘

┌──────────────────────┐
│  SwapBridgeRouter    │◄── User calls this (via Permit2 signature)
│  (single instance)   │
└──────────┬───────────┘
           │
           │ pulls tokens via Permit2
           │ calls UniswapFuelSwap for gas portion
           │ calls TokenPortal for token portion
           │
           ▼
┌──────────────────────┐    ┌──────────────────┐
│  UniswapFuelSwap     │───►│ Uniswap V4       │
│  (single instance)   │    │ PoolManager      │    ┌──────────────┐
└──────────────────────┘    │                  │    │ BridgedFPC   │
                            │ Pool: ETH/FJ     │    │ (L2, private)│
                            │ Pool: USDC/WETH  │    │ pays gas for │
                            │ Pool: USDT/WETH  │    │ claim tx     │
                            └──────────────────┘    └──────────────┘
```

---

### The Complete User Flow (What Happens When Someone Bridges)

```
User clicks "Bridge 100 USDC with $5 gas top-up"
    │
    ▼
[1] Frontend builds a Permit2 witness message
    │   - Contains: token, amount, fuel amount, L2 recipient, claim secret hash
    │   - User signs ONE EIP-712 message in their Ethereum wallet
    │
    ▼
[2] Frontend calls SwapBridgeRouter.depositWithFuel()
    │   - Router pulls 100 USDC from user via Permit2
    │   - Splits into: 95 USDC (bridge) + 5 USDC (fuel)
    │
    ▼
[3] Fuel portion: 5 USDC → FeeJuice
    │   - Router sends 5 USDC to UniswapFuelSwap
    │   - UniswapFuelSwap executes: USDC → WETH → ETH → FeeJuice
    │   - FeeJuice deposited to L2 via FeeJuicePortal
    │
    ▼
[4] Token portion: 95 USDC → L2
    │   - Router calls TokenPortal.depositToAztecPrivateFor()
    │   - Portal locks 95 USDC on L1
    │   - Sends L1→L2 message: "95 USDC for <recipient>"
    │
    ▼
[5] Wait for L2 to process (~20 min on devnet)
    │   - L1→L2 messages are included in the next Aztec rollup batch
    │
    ▼
[6] User claims on L2
    │   - Frontend calls TokenBridge.claim_private()
    │   - Uses the claim secret (generated in step 1, stored client-side)
    │   - Gas is paid by the FeeJuice deposited in step 3
    │
    ▼
[7] Done! User has 95 USDC + FeeJuice gas on L2
```

---

## Glossary

Every technical term used in this PR. Each entry explains: what it is, why it exists, and what depends on it.

---

### Blockchains & Layers

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **L1 (Layer 1)** | Ethereum — the main blockchain. On testnet, we use **Sepolia** (a test version of Ethereum where the ETH is free). | The main highway. | Nothing — it's the foundation. |
| **L2 (Layer 2)** | Aztec — a privacy-focused blockchain built on top of Ethereum. Your tokens go here after bridging. | A private tunnel built over the highway. Faster, cheaper, and nobody can see what's inside. | L1 (Aztec posts proofs back to Ethereum for security). |
| **Bridge** | Software that moves tokens between L1 and L2. Like a door between two rooms. | An airport terminal connecting two countries. | L1 + L2 both need to be running. |
| **Testnet / Devnet** | A practice version of the blockchain where tokens are free. We use it for testing so we don't lose real money. | A driving simulator — same controls, no real consequences. | Nothing — it's independent. |

---

### Tokens & Gas

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **ERC-20** | A standard for tokens on Ethereum (USDC, USDT, WETH, etc.). Like a universal format for gift cards — any wallet can read them. | Gift cards that work at every store. | L1 (they live on Ethereum). |
| **USDC** | A stablecoin pegged to the US dollar. 1 USDC = $1. We use test USDC on Sepolia. | Fake dollars for the driving simulator. | ERC-20 standard. |
| **WETH (Wrapped ETH)** | ETH wrapped into an ERC-20 token. Uniswap pools need tokens in ERC-20 format, but ETH isn't ERC-20, so we wrap it. Think of it as putting cash into a prepaid card so it works with the card machine. | Putting coins into a paper roll so the machine accepts them. | ETH exists in the wallet. |
| **FeeJuice** | The gas token on Aztec (L2). Every L2 action costs FeeJuice, just like every Ethereum action costs ETH. On L1, it exists as an ERC-20 called "AZTEC". On L2, it's the native gas currency. | Local currency in a foreign country — you need it to buy anything. | L2 (Aztec) must be running. |
| **Fuel** | Slang for FeeJuice. "Fuel swap" = converting some of your tokens into FeeJuice so you have gas money on L2. | Exchanging dollars for local currency at the airport. | FeeJuice exists + Uniswap pools have liquidity. |
| **Gas** | The fee you pay to execute a transaction on any blockchain. On Ethereum, gas is paid in ETH. On Aztec, gas is paid in FeeJuice. | The toll you pay to cross a bridge. | The blockchain is running. |
| **FeeAssetHandler** | A testnet-only faucet contract. Calling `mint()` gives you free test tokens. Each call gives a fixed amount (e.g. 1,000 FeeJuice). We can't change the amount after deployment. | A vending machine that gives one candy per button press. | Deployed on L1. |

---

### Contracts & Architecture

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **Smart Contract** | A program that lives on the blockchain. Once deployed, it runs exactly as written — nobody can change it. It has an address, like a building has a street address. | A vending machine — put money in, get product out, no human needed. | The blockchain it's deployed on. |
| **Portal** | An L1 contract that acts as a gateway between L1 and L2. `TokenPortal` handles your USDC/USDT deposits. `FeeJuicePortal` handles FeeJuice deposits. The portal **locks** your tokens on L1 and sends a message to L2 saying "release the equivalent tokens there." | The departure gate at the airport — your luggage goes in, and it comes out at the destination. | L1 (deployed on Ethereum). The portal must be **initialized** with a registry, token, and L2 bridge before it works. |
| **TokenPortal** | A specific portal for bridging ERC-20 tokens. Each token (USDC, USDT, etc.) has its own portal. It locks tokens on L1 and tells L2 to mint them. | One departure gate per airline. | Registry + L1 token + L2 bridge address (set during initialization). |
| **FeeJuicePortal** | A portal specifically for FeeJuice. Deployed by the Aztec network (not by us). Used to deposit FeeJuice to L2. | The gate for local currency transfers. | Aztec network deployed it. |
| **UniswapFuelSwap** | An L1 contract that executes token swaps through Uniswap V4 pools. It takes your USDC, swaps it through one or two pools, and gives back FeeJuice. | The currency exchange booth. | PoolManager (Uniswap V4) + pools must have liquidity. |
| **SwapBridgeRouter** | The main entry point contract. Users interact with THIS contract. It pulls your tokens (via Permit2), calls UniswapFuelSwap for the gas portion, and calls TokenPortal for the token portion — all in one transaction. | The travel agent who handles everything — currency exchange, flight booking, luggage — in one visit. | Permit2 + UniswapFuelSwap + TokenPortal + FeeJuicePortal. |
| **BridgedFPC (Bridged Fee Payment Contract)** | An L2 contract that pays gas on your behalf for privacy. Instead of you paying gas directly (which reveals your address), the BridgedFPC claims the FeeJuice and pays gas so your identity stays hidden. It's **not deployed** — it's a deterministic contract that's **registered** with your wallet. | A courier who picks up your package and pays the delivery fee, so your name isn't on the receipt. | Aztec L2 + wallet registration. |
| **SponsoredFPC** | A special contract on L2 that pays gas for free during deployment. We use it so deploying L2 contracts doesn't cost us FeeJuice. Only used during setup, not by end users. | A "first ride free" coupon for the taxi. | Aztec network provides it. |
| **PoolSeeder** | A temporary helper contract deployed during pool seeding. It handles creating the pool, adding liquidity, and returning leftover tokens to the deployer — all in one transaction. Destroyed after use. | A construction crew that builds a fountain, fills it with water, and leaves. | PoolManager + tokens to seed with. |
| **Trusted Forwarder** | An access control list on TokenPortal. When you bridge with fuel, the **SwapBridgeRouter** (not you) calls the portal's deposit function on your behalf. But the portal only allows calls from addresses on its "trusted" list. We must add SwapBridgeRouter to this list after deployment. Without it, fuel swaps fail with `NotTrustedForwarder`. Only the **portal owner** (whoever deployed it) can add/remove forwarders. | A VIP list at a club — only approved guests (SwapBridgeRouter) can enter through the back door (depositToAztecPrivateFor). | TokenPortal must be deployed + SwapBridgeRouter address must be known. |

---

### Uniswap & Liquidity Pools

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **Uniswap V4** | A decentralized exchange on Ethereum. Instead of a traditional order book, it uses **liquidity pools** — buckets of tokens that traders swap against. V4 is the latest version. | A vending machine with two coin slots — put dollars in, get euros out (and vice versa). The machine has a stash of both currencies inside. | Deployed on L1 (Sepolia address: `0xE03A...`). |
| **PoolManager** | The single Uniswap V4 contract that manages ALL pools. Every swap goes through it. All pool liquidity lives inside it. | The building that houses all the vending machines. | Deployed by Uniswap on each chain. |
| **Liquidity Pool** | A bucket of two tokens that enables swapping. For example, the ETH/FeeJuice pool holds ETH and FeeJuice. When someone swaps ETH for FeeJuice, they add ETH to the bucket and take FeeJuice out. **If the bucket is empty, nobody can swap.** | Two jars on a table — one with dollars, one with euros. People trade between them. If a jar is empty, trading stops. | Tokens must be deposited ("seeded") into the pool first. |
| **Pool Seeding** | Putting initial tokens into a pool so it has liquidity for swaps. Without seeding, the pool is empty and all swaps fail with "pool liquidity exceeded." This is the **most common issue after a fresh deployment.** | Filling the jars with initial dollars and euros before opening the exchange. | Deployer has tokens + ETH to seed with. |
| **PoolKey** | The unique identifier for a pool. Contains: the two tokens (currency0, currency1), the fee percentage, tick spacing, and hooks address. Two pools with different PoolKeys are completely separate. | The label on a vending machine — "USD/EUR, 0.3% fee." | The two tokens must exist. |
| **currency0 / currency1** | The two tokens in a pool. **currency0 must have a numerically lower address than currency1.** The scripts handle this sorting automatically. Native ETH uses `address(0)`. | Alphabetical order for the labels — "A" always comes before "B." | Token addresses must be known. |
| **Swap Route / Hops** | The path tokens take through pools. USDC→FeeJuice requires **two hops**: USDC→WETH (pool 1), then WETH→ETH→FeeJuice (pool 2). WETH→FeeJuice only needs **one hop**. | A connecting flight — sometimes you need to stop at a hub airport. | All pools in the route must have liquidity. |
| **zeroForOne** | Swap direction in a pool. `true` = sell currency0, buy currency1. `false` = the opposite. You don't set this manually — the scripts calculate it based on which token you're selling. | "Left to right" or "right to left" on the vending machine. | Knowing which token you're selling. |
| **Flash Accounting** | How Uniswap V4 handles swaps internally. During a swap, no tokens actually move. Instead, the system keeps a running tab of IOUs. At the very end, everything is settled in one step. This saves gas. | Running a bar tab — order drinks all night, pay once when you leave. | PoolManager (V4 feature). |
| **sqrtPriceX96** | How V4 stores prices internally. It's the square root of the price, multiplied by 2^96. You never need to calculate this yourself — the quoter and scripts handle it. | The internal encoding on a barcode — the cashier reads it, you don't need to. | Uniswap V4 math. |
| **Tick / Tick Range** | Uniswap V4 divides the price range into discrete "ticks." When you add liquidity, you pick a range (e.g. tick 69,060 to 115,140 = ~1,000 to ~100,000 FeeJuice per ETH). Your liquidity only earns fees when the price is inside your range. | Setting a minimum and maximum price on your currency exchange booth — "I'll trade between $0.001 and $0.10 per FeeJuice." | Pool exists. |
| **Slippage** | The difference between the expected price and the actual price. Prices can change between when you get a quote and when your transaction executes. We set 3% tolerance — if the price moves more than 3%, the transaction cancels instead of giving you a bad deal. | You check the exchange rate and it says $1 = 0.85 EUR. By the time you get to the counter, it's $1 = 0.83 EUR. If it drops below $1 = 0.82 EUR (3% worse), you walk away. | Getting a price quote first. |
| **Quoter** | A read-only Uniswap contract that tells you "if you swap X tokens, you'll get Y back" without actually doing the swap. The frontend calls this to show the user estimated amounts. | Asking the exchange booth "how much euro would I get for $5?" before committing. | Pools must have liquidity for the quote to work. |
| **Idempotent** | An operation that can be run multiple times without causing problems. Pool seeding is idempotent — if the pool already exists, it skips creation and just adds more liquidity. | Pressing the elevator button twice — the elevator still only comes once. | Nothing — it's a property of the operation. |

---

### Signatures & Security

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **Permit2** | Uniswap's token approval system. Instead of giving each contract unlimited access to your tokens (dangerous), you approve **Permit2 once**, then sign individual permission slips for each transfer. Each slip is one-time-use. | Instead of giving your house key to every delivery person, you give it to one trusted doorman (Permit2). Each delivery person gets a signed note saying "let them take one package." | Deployed on every chain at the same address (`0x0000...0022D4...`). |
| **Witness** | Extra data baked into a Permit2 signature. It locks your **entire intent** — recipient, amounts, swap route, slippage limits — into the signature. If anyone changes any detail, the signature becomes invalid. | Writing a check where the amount, recipient, and purpose are all in permanent ink. If someone tries to change the recipient, the bank rejects it. | Permit2 must be used. |
| **BridgeWitness** | The specific witness struct for our bridge. Contains: portal address, token, amounts (total + fuel), L2 recipient, fuel recipient, secret hashes, minimum fuel output, swap route hash, and privacy mode. Every field is cryptographically locked. | The fine print on your check — every detail of what should happen with your money. | SwapBridgeRouter reads and verifies this. |
| **EIP-712** | A standard for signing structured data. Instead of signing a meaningless blob of numbers, your wallet shows you human-readable fields ("Token: USDC, Amount: 100, Recipient: 0x..."). Permit2 uses this format. | A form with labeled fields instead of a blank page — you can see exactly what you're signing. | Ethereum wallet supports it (all modern wallets do). |
| **Nonce** | A one-time-use number included in every Permit2 signature. After a signature is used, its nonce is marked as "spent" and the same signature can never be replayed. Permit2 uses random nonces (not sequential). | A lottery ticket number — each one can only be claimed once. | Permit2 tracks used nonces on-chain. |
| **Secret / SecretHash** | A random value (the secret) and its hash. You need the secret to claim your tokens on L2. The hash is stored publicly (so the system knows a claim exists), but only someone who knows the actual secret can claim. Generated in your browser — **never sent to the server.** | A combination lock — the hash is the lock (visible to everyone), the secret is the combination (only you know it). | Generated client-side before the L1 deposit. |
| **Poseidon2** | A special hash function used on Aztec L2. It's used instead of regular hashing (keccak256) because it's much cheaper inside zero-knowledge proof circuits. The secret hashes for L2 claims use Poseidon2. | A specialized encoding machine that's faster for the privacy system. Same purpose as regular hashing, just optimized. | Aztec L2 uses it. |
| **Nullifier** | A unique value that marks something as "used" on L2. When you claim your tokens, a nullifier is added to Aztec's tree. If someone tries to claim the same tokens again, the system sees the nullifier already exists and rejects it. Prevents double-spending. | A movie ticket that gets torn at the entrance — you can't use the stub to get in again. | Aztec L2 nullifier tree. |
| **Auth Witness** | Aztec's version of token approvals. A signed authorization that lets one contract act on behalf of your account for a specific function call. More precise than Ethereum's `approve` — it only allows exactly one action, and it's privacy-preserving. | A one-time power of attorney that says "this contract can do THIS ONE THING on my behalf." | Aztec wallet must sign it. |
| **CleanHands (POCH)** | "Proof of Clean Hands." A compliance check — a trusted signer certifies that the depositor is not on a sanctions list. Required for private deposits on the compliant bridge variant. | A security clearance check before entering a restricted area. | A trusted attester must sign the attestation. |

---

### Wallet & Frontend

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **Wallet** | A browser extension that holds your private keys and signs transactions. On Ethereum, this is MetaMask. On Aztec, there's a similar extension that the Wallet-SDK connects to. | Your physical wallet — it holds your cards and you authorize payments with it. | Must be installed in the browser. |
| **WalletProvider** | A discovered Aztec wallet browser extension. When the SDK scans for wallets, each one it finds is a WalletProvider (name, icon, capabilities). | A list of available payment apps on your phone (Apple Pay, Google Pay, etc.). | Wallet extension must be installed. |
| **Wallet-SDK** | The `@aztec/wallet-sdk` library. It's a standard protocol for connecting any Aztec wallet to any Aztec dapp. Before this PR, only one wallet brand worked. Now any wallet that follows the standard can connect. | A universal USB port — any device can plug in, regardless of brand. | Wallet extension must support the SDK protocol. |
| **Secure Channel** | An encrypted connection between the dapp and the wallet, verified with matching emojis. If the emojis on your screen match the emojis in the wallet popup, the connection is authentic (no one is intercepting). | Video calling someone and verifying their face matches — if it does, you know it's really them. | WalletProvider must support secure channels. |
| **Capability Manifest** | A list the dapp sends to the wallet saying "here's everything I need access to: these contracts, these functions, these accounts." The wallet shows this to the user for approval. | A permission slip — "this app wants to: read your balance, send transactions, access your account." | Wallet is connected. |
| **Deployment JSON** | A file (`deployments/<version>_<date>.json`) that stores every contract address from a deployment. The frontend reads a copy of this to know where all the contracts are. Created by the deploy script, synced to `frontend/src/constants/deployments.json`. | An address book listing every building (contract) in town. | Deploy script has been run. |

---

### Deployment Concepts

| Term | What it is | Real-world analogy | Depends on |
|------|-----------|-------------------|------------|
| **Deploy** | Publishing a smart contract to the blockchain. Once deployed, it has a permanent address and runs forever. Costs gas. | Opening a new store — once it's open, it's there. | Gas (ETH on L1, FeeJuice on L2). |
| **Initialize** | A one-time setup call after deploying a contract. For TokenPortal, `initialize(registry, token, l2Bridge)` wires it to the right addresses. Can only be called once — if you mess it up, you need to redeploy. | Connecting the plumbing after building a house — you only do it once. | Contract must be deployed first. |
| **Forge / Foundry** | A toolkit for writing, testing, and deploying Solidity (L1) smart contracts. `forge build` compiles the code, `forge script` runs deployment scripts. | The construction tools — compiler + deployer for L1 contracts. | Must be installed. |
| **ABI (Application Binary Interface)** | A JSON description of a smart contract's functions. The TypeScript code needs the ABI to know how to call a contract. Generated by `forge build` and stored in `l1-contracts/out/`. | An instruction manual for the vending machine — "press button A to get candy, insert $1 first." | `forge build` must be run first. |
| **viem** | A TypeScript library for interacting with Ethereum. Our scripts use it to send transactions, deploy contracts, and read blockchain state. | The steering wheel and pedals — how we drive (interact with) the blockchain from code. | Node.js installed. |
| **Broadcast** | When a Forge script sends transactions to the real blockchain (not just simulating). Without `--broadcast`, Forge only simulates what would happen. | Actually mailing a letter vs. just writing it. | RPC connection + private key. |
| **RPC URL** | The web address of a blockchain node. Our scripts send transactions through this URL. Example: `https://eth-sepolia.g.alchemy.com/v2/...`. Think of it as the internet address of the blockchain. | The phone number of the bank — you call it to make transactions. | An RPC provider (Alchemy, Infura, etc.). |

---

## Feature 1: Wallet-SDK Migration

### What problem does it solve?

Previously, the bridge used `@azguardwallet/client` -- a single-vendor wallet library that only worked with the Azguard wallet. The new `@aztec/wallet-sdk` is a **standardized protocol** that allows any Aztec wallet extension to connect to the dapp. Think of it like how MetaMask, Rabby, and Rainbow all work on any Ethereum dapp -- this SDK brings that same interoperability to Aztec.

### How it works -- step by step

```
User clicks "Connect Wallet"
        |
        v
[1. Discovery] -- SDK scans for wallet browser extensions
        |
        v
[2. Selection] -- User picks a wallet from discovered list
        |
        v
[3. Secure Channel] -- Encrypted connection + emoji verification
        |
        v
[4. Capability Request] -- Dapp asks wallet for permissions
        |
        v
[5. Account Selection] -- User picks which L2 account to use
        |
        v
[6. Connected] -- Dapp can now send L2 transactions via wallet
```

#### Step 1: Discovery

```
walletSdkConnection.ts -> WalletManager.configure({ extensions: { enabled: true } })
```

The SDK starts scanning for wallet browser extensions that have injected themselves into the page. Each time a wallet is found, a callback fires with the wallet's `WalletProvider` (name, icon, etc.).

#### Step 2: Selection

As wallets are discovered, they appear in the UI. If only one is found, it's auto-selected. The user clicks the one they want.

#### Step 3: Secure Channel + Emoji Verification

```
provider.establishSecureChannel(APP_ID) -> PendingConnection { verificationHash }
```

An encrypted channel is established between the dapp and the wallet extension. The `verificationHash` is converted to a sequence of emojis. The user sees the same emojis in both the dapp and the wallet popup. If they match, the connection is authentic (no man-in-the-middle). This is similar to how Signal shows safety numbers.

#### Step 4: Capability Request

```
walletCapabilities.ts -> wallet.requestCapabilities(manifest)
```

The dapp tells the wallet exactly what it needs:
- **Accounts**: access to L2 accounts, ability to create auth witnesses
- **Contracts**: register specific L2 contracts (token bridge, token, FeeJuice, BridgedFPC, proxy)
- **Simulation**: permission to call view functions (e.g., `balance_of_private`)
- **Transaction**: permission to call state-changing functions (e.g., `claim_public`, `transfer`)

The wallet shows this to the user for approval.

#### Step 5: Account Selection

The wallet returns the user's L2 accounts. If there are multiple, the user picks one. This becomes the `aztecAddress` used for all bridge operations.

#### Step 6: Connected

A `WalletAdapter` wraps the SDK wallet to provide a clean interface:
- `executeCall(address, method, args)` -- send an L2 transaction
- `simulateViews(calls)` -- read L2 state without sending a transaction
- `registerToken(address)` -- add a token to the wallet's UI

### What happens on L1 vs L2?

- **L1**: Nothing. This is purely about L2 wallet connectivity.
- **L2**: The wallet provides the dapp with the ability to send L2 transactions (claims, transfers, burns) and query L2 state (balances).

### Key files

| File | Role |
|------|------|
| `frontend/src/utils/walletSdkConnection.ts` | Discovery session management |
| `frontend/src/utils/walletCapabilities.ts` | Capability manifest builder |
| `frontend/src/hooks/useWalletAdapter.ts` | React hook wrapping the SDK wallet |
| `frontend/src/stores/walletStore.ts` | State machine for wallet connection flow |

---

## Feature 2: Uniswap V4 Fuel Swap

### What problem does it solve?

When you bridge tokens (e.g. USDC) from L1 to L2, you need FeeJuice to pay gas for the L2 claim transaction. But new users don't have any FeeJuice. It's a chicken-and-egg problem: you can't claim your tokens without gas, but you can't get gas without tokens.

The fuel swap solves this by **automatically converting a small portion of your deposit into FeeJuice** as part of the same L1 transaction. One click, and you have both your tokens and the gas to claim them on L2.

### Two modes: Public vs Private

| | Public Fuel | Private Fuel (BridgedFPC) |
|---|---|---|
| **FeeJuice goes to** | Your L2 address directly | The BridgedFPC contract |
| **Who pays L2 gas** | You (from your FeeJuice balance) | BridgedFPC (on your behalf) |
| **Privacy** | Your FeeJuice balance is publicly visible | Gas payment is hidden from public view |
| **Secret derivation** | Random | Deterministic: `poseidon2(salt, userAddress)` |
| **L2 payment method** | `FeeJuicePaymentMethodWithClaim` | `BridgedMintAndPayFeePaymentMethod` |

### How it works -- the complete flow

```
User toggles "Fuel" ON, picks amount (e.g. "$5")
        |
        v
[1. Price Quote] -- Get token/ETH/FeeJuice exchange rates
        |
        v
[2. Route Building] -- Determine swap path through V4 pools
        |
        v
[3. Permit2 Signing] -- Sign the full intent (bridge + fuel)
        |
        v
[4. L1 Transaction] -- SwapBridgeRouter.bridgeWithFuel()
        |
        v
[5. Swap Execution] -- UniswapFuelSwap converts tokens to FeeJuice
        |
        v
[6. Double Deposit] -- FeeJuice + remaining tokens deposited to L2
        |
        v
[7. Wait for Sync] -- Both L1->L2 messages must be picked up by L2
        |
        v
[8. L2 Claim] -- Claim tokens using FeeJuice to pay gas
```

#### Step 1: Price Quote

```
fuelPricing.ts -> CoinGecko API -> token price in USD
                -> V4 Quoter -> exact swap output for each hop
```

The frontend converts the user's selected dollar amount to token units using CoinGecko prices (e.g. "$5 = 5 USDC"). Then it calls the Uniswap V4 Quoter contract (via `eth_call`, not a transaction) to get the exact FeeJuice output for that input amount.

#### Step 2: Route Building

```
fuelPricing.ts -> buildSwapRoute()

USDC -> WETH -> FeeJuice  (2 hops)
WETH -> FeeJuice           (1 hop)
```

The route depends on the input token:
- If it's WETH: single hop through the WETH/FeeJuice pool
- If it's anything else (USDC, USDT, etc.): two hops -- first to WETH, then to FeeJuice

Each hop is defined by a `PoolKey` (the V4 pool identifier) and a `zeroForOne` flag (swap direction).

3% slippage tolerance is applied to the quoted output to get `minFuelOutput`.

#### Step 3: Permit2 Signing

(See [Feature 3](#feature-3-witness-bound-permit2) for full details)

The user signs an EIP-712 message that locks: total amount, fuel amount, recipient addresses, secret hashes, swap route, and slippage limits. This prevents any tampering.

#### Step 4: L1 Transaction -- SwapBridgeRouter

```solidity
// SwapBridgeRouter.sol
function bridgeWithFuel(
    PermitTransferFrom permit,    // token, amount, nonce, deadline
    bytes signature,               // user's Permit2 signature
    BridgeParams params,          // recipient, secrets, amounts, route
    PoolKey[] poolKeys,           // V4 pool definitions for the swap
    bool[] zeroForOnes            // swap direction for each hop
)
```

The router does everything in one transaction:

1. **Pull tokens** from user via Permit2 (signature verified on-chain)
2. **Swap** `fuelAmount` tokens for FeeJuice via UniswapFuelSwap
3. **Deposit FeeJuice** to L2 via FeeJuicePortal
4. **Deposit remaining tokens** to L2 via TokenPortal
5. **Emit** `BridgeWithFuel` event with both message hashes and leaf indices

#### Step 5: Swap Execution -- UniswapFuelSwap

```solidity
// UniswapFuelSwap.sol
function swap(
    address tokenIn,
    uint256 amountIn,
    uint256 minOutput,
    PoolKey[] poolKeys,
    bool[] zeroForOnes
) -> uint256 amountOut
```

Inside the swap:

1. Pull `amountIn` tokens from the router
2. Call `poolManager.unlock()` -- this enters V4's flash accounting context
3. In `unlockCallback`: execute each hop via `poolManager.swap()`
4. Settle all deltas (pay tokens in, receive FeeJuice out)
5. Return FeeJuice to the router

Flash accounting means no tokens move during the swap execution -- everything is tracked as virtual debits/credits and settled at the very end. This is more gas efficient.

#### Step 6: Double Deposit

The router makes two separate L1-to-L2 deposits:

1. `feeJuicePortal.depositToAztecPublic(fuelRecipient, fuelAmount, fuelSecretHash)`
   - Public mode: `fuelRecipient` = user's L2 address
   - Private mode: `fuelRecipient` = BridgedFPC contract address

2. `tokenPortal.depositToAztecPublic(recipient, bridgeAmount, tokenSecretHash)`
   or `tokenPortal.depositToAztecPrivateFor(recipient, bridgeAmount, tokenSecretHash, attestations)`

Each deposit creates an L1-to-L2 message that Aztec's rollup will pick up.

#### Step 7: Wait for L2 Sync

The frontend polls `aztecNode.getL1ToL2MessageBlock()` for both the token message and the fuel message. Both must be included in an L2 block before the claim can proceed.

#### Step 8: L2 Claim

- **Public fuel**: `FeeJuicePaymentMethodWithClaim` atomically claims the FeeJuice and uses it to pay gas for the token claim transaction. One transaction does both.
- **Private fuel**: `BridgedMintAndPayFeePaymentMethod` tells the BridgedFPC contract to claim the FeeJuice and pay gas on the user's behalf. The secret is derived deterministically from the user's address and a salt, so only the intended claimer can trigger it.

### Contract interaction diagram

```
User's Wallet
     |
     | signs Permit2 + witness
     v
SwapBridgeRouter.bridgeWithFuel()
     |
     |-- [1] Permit2.permitWitnessTransferFrom()  --> pulls tokens from user
     |
     |-- [2] UniswapFuelSwap.swap()
     |         |
     |         |-- PoolManager.unlock()
     |         |     |
     |         |     |-- unlockCallback()
     |         |           |-- swap hop 1: Token -> WETH
     |         |           |-- swap hop 2: WETH -> FeeJuice
     |         |           |-- settle all deltas
     |         |
     |         |-- returns FeeJuice to router
     |
     |-- [3] FeeJuicePortal.depositToAztecPublic()  --> FeeJuice -> L2
     |
     |-- [4] TokenPortal.depositToAztecPublic()      --> Tokens -> L2
     |
     v
  Emits BridgeWithFuel event
```

### UI: The Fuel Toggle

`FuelToggle.tsx` provides the user interface:

- Toggle switch to enable/disable fuel
- Dollar amount presets ($1, $2, $5, $10) or custom input
- Real-time conversion showing token amount and estimated FeeJuice output
- Public/Private fuel mode selector
- Error states: pool liquidity issues, quote failures, minimum amounts

### Key files

| File | Role |
|------|------|
| `l1-contracts/src/SwapBridgeRouter.sol` | Main router -- pulls tokens, coordinates swap + double deposit |
| `l1-contracts/src/UniswapFuelSwap.sol` | Executes V4 multi-hop swaps |
| `frontend/src/components/FuelToggle.tsx` | UI toggle with amount selection |
| `frontend/src/utils/fuelPricing.ts` | Route building + V4 quoter calls |
| `frontend/src/utils/fuelQuote.ts` | Quote state management |
| `frontend/src/utils/coinGeckoPrice.ts` | USD price fetching |

---

## Feature 3: Witness-Bound Permit2

### What problem does it solve?

When you sign a Permit2 message, you're authorizing the SwapBridgeRouter to pull tokens from your wallet. But a standard Permit2 signature only says **"take X tokens from me"** -- it doesn't say **what to do with them**.

Without witness binding, a malicious actor could:
- Intercept your signature
- Change the L2 recipient to steal your tokens
- Change the secret hash so only they can claim
- Route the swap through a malicious pool to drain value
- Switch from private to public mode, breaking your privacy

Witness binding solves this by **baking your entire intent into the signature itself**. If any parameter is changed, the signature becomes invalid.

### How standard Permit2 works

```
[1] One-time: approve(Permit2, MAX) for your token
[2] Per-transfer: sign an off-chain EIP-712 message
[3] Spender calls Permit2.permitTransferFrom() which:
    - Verifies the signature
    - Checks nonce hasn't been used
    - Checks deadline hasn't passed
    - Transfers tokens to the spender
```

The signed message covers: **token, amount, nonce, deadline, spender**. That's it.

### How witness-bound Permit2 works

Same as above, but the signed message ALSO covers a **witness** -- an arbitrary struct of application data:

```
[2'] Per-transfer: sign an off-chain EIP-712 message that includes BridgeWitness
[3'] Spender calls Permit2.permitWitnessTransferFrom() which:
    - Verifies the signature (including the witness hash)
    - Everything else same as above
```

### The BridgeWitness struct

This is what gets baked into your signature:

```
BridgeWitness {
    tokenPortal       // which L1 portal contract receives the tokens
    bridgeToken        // which ERC-20 you're bridging
    totalAmount        // total tokens pulled (bridge amount + fuel amount)
    fuelAmount         // how much goes to the fuel swap
    aztecRecipient     // your L2 address (where tokens go)
    fuelRecipient      // where FeeJuice goes (your address or BridgedFPC)
    tokenSecretHash    // hash of the secret needed to claim tokens on L2
    fuelSecretHash     // hash of the secret needed to claim FeeJuice on L2
    minFuelOutput      // minimum FeeJuice from the swap (slippage protection)
    routeHash          // hash of the entire swap route (pools + directions)
    isPrivate          // whether this is a private or public deposit
}
```

### Why each field matters

| Field | What it prevents if tampered |
|-------|------------------------------|
| `tokenPortal` | Sending tokens to a fake portal |
| `bridgeToken` | Swapping the token type |
| `totalAmount` | Changing the deposit amount |
| `fuelAmount` | Draining more tokens to the swap |
| `aztecRecipient` | Stealing the L2 tokens |
| `fuelRecipient` | Stealing the L2 FeeJuice |
| `tokenSecretHash` | Making only the attacker able to claim |
| `fuelSecretHash` | Making only the attacker able to claim fuel |
| `minFuelOutput` | Accepting a bad swap rate |
| `routeHash` | Routing through a malicious pool |
| `isPrivate` | Switching deposit mode |

### Flow in code

```
bridgeL1ToL2.ts:

1. Generate random nonce (256-bit)
2. Compute routeHash = keccak256(encode(poolKeys, zeroForOnes))
3. Build EIP-712 typed data:
   - Domain: { name: "Permit2", chainId, verifyingContract: PERMIT2 }
   - Types: PermitWitnessTransferFrom + BridgeWitness
   - Values: all fields above
4. User signs via wallet (eth_signTypedData_v4)
5. Send tx: SwapBridgeRouter.bridgeWithFuel(permit, signature, params, ...)
6. On-chain: Permit2 verifies signature covers both transfer + witness
```

### For simple bridge (no fuel swap)

Even without fuel, witness binding is still used. The fuel-related fields are zeroed out:
- `fuelAmount: 0`
- `fuelRecipient: bytes32(0)`
- `fuelSecretHash: bytes32(0)`
- `minFuelOutput: 0`
- `routeHash: bytes32(0)`

This means **every bridge operation** benefits from witness protection, not just fuel swaps.

---

## How All Three Features Work Together

Here's the complete flow when a user bridges USDC from L1 to L2 with fuel enabled:

```
[WALLET-SDK]
1. User connects Aztec wallet via SDK
2. Emoji verification confirms secure channel
3. Dapp gets L2 account address + transaction capabilities

[FUEL QUOTE]
4. User enters bridge amount (e.g. 100 USDC)
5. User enables fuel toggle, selects $5 worth
6. Frontend quotes: $5 USDC -> X WETH -> Y FeeJuice (via V4 quoter)
7. 3% slippage applied -> minFuelOutput = Y * 0.97

[PERMIT2 + WITNESS]
8. Total amount = 100 USDC (95 bridge + 5 fuel)
9. Secrets generated (claim secret, fuel secret)
10. Secrets encrypted and backed up to server
11. User signs Permit2 + BridgeWitness (locks all parameters)

[L1 TRANSACTION]
12. SwapBridgeRouter.bridgeWithFuel() called
13. Permit2 verifies signature + witness
14. 5 USDC swapped to FeeJuice via V4
15. FeeJuice deposited to L2 (via FeeJuicePortal)
16. 95 USDC deposited to L2 (via TokenPortal)

[L2 CLAIM via WALLET-SDK]
17. Frontend waits for both messages to sync to L2
18. Wallet creates claim transaction:
    - FeeJuice claim pays for gas
    - Token claim executes atomically
19. User has 95 USDC + leftover FeeJuice on L2
```

---

## Recovery Architecture

Every irreversible operation is protected by pre-persisted recovery data.

### What gets saved BEFORE the L1 deposit

| Data | Where | Why |
|------|-------|-----|
| Claim secret + fuel secret | Encrypted (AES-GCM) on server | Needed to claim on L2 |
| Encryption key derivation | User's L1 wallet signature | Only the user can decrypt |
| Secret hashes (plaintext) | Server DB | For querying/matching operations |
| L1 tx hash | Server DB + localStorage | For receipt-based recovery |
| Portal address, token address | Server DB | For finding the right events |

### Three recovery paths (from fastest to slowest)

1. **From messageHash**: If we have the L1-to-L2 message hash, directly query the L2 node for its block inclusion
2. **From L1 txHash**: Parse the L1 transaction receipt to extract events, reconstruct message hashes
3. **From block scan**: Scan the last 50,000 L1 blocks (~7 days) for matching portal events, verify secret hash matches

### What happens if the page crashes at each stage

| Crash point | Recovery |
|-------------|----------|
| After secrets generated, before L1 tx | Secrets are already encrypted on server. No funds at risk -- L1 tx never happened. |
| After L1 tx submitted, before receipt | L1 tx hash is in localStorage. Resume finds receipt, extracts events, continues to L2 claim. |
| After L1 confirmed, before L2 claim | Full recovery: decrypt secrets from server, find L1 events, rebuild fee payment method, claim on L2. |
| After partial L2 claim | Pre-claim check queries server to detect already-completed operations. Won't double-claim (nullifier prevents it anyway). |

---

## Deployment & Setup Guide

Everything you need to deploy the bridge infrastructure from scratch, including contracts, liquidity pools, and the BridgedFPC.

### Prerequisites

| Requirement | Details |
|-------------|---------|
| Node.js | v20+ |
| Foundry | `forge` CLI installed (`curl -L https://foundry.paradigm.xyz \| bash`) |
| pnpm | Package manager |
| Funded Sepolia wallet | Needs Sepolia ETH for gas + token minting |

### Environment Variables

Create a `.env` file in `bridge-script/`:

```bash
# ---- Required ----
L1_PRIVATE_KEY=0x...          # Hex private key for the deployer (preferred)
# OR
MNEMONIC="word1 word2 ..."    # Mnemonic (L1_PRIVATE_KEY takes priority if both set)

L1_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY   # Sepolia RPC

# ---- Optional ----
AZTEC_ENV=devnet              # "devnet" or "sandbox" (default: sandbox)
FEE_BASIS_POINTS=500          # Fee on deposits, 500 = 5% (default: 500)

# ---- Compliant bridge only ----
POCH_ATTESTER_PRIVATE_KEY=0x...     # Clean-hands attestation signer
PASSPORT_SIGNER_PRIVATE_KEY=0x...   # Passport attestation signer
```

> **Important**: `L1_PRIVATE_KEY` is strongly preferred over `MNEMONIC`. The Uniswap pool seeding step shells out to `forge` which requires `PRIVATE_KEY` (derived from `L1_PRIVATE_KEY`). If only `MNEMONIC` is set, pool seeding will be skipped with a warning.

### The Single Command

```bash
# 1. Build Solidity contracts first (required -- TS script imports Forge artifacts)
cd l1-contracts && forge build && cd ..

# 2. Run the full deployment
cd bridge-script
AZTEC_ENV=devnet pnpm start-devnet
```

This runs `index-devnet.ts` which executes **6 phases** in order. Here's what happens:

---

### Phase 1: Setup (Wallet + L1 Client + Node Info)

```
index-devnet.ts -> setupWallet() + createExtendedL1Client() + node.getNodeInfo()
```

1. **Creates an L2 wallet** -- `EmbeddedWallet` connected to the devnet PXE
2. **Creates an L1 client** -- Connects to Sepolia using your private key or mnemonic
3. **Reads L1 contract addresses from the Aztec node** -- The node returns the canonical addresses for:
   - Rollup contract
   - Registry contract
   - Inbox / Outbox
   - FeeJuice (AZTEC token) address
   - FeeJuicePortal address
4. **Registers SponsoredFPC** -- Gets the pre-deployed SponsoredFPC instance for fee-free L2 deploys
5. **Deploys a Schnorr account on L2** -- Used as the deployer identity for L2 contracts
6. **Creates deployment file** -- `deployments/<version>_<date>.json` + updates `registry.json`

---

### Phase 2: Deploy Tokens

For each token in the config (USDC, USDT, DAI, HUMN, GOAT, WBTC, WETH), the script deploys a complete stack:

```
For each token:
    |
    [1] Deploy L1 TestERC20
    |   - constructor(name, symbol, decimals, owner)
    |   - Mints 1e18 tokens to the owner
    |   - WETH is special: uses the real Sepolia WETH (0xfFf9976...)
    |
    [2] Deploy L1 FeeAssetHandler
    |   - constructor(owner, l1Token, mintAmount=1e15)
    |   - Registers as a minter on the TestERC20
    |
    [3] Deploy L1 TokenPortal
    |   - Uses @aztec/l1-artifacts standard portal (no custom args)
    |
    [4] Deploy L2 Token Contract
    |   - constructor(owner, name, symbol, decimals)
    |   - Deployed via SponsoredFPC (free gas)
    |
    [5] Deploy L2 Token Bridge Contract
    |   - constructor(l2TokenAddress, l1PortalAddress)
    |   - Deployed via SponsoredFPC
    |
    [6] Set bridge as minter
    |   - l2Token.set_minter(l2Bridge, true)
    |
    [7] Initialize L1 Portal
    |   - l1Portal.initialize(registry, l1Token, l2Bridge)
    |   - Wires the portal to the registry, token, and L2 bridge
    |   - Can only be called ONCE
    |
    [8] Save to deployment JSON
```

> **Skip-if-deployed**: If a token already exists in the deployment file, it's skipped. Set `forceDeploy: true` in `constants/tokens.ts` to redeploy a specific token.

---

### Phase 3: Deploy Fuel Swap Infrastructure

This is where the new PR #10 contracts get deployed.

#### Step 1: Deploy UniswapFuelSwap (L1)

```
UniswapFuelSwap(poolManager, feeJuice, weth)
```

| Constructor arg | Value | Source |
|----------------|-------|--------|
| `poolManager` | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` | Uniswap V4 PoolManager on Sepolia |
| `feeJuice` | `0x35d0186d1FD53b72996475D965C5Ed171D52b986` | From `nodeInfo.l1ContractAddresses.feeJuiceAddress` |
| `weth` | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | Sepolia WETH |

This contract executes multi-hop swaps through V4 pools using flash accounting.

#### Step 2: Deploy SwapBridgeRouter (L1)

```
SwapBridgeRouter(permit2, feeJuicePortal, uniswapFuelSwap)
```

| Constructor arg | Value | Source |
|----------------|-------|--------|
| `permit2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical Permit2 (same on all chains) |
| `feeJuicePortal` | `0x516E3f74FD1C19B24da0706d28B5a30578f054AB` | From `nodeInfo.l1ContractAddresses.feeJuicePortalAddress` |
| `uniswapFuelSwap` | (from step 1) | The address just deployed |

This is the user-facing contract that pulls tokens via Permit2, swaps for FeeJuice, and deposits both to L2.

#### Step 3: Register BridgedFPC (L2)

```typescript
import { registerBridgedContract } from '@defi-wonderland/aztec-fee-payment';
const bridgedFpc = await registerBridgedContract(wallet);
```

**This is NOT a deployment** -- BridgedFPC is a fully private L2 contract. It's registered with the wallet (so it knows the contract exists), but no deploy transaction is sent on-chain. The contract instance is deterministically addressed.

Current address: `0x2536e27c6187a18a0c23c7288efaf6dfcd020f6d7d4c63745f6870681f0064f7`

#### Step 4: Save to deployment JSON

Writes `uniswapFuelSwapAddress`, `swapBridgeRouterAddress`, and `bridgedFpcAddress` to the deployment file.

> **Fuel swap addresses are preserved across re-runs** -- if they already exist in the deployment, they're carried forward via spread operator. Only overwritten if freshly deployed.

---

### Phase 4: Seed Uniswap V4 Liquidity Pools

The script deploys a temporary `PoolSeeder` contract via viem and seeds the pools one transaction at a time (no Forge, no nonce issues):

This creates and seeds **two pools**:

#### Pool 1: ETH / FeeJuice (AZTEC)

| Parameter | Value |
|-----------|-------|
| currency0 | Native ETH (`address(0)`) |
| currency1 | AZTEC (`0x35d0...`) |
| Fee | 0.3% (3000) |
| Tick spacing | 60 |
| Initial price | ~10,000 FeeJuice per ETH |
| Tick range | 69,060 to 115,140 (~1,000 to ~100,000 FJ/ETH) |
| Seed liquidity | 0.05 ETH + 15,000 FeeJuice |
| Liquidity delta | 1e18 |

FeeJuice is minted via `FeeAssetHandler.mint()` (15 calls x 1,000 FJ each = 15k FJ).

#### Pool 2: ERC20 (USDC) / WETH

| Parameter | Value |
|-----------|-------|
| currency0 | USDC (lower address) |
| currency1 | WETH (higher address) |
| Fee | 0.3% (3000) |
| Tick spacing | 60 |
| Initial price | ~2,100 USDC per WETH |
| Tick range | 169,800 to 229,800 |
| Seed liquidity | 500 USDC + 0.15 WETH |
| Liquidity delta | 6e13 |

> **Only created if `ERC20_TOKEN` env var is set**. The TS script passes the first deployed token's L1 address.

Both pool initializations are **idempotent** -- if the pool already exists, the `initialize()` call is caught and skipped; only liquidity is added.

The script deploys a temporary `PoolSeeder` helper contract that handles minting, pool creation, liquidity seeding, and sweeping leftover tokens back to the deployer -- all in one transaction.

#### How the swap route works after seeding

```
USDC bridge with fuel:
  USDC -> [Pool 2] -> WETH -> [unwrap] -> ETH -> [Pool 1] -> FeeJuice

WETH bridge with fuel:
  WETH -> [unwrap] -> ETH -> [Pool 1] -> FeeJuice
```

---

### Phase 5: Set Trusted Forwarders

**This IS done automatically by `index-devnet.ts`** after pool seeding. You can also run it separately if needed.

#### Why trusted forwarders are needed

The SwapBridgeRouter calls `depositToAztecPrivateFor()` on TokenPortal on behalf of the user. Without the trusted forwarder allowlist, **anyone** could call this function with arbitrary depositor addresses. The check in TokenPortal is:

```solidity
if (!trustedForwarders[msg.sender]) revert NotTrustedForwarder();
```

#### Option A: Forge script (batch -- all portals at once)

```bash
cd l1-contracts

# Edit the script to include your portal addresses, then:
PRIVATE_KEY=0x... TRUSTED_FORWARDER=<SwapBridgeRouter_address> \
  forge script script/SetTrustedForwarderAllPortals.s.sol:SetTrustedForwarderAllPortals \
  --rpc-url $L1_URL --broadcast -vvv
```

The script has a hardcoded list of portal addresses and calls `setTrustedForwarder(forwarder, true)` on each.

#### Option B: Inline (per portal -- used by redeploy-permit2.ts)

```typescript
await l1Portal.write.setTrustedForwarder([SWAP_BRIDGE_ROUTER_ADDRESS, true]);
```

> **You must be the portal owner** to call `setTrustedForwarder`. This is the same account that called `initialize()` on the portal.

---

### Phase 6: Sync to Frontend

```typescript
copyToFrontend(); // Writes deployment bundle to frontend/src/constants/deployments.json
```

The deployment JSON is copied so the frontend knows all the contract addresses. Then the script runs a basic L1->L2 bridge test with the first token (USDC).

---

### Redeploying Just the Portal + Bridge (Keeping Swap Infra)

If you need to redeploy the L1 portal and L2 bridge (e.g. after a contract upgrade) without redeploying the swap infrastructure:

```bash
cd bridge-script
AZTEC_ENV=devnet L1_PRIVATE_KEY=0x... pnpm redeploy-permit2
```

This runs `redeploy-permit2.ts` which:
1. Deploys a fresh L1 TokenPortal + L2 Token + L2 Bridge
2. Initializes the portal
3. Sets the SwapBridgeRouter as trusted forwarder (inline, not separate step)
4. Reuses the existing UniswapFuelSwap, SwapBridgeRouter, and BridgedFPC addresses from the deployment file
5. Updates the deployment JSON and copies to frontend

---

### Currently Deployed Addresses (Sepolia Devnet)

From the active deployment `4.0.0-devnet.2-patch.3_2026-03-24`:

**L1 Core:**

| Contract | Address |
|----------|---------|
| Registry | `0x52945c29d2788ccb076e910509c0449bfcbe29e6` |
| Rollup | `0xcd1a7be18501092f3ba8d80ce5629501ba178de0` |
| FeeJuice (AZTEC) | `0x35d0186d1fd53b72996475d965c5ed171d52b986` |
| FeeJuicePortal | `0x516e3f74fd1c19b24da0706d28b5a30578f054ab` |
| FeeAssetHandler | `0xed9c5557d2e0abcc7c7fca958ee4292199413494` |

**Fuel Swap Infrastructure:**

| Contract | Address |
|----------|---------|
| UniswapFuelSwap | `0x346c8a2f96b9aebac6989ca4fede206e1ad5e010` |
| SwapBridgeRouter | `0xd281eaae666091e8eab5e9a7f2152498f710d56e` |
| BridgedFPC (L2) | `0x2536e27c6187a18a0c23c7288efaf6dfcd020f6d7d4c63745f6870681f0064f7` |

**Hardcoded Sepolia Constants:**

| Name | Address |
|------|---------|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| V4 PoolManager | `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543` |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` |

---

### Gotchas & Troubleshooting

| Issue | Fix |
|-------|-----|
| `Cannot find module .../SwapBridgeRouter.json` | Run `cd l1-contracts && forge build` before the TS script |
| Pool seeding skipped with warning | Set `L1_PRIVATE_KEY` (not just `MNEMONIC`) -- Forge needs `PRIVATE_KEY` env var |
| `NotTrustedForwarder` error on bridge | Run `SetTrustedForwarderAllPortals.s.sol` or manually call `setTrustedForwarder` |
| `OwnableUnauthorizedAccount` on portal setup | You must use the same account that called `initialize()` on the portal |
| Token deploy skipped unexpectedly | Token already in deployment file. Set `forceDeploy: true` in `constants/tokens.ts` |
| Pool already initialized | Normal -- `initialize()` is idempotent. Liquidity is still added. |
| Currency ordering error in V4 | `currency0` must have a lower address than `currency1`. The scripts handle this automatically. |
| `@defi-wonderland/aztec-fee-payment` not found | Installed from GitHub tarball, not npm. Run `pnpm install` in both `bridge-script/` and `frontend/` |
| Deployment timeouts | Devnet uses 20-min deploy timeout, 3-min tx timeout (configured in `config/devnet.json`) |
| "Swap amount exceeds pool liquidity" | The Uniswap V4 pool doesn't have enough tokens to fill your fuel swap. The Sepolia testnet pools are seeded with limited liquidity (~500 USDC + 0.15 WETH, and 0.05 ETH + 15k FeeJuice). **Fix**: Select a smaller fuel amount ($1 instead of $5/$10), or re-run `pnpm seed-pools` to add more liquidity. |

---

### What is "Fuel Swap"? (Plain English)

When you bridge tokens (e.g. USDC) from Ethereum to Aztec, you need **FeeJuice** to pay for the L2 claim transaction — just like you need ETH to pay gas on Ethereum. But new users have zero FeeJuice on L2. It's a chicken-and-egg problem: you can't claim your tokens without gas, and you can't get gas without tokens.

**Fuel swap fixes this.** When you enable "Top up gas balance" in the UI, a small portion of your deposit is automatically swapped into FeeJuice via Uniswap V4 pools on L1, then deposited to L2 alongside your tokens — all in **one L1 transaction**.

**Example**: You bridge 100 USDC with $5 fuel enabled:

```
100 USDC total
  |
  |-- 5 USDC --> [Uniswap V4: USDC -> WETH -> FeeJuice] --> deposited to L2 as gas
  |
  |-- 95 USDC --> deposited to L2 normally
  |
  v
You arrive on L2 with: 95 USDC + enough FeeJuice to pay gas for claiming
```

Without fuel swap, you'd need someone to send you FeeJuice first, or use the BridgedFPC (private fuel) where someone else pays gas on your behalf.

---

## Liquidity Pool Seeding Guide

### Why You Need to Seed Pools

The fuel swap converts your bridged tokens into FeeJuice via Uniswap V4 pools on L1. **If these pools have no liquidity, the swap reverts** and you'll see the error:

> "Swap amount exceeds pool liquidity — try a smaller amount"

This is the most common issue after a fresh deployment. The pools must be seeded with tokens before anyone can use the fuel toggle.

### What Pools Are Needed

For a USDC bridge with fuel, the swap goes through **two pools**:

```
USDC -> [Pool 1: USDC/WETH] -> WETH -> [unwrap] -> ETH -> [Pool 2: ETH/FeeJuice] -> FeeJuice
```

If **either** pool is empty, the quote fails. Both must have liquidity.

| Pool | What it needs | Default seed |
|------|---------------|-------------|
| ETH / FeeJuice (AZTEC) | ETH + FeeJuice tokens | 0.05 ETH + 15,000 FJ |
| ERC20 / WETH | The ERC20 token + WETH | 500 tokens + 0.15 WETH |

- **WETH** doesn't need its own pool — it goes directly through the ETH/FeeJuice pool (single hop)
- Every other token (USDC, USDT, DAI, HUMN, GOAT, WBTC) needs its own ERC20/WETH pool

### How to Seed Pools

**Option A: TypeScript (recommended — no nonce issues)**

```bash
cd bridge-script

# Seed all tokens from active deployment
L1_PRIVATE_KEY=0x... pnpm seed-pools

# Seed a specific token only
L1_PRIVATE_KEY=0x... ERC20_TOKEN=0x... pnpm seed-pools

# Skip ETH/AZTEC pool (only seed ERC20/WETH pools)
L1_PRIVATE_KEY=0x... SKIP_ETH_AZTEC=true pnpm seed-pools

# With more liquidity
L1_PRIVATE_KEY=0x... ERC20_AMOUNT=50000000000 WETH_SEED=5000000000000000000 FEE_MINT_COUNT=500 pnpm seed-pools
```

**Option B: Forge (alternative)**

```bash
cd l1-contracts

# Seed both pools
PRIVATE_KEY=0x... ERC20_TOKEN=0x... L1_URL=https://... pnpm seed-pools

# Just ETH/AZTEC pool (omit ERC20_TOKEN)
PRIVATE_KEY=0x... L1_URL=https://... pnpm seed-pools
```

> **Warning**: Forge batches many transactions at once which can cause nonce drift errors on rate-limited RPCs. Use `--slow` or prefer the TypeScript version.

### Configurable Parameters

| Env var | What it controls | Default |
|---|---|---|
| `ERC20_TOKEN` | Specific token to seed (address) | All tokens in deployment |
| `ERC20_AMOUNT` | Raw token amount (e.g. `5000000000` for 5000 USDC) | `5000 * 10^decimals` |
| `WETH_SEED` | ETH to wrap into WETH (wei) | `1500000000000000000` (1.5 ETH) |
| `ETH_SEED` | ETH for ETH/FeeJuice pool (wei) | `50000000000000000` (0.05 ETH) |
| `FEE_MINT_COUNT` | FeeJuice mints (1,000 FJ each) | `15` (= 15k FJ) |
| `SKIP_ETH_AZTEC` | Skip ETH/FeeJuice pool | `false` |

### How to Check Pool Liquidity

```bash
cd bridge-script
pnpm check-pools
```

This shows the PoolManager's token balances for each deployed token and whether the pools have liquidity.

Or manually via `cast`:

```bash
# Check USDC balance in PoolManager (0 = no liquidity)
cast call <USDC_ADDRESS> "balanceOf(address)(uint256)" 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 --rpc-url <RPC_URL>

# Check FeeJuice balance in PoolManager
cast call 0x35d0186d1FD53b72996475D965C5Ed171D52b986 "balanceOf(address)(uint256)" 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 --rpc-url <RPC_URL>
```

### When to Re-Seed

- After a fresh deployment (`pnpm start-devnet`)
- If pools get drained from heavy usage
- If `pnpm start-devnet` pool seeding failed (nonce errors, rate limits)
- After adding a new token that wasn't in the original deployment

Pool seeding is **idempotent** — if the pool already exists, it skips initialization and just adds more liquidity.

### Requirements

- Deployer wallet needs **Sepolia ETH** (at least ~2 ETH for WETH wrap + ETH seed + gas)
- Deployer must be the token minter (the account that ran `pnpm start-devnet`)
- FeeJuice is minted via `FeeAssetHandler.mint()` — no pre-existing FJ balance needed

---

## All Scripts Reference

### TypeScript Scripts (`bridge-script/`)

Run from the `bridge-script/` directory. All require `L1_PRIVATE_KEY` env var.

| Command | Script file | What it does |
|---|---|---|
| `pnpm start-devnet` | `index-devnet.ts` | **Full deployment**: L2 wallet, tokens, portals, UniswapFuelSwap, SwapBridgeRouter, BridgedFPC, pool seeding, frontend sync |
| `pnpm start-devnet:compliant` | `index-devnet-compliant.ts` | Full deployment + compliant bridge with attestation/passport tests |
| `pnpm seed-pools` | `seed-pools.ts` | Seed V4 liquidity pools for all deployed tokens via viem (no Forge needed) |
| `pnpm check-pools` | `check-pool-liquidity.ts` | Read-only: check PoolManager balances and pool health |
| `pnpm set-trusted-forwarders` | `set-trusted-forwarders.ts` | Set SwapBridgeRouter as trusted forwarder on all token portals |
| `pnpm deploy-fuel-swap` | `deploy-fuel-swap.ts` | Deploy UniswapFuelSwap contract only |
| `pnpm deploy-swap-router` | `deploy-swap-router.ts` | Deploy SwapBridgeRouter contract only |
| `pnpm deploy-token-portal` | `deploy-token-portal.ts` | Deploy custom TokenPortal (with fee + attestation) + init + set forwarder |
| `pnpm redeploy-permit2` | `redeploy-permit2.ts` | Redeploy L1 portal + L2 bridge + L2 token for a single token (USDC), reusing existing swap infra |

#### When to use `redeploy-permit2.ts`

This script is for **redeploying just the portal and bridge contracts for a single token** without touching the swap infrastructure. Use it when:

- The L2 bridge contract needs upgrading (e.g. after an Aztec protocol update)
- The L1 portal contract needs changes (e.g. new fee parameters, attestation config)
- The Permit2 witness structure changed and the portal needs to be redeployed to match
- You want a fresh portal/bridge but want to keep the existing UniswapFuelSwap, SwapBridgeRouter, and BridgedFPC

What it does step by step:
1. Deploys a fresh L1 custom TokenPortal (with fee + attestation args)
2. Deploys a fresh L2 Token contract (cUSDC)
3. Deploys a fresh L2 Bridge contract
4. Sets the bridge as minter on the L2 token
5. Initializes the L1 portal (wires it to registry, L1 USDC, L2 bridge)
6. Sets the existing SwapBridgeRouter as trusted forwarder on the new portal
7. Updates the deployment JSON and syncs to frontend

It reuses the existing L1 USDC address and SwapBridgeRouter address (hardcoded in the script).

### Solidity Scripts (`l1-contracts/script/`)

Run from the `l1-contracts/` directory. All require `PRIVATE_KEY` and `L1_URL` env vars.

| Command | Script file | What it does |
|---|---|---|
| `pnpm deploy:fuel-swap` | `DeployUniswapFuelSwap.s.sol` | Deploys UniswapFuelSwap contract + a PoolSetupHelper, seeds ETH/AZTEC and USDC/WETH pools |
| `pnpm deploy:swap-router` | `DeploySwapBridgeRouter.s.sol` | Deploys SwapBridgeRouter with hardcoded Permit2, FeeJuicePortal, and UniswapFuelSwap addresses |
| `pnpm deploy:token-portal` | `DeployTokenPortalWithForwarder.s.sol` | Deploys custom TokenPortal + SwapBridgeRouter, initializes portal, sets router as trusted forwarder |
| `pnpm seed-pools` | `SeedUniswapPools.s.sol` | Creates and seeds V4 pools (ETH/AZTEC + ERC20/WETH). Idempotent — skips init if pool exists |
| `pnpm set-trusted-forwarders` | `SetTrustedForwarderAllPortals.s.sol` | Calls `setTrustedForwarder()` on a hardcoded list of portal addresses |

#### Solidity Script Details

**`DeployUniswapFuelSwap.s.sol`** — The most comprehensive deploy script. In one run it:
1. Deploys `UniswapFuelSwap(poolManager, feeJuice, weth)`
2. Deploys a `PoolSetupHelper` contract (implements V4 `IUnlockCallback`)
3. Mints FeeJuice via `FeeAssetHandler.mint()` (configurable count)
4. Seeds ETH/AZTEC pool (~10,000 FJ per ETH, 0.3% fee)
5. Wraps ETH to WETH, seeds USDC/WETH pool (~2,100 USDC per WETH, 0.3% fee)
6. Sweeps leftover tokens back to deployer

Env vars: `MINT_COUNT`, `ETH_SEED`, `LIQUIDITY_DELTA`, `WETH_SEED`, `USDC_SEED`, `USDC_WETH_LIQUIDITY`

**`DeploySwapBridgeRouter.s.sol`** — Simple single-contract deploy:
- `SwapBridgeRouter(Permit2, FeeJuicePortal, UniswapFuelSwap)`
- All three constructor addresses are hardcoded in the script

**`DeployTokenPortalWithForwarder.s.sol`** — Full portal setup in one tx:
1. Deploys `TokenPortal(owner, feeRecipient, feeBasisPoints, humanIdAttester, cleanHandsCircuitId, passportSigner)`
2. Initializes with hardcoded registry, USDC, and L2 bridge addresses
3. Deploys a new SwapBridgeRouter
4. Sets the router as trusted forwarder on the portal

Env vars: `FEE_RECIPIENT`, `FEE_BASIS_POINTS`, `HUMAN_ID_ATTESTER`, `CLEAN_HANDS_CIRCUIT_ID`, `PASSPORT_SIGNER`

**`SeedUniswapPools.s.sol`** — Pool seeding only (no contract deploys except the temporary PoolSeeder helper):
- Deploys a temporary `PoolSeeder` contract
- Mints FeeJuice, seeds ETH/AZTEC pool
- Mints ERC20, wraps WETH, seeds ERC20/WETH pool (if `ERC20_TOKEN` is set)
- Sweeps all leftovers back to deployer
- Pool init is idempotent — safe to run multiple times

Env vars: `ERC20_TOKEN`, `ERC20_DECIMALS`, `SKIP_ETH_AZTEC`, `FEE_MINT_COUNT`, `ETH_SEED`, `ETH_AZTEC_LIQUIDITY`, `ERC20_AMOUNT`, `WETH_SEED`, `ERC20_WETH_LIQUIDITY`

**`SetTrustedForwarderAllPortals.s.sol`** — Batch trusted forwarder setup:
- Has a **hardcoded list of 7 portal addresses** (USDC, USDT, DAI, HUMN, GOAT, WBTC, WETH)
- Calls `setTrustedForwarder(address, true)` on each
- Must be called by the portal owner (same account that called `initialize()`)
- **Important**: If you deploy new portals, you must update the hardcoded addresses in this script

Env vars: `TRUSTED_FORWARDER`

### TypeScript vs Solidity — When to Use Which

| Scenario | Use |
|---|---|
| Fresh full deployment | `pnpm start-devnet` (TS) — handles everything |
| Seed pools after deployment | `pnpm seed-pools` (TS) — no nonce issues, seeds all tokens |
| Deploy a single contract | TS scripts (`deploy-fuel-swap`, `deploy-swap-router`) — reads addresses from deployment |
| Quick one-off on an existing setup with hardcoded addresses | Forge scripts — faster, no Node.js needed |
| Redeploy portal + bridge only | `pnpm redeploy-permit2` (TS) — handles L1 + L2 |
| Set forwarders on new portals | `pnpm set-trusted-forwarders` (TS) — reads portals from deployment |

The **TS scripts are preferred** because they:
- Read addresses from the active deployment (no hardcoding)
- Send transactions one at a time via viem (no nonce batching issues)
- Work with rate-limited RPCs (Alchemy, Infura)
- Auto-sync changes to the frontend deployment file

The **Forge scripts are useful** when:
- You need to verify contracts on Etherscan (`--verify` flag)
- You're working outside the TS deployment system
- You need maximum gas efficiency (Forge batches transactions)

---

## PR vs Local Audit Report

Full comparison of PR #10 against the local codebase (`review/fuel-swap-pr10` branch). Audit date: 2026-03-25.

### Summary

| Category | Count |
|----------|-------|
| Files identical (PR = local) | **30** |
| Files where local is ahead of PR | **24** |
| Files in PR but missing locally | **7** (2 intentionally unnecessary, 5 old deployments) |
| Files removed in PR | **5** (4 correctly gone locally, 1 orphan) |

**Bottom line: The local codebase is a superset of the PR. Nothing from the PR is missing. Local has significant security and data-flow improvements on top of the PR.**

---

### Files Identical -- No Differences (30)

All Solidity contracts and their tests match perfectly between PR and local:

| Category | Files |
|----------|-------|
| Solidity contracts | `SwapBridgeRouter.sol`, `TokenPortal.sol`, `UniswapFuelSwap.sol`, `ISignatureTransfer.sol` |
| Solidity tests | `SwapBridgeRouter.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`, `TokenPortal.t.sol`, `UniswapFuelSwap.t.sol` |
| Deploy scripts | `DeploySwapBridgeRouter.s.sol`, `DeployTokenPortalWithForwarder.s.sol`, `DeployUniswapFuelSwap.s.sol`, `SeedUniswapPools.s.sol`, `SetTrustedForwarderAllPortals.s.sol` |
| Foundry config | `l1-contracts/foundry.toml` |
| Frontend (unchanged) | `Steps.txt`, `UPGRADING_BRIDGE.md`, `package.json`, `progress/page.tsx`, `BridgeActionButton.tsx`, `BridgeSection.tsx`, `FuelToggle.tsx`, `SwapBridgeRouterAbi.ts`, `useWalletAdapter.ts`, `coinGeckoPrice.ts`, `fuelQuote.ts`, `walletCapabilities.ts`, `walletSdkConnection.ts` |
| Bridge-script | `TokenBridge.ts`, `TokenMinterProxy.ts`, `codegenCache.json` |

---

### Files Where Local is Ahead of PR (24)

#### Critical Security & Data-Flow Fixes

**`frontend/src/hooks/bridge/bridgeL1ToL2.ts`** (~391 diff lines)

| What changed | PR | Local |
|---|---|---|
| Secret hash computation | Server-side via `/api/compute-secret-hash` (secrets sent to server) | **Client-side** using `computeSecretHash()` from `@aztec/stdlib/hash` (secrets never leave browser) |
| Fuel secret generation timing | Generated AFTER encrypted backup | Generated **BEFORE** backup (included in encrypted payload -- crash safe) |
| `calculateFee` failure | Silently falls back to original amount | **Throws** (prevents wrong claim amounts) |
| Claim retry guards | Blindly retries | Early-exit on `user rejected` and `already consumed` |
| Receipt revert check | Missing | **Throws** on `txReceipt.status === 'reverted'` |
| Etherscan URLs | Hardcoded `https://sepolia.etherscan.io` | Uses `getL1TxUrl()` helper |
| DB patches | Fire-and-forget `patchOperationAsync` | **`patchOperationWithRetry`** |
| LocalStorage matching | By `l1Address` | By `claimSecretHash` (more reliable) |
| Portal ABI fallback | Single fallback | Three-tier: `CustomTokenPortalEventAbi` -> `CustomTokenPortalAbi` -> upstream `TokenPortalAbi` |

**`frontend/src/hooks/useResumeL1BridgeToL2.ts`** (~435 diff lines)

| What changed | PR | Local |
|---|---|---|
| Recovery result type | Basic fields | Adds `claimAmount`, `fuelMessageHash`, `fuelMessageLeafIndex`, `fuelAmount` |
| Event filtering | No verification | **SecretHash-based** -- verifies `eventSecretHash` matches `claimSecretHash` |
| Post-fee claimAmount | Not extracted | **Extracted** from portal events during recovery |
| Block scan range | 2,000 blocks | **50,000 blocks** (~7 days coverage) |
| Fuel fee payment on resume | Not reconstructed | **Rebuilds** `BridgedMintAndPayFeePaymentMethod` or `FeeJuicePaymentMethodWithClaim` |
| Pre-claim check | Missing | **Queries server** before attempting L2 claim (detects already-completed) |
| `portalAddressL1` | Optional (silent fallback) | **Mandatory** (throws with clear error) |
| DB patches | Async fire-and-forget | **`patchOperationWithRetry`** |

**`frontend/src/hooks/useL1Operations.ts`** (~152 diff lines)

| What changed | PR | Local |
|---|---|---|
| `depositConfirmed` timing | Set after `submitDeposit` (before receipt) | Set **after `waitForReceiptAndExtractEvent`** confirms `status=success` |
| Fuel amount conversion | `Math.floor(Number(...) * 10**decimals)` | **`parseUnits` from viem** (no floating-point precision bugs) |
| API calls | Raw `axios.post` | **`api.post`** (consistent interceptors) |
| Brute-forced leaf index | Lost | **Persisted** back to server |
| Completion patches | Basic | **`patchOperationWithRetry`** |
| Decryption domain | Uses current domain | Uses **stored `keyDerivationDomain`** (migration safe) |
| Telemetry | Basic | Adds `l1TxHash`, `usedFuel`, `isPrivacyModeEnabled` |

> The `depositConfirmed` timing fix is critical -- the PR could mark funds as locked even if the L1 transaction reverted.

**`frontend/src/hooks/useL2Operations.ts`** (~161 diff lines)

| What changed | PR | Local |
|---|---|---|
| Completion patches | Basic | **`patchOperationWithRetry`** |
| Required fields | Optional with fallback | `l2BridgeAddress` and `portalAddressL1` **mandatory** (throws with clear errors) |
| Witness epoch | Not persisted | Stored in **both localStorage and server** |
| Recovery witness data | Not synced | Synced to backend (`l2ToL1MessageIndex`, `siblingPath`, `epoch`, `status: 'ready'`) |
| Block number queries | `/api/aztec-node` proxy | **Direct `L2_NODE_URL` fetch** |
| Telemetry | Basic | Adds `l1TxHash`, `isPrivacyModeEnabled` |

#### Configuration & Security Hardening

**`frontend/src/config/index.ts`**

| What changed | PR | Local |
|---|---|---|
| Deployment override | Always reads `localStorage.getItem('selectedDeploymentId')` | **Gated to `development` only** -- prevents production users from being redirected to compromised contract addresses via localStorage manipulation |

**`frontend/src/app/api/bridge/operations/[id]/route.ts`**

| What changed | PR | Local |
|---|---|---|
| State transitions | Basic | `pending` can now transition to `submitted` |
| Field sanitization | Generic string | `l2TxHash` **sanitized as hex** |
| New fields | None | `epoch`, `claimAmount`, `fuelMessageHash`, `fuelMessageLeafIndex`, `fuelAmount` |
| Immutable fields | Few | Expanded: `l2BlockNumberBeforeTx`, `claimSecretHash`, `fuelSecretHash`, `privateFuelSecretHash` |
| Immutable guard | Only blocks when existing value is non-null | Blocks **ANY update** to immutable fields |
| `completedAt` | Client-provided | **Set server-side** for terminal states |
| `currentStep` | Can go backwards | **Forward-only guard** (prevents step regression) |

**`frontend/src/aztec.ts`**

| What changed | PR | Local |
|---|---|---|
| Aztec node access | Server-side proxy (`/api/aztec-node`) | **Direct `L2_NODE_URL`** (no proxy needed) |

**`frontend/src/stores/walletStore.ts`**

| What changed | PR | Local |
|---|---|---|
| Block explorer URLs | Hardcoded etherscan | **`networkConfig[L1_CHAIN_ID]?.blockExplorer`** |

#### Data Model Changes

**`frontend/prisma/schema.prisma`**

| Addition | Fields |
|----------|--------|
| User model | `lastLoginAt`, `lastLoginIp` |
| BridgeOperation | `claimSecretHash`, `fuelSecretHash`, `privateFuelSecretHash`, `epoch`, `claimAmount`, `clientIp` |
| Removed | `tokenLogoUrlL1`, `tokenLogoUrlL2` |

**`frontend/src/stores/bridgeStore.ts`**

| Addition | Fields |
|----------|--------|
| `PendingClaimData` | `claimAmount` |
| Fuel recovery | `fuelSecret`, `privateFuelSalt`, `privateFuelSecret`, `fuelMessageHash`, `fuelMessageLeafIndex`, `fuelAmount` |

#### Recovery Data Completeness

**`frontend/src/utils/index.ts`**

| Export type | PR | Local |
|---|---|---|
| L1->L2 | Basic fields | Adds `encryptedCiphertext`, `encryptedIv`, `encryptedTag`, `keyDerivationDomain`, contract snapshot (`portalAddressL1`, `bridgeAddressL2`, `tokenAddressL1`, `tokenAddressL2`), fuel recovery fields |
| L2->L1 | Basic fields | Adds `bridgeAddressL2`, `recipientL1Address`, `portalAddressL1`, `rollupVersion`, `chainIdL1`, `l1RollupAddress` |

**`frontend/src/utils/walletAdapters.ts`**

| What changed | PR | Local |
|---|---|---|
| Auth witness caller | `bridgeAddr` | **`proxyAddr` (TokenMinterProxy)** -- matches actual call chain: Bridge -> TokenMinterProxy -> Token |
| Private withdrawal | No attestation support | Supports `cleanHandsData` and `passportData` parameters |
| Exit method | Always `exit_to_l1_public` | Selects `exit_to_l1_private` vs `exit_to_l1_public` based on attestation data |

#### Infrastructure & Deployment

**`bridge-script/index-devnet.ts`** (~210 diff lines)

| What changed | PR | Local |
|---|---|---|
| Old contracts | BridgeAndFuel + MockFuelSwap | **UniswapFuelSwap + SwapBridgeRouter + BridgedFPC** |
| Private key support | MNEMONIC only | **`L1_PRIVATE_KEY` preferred** (also needed for Forge) |
| Pool seeding | Not present | **Automated** via `SeedUniswapPools.s.sol` |
| BridgedFPC | Not present | **Registered** via `@defi-wonderland/aztec-fee-payment` |

**`bridge-script/utils/save_contracts.ts`**

| What changed | PR | Local |
|---|---|---|
| Function name | `saveFuelInfraToDeployment` | `saveFuelSwapInfraToDeployment` |
| Fields | `bridgeAndFuelAddress`, `mockFuelSwapAddress` | `uniswapFuelSwapAddress`, `swapBridgeRouterAddress`, `bridgedFpcAddress` |
| Re-run safety | Overwrites | **Preserves** existing fuel addresses via spread operator |

**Other infrastructure differences:**

| File | What's different |
|------|-----------------|
| `bridge-script/deployments/registry.json` | Local points to `2026-03-24` (PR had `2026-03-20`) |
| `frontend/src/constants/deployments.json` | Local has `2026-03-24` deployment with updated addresses |
| `frontend/src/constants/abis/V4QuoterAbi.ts` | `quoteExactInputSingle` stateMutability fixed: `nonpayable` -> `view` |
| `frontend/src/utils/fuelPricing.ts` | Quote client cache invalidated when `l1RpcUrl` changes |
| `bridge-script/README.md` | Local adds Uniswap V4 pool seeding documentation |

#### UI Changes

| File | What's different |
|------|-----------------|
| `frontend/src/components/DeploymentSelector.tsx` | Hover state tracking, single-deployment handling, improved visual design |
| `frontend/src/components/RootStyle.tsx` | Added `py-10` padding |
| `frontend/src/app/page.tsx` | Formatting/linting changes only (no logic changes) |

---

### Files in PR but Missing Locally (7)

| File | Why it's fine |
|------|--------------|
| `frontend/src/app/api/aztec-node/route.ts` (+32 lines) | **Not needed** -- local calls `L2_NODE_URL` directly instead of using a server proxy |
| `frontend/src/app/api/compute-secret-hash/route.ts` (+74 lines) | **Not needed** -- hashing moved client-side (security improvement: secrets never leave browser) |
| `bridge-script/deployments/4.0.0-devnet.2-patch.0_2026-03-08.json` | Old deployment -- superseded by `2026-03-24` |
| `bridge-script/deployments/4.0.0-devnet.2-patch.3_2026-03-10.json` | Old deployment -- superseded by `2026-03-24` |
| `bridge-script/deployments/4.0.0-devnet.2-patch.3_2026-03-16.json` | Old deployment -- superseded by `2026-03-24` |
| `bridge-script/deployments/4.0.0-devnet.2-patch.3_2026-03-19.json` | Old deployment -- superseded by `2026-03-24` |
| `bridge-script/deployments/4.0.0-devnet.2-patch.3_2026-03-20.json` | Old deployment -- superseded by `2026-03-24` |

---

### Files Removed in PR -- Status in Local

| File | PR Status | Local Status | Action needed? |
|------|-----------|-------------|----------------|
| `l1-contracts/src/BridgeAndFuel.sol` | Removed | Missing (correct) | None |
| `l1-contracts/src/MockFuelSwap.sol` | Removed | Missing (correct) | None |
| `l1-contracts/src/test/BridgeAndFuel.t.sol` | Removed | Missing (correct) | None |
| `frontend/src/constants/abis/BridgeAndFuelAbi.ts` | Removed | Missing (correct) | None |
| `frontend/src/components/model/AzguardPrompt.tsx` | Removed | **Still exists** | **Delete it** -- nothing imports it, it's dead code from the old Azguard wallet integration |

---

### Data-Flow Audit: 5 Critical Findings (All Fixed in Local)

These are security-relevant differences where the local codebase is correct and the PR has issues:

#### 1. Secret Trust Boundary Violation

- **PR**: Sends claim/fuel secrets to server via `/api/compute-secret-hash` to compute poseidon2 hashes
- **Local**: Computes hashes client-side using `@aztec/stdlib/hash` and `@aztec/foundation/crypto/poseidon`
- **Impact**: In the PR, secrets cross a trust boundary (client -> server). If the server is compromised, an attacker could intercept secrets and claim tokens on L2. Local keeps secrets in the browser.

#### 2. Fuel Secret Backup Ordering

- **PR**: Generates fuel secrets AFTER the encrypted backup is created
- **Local**: Generates fuel secrets BEFORE backup, so they're included in the encrypted payload
- **Impact**: In the PR, if the session crashes between backup and fuel secret generation, the fuel secrets are permanently lost. The FeeJuice is deposited to L2 but nobody can claim it.

#### 3. `depositConfirmed` Set Before Receipt

- **PR**: Sets `depositConfirmed = true` after calling `submitDeposit()` but BEFORE waiting for the receipt
- **Local**: Sets it AFTER `waitForReceiptAndExtractEvent()` confirms `status = success`
- **Impact**: In the PR, if the L1 transaction reverts, the code still thinks the deposit was confirmed. The outer catch won't mark the operation as failed, leaving the user in a broken state.

#### 4. Missing Recovery Data Persistence

- **PR**: Does not persist `claimAmount`, fuel message hashes, or epoch to the server
- **Local**: Persists all of these for crash recovery
- **Impact**: In the PR, if the session crashes during L2 claim, these values are lost. Recovery becomes harder or impossible for fuel-related data.

#### 5. Auth Witness Caller Mismatch

- **PR**: Uses `bridgeAddr` as the auth witness caller
- **Local**: Uses `proxyAddr` (TokenMinterProxy)
- **Impact**: The actual call chain is Bridge -> TokenMinterProxy -> Token. The auth witness must match the direct caller of the token contract (TokenMinterProxy), not the originating caller (Bridge). Using the wrong caller could cause auth witness verification to fail.

---

## Key Files Reference

### Solidity Contracts (L1)

| File | What it does |
|------|-------------|
| `l1-contracts/src/SwapBridgeRouter.sol` | Main entry point. Pulls tokens via Permit2, coordinates swap + double deposit. |
| `l1-contracts/src/UniswapFuelSwap.sol` | Executes multi-hop V4 swaps within flash accounting. |
| `l1-contracts/src/TokenPortal.sol` | Deposits tokens from L1 to L2. Supports public/private modes + attestations. |
| `l1-contracts/src/ISignatureTransfer.sol` | Permit2 interface definitions. |

### Frontend -- Bridge Flow

| File | What it does |
|------|-------------|
| `frontend/src/hooks/bridge/bridgeL1ToL2.ts` | Core L1->L2 logic: secret generation, Permit2 signing, L2 claiming. |
| `frontend/src/hooks/useL1Operations.ts` | Orchestrates the full bridge flow with UI state management. |
| `frontend/src/hooks/useResumeL1BridgeToL2.ts` | Recovery/resume logic for interrupted bridges. |
| `frontend/src/hooks/useL2Operations.ts` | L2->L1 withdrawal flow. |

### Frontend -- Wallet SDK

| File | What it does |
|------|-------------|
| `frontend/src/utils/walletSdkConnection.ts` | Discovery session + connection management. |
| `frontend/src/utils/walletCapabilities.ts` | Builds the capability manifest for the wallet. |
| `frontend/src/hooks/useWalletAdapter.ts` | React hook providing a clean wallet interface. |
| `frontend/src/stores/walletStore.ts` | State machine for the full connection flow. |

### Frontend -- Fuel Swap

| File | What it does |
|------|-------------|
| `frontend/src/components/FuelToggle.tsx` | UI component for fuel enable/disable + amount selection. |
| `frontend/src/utils/fuelPricing.ts` | Builds V4 swap routes + calls on-chain quoter. |
| `frontend/src/utils/fuelQuote.ts` | Manages quote state and refresh logic. |
| `frontend/src/utils/coinGeckoPrice.ts` | Fetches USD prices for tokens. |

### Frontend -- State & Types

| File | What it does |
|------|-------------|
| `frontend/src/stores/bridgeStore.ts` | Bridge state: amounts, fuel config, pending claims. |
| `frontend/src/types/bridge.ts` | TypeScript types for bridge operations. |
| `frontend/src/config/index.ts` | Deployment config loading + environment gating. |

### Deploy Scripts

| File | What it does |
|------|-------------|
| `bridge-script/index-devnet.ts` | Full deployment: portals, swap infra, pool seeding, BridgedFPC, E2E fuel tests. |
| `bridge-script/seed-pools.ts` | Standalone pool seeding script with balance logging and skip logic. |
| `l1-contracts/script/DeploySwapBridgeRouter.s.sol` | Deploys the router contract. |
| `l1-contracts/script/DeployUniswapFuelSwap.s.sol` | Deploys the swap executor. |
| `l1-contracts/script/SeedUniswapPools.s.sol` | Creates and seeds V4 liquidity pools. |

---

## Fuel Swap E2E Tests

The devnet bridge script (`index-devnet.ts`) includes full end-to-end tests for both fuel swap paths.

### Test 1: Public fuel (FeeJuicePaymentMethodWithClaim)

1. Mints ERC20 → approves Permit2 → signs Permit2 witness typed data
2. Calls `SwapBridgeRouter.bridgeWithFuel()` with `fuelRecipient = ownerAztecAddress` (user)
3. Router swaps part of ERC20 → WETH → FeeJuice on Uniswap V4 (2-hop: ERC20/WETH pool → ETH/AZTEC pool), bridges both to L2
4. Parses `BridgeWithFuel` event for token + fuel claim data
5. Polls for L1→L2 message sync (both token and fuel messages)
6. Waits 2 min buffer for message availability
7. Creates `FeeJuicePaymentMethodWithClaim` and claims tokens on L2 (gas paid from swapped FeeJuice)

### Test 2: Private fuel (BridgedMintAndPayFeePaymentMethod)

1. Same L1 flow but with `fuelRecipient = bridgedFpcAddress` (BridgedFPC, not user)
2. Derives secret via `poseidon2([salt, userAddress], DOM_SEP=3952304070)`
3. Polls for L1→L2 message sync (both token and fuel messages)
4. Queries `node.getCurrentMinFees()` → builds explicit `gasSettings` with `REASONABLE_GAS_LIMITS`
5. Creates `BridgedMintAndPayFeePaymentMethod` and claims tokens on L2

### Balance logging

Before/after each test: L2 token balance, L2 FeeJuice balance (remaining gas credit), L1 deployer ETH.

### Pool seeding

- Pools live in the **Uniswap V4 PoolManager singleton** on Sepolia, not in our contracts.
- Skip logic checks per-pool token balances in PoolManager — skips if already seeded.
- `FORCE_SEED=true` overrides and adds more liquidity (idempotent — `PoolSeeder.setup()` uses try/catch on initialize, works on both new and existing pools).
- Redeploying portals, router, or fuel swap → **no re-seeding needed**, pools are unaffected.
- Redeploying ERC20 tokens (new address) → **new pools are seeded automatically** (skip logic detects 0 balance for the new token address).
- ETH/AZTEC (FeeJuice) pool → **never needs re-seeding** (FeeJuice and WETH addresses are fixed on Sepolia).

### Seed amounts (kept small for testnet faucets ~0.05 ETH)

| Pool | Token A | Token B | Liquidity |
|------|---------|---------|-----------|
| ETH/AZTEC | 0.005 ETH | 3,000 FeeJuice (minted) | 1e18 |
| ERC20/WETH | 100 USDC (minted) | 0.01 WETH (wrapped) | 3e11 |

### Env vars

| Variable | Description |
|----------|-------------|
| `SKIP_TO_FUEL_TESTS=true` | Skip bridge+withdrawal tests, jump straight to fuel swap tests |
| `FORCE_SEED=true` | Re-seed pools even if they already have liquidity |
| `FORCE_REDEPLOY_TOKENS=true` | Redeploy all tokens even if they exist |
| `FORCE_REDEPLOY_SWAPS=true` | Redeploy fuel swap infra even if it exists |

### User interactions (real frontend flow)

Both public and private fuel have the **same UX** — the only difference is internal (where FeeJuice is sent on L2).

| Step | Action | Type | Notes |
|------|--------|------|-------|
| 1 | Approve ERC20 → Permit2 | MetaMask tx | One-time per token. Skipped if already approved. |
| 2 | Sign Permit2 witness | MetaMask signature (EIP-712) | No gas cost. Locks in all bridge params (amounts, recipients, swap route). |
| 3 | `bridgeWithFuel` | MetaMask tx | Single L1 tx does everything: pull tokens via Permit2, swap portion to FeeJuice on Uniswap V4, bridge both to L2. |
| 4 | Wait for L1→L2 sync | No user action | ~20 min for Aztec to process the L1→L2 messages. |
| 5 | Claim on L2 | Aztec wallet tx | Gas paid automatically from the swapped FeeJuice. |

**Returning user (Permit2 already approved): 1 signature + 1 L1 tx + 1 L2 claim.**

This is the same number of interactions as a bridge without fuel — the swap adds zero extra clicks.

### Fee payment SDKs

| Fuel mode | Payment method | SDK | Package |
|-----------|---------------|-----|---------|
| Public fuel | `FeeJuicePaymentMethodWithClaim` | Aztec SDK | `@aztec/aztec.js/fee` |
| Private fuel | `BridgedMintAndPayFeePaymentMethod` | Wonderland SDK | `@defi-wonderland/aztec-fee-payment` |

- **Public fuel**: FeeJuice is sent directly to the user's L2 address. Uses Aztec's built-in `FeeJuicePaymentMethodWithClaim` to claim and pay gas in one step.
- **Private fuel**: FeeJuice is sent to a `BridgedFPC` (Fee Payment Contract) on L2, deployed via Wonderland's SDK. The `BridgedMintAndPayFeePaymentMethod` claims FeeJuice from the BridgedFPC and pays gas on behalf of the user — keeping the user's balance private.
