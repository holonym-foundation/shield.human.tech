import { BridgeDirection } from '@prisma/client'
export { BridgeDirection }

export interface Network {
  id: number;
  img: string;
  title: string;
  chainId: number;
  network: string;
  symbol: string;
}

export interface Token {
  id: number;
  img: string;
  title: string;
  symbol: string;
  decimals: number;
  address: string;
  // Bridge contract info (populated from deployed-tokens.json)
  l1TokenContract?: string;
  l2TokenContract?: string;
  l1PortalContract?: string;
  l2BridgeContract?: string;
  l2ProxyContract?: string;
  feeAssetHandler?: string;
  pairedSymbol?: string;
}

export interface BridgeSectionState {
  network: Network | null;
  token: Token | null;
}

export interface BridgeState {
  from: BridgeSectionState;
  to: BridgeSectionState;
  direction: BridgeDirection;
  amount: string;
}
