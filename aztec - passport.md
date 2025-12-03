off chain signer/ attester -- which checks the passport score and tells us how much they can bridge


if they have proof of clean hand and then they can bridge any amount


# Passport Verification & Bridge Limits

This document describes the off-chain signer/attester system that checks passport scores and enforces bridge limits.

## Overview

The system implements an off-chain attester that:
1. Checks a user's passport score (via Holonym API integration)
2. Determines bridge limits based on the score
3. Issues signed attestations that verify the user's bridge capacity
4. Enforces limits before allowing bridge transactions

## Key Features

### Proof of Clean Hand
Users with a passport score of 90+ receive "Proof of Clean Hand" status, allowing them to bridge **unlimited amounts**.

### Bridge Limit Tiers

| Score Range | Tier | Max Bridge Amount |
|------------|------|------------------|
| 90-100 | Proof of Clean Hand | Unlimited |
| 75-89 | High Trust | 10,000 tokens |
| 50-74 | Medium Trust | 1,000 tokens |
| 25-49 | Low Trust | 100 tokens |
| 0-24 | Very Low Trust | 10 tokens |

## Architecture

### API Endpoints

#### `POST /api/passport/verify`
Verifies passport score and creates an attestation signature.

**Request:**
```json
{
  "address": "0x..."
}
```

**Response:**
```json
{
  "success": true,
  "address": "0x...",
  "passportScore": 95,
  "tier": "Proof of Clean Hand",
  "maxBridgeAmount": null,
  "hasProofOfCleanHand": true,
  "attestation": {
    "signature": "0x...",
    "attesterAddress": "0x...",
    "timestamp": 1234567890,
    "message": "0x...|95|unlimited|1234567890"
  }
}
```

#### `POST /api/passport/verify-signature`
Verifies an attestation signature.

**Request:**
```json
{
  "address": "0x...",
  "signature": "0x...",
  "message": "...",
  "attesterAddress": "0x..."
}
```

### Frontend Hooks

#### `usePassportVerification()`
Main hook for passport verification. Returns:
- `data`: Verification result with passport score and limits
- `isLoading`: Loading state
- `canBridgeAmount(amount)`: Check if amount is within limit
- `getRemainingCapacity(amount)`: Get remaining bridge capacity
- `refreshVerification()`: Refresh verification

#### `useCanBridgeAmount(amount)`
Helper hook to check if a specific amount can be bridged.

### Components

#### `PassportVerificationBadge`
Displays passport verification status and bridge limits in the UI.

## Setup

### Environment Variables

Add to your `.env.local`:

```bash
ATTESTER_PRIVATE_KEY=0x... # Private key of the attester wallet
```

**Important:** This private key should be kept secure and only used for signing attestations.

### Holonym API Integration

Currently, the system uses a mock implementation for passport scores. To integrate with the actual Holonym API:

1. Update the `getPassportScore()` function in `/api/passport/verify/route.ts`
2. Replace the mock implementation with actual API call:

```typescript
async function getPassportScore(address: string): Promise<number> {
  const response = await fetch(`https://api.holonym.id/passport/score/${address}`)
  const data = await response.json()
  return data.score
}
```

## How It Works

1. **User connects wallet** → System automatically fetches passport verification
2. **User enters bridge amount** → System checks if amount is within limit
3. **Before bridging** → System verifies passport score and limits
4. **If limit exceeded** → User sees error message with their limit
5. **If within limit** → Bridge proceeds normally

## Attestation Details

Attestations are:
- **Signed** by the attester's private key
- **Cached** in localStorage for 24 hours
- **Verified** before each bridge transaction
- **Format**: `address|passportScore|maxBridgeAmount|timestamp`

## Security Considerations

1. **Attestation Expiration**: Attestations expire after 24 hours
2. **Signature Verification**: All attestations are cryptographically verified
3. **Off-chain**: Attestations are off-chain, reducing gas costs
4. **Rate Limiting**: Consider adding rate limiting to the API endpoints

## Future Enhancements

1. **On-chain Verification**: Store attestations on-chain for additional security
2. **Multiple Attesters**: Support multiple attesters with threshold signatures
3. **Dynamic Limits**: Adjust limits based on additional factors
4. **Historical Tracking**: Track bridge history per user
