import React from 'react'
import DocsLayout, { Callout, Code, P, UL, Table, Th, Td, type DocsSection } from '@/components/DocsLayout'
import { getBridgeMaxDepositUsd } from '@/lib/attestation'

const maxDepositUsd = getBridgeMaxDepositUsd()

export const metadata = {
  title: 'User Guide · Shield',
  description: 'Risks, limits, tokens, backup, and recovery for Shield, the human.tech bridge to Aztec.',
  alternates: { canonical: 'https://support.shield.human.tech/getting-started' },
}

const sections: DocsSection[] = [
  {
    id: 'alpha',
    label: 'Network & Risks',
    content: (
      <>
        <P>
          This bridge runs on Ethereum mainnet and the Aztec network. You are moving real assets — treat every
          transaction as final.
        </P>
        <UL>
          <li>
            Shield&apos;s components are independently audited, each scoped to its component: the bridge contracts by
            Nethermind Security, the Clean Hands ZK circuits by Hexens, and the Human Network cryptography by Halborn.
            The Aztec network it runs on is still an early (alpha) network, so undiscovered bugs are still possible.
          </li>
          <li>There are no warranties, refunds, or insurance.</li>
          <li>
            It is non-custodial: the protocol smart contracts hold your funds in transit, not Human Tech. No one can
            move or recover them on your behalf.
          </li>
        </UL>
        <Callout tone="danger">
          You can permanently lose funds. Bridge only what you can afford to lose while the network is in Alpha.
        </Callout>
      </>
    ),
  },
  {
    id: 'risks',
    label: 'Risks',
    content: (
      <>
        <UL>
          <li>
            <strong>Irreversibility.</strong> Once an L1 transaction is submitted it cannot be reversed. If the L2 claim
            fails, your funds are not lost but must be recovered via Resume.
          </li>
          <li>
            <strong>L1 gas is spent regardless.</strong> Ethereum gas is consumed even if the bridge fails partway.
          </li>
          <li>
            <strong>Fuel swap slippage.</strong> When you fund gas, a portion of your tokens is swapped on Uniswap V4
            for FeeJuice. The amount received can differ from the quoted estimate.
          </li>
          <li>
            <strong>Loss of access.</strong> Operation secrets are encrypted with your wallet. If you lose both your
            wallet and your backup, no one can recover the funds.
          </li>
          <li>
            <strong>FeeJuice is non-transferable.</strong> Once FeeJuice lands at an address on Aztec, it cannot be
            moved.
          </li>
        </UL>
        <Callout tone="warning">
          While a bridge is in progress: don&apos;t reload or close the page, or it may be difficult to recover your
          funds.
        </Callout>
      </>
    ),
  },
  {
    id: 'getting-started',
    label: 'Getting Started',
    content: (
      <>
        <P>
          Bridging uses two wallets: an <strong>Ethereum (L1) wallet</strong> for the deposit, and a separate{' '}
          <strong>Aztec (L2) wallet</strong> that receives and claims your tokens.
        </P>
        <P>A first bridge, end to end:</P>
        <UL>
          <li>Connect your Ethereum wallet.</li>
          <li>
            Connect your Aztec wallet — you&apos;ll confirm a short set of emojis to verify the connection is genuine.
          </li>
          <li>
            Complete verification once (see{' '}
            <a href="#verification" className="text-latest-blue-100 underline">Verification</a>) — required before any
            bridge.
          </li>
          <li>
            Pick a token and amount, and optionally turn on gas top-up (see{' '}
            <a href="#fuel" className="text-latest-blue-100 underline">Fuel &amp; Gas</a>).
          </li>
          <li>Approve the deposit in your Ethereum wallet.</li>
          <li>Wait for the tokens to arrive on Aztec and claim them — this can take roughly 15–50 minutes.</li>
        </UL>
        <Callout tone="info">
          The bridge claims on L2 for you while the page is open. If you close it mid-way, resume from the Activity page
          (see <a href="#resume" className="text-latest-blue-100 underline">Resuming</a>).
        </Callout>
      </>
    ),
  },
  {
    id: 'verification',
    label: 'Verification',
    content: (
      <>
        <P>
          Every bridge — public or private — requires a one-time humanity check that proves you&apos;re a unique,
          legitimate user. There are two ways to pass it, and the bridge tries them in order:
        </P>
        <UL>
          <li>
            <strong>Proof of Clean Hands.</strong> A privacy-preserving proof you complete once with human.tech. It
            carries the highest limit.
          </li>
          <li>
            <strong>Human Passport.</strong> A fallback that requires a Human Passport score of at least 20. It covers
            up to 1,000 USDC in total deposits (see <a href="#limits" className="text-latest-blue-100 underline">Rate
            Limits &amp; Caps</a>); completing Proof of Clean Hands lifts that cumulative limit. Daily limits still
            apply either way.
          </li>
        </UL>
        <P>
          Separately from the one-time identity check, your Ethereum address is screened against international
          sanctions and watchlist sources on <strong>every deposit and every withdrawal</strong>, in both public and
          private mode. The screen looks at the address, not at the tokens. It runs again at exit because sanctions
          listings change over time, so a withdrawal can be refused even if your deposit cleared.
        </P>
        <Callout tone="info">
          When verification is needed, the bridge links you to the right place to complete it, then you can continue
          where you left off.
        </Callout>
      </>
    ),
  },
  {
    id: 'limits',
    label: 'Rate Limits & Caps',
    content: (
      <>
        <P>
          Two limits apply while the network is in Alpha. See{' '}
          <a href="#verification" className="text-latest-blue-100 underline">Verification</a> for how to qualify.
        </P>
        <Table>
          <thead>
            <tr>
              <Th>Limit</Th>
              <Th>Value</Th>
              <Th>Notes</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>Alpha daily cap</Td>
              <Td>${maxDepositUsd} per user / day</Td>
              <Td>Total deposits per rolling 24h window. Shown as &quot;Alpha Deposit Limit Reached&quot; once used up; budget frees up as deposits age past 24h.</Td>
            </tr>
            <tr>
              <Td>Cumulative (Human Passport)</Td>
              <Td>up to 1,000 USDC total</Td>
              <Td>Requires a Human Passport attestation with score ≥ 20. This is an all-time total across
                deposits, so splitting a larger amount into several smaller ones does not get around it. Past
                1,000 USDC you need Proof of Clean Hands.</Td>
            </tr>
          </tbody>
        </Table>
        <P>
          As you approach the cap, the action button shows how much you have left (e.g. &quot;Only $4.20 left (Alpha
          limit)&quot;) and then locks once the cap is reached.
        </P>
        <Callout tone="info">
          <strong>Pending-deposit holds (Human Passport).</strong> When you request a Human Passport attestation for a
          deposit, that deposit&apos;s amount is briefly reserved against your limits so a signed authorization
          can&apos;t be stockpiled and spent later to slip past the caps. The hold clears once the deposit
          confirms on-chain, so successful deposits back-to-back are unaffected. If a deposit fails or is abandoned, its
          hold releases automatically. A retry that would exceed your remaining budget may need to wait for the hold to
          clear. While a hold is blocking a deposit, the app notes that part of your limit is held by a pending deposit.
        </Callout>
      </>
    ),
  },
  {
    id: 'tokens',
    label: 'Supported Tokens',
    content: (
      <>
        <Table>
          <thead>
            <tr>
              <Th>L1 token</Th>
              <Th>L2 name</Th>
              <Th>L2 symbol</Th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <Td>USDC</Td>
              <Td>Clean USDC</Td>
              <Td>cUSDC</Td>
            </tr>
          </tbody>
        </Table>
        <P>USDC is the only token enabled today. Additional tokens may be added as the network matures.</P>
      </>
    ),
  },
  {
    id: 'modes',
    label: 'Private vs Public',
    content: (
      <>
        <P>Toggle between modes with the icon in the header. Your choice is remembered between visits.</P>
        <UL>
          <li>
            <strong>Private mode.</strong> Your balance and history live as private notes in your Aztec wallet, so
            your activity on Aztec is not visible on the Aztec explorer. Gas funding (fuel) is routed through the
            Bridged Fee Payment Contract. Note that the Ethereum side stays public either way: your deposit and your
            later withdrawal are both visible on Ethereum, so someone watching that address can see you used the
            bridge and for how much.
          </li>
          <li>
            <strong>Public mode.</strong> Your balance and transfers are visible on the Aztec block explorer. Fuel can
            be sent to any address you choose.
          </li>
        </UL>
        <Callout tone="info">
          Choose private mode before bridging if you want your Aztec activity to stay confidential. The setting applies
          to the operation you start while it is enabled.
        </Callout>
      </>
    ),
  },
  {
    id: 'fuel',
    label: 'Fuel & Gas',
    content: (
      <>
        <P>
          <strong>FeeJuice</strong> is the gas token on Aztec. You need FeeJuice in your Aztec wallet to claim your
          bridged tokens on L2.
        </P>
        <UL>
          <li>
            Turn on <strong>Top up gas balance</strong> while bridging and the app swaps a small portion of your
            deposit into FeeJuice automatically (route: USDC → ETH → FeeJuice on Uniswap V4).
          </li>
          <li>Quick presets let you fund roughly $1, $5, or $10 worth of gas.</li>
          <li>In private mode the fuel goes to the Bridged FPC; in public mode you can direct it to any address.</li>
        </UL>
        <Callout tone="warning">
          FeeJuice is non-transferable. If you fund someone else&apos;s address, they need a claim link from you to use
          it — it can&apos;t be sent back.
        </Callout>
      </>
    ),
  },
  {
    id: 'fuel-links',
    label: 'Sharing Gas',
    content: (
      <>
        <P>
          Because FeeJuice can&apos;t be moved once it lands, the only way to fund someone else&apos;s Aztec gas is to
          send it to their address during a bridge. When you do, the bridge gives you a <strong>claim link</strong>.
        </P>
        <UL>
          <li>Send the link to the recipient through a trusted channel.</li>
          <li>They open it and claim the FeeJuice to their Aztec account.</li>
          <li>
            Anyone holding the link can pay the gas to submit the claim, but the funds always land at the encoded
            recipient address — it can&apos;t be redirected.
          </li>
          <li>The claim works only after the deposit has propagated to L2 (the same ~15–50 minute wait).</li>
        </UL>
        <Callout tone="info">
          Lost the link? As long as the operation is still in your Activity, you can re-share it from there.
        </Callout>
      </>
    ),
  },
  {
    id: 'backup',
    label: 'Backups',
    content: (
      <>
        <P>
          Your operation secrets are encrypted on your device and also stored, encrypted, on the backend. Keep your own
          backup so you can recover even if your browser storage is cleared.
        </P>
        <UL>
          <li>
            On the progress screen, use <strong>Export Backup ↓</strong> to download a JSON file for any incomplete
            operation.
          </li>
          <li>
            The file is named like <Code>shield-human-tech-claim-&#123;id&#125;-&#123;timestamp&#125;.json</Code> (or{' '}
            <Code>shield-human-tech-withdrawal-…</Code> for withdrawals).
          </li>
          <li>Save your operation ID — you need it to resume from a different device or browser.</li>
        </UL>
        <P>
          Resuming from the Activity page decrypts the backend snapshot using a signature from the same wallet that
          started the bridge.
        </P>
      </>
    ),
  },
  {
    id: 'resume',
    label: 'Resuming',
    content: (
      <>
        <P>
          A bridge can be interrupted by a network drop, a closed tab, or a wallet disconnect. Open the{' '}
          <strong>Activity</strong> page to see every operation and its status, then press <strong>Resume</strong> on
          any that are incomplete.
        </P>
        <Table>
          <thead>
            <tr>
              <Th>Status</Th>
              <Th>Meaning</Th>
            </tr>
          </thead>
          <tbody>
            <tr><Td>Pending</Td><Td>Operation created, waiting for the transaction</Td></tr>
            <tr><Td>Deposited</Td><Td>L1 deposit confirmed — waiting for the L2 claim</Td></tr>
            <tr><Td>Claimed</Td><Td>L2 claim submitted — waiting for confirmation</Td></tr>
            <tr><Td>Submitted</Td><Td>L2 burn confirmed — waiting for the L1 proof</Td></tr>
            <tr><Td>Ready</Td><Td>L2 block proven on L1 — ready to finalize the withdrawal</Td></tr>
            <tr><Td>Finalizing</Td><Td>Waiting for L1 block finalization</Td></tr>
            <tr><Td>Completed</Td><Td>Bridge finished successfully</Td></tr>
            <tr><Td>Failed</Td><Td>No funds moved, no recovery needed — safe to retry</Td></tr>
          </tbody>
        </Table>
        <Callout tone="warning">
          A &quot;Funds may be locked&quot; badge appears when a deposit transaction exists but the operation is still
          Pending. Use Resume promptly.
        </Callout>
      </>
    ),
  },
  {
    id: 'troubleshooting',
    label: 'Troubleshooting',
    content: (
      <>
        <UL>
          <li>
            <strong>&quot;Aztec network is not available&quot; / &quot;congested&quot;.</strong> The network is down or
            busy; bridging is paused or slow. Wait and retry — a banner appears automatically.
          </li>
          <li>
            <strong>&quot;Alpha Deposit Limit Reached&quot;.</strong> You&apos;ve used the ${maxDepositUsd} per-user daily cap
            (rolling 24h). Budget frees up as your earlier deposits age past 24 hours.
          </li>
          <li>
            <strong>Limit held by a pending deposit.</strong> A Human Passport deposit you started
            is still holding part of your limit (see{' '}
            <a href="#limits" className="text-latest-blue-100 underline">Rate Limits &amp; Caps</a>). Once that deposit
            confirms the hold clears; if it failed or was abandoned, the hold releases on its own and you can retry.
          </li>
          <li>
            <strong>An RPC/batch error toast.</strong> Some free RPC endpoints reject batched requests. Use a paid RPC
            endpoint, or wait for the automatic retry.
          </li>
          <li>
            <strong>Bridged tokens don&apos;t appear.</strong> Make sure your Aztec wallet is synced to the correct
            node.
          </li>
        </UL>
      </>
    ),
  },
]

export default function UsersDocsPage() {
  return (
    <DocsLayout
      title="User Guide"
      subtitle="Bridge safely between Ethereum and Aztec."
      sections={sections}
    />
  )
}
