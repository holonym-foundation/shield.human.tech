import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { AztecAddress } from '@aztec/stdlib/aztec-address'
import { ADDRESS } from '@/config'
import { TokenBridgeContract } from '@aztec/noir-contracts.js/TokenBridge'
import { TokenContract } from '@aztec/noir-contracts.js/Token'
import { Contract } from 'raven-house-wallet-sdk/eip1193'
import { showToast } from '@/hooks/useToast'
import { getL1ContractAddresses } from '@/utils/aztecHelpers'

class L2Token extends Contract.fromAztec(TokenContract as any) {}
class L2TokenBridge extends Contract.fromAztec(TokenBridgeContract as any) {}

// Use intersection type instead of extending
type L2TokenMetadata = {
  name: string
  symbol: string
  decimals: number
}

interface ContractState {
  l2TokenContract: L2Token | null
  l2TokenMetadata: L2TokenMetadata | null
  l2BridgeContract: L2TokenBridge | null
  l1ContractAddresses: any | null
  setL2Contracts: (aztecAccount: any) => Promise<void>
  resetContracts: () => void
}

const contractStore = create<ContractState>((set) => ({
  l2TokenContract: null,
  l2TokenMetadata: null,
  l2BridgeContract: null,
  l1ContractAddresses: null,

  setL2Contracts: async (aztecAccount) => {
    if (!aztecAccount) {
      return
    }

    try {
      const l1ContractAddresses = await getL1ContractAddresses(aztecAccount)

      // Check if this is an Azguard wallet (has azguardClient)
      const isAzguard = !!aztecAccount.azguardClient

      if (isAzguard) {
        const azguardClient = aztecAccount.azguardClient
        if (!azguardClient) {
          throw new Error('Azguard client not found in account')
        }

        // Try to register contracts without instance/artifact - Azguard will fetch them from PXE/node
        try {
          const tokenAddress = ADDRESS[1674512022].L2.TOKEN_CONTRACT
          const bridgeAddress = ADDRESS[1674512022].L2.TOKEN_BRIDGE_CONTRACT
          const chain = 'aztec:1674512022'
          
          // Register contracts - Azguard will fetch instance/artifact from PXE/node automatically
          try {
            await azguardClient.execute([
              {
                kind: 'register_contract',
                chain,
                address: tokenAddress,
                // instance and artifact are optional - Azguard will fetch them
              },
            ])
          } catch {
            // Contract might already be registered
          }
          
          try {
            await azguardClient.execute([
              {
                kind: 'register_contract',
                chain,
                address: bridgeAddress,
                // instance and artifact are optional - Azguard will fetch them
              },
            ])
          } catch {
            // Contract might already be registered
          }
        } catch {
          // Contracts will be registered automatically on first use
        }
        
        const nameResponse = 'Test USDC'
        const symbolResponse = 'USDC'
        const decimals = 6

        set({
          l2TokenContract: null, // Not used for Azguard
          l2TokenMetadata: {
            name: nameResponse,
            symbol: symbolResponse,
            decimals: Number(decimals),
          },
          l2BridgeContract: null, // Not used for Azguard
          l1ContractAddresses,
        })
      } else {
        // For Obsidion (SDK), create Contract instances
        const token = await L2Token.at(
          AztecAddress.fromString(ADDRESS[1674512022].L2.TOKEN_CONTRACT) as any,
          aztecAccount
        )

        const bridge = await L2TokenBridge.at(
          AztecAddress.fromString(ADDRESS[1674512022].L2.TOKEN_BRIDGE_CONTRACT) as any,
          aztecAccount
        )

        const nameResponse = 'Test USDC'
        const symbolResponse = 'USDC'
        const decimals = 6

        set({
          l2TokenContract: token,
          l2TokenMetadata: {
            name: nameResponse,
            symbol: symbolResponse,
            decimals: Number(decimals),
          },
          l2BridgeContract: bridge,
          l1ContractAddresses,
        })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      showToast('error', `Failed to setup contracts: ${errorMessage}`)
    }
  },

  resetContracts: () => {
    set({
      l2TokenContract: null,
      l2TokenMetadata: null,
      l2BridgeContract: null,
      l1ContractAddresses: null,
    })
  },
}))

// Export main store with all state and actions
export const useContractStore = () =>
  contractStore(
    useShallow((state) => ({
      l2TokenContract: state.l2TokenContract,
      l2TokenMetadata: state.l2TokenMetadata,
      l2BridgeContract: state.l2BridgeContract,
      l1ContractAddresses: state.l1ContractAddresses,
      setL2Contracts: state.setL2Contracts,
      resetContracts: state.resetContracts,
    }))
  )

// Export the store directly for non-hook usage
export { contractStore }
