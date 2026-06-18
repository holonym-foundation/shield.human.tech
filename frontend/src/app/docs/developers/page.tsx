import React from 'react'
import DocsLayout, { Callout, Code, P, UL, Table, Th, Td, type DocsSection } from '@/components/DocsLayout'
import CodeBlock from '@/components/CodeBlock'

export const metadata = {
  title: 'Developer Guide · Aztec Bridge Docs',
  description: 'Integrate the @human.tech/aztec-bridge-sdk into your dapp — API reference and examples.',
}

const sections: DocsSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    content: (
      <>
        <P>
          <Code>@human.tech/aztec-bridge-sdk</Code> wraps the full bridge flow — authentication, L1↔L2 transfers,
          optional fuel swaps, recovery, and attestation — behind a single <Code>HumanTechBridge</Code> class.
        </P>
        <UL>
          <li>Works in the browser and in Node.js.</li>
          <li>Aztec and viem dependencies are bundled — there are no peer dependencies to install separately.</li>
          <li>Fully typed; every public type is exported from the package root.</li>
        </UL>
      </>
    ),
  },
  {
    id: 'install',
    label: 'Installation',
    content: (
      <>
        <CodeBlock lang="bash">{`npm install @human.tech/aztec-bridge-sdk`}</CodeBlock>
        <P>You supply your own Ethereum RPC URL; the SDK does not bundle a default endpoint.</P>
      </>
    ),
  },
  {
    id: 'init',
    label: 'Initialization',
    content: (
      <>
        <CodeBlock>{`import { HumanTechBridge, ACTIVE_DEPLOYMENT_ID } from '@human.tech/aztec-bridge-sdk'

const bridge = new HumanTechBridge({
  l1RpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY', // required
  deployment: ACTIVE_DEPLOYMENT_ID, // optional, defaults to the active deployment
  domain: window.location.origin,   // optional in the browser, required in Node.js
  apiUrl: 'https://bridge.human.tech', // optional, this is the default
  // l2NodeUrl: '...'               // optional, overrides the deployment default
})`}</CodeBlock>
        <Callout tone="info">
          <Code>domain</Code> is used to derive the encryption key for operation backups. In the browser it defaults to{' '}
          <Code>window.location.origin</Code>; in Node.js you must pass it explicitly.
        </Callout>
      </>
    ),
  },
  {
    id: 'auth',
    label: 'Authentication',
    content: (
      <>
        <P>The SDK authenticates with Sign-In with Ethereum (SIWE / EIP-4361) and returns a JWT.</P>
        <CodeBlock>{`const { token, userId, user } = await bridge.authenticate({
  l1Address: '0x...',              // Ethereum address
  l2Address: '0x...',              // Aztec address
  domain: window.location.host,
  uri: window.location.origin,
  chainId: 1,                      // Ethereum mainnet
  signMessage: (msg) => wallet.signMessage(msg),
  // optional: nonce, l1LoginMethod, l1WalletProvider, l2LoginMethod, l2WalletProvider
})

// Persist the JWT, then restore it on the next page load:
bridge.setAuthToken(token)

// Non-throwing session check — call on startup to detect a stale JWT:
const session = await bridge.verifySession()
if (!session.valid) {
  // session.reason: 'no_token' | 'token_expired' | 'user_not_found' | 'network_error'
}`}</CodeBlock>
        <Callout tone="warning">
          <Code>authenticate()</Code> requires <Code>domain</Code>, <Code>uri</Code>, and <Code>chainId</Code> (a
          breaking change from v1).
        </Callout>
      </>
    ),
  },
  {
    id: 'wallet-adapter',
    label: 'Wallet Adapter',
    content: (
      <>
        <P>
          Bridging and withdrawing need a <Code>walletAdapter</Code> — the link between this SDK and an Aztec wallet.
          It&apos;s any object implementing <Code>WalletAdapterInterface</Code> (defined by this SDK), so you can wrap an{' '}
          <Code>@aztec/wallet-sdk</Code> wallet or your own.
        </P>
        <CodeBlock>{`import type { WalletAdapterInterface } from '@human.tech/aztec-bridge-sdk'

const walletAdapter: WalletAdapterInterface = {
  // L2 TokenBridge address this adapter acts on
  bridgeAddress: '0x...',

  // Run an L2 contract call; return the resulting tx hash
  async executeCall(contractAddress, method, args, options) {
    const txHash = await myAztecWallet.call(contractAddress, method, args, options)
    return { txHash }
  },

  // Private L2 -> L1 exit
  async executeWithdrawToL1Private(l1Address, amount, nonce, cleanHands, passport, l2Address) {
    const { txHash, l2BlockNumber } = await myAztecWallet.withdrawPrivate(/* ... */)
    return { txHash, l2BlockNumber }
  },

  // Public L2 -> L1 exit (same signature as the private variant)
  async executeWithdrawToL1Public(l1Address, amount, nonce, cleanHands, passport, l2Address) {
    const { txHash, l2BlockNumber } = await myAztecWallet.withdrawPublic(/* ... */)
    return { txHash, l2BlockNumber }
  },

  // Optional: register the bridged token with the wallet's PXE after claiming
  async registerToken(tokenAddress) { /* ... */ },
}`}</CodeBlock>
        <Callout tone="info">
          Register the token and bridge contracts with your Aztec wallet&apos;s PXE before bridging, or the L2 claim
          will fail. The Next.js app in this monorepo is a complete reference implementation.
        </Callout>
      </>
    ),
  },
  {
    id: 'bridge',
    label: 'Bridge L1 → L2',
    content: (
      <>
        <P>Deposit an ERC-20 on Ethereum and claim it on Aztec. Pass an optional fuel config to also fund L2 gas.</P>
        <CodeBlock>{`const result = await bridge.bridgeL1ToL2({
  token: 'USDC',          // symbol or L1 contract address
  amount: '100.00',       // human-readable amount
  l1Address: '0x...',
  l2Address: '0x...',
  isPrivate: true,        // private (shielded) or public claim on L2
  fuel: {
    enabled: true,
    amount: '5',          // token amount (native decimals) to swap into FeeJuice
    fuelType: 'private',  // 'public' | 'private' — must be 'private' in private mode
    slippageBps: 300,     // optional, default 300 (3%)
  },
  // fuelQuote is optional — omit it and the SDK builds the V4 quote internally
  sendTransaction: (tx) => wallet.sendTransaction(tx),
  walletAdapter: aztecWalletAdapter, // implements WalletAdapterInterface (see "Wallet Adapter")
  signMessage: (msg) => wallet.signMessage(msg),
  signTypedData: (addr, json) => wallet.signTypedData(addr, JSON.parse(json)), // Permit2
  onEvent: (event) => console.log(event.type, event),
})
// result: { operationId, l1TxHash, l2TxHash, l1TxUrl, l2TxUrl }`}</CodeBlock>
        <Callout tone="warning">
          Never use <Code>fuelType: &apos;public&apos;</Code> in private mode — it leaks the L2 recipient on-chain.
        </Callout>
      </>
    ),
  },
  {
    id: 'withdraw',
    label: 'Withdraw L2 → L1',
    content: (
      <>
        <P>Burn the token on Aztec and finalize the withdrawal on Ethereum.</P>
        <CodeBlock>{`const result = await bridge.withdrawL2ToL1({
  token: 'cUSDC',         // L2 symbol or L2 contract address
  amount: '50.00',
  l1Address: '0x...',     // L1 recipient
  l2Address: '0x...',
  isPrivate: true,
  sendTransaction: (tx) => wallet.sendTransaction(tx),
  walletAdapter: aztecWalletAdapter,
  signMessage: (msg) => wallet.signMessage(msg),
  onEvent: (event) => console.log(event.type, event),
})`}</CodeBlock>
      </>
    ),
  },
  {
    id: 'attestation',
    label: 'Attestation',
    content: (
      <>
        <P>
          Every deposit and withdrawal — public or private — is gated on an attestation (Proof of Clean Hands, with a
          Passport fallback). The SDK fetches it automatically inside <Code>bridgeL1ToL2</Code> and{' '}
          <Code>withdrawL2ToL1</Code>; the calls below are optional pre-checks for your own UI.
        </P>
        <CodeBlock>{`// Full status: binding, nonce counts, attester config
const status = await bridge.getAttestationStatus()

// Lightweight pre-checks — no nonce consumed
const poch = await bridge.checkPochEligibility()
if (!poch.eligible) {
  const passport = await bridge.checkPassportEligibility()
  // passport.eligible, passport.score, passport.maxAmount
}`}</CodeBlock>
      </>
    ),
  },
  {
    id: 'resume',
    label: 'Resume',
    content: (
      <>
        <P>
          List operations and resume any that were interrupted. <Code>resume()</Code> auto-detects the recovery stage
          and continues from where it left off.
        </P>
        <CodeBlock>{`const ops = await bridge.getOperations()
const op = await bridge.getOperation(operationId) // fetch a single operation by ID

const result = await bridge.resume(operationId, {
  signMessage: (msg) => wallet.signMessage(msg),
  sendTransaction: (tx) => wallet.sendTransaction(tx), // needed for L2→L1 resume
  walletAdapter: aztecWalletAdapter,                   // needed for L1→L2 resume
  l1Address: '0x...',                                  // optional hint
  l2Address: '0x...',                                  // optional hint
  onEvent: (event) => console.log(event.type, event),
})`}</CodeBlock>
      </>
    ),
  },
  {
    id: 'events',
    label: 'Events',
    content: (
      <>
        <P>
          Pass an <Code>onEvent</Code> callback to observe the lifecycle — useful for progress UI, toasts, and
          telemetry. Use the <Code>BridgeEventType</Code> constants instead of raw strings.
        </P>
        <Table>
          <thead>
            <tr>
              <Th>Event type</Th>
              <Th>Fires when</Th>
            </tr>
          </thead>
          <tbody>
            <tr><Td><Code>operation_created</Code></Td><Td>The backend operation record is created</Td></tr>
            <tr><Td><Code>secrets_generated</Code></Td><Td>Claim secrets generated (hashes + encrypted payload only)</Td></tr>
            <tr><Td><Code>attestation_fetch</Code></Td><Td>Fetching a POCH or Passport attestation</Td></tr>
            <tr><Td><Code>do_not_reload</Code></Td><Td>An irreversible on-chain tx is imminent — show a warning</Td></tr>
            <tr><Td><Code>deposit_sent</Code></Td><Td>L1 deposit transaction sent</Td></tr>
            <tr><Td><Code>claim_attempt</Code></Td><Td>L2 claim attempt starting</Td></tr>
            <tr><Td><Code>burn_sent</Code></Td><Td>L2→L1 burn transaction sent</Td></tr>
            <tr><Td><Code>witness_computed</Code></Td><Td>L2→L1 membership witness ready</Td></tr>
            <tr><Td><Code>l1_withdraw_sent</Code></Td><Td>L1 finalization transaction sent</Td></tr>
            <tr><Td><Code>token_registered</Code></Td><Td>Token registered in the wallet after claiming</Td></tr>
            <tr><Td><Code>error</Code></Td><Td>An error occurred (carries a <Code>fundsAtRisk</Code> flag)</Td></tr>
          </tbody>
        </Table>
      </>
    ),
  },
  {
    id: 'fuel-quote',
    label: 'Fuel Quotes',
    content: (
      <>
        <P>
          Preview the expected FeeJuice output before committing. For actual bridging, prefer passing <Code>fuel</Code>{' '}
          to <Code>bridgeL1ToL2</Code> without a pre-built quote — the SDK builds it internally and guarantees the same
          routing the contract call uses.
        </P>
        <CodeBlock>{`const quote = await bridge.getFuelQuote({
  token: 'USDC',      // symbol or L1 contract address
  fuelAmount: '5',    // token amount in NATIVE decimals (not USD)
  slippageBps: 300,   // optional, default 300 (3%)
})
// quote: { expectedOutput, minOutput, poolKeys, zeroForOnes }`}</CodeBlock>
      </>
    ),
  },
  {
    id: 'errors',
    label: 'Error Handling',
    content: (
      <>
        <P>
          API failures throw <Code>BridgeApiError</Code>, which carries a human-readable message and the raw response.
        </P>
        <CodeBlock>{`import { BridgeApiError } from '@human.tech/aztec-bridge-sdk'

try {
  await bridge.bridgeL1ToL2(params)
} catch (err) {
  if (err instanceof BridgeApiError) {
    console.error(err.friendlyMessage) // human-readable
    console.error(err.status)          // HTTP status code
    console.error(err.parsedBody)      // parsed JSON body, or null
  }
}`}</CodeBlock>
        <Callout tone="info">
          Call <Code>bridge.verifyNodeCompatibility()</Code> once at startup to detect a node whose rollup version
          doesn&apos;t match the SDK build — a mismatch puts the resume/witness paths at risk.
        </Callout>
      </>
    ),
  },
  {
    id: 'other-methods',
    label: 'Other Methods',
    content: (
      <>
        <P>Additional helpers on the <Code>HumanTechBridge</Code> instance:</P>
        <Table>
          <thead>
            <tr>
              <Th>Method</Th>
              <Th>Returns / purpose</Th>
            </tr>
          </thead>
          <tbody>
            <tr><Td><Code>getOperation(id)</Code></Td><Td>A single operation by ID</Td></tr>
            <tr><Td><Code>getAttestationStatus()</Code></Td><Td>Binding status, nonce counts, attester config</Td></tr>
            <tr><Td><Code>getPortalFeeBasisPoints(portal)</Code></Td><Td>TokenPortal fee rate (bps), to compute the post-fee amount</Td></tr>
            <tr><Td><Code>getL1TokenBalances(address, chains)</Code></Td><Td>L1 token balances via the backend Alchemy proxy</Td></tr>
            <tr><Td><Code>getAztecNodeInfo()</Code></Td><Td>L2 node info (version, L1 contract addresses)</Td></tr>
            <tr><Td><Code>isAztecNodeReady()</Code></Td><Td>Whether the L2 node is accepting requests</Td></tr>
            <tr><Td><Code>getAztecPendingTxCount()</Code></Td><Td>L2 mempool pending-tx count (a congestion signal)</Td></tr>
            <tr><Td><Code>getAztecBlockHeader(n | &apos;latest&apos;)</Code></Td><Td>An L2 block header</Td></tr>
            <tr><Td><Code>retryFailedPatches()</Code></Td><Td>Re-send backend updates queued after a network failure</Td></tr>
          </tbody>
        </Table>
      </>
    ),
  },
  {
    id: 'types',
    label: 'Type Reference',
    content: (
      <>
        <P>Key types exported from the package root:</P>
        <Table>
          <thead>
            <tr>
              <Th>Type</Th>
              <Th>Purpose</Th>
            </tr>
          </thead>
          <tbody>
            <tr><Td><Code>HumanTechBridgeConfig</Code></Td><Td>Constructor options</Td></tr>
            <tr><Td><Code>BridgeL1ToL2Params</Code></Td><Td>Deposit parameters</Td></tr>
            <tr><Td><Code>WithdrawL2ToL1Params</Code></Td><Td>Withdrawal parameters</Td></tr>
            <tr><Td><Code>ResumeParams</Code></Td><Td>Resume parameters</Td></tr>
            <tr><Td><Code>BridgeResult</Code></Td><Td>Operation result (ids, tx hashes, URLs)</Td></tr>
            <tr><Td><Code>BridgeOperation</Code></Td><Td>Full backend operation record</Td></tr>
            <tr><Td><Code>BridgeOperationStatus</Code></Td><Td>Status union (pending → … → completed / failed)</Td></tr>
            <tr><Td><Code>BridgeEvent</Code> / <Code>BridgeEventCallback</Code></Td><Td>Lifecycle events and the <Code>onEvent</Code> signature</Td></tr>
            <tr><Td><Code>FuelQuote</Code></Td><Td>Fuel swap quote (expected/min output, pool keys)</Td></tr>
            <tr><Td><Code>WalletAdapterInterface</Code></Td><Td>Aztec wallet adapter contract</Td></tr>
            <tr><Td><Code>SessionStatus</Code></Td><Td>Result of <Code>verifySession()</Code></Td></tr>
            <tr><Td><Code>BridgeApiError</Code></Td><Td>Error thrown by API calls</Td></tr>
          </tbody>
        </Table>
      </>
    ),
  },
]

export default function DevelopersDocsPage() {
  return (
    <DocsLayout
      title="Developer Guide"
      subtitle="Integrate the bridge SDK into your dapp."
      sections={sections}
    />
  )
}
