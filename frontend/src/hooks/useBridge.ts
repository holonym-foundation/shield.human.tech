'use client'

import { createContext, useContext, useMemo } from 'react'
import { HumanTechBridge, type HumanTechBridgeConfig } from '@human.tech/aztec-bridge-sdk'

export const BridgeContext = createContext<HumanTechBridge | null>(null)

export interface BridgeProviderConfig extends HumanTechBridgeConfig {
  children: React.ReactNode
}

export function useBridgeInstance(config?: HumanTechBridgeConfig): HumanTechBridge {
  return useMemo(
    () => new HumanTechBridge(config ?? {}),
    [config?.deployment, config?.domain, config?.apiUrl, config?.l1RpcUrl, config?.l2NodeUrl],
  )
}

export function useBridge(): HumanTechBridge {
  const bridge = useContext(BridgeContext)
  if (!bridge) {
    throw new Error('useBridge must be used within a BridgeContext.Provider')
  }
  return bridge
}
