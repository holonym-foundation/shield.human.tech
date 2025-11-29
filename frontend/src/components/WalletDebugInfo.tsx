import { useWalletStore } from '@/stores/walletStore'
import { useState, useEffect } from 'react'

export default function WalletDebugInfo() {
  const { 
    waapAddress: address, 
    waapLoginMethod: loginMethod, 
    waapWalletProvider: walletProvider, 
    getAllAvailableWallets 
  } = useWalletStore()

  const [eip6963Providers, setEip6963Providers] = useState<any[]>([])

  const availableWallets = getAllAvailableWallets()

  useEffect(() => {
    // Listen for EIP-6963 announcements
    const handleProviderAnnounce = (event: any) => {
      setEip6963Providers(prev => [...prev, event.detail])
    }

    window.addEventListener('eip6963:announceProvider', handleProviderAnnounce)
    
    // Request providers to announce themselves
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    return () => {
      window.removeEventListener('eip6963:announceProvider', handleProviderAnnounce)
    }
  }, [])

  return (
    <div style={{
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      background: 'rgba(0,0,0,0.8)',
      color: 'white',
      padding: '10px',
      borderRadius: '8px',
      fontSize: '12px',
      zIndex: 9999,
      maxWidth: '350px',
      maxHeight: '400px',
      overflow: 'auto'
    }}>
      <div><strong>🔍 Wallet Debug Info:</strong></div>
      <div>Address: {address || 'Not connected'}</div>
      <div>Login Method: {loginMethod || 'null'}</div>
      <div>Wallet Provider: {walletProvider || 'null'}</div>
      <div>Available Wallets: {availableWallets.join(', ') || 'None'}</div>
      <div>Multiple Wallets: {Array.isArray(window.ethereum) ? 'Yes' : 'No'}</div>
      
      <div style={{ marginTop: '10px', borderTop: '1px solid #555', paddingTop: '10px' }}>
        <div><strong>🔍 EIP-6963 Providers:</strong></div>
        {eip6963Providers.length > 0 ? (
          eip6963Providers.map((provider, index) => (
            <div key={index} style={{ marginLeft: '10px', fontSize: '11px' }}>
              • {provider.info.name} ({provider.info.rdns})
            </div>
          ))
        ) : (
          <div style={{ fontSize: '11px', color: '#ccc' }}>No EIP-6963 providers found</div>
        )}
      </div>
    </div>
  )
}
