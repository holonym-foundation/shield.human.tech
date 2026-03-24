# @human.tech/aztec-bridge-sdk

Privacy-preserving bridge SDK for moving tokens between Ethereum (L1) and Aztec (L2).

## Install

```bash
npm install @human.tech/aztec-bridge-sdk
# or
pnpm add @human.tech/aztec-bridge-sdk
```

## Quick Start

```ts
import { HumanTechBridge } from '@human.tech/aztec-bridge-sdk'

const bridge = new HumanTechBridge({
  l1RpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY',
})
```

### Constructor Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `l1RpcUrl` | Yes | — | Ethereum JSON-RPC URL |
| `deployment` | No | Active deployment | Deployment ID from `deployments.json` |
| `domain` | No | `window.location.origin` | Domain for encryption key derivation (required in Node.js) |
| `apiUrl` | No | `"https://bridge.human.tech"` | Backend API URL. Use `""` for same-origin |
| `l2NodeUrl` | No | From deployment config | Override Aztec node URL |

## Authentication (SIWE)

The SDK uses Sign-In with Ethereum (EIP-4361) for authentication:

```ts
const { token, userId } = await bridge.authenticate({
  l1Address: '0x...', // Ethereum wallet address
  l2Address: '0x...', // Aztec wallet address
  domain: window.location.host,
  uri: window.location.origin,
  chainId: 11155111, // Sepolia
  signMessage: (msg) => wallet.signMessage(msg), // Your wallet's sign function
})

// On page reload, restore the persisted JWT:
bridge.setAuthToken(savedToken)

// Verify the session is still valid:
const session = await bridge.verifySession()
if (!session.valid) {
  // Re-authenticate. session.reason is one of:
  // 'token_expired' | 'user_not_found' | 'no_token' | 'network_error'
}
```

## L1 → L2 Deposit

```ts
const result = await bridge.bridgeL1ToL2({
  token: 'USDC',           // Token symbol or L1 address
  amount: '100',            // Human-readable amount
  l1Address: '0x...',
  l2Address: '0x...',
  isPrivate: false,         // true for privacy-preserving deposit
  sendTransaction: (tx) => wallet.sendTransaction(tx),
  walletAdapter: aztecWalletAdapter,
  signMessage: (msg) => wallet.signMessage(msg),

  // Optional: fund L2 gas
  fuel: { enabled: true, amount: '5' },
  fuelQuote: await getMockFuelQuote({ ... }),

  // Optional: progress callbacks
  onStep: (step, status) => console.log(`Step ${step}: ${status}`),
  onEvent: (event) => console.log(event),
})

console.log(result.operationId) // Track this operation
console.log(result.l1TxHash)    // L1 transaction hash
```

**Status flow:** `pending` → `deposited` → `claimed` → `completed`

## L2 → L1 Withdrawal

```ts
const result = await bridge.withdrawL2ToL1({
  token: 'cUSDC',          // L2 token symbol or address
  amount: '100',
  l1Address: '0x...',
  l2Address: '0x...',
  isPrivate: false,
  sendTransaction: (tx) => wallet.sendTransaction(tx),
  walletAdapter: aztecWalletAdapter,
  signMessage: (msg) => wallet.signMessage(msg),
  onStep: (step, status) => console.log(`Step ${step}: ${status}`),
  onEvent: (event) => console.log(event),
})
```

**Status flow:** `pending` → `submitted` → `ready` → `pending_finalize` → `completed`

## Resuming Interrupted Operations

If a bridge operation is interrupted (browser closed, network error), resume it:

```ts
const result = await bridge.resume(operationId, {
  signMessage: (msg) => wallet.signMessage(msg),
  sendTransaction: (tx) => wallet.sendTransaction(tx),  // For L2→L1
  walletAdapter: aztecWalletAdapter,                     // For L1→L2
  l1Address: '0x...',
  l2Address: '0x...',
})
```

The SDK automatically determines where the operation left off and resumes from that point. Recovery data is encrypted client-side and backed up to the server — secrets never leave the client unencrypted.

## Querying Operations

```ts
// All operations for the authenticated user
const operations = await bridge.getOperations()

// Single operation by ID
const operation = await bridge.getOperation(operationId)
```

## Deployments & Config

The SDK embeds all contract addresses and network config in `deployments.json`. Use the config helpers to access them:

```ts
import {
  ALL_DEPLOYMENTS,
  ACTIVE_DEPLOYMENT_ID,
  getDeployment,
  resolveToken,
  createConfig,
  getAztecscanUrl,
  getEtherscanUrl,
} from '@human.tech/aztec-bridge-sdk'

// Get the active deployment
const deployment = getDeployment(ACTIVE_DEPLOYMENT_ID)
console.log(deployment.tokens)     // Available tokens with all contract addresses
console.log(deployment.network)    // Chain IDs, node URLs, rollup config

// Resolve a token by symbol or address
const config = createConfig(ACTIVE_DEPLOYMENT_ID, { l1RpcUrl: '...' })
const token = resolveToken(config, 'USDC')

// Block explorer URLs
const etherscanUrl = getEtherscanUrl(11155111) // Sepolia
const aztecscanUrl = getAztecscanUrl(deployment.network.l2ChainId)
```

## Events

Subscribe to detailed lifecycle events via the `onEvent` callback:

```ts
bridge.bridgeL1ToL2({
  // ...params
  onEvent: (event) => {
    switch (event.type) {
      case 'deposit_sent':
        console.log('L1 tx:', event.l1TxHash)
        break
      case 'deposit_confirmed':
        console.log('Message hash:', event.messageHash)
        break
      case 'claim_attempt':
        console.log(`Claiming (attempt ${event.attempt}/${event.maxAttempts})`)
        break
      case 'operation_completed':
        console.log('Done! Operation:', event.operationId)
        break
      case 'error':
        console.error(event.error, 'Funds at risk:', event.fundsAtRisk)
        break
    }
  },
})
```

**Deposit events:** `deposit_sent`, `deposit_confirmed`, `claim_attempt`, `claim_retry`, `operation_completed`

**Withdrawal events:** `burn_sent`, `burn_confirmed`, `witness_computed`, `proven_poll`, `l1_withdraw_sent`, `operation_completed`

**Common events:** `operation_created`, `sync_poll`, `recovery_from_receipt`, `secrets_generated`, `error`

## Attestation (Private Operations)

For privacy-preserving operations (`isPrivate: true`), check eligibility first:

```ts
// Check attestation status
const status = await bridge.getAttestationStatus()
console.log(status.binding)  // { status: 'bound', l1Address, l2Address }

// Check POCH eligibility (no nonce consumed)
const poch = await bridge.checkPochEligibility()
console.log(poch.eligible, poch.reason)

// Check Passport eligibility
const passport = await bridge.checkPassportEligibility()
console.log(passport.eligible, passport.score, passport.maxAmount)
```

Attestation is handled automatically during `bridgeL1ToL2` and `withdrawL2ToL1` when `isPrivate: true`.

## Encryption

The SDK derives deterministic encryption keys from wallet signatures for client-side encryption of recovery data:

```ts
import {
  createSigningMessage,
  deriveEncryptionKey,
  decryptData,
} from '@human.tech/aztec-bridge-sdk'

// Create the deterministic message to sign
const message = createSigningMessage(l1Address, domain)

// Sign it with the wallet
const signature = await wallet.signMessage(message)

// Derive the encryption key
const key = await deriveEncryptionKey(l1Address, signature, domain)

// Decrypt recovery data from a stored operation
const plaintext = await decryptData(ciphertext, iv, tag, key)
```

## Aztec Node Status

```ts
const info = await bridge.getAztecNodeInfo()
const ready = await bridge.isAztecNodeReady()
const pending = await bridge.getAztecPendingTxCount()
const header = await bridge.getAztecBlockHeader('latest')
```

## Error Handling

```ts
import { BridgeApiError } from '@human.tech/aztec-bridge-sdk'

try {
  await bridge.bridgeL1ToL2({ ... })
} catch (err) {
  if (err instanceof BridgeApiError) {
    console.error(`API error ${err.status}: ${err.method} ${err.path}`)
    console.error(err.body)
  }
}
```

## Real-World Example

The [frontend](../../frontend/) directory in this monorepo is a full Next.js application built on this SDK. Key integration patterns:

- **[frontend/src/hooks/useBridge.ts](../../frontend/src/hooks/useBridge.ts)** — React context provider wrapping `HumanTechBridge`
- **[frontend/src/config/index.ts](../../frontend/src/config/index.ts)** — Deriving UI config from SDK deployments
- **[frontend/src/hooks/useL1Operations.ts](../../frontend/src/hooks/useL1Operations.ts)** — L1→L2 deposit hook
- **[frontend/src/hooks/useL2Operations.ts](../../frontend/src/hooks/useL2Operations.ts)** — L2→L1 withdrawal hook

## Network

Currently targeting **Aztec Devnet 4** on Sepolia. See `package.json` for pinned Aztec package versions.

## License

MIT
