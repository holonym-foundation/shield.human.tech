# Aztec Bridge UI

Privacy-preserving cross-chain bridge between Ethereum (L1) and Aztec (L2). Monorepo with a Next.js frontend and a standalone SDK package.

## Project Structure

```
aztec-bridge/
├── frontend/          # Next.js 16, React 19, Tailwind, Zustand, Prisma
├── packages/sdk/      # @human.tech/aztec-bridge-sdk (ESM + CJS via tsup)
├── bridge-script/     # Deployment automation scripts
├── l1-contracts/      # Foundry Solidity contracts
├── aztec-contracts/   # Noir L2 contracts
└── docs/              # Design specs and plans
``
 console.log("Add it to the global ~/.claude/CLAUDE.md — So it applies across all your projects.

Both — Belt and suspenders. ", Add it to the global ~/.claude/CLAUDE.md — So it applies across all your projects.

Both — Belt and suspenders.);`

**Monorepo tooling:** pnpm workspaces + Turbo. SDK builds first, frontend depends on it.

## Commands

```bash
# Root (all packages via Turbo)
pnpm build              # Build SDK then frontend
pnpm dev                # Dev all packages
pnpm typecheck          # TypeScript check all packages

# Frontend
cd frontend
pnpm dev                # Next.js dev (uses --webpack flag)
pnpm build              # prisma generate + next build
pnpm lint               # ESLint
pnpm db:push            # prisma db push
pnpm db:migrate         # prisma migrate dev
pnpm db:studio          # prisma studio

# SDK
cd packages/sdk
pnpm build              # tsup → dist/ (ESM + CJS + .d.ts)
pnpm dev                # tsup --watch
pnpm typecheck          # tsc --noEmit

# Contracts
cd l1-contracts && forge test
```

## Tech Stack

- **Frontend:** Next.js 16, React 19, TypeScript 5 (strict), Tailwind CSS 3
- **State:** Zustand 5 (with persist) for client state, @tanstack/react-query 5 for server state
- **Web3:** viem 2, wagmi 2, @aztec packages (devnet), siwe 3
- **Backend:** Next.js API routes, Prisma 6 + PostgreSQL, JWT auth
- **SDK:** tsup build, exports HumanTechBridge client class
- **Monitoring:** Datadog RUM + Logs
- **Hosting:** Vercel (serverless functions, auto-deploy from main)

## Architecture

### SDK is single source of truth
`packages/sdk/src/deployments.json` owns all token addresses, contract addresses, and network config. Frontend imports from the SDK — never duplicate deployment config.

```ts
import { getDeployment, ALL_DEPLOYMENTS } from '@human.tech/aztec-bridge-sdk'
```

### Bridge context pattern
`frontend/src/hooks/useBridge.ts` provides `BridgeProvider` wrapping the app. SDK client uses `apiUrl=""` (relative URLs) so same-origin auth works automatically.

### Authentication flow (SIWE)
1. `GET /api/auth/nonce` → server generates nonce, stores in DB (`AuthNonce` table)
2. Client builds SIWE message with L1 address + L2 address in `resources` field
3. Client signs with wallet → `POST /api/auth/authenticate`
4. Server verifies SIWE signature, consumes nonce, issues JWT
5. JWT stored in Zustand `useAuthStore` (persisted to localStorage)

### Bridge operations
- **L1→L2 deposits:** pending → deposited → claimed → completed
- **L2→L1 withdrawals:** pending → submitted → ready → pending_finalize → completed
- Recovery data encrypted client-side, backed up to DB via `BridgeActivity` table

## Key Directories

### Frontend (`frontend/src/`)
- `app/` — Pages + API routes (Next.js App Router)
- `app/api/auth/` — SIWE nonce + authenticate endpoints
- `app/api/bridge/` — Bridge operation CRUD
- `components/` — React components (`'use client'` where needed)
- `hooks/` — `useBridge`, `useL1Operations`, `useL2Operations`, resume hooks
- `stores/` — Zustand stores: `walletStore`, `useAuthStore`, `bridgeStore`
- `config/` — Imports from SDK deployments, derives UI config
- `lib/` — `prisma.ts`, `jwt.ts`, `siweNonceStore.ts`, `validation.ts`
- `types/` — TypeScript interfaces for bridge, wallet, tokens

### SDK (`packages/sdk/src/`)
- `client.ts` — `HumanTechBridge` class (main entry point)
- `bridge/` — L1→L2, L2→L1 operations, polling, witness, resume
- `auth.ts` — SIWE authentication
- `encryption.ts` — Client-side encryption key derivation
- `config.ts` — Deployment resolution, URL helpers
- `api.ts` — REST client for backend

## Code Conventions

### Naming
- Components: `PascalCase.tsx`
- Hooks: `useCamelCase.ts`
- Stores: `camelCaseStore.ts`
- Constants: `UPPER_SNAKE_CASE`
- Files: camelCase for utilities, PascalCase for components

### Imports
- Use `type` keyword for type-only imports
- Frontend path alias: `@/*` → `frontend/src/*`
- SDK: `import { ... } from '@human.tech/aztec-bridge-sdk'`

## Memory Files

- ALWAYS write memory files to the **project-local** `.claude/memory/` directory, NEVER to the global `~/.claude/projects/` path.

## Git & Commits

- Do NOT commit code — user reviews and commits manually
- Do NOT include `Co-Authored-By` lines in commit messages
- Commit message format: `<type>: <lowercase description>`
- Types: `feat`, `fix`, `chore`, `refactor`, `docs`

### Linting
ESLint flat config with: next/core-web-vitals, react, react-hooks, prettier. `no-explicit-any` is off, `no-unused-vars` is warn-only.

## Database (Prisma)

Schema at `frontend/prisma/schema.prisma`. Models:
- **User** — Composite unique on `(l1Address, l2Address)`. Stores login methods, wallet providers.
- **AuthNonce** — One-time SIWE nonces with TTL. Consumed on authenticate.
- **BridgeActivity** — Encrypted bridge operation backups with full recovery metadata.

Run `pnpm db:push` after schema changes. Prisma client auto-generates on `pnpm build`.

## Environment Variables

Required in `.env.local` (frontend):
```
DATABASE_URL              # PostgreSQL connection string
ALLOWED_DOMAIN            # SIWE domain verification (e.g. bridge.human.tech)
JWT_SECRET                # For signing auth tokens
ETHEREUM_RPC_URL          # Backend RPC
ALCHEMY_API_KEY           # NFT/balance APIs
FAUCET_PRIVATE_KEY        # Testnet faucet (server-only, sensitive)
NEXT_PUBLIC_DATADOG_*     # Datadog RUM config
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
```

Root `.env`:
```
L1_URL                    # Ethereum RPC for scripts
BOOTNODE                  # Aztec node URL
L1_CHAIN_ID               # 11155111 (Sepolia)
```

## Important Notes

- **Vercel deployment:** All API routes run as serverless functions — no shared in-memory state between invocations. Nonces must be in DB, not in-memory.
- **Next.js build requires `--webpack` flag** due to Node.js polyfill config for Aztec WASM modules.
- **No COOP/COEP headers** — they break WaaP iframe wallet communication.
- **No test framework configured** for frontend/SDK. L1 contracts use Forge, L2 contracts use Aztec CLI.
- **Aztec version:** devnet 4 (`4.0.0-devnet.2-patch.3`). Check `packages/sdk/package.json` for pinned versions.
- **EIP-55 checksums:** Always use `getAddress()` from viem before passing addresses to SIWE.
