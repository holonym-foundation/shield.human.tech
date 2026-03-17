import { recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f094538c5f7a4d3f2db4f93f0f5f1d5e3c5d9b77',
)

const domain = {
  name: 'Permit2',
  chainId: 11155111,
  verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
}

const permitMessage = {
  permitted: {
    token: '0x1111111111111111111111111111111111111111',
    amount: 123n,
  },
  spender: '0x2222222222222222222222222222222222222222',
  nonce: 456n,
  deadline: 789n,
}

// Mirrors frontend/src/hooks/bridge/bridgeL1ToL2.ts::signPermit2Transfer.
const frontendTypes = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
}

// Matches Uniswap Permit2 SignatureTransfer.permitTransferFrom docs.
const canonicalPermit2Types = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
}

const signature = await account.signTypedData({
  domain,
  types: frontendTypes,
  primaryType: 'PermitTransferFrom',
  message: permitMessage,
})

const recoveredWithFrontendSchema = await recoverTypedDataAddress({
  domain,
  types: frontendTypes,
  primaryType: 'PermitTransferFrom',
  message: permitMessage,
  signature,
})

const recoveredWithCanonicalSchema = await recoverTypedDataAddress({
  domain,
  types: canonicalPermit2Types,
  primaryType: 'PermitTransferFrom',
  message: {
    permitted: permitMessage.permitted,
    nonce: permitMessage.nonce,
    deadline: permitMessage.deadline,
  },
  signature,
})

console.log(
  JSON.stringify(
    {
      signer: account.address,
      signature,
      recoveredWithFrontendSchema,
      recoveredWithCanonicalSchema,
      frontendSchemaMatchesSigner:
        recoveredWithFrontendSchema.toLowerCase() === account.address.toLowerCase(),
      canonicalSchemaMatchesSigner:
        recoveredWithCanonicalSchema.toLowerCase() === account.address.toLowerCase(),
    },
    null,
    2,
  ),
)
