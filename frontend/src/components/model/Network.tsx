import React, { useState } from 'react';
import StyledImage from '../StyledImage';
import { BridgeDirection, Network as NetworkType } from '@/types/bridge';
import { L1_NETWORKS, L2_NETWORKS, publicAsset } from '@/config';
import { useNetworkVersions } from '@/hooks/useNetworkVersions';

// Reusable FilterButton component for consistency
function FilterButton({ active, children, className = '', ...props }: React.ComponentProps<'button'> & { active: boolean }) {
  return (
    <button
      {...props}
      className={`px-3 py-1 rounded-full text-sm font-medium transition-colors duration-200 ${
        active
          ? 'bg-latest-red-100 text-white'
          : 'bg-latest-grey-200 text-neutral-600 hover:bg-latest-grey-300'
      } ${className}`}
    >
      {children}
    </button>
  );
}

interface IProps {
  networkData: NetworkType | null;
  setNetworkData: (val: NetworkType) => void;
  handleClose: () => void;
  direction: BridgeDirection;
  isFromSection: boolean;
}

export default function Network({ networkData, setNetworkData, handleClose, direction, isFromSection }: IProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Determine which network list to show based on both direction and isFromSection
  const shouldShowL1Networks = (
    (direction === BridgeDirection.L1_TO_L2 && isFromSection) ||
    (direction === BridgeDirection.L2_TO_L1 && !isFromSection)
  );

  const { others: otherVersions } = useNetworkVersions();
  const versionNetworks: NetworkType[] = otherVersions.map((v, i) => ({
    ...L2_NETWORKS[0],
    id: L2_NETWORKS[0].id * 100 + i + 1,
    title: v.status === 'legacy' ? `${v.label} · withdraw only` : v.label,
    href: v.path,
  }));

  const networks = shouldShowL1Networks ? L1_NETWORKS : [...L2_NETWORKS, ...versionNetworks];

  // Filter networks based on search query
  const filteredNetworks = networks.filter(network =>
    network.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleNetworkSelect = async (network: NetworkType) => {
    try {
      setIsLoading(true);
      setError(null);
      if (network.href) {
        window.location.assign(network.href);
        return;
      }
      await setNetworkData(network);
      handleClose();
    } catch (error) {
      console.error('Error selecting network:', error);
      setError('Failed to select network. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className='absolute inset-0 z-10 p-5 bg-latest-grey-900 flex items-center'>
      <div className='w-full'>
        <div className='max-w-[344px] mx-auto w-full bg-white rounded-lg p-2.5'>
          <div className='flex justify-between max-w-[200px]'>
            <button 
              onClick={handleClose} 
              className='p-1.5 rounded-full hover:bg-gray-200 transition-colors duration-200'
              aria-label="Close modal"
            >
              <StyledImage src={publicAsset('/assets/svg/cross.svg')} alt='Close' className='h-3 w-3' />
            </button>
            <p className='text-center text-latest-black-400 text-16 font-medium'>Switch network</p>
          </div>
          <input
            type='text'
            placeholder='Search network'
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className='my-2.5 py-2.5 px-4 rounded-[8px] outline-none bg-latest-grey-800 w-full focus:ring-2 focus:ring-latest-red-100'
          />
          {error && (
            <div className='text-red-500 text-sm mb-2' role="alert">
              {error}
            </div>
          )}
          {/* Example usage of FilterButton for future filter/sort UI (not yet functional) */}
          {/*
          <div className='flex gap-2 mb-2'>
            <FilterButton active={true} onClick={() => {}}>All</FilterButton>
            <FilterButton active={false} onClick={() => {}}>L1</FilterButton>
            <FilterButton active={false} onClick={() => {}}>L2</FilterButton>
          </div>
          */}
          <div className='h-[300px] overflow-y-auto'>
            {filteredNetworks.map((network) => (
              <div
                key={network.id}
                onClick={() => !isLoading && handleNetworkSelect(network)}
                className={`hover:bg-latest-red-100 cursor-pointer p-2.5 flex gap-2 transition-colors duration-200 ${
                  isLoading ? 'opacity-40 cursor-not-allowed' : ''
                }`}
                role="button"
                tabIndex={0}
                onKeyPress={(e) => !isLoading && e.key === 'Enter' && handleNetworkSelect(network)}
              >
                <StyledImage src={network.img} alt={network.title} className='h-6 w-6' />
                <p className='text-16 font-medium text-latest-black-100'>{network.title}</p>
              </div>
            ))}
            {filteredNetworks.length === 0 && (
              <p className='text-center text-latest-grey-500 py-4'>No networks found</p>
            )}
          </div>
          {isLoading && (
            <div className='flex justify-center py-2'>
              <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-latest-red-100'></div>
            </div>
          )}
        </div>
        {/* <div className='max-w-[344px] bg-white rounded-lg mt-2 mx-auto w-full p-2.5 flex justify-between'>
          <div className='flex gap-2'>
            <StyledImage src={publicAsset('/assets/svg/silk.svg')} alt='Silk' className='h-10 w-10' />
            <div>
              <p className='text-latest-black-100 text-16 font-medium'>silk.sc</p>
              <p className='text-neutral-600 text-14 font-medium'>Not connected</p>
            </div>
          </div>
          <img src={publicAsset('/assets/svg/Toggle.svg')} alt='Toggle' />
        </div> */}
      </div>
    </div>
  );
}
