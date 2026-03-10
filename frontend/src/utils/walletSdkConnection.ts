import {
  WalletManager,
  type WalletProvider,
  type PendingConnection,
  type DiscoverySession,
} from '@aztec/wallet-sdk/manager'
import { hashToEmoji } from '@aztec/wallet-sdk/crypto'
import type { ChainInfo } from '@aztec/aztec.js/account'
import { Fr } from '@aztec/aztec.js/fields'
import { L1_CHAIN_ID, ROLLUP_VERSION } from '@/config'

export const APP_ID = 'Human Tech'

let cachedChainInfo: ChainInfo | null = null

export function getChainInfo(): ChainInfo {
  if (cachedChainInfo) return cachedChainInfo
  cachedChainInfo = {
    chainId: new Fr(L1_CHAIN_ID),
    version: new Fr(ROLLUP_VERSION),
  }
  return cachedChainInfo
}

export function discoverWallets(opts?: {
  timeout?: number
  onWalletDiscovered?: (provider: WalletProvider) => void
}): DiscoverySession {
  const manager = WalletManager.configure({ extensions: { enabled: true } })
  return manager.getAvailableWallets({
    chainInfo: getChainInfo(),
    appId: APP_ID,
    timeout: opts?.timeout ?? 60000,
    onWalletDiscovered: opts?.onWalletDiscovered,
  })
}

export async function connectToProvider(
  provider: WalletProvider
): Promise<PendingConnection> {
  return provider.establishSecureChannel(APP_ID)
}

export { hashToEmoji }
export type { WalletProvider, PendingConnection, DiscoverySession }
