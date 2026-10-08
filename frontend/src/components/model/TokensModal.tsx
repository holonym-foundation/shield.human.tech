import React, { useState, useMemo } from 'react'
import StyledImage from '../StyledImage'
import { BridgeDirection, Token as TokenType } from '@/types/bridge'
import { L1_TOKENS, L2_TOKENS, publicAsset } from '@/config'

type SortOption = 'name' | 'amount' | 'percentage'
type TokenTypeFilter = 'all' | 'stable' | 'native'

// Internal reusable FilterButton component
function FilterButton({
  active,
  children,
  className = '',
  ...props
}: React.ComponentProps<'button'> & { active: boolean }) {
  return (
    <button
      {...props}
      className={`px-3 py-1 rounded-full text-sm font-medium transition-colors duration-200 ${
        active
          ? 'bg-latest-red-100 text-white'
          : 'bg-latest-grey-200 text-neutral-600 hover:bg-latest-grey-300'
      } ${className}`}>
      {children}
    </button>
  )
}

// Internal reusable TokenListItem component
function TokenListItem({
  token,
  onClick,
  disabled,
}: {
  token: TokenType
  onClick: () => void
  disabled: boolean
}) {
  return (
    <div
      onClick={() => !disabled && onClick()}
      className={`flex cursor-pointer justify-between p-2.5 hover:bg-latest-red-100 transition-colors duration-200 ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      }`}
      role='button'
      tabIndex={0}
      onKeyPress={(e) => !disabled && e.key === 'Enter' && onClick()}>
      <div className='flex gap-2'>
        <StyledImage src={token.img} alt={token.title} className='h-10 w-10' />
        <div>
          <p className='text-16 font-medium text-latest-black-200'>
            {token.title}
          </p>
          <p className='text-14 font-medium text-neutral-600'>{token.symbol}</p>
        </div>
      </div>
      {/* <div className='text-right'>
        <p className='text-16 font-medium text-latest-black-200'>{token.amount}</p>
        <p className={`text-14 font-medium ${
          token.percentage.startsWith('+') 
            ? 'text-green-500' 
            : token.percentage.startsWith('-')
            ? 'text-red-500'
            : 'text-neutral-600'
        }`}>
          {token.percentage}
        </p>
      </div> */}
    </div>
  )
}

interface IProps {
  tokensData: TokenType | null
  setTokensData: (val: TokenType) => void
  handleClose: () => void
  direction: BridgeDirection
  isFromSection: boolean
}

export default function TokensModal({
  setTokensData,
  tokensData,
  handleClose,
  direction,
  isFromSection,
}: IProps) {
  // --- State ---
  const [searchQuery, setSearchQuery] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // const [sortBy, setSortBy] = useState<SortOption>('name');
  const [tokenType, setTokenType] = useState<TokenTypeFilter>('all')

  // --- Data ---
  const shouldShowL1Tokens = (
    (direction === BridgeDirection.L1_TO_L2 && isFromSection) ||
    (direction === BridgeDirection.L2_TO_L1 && !isFromSection)
  );
  const tokens = shouldShowL1Tokens ? L1_TOKENS : L2_TOKENS

  // --- Derived: filtered and sorted tokens ---
  const filteredTokens = useMemo(() => {
    const result = tokens.filter((token) => {
      const matchesSearch = token.title
        .toLowerCase()
        .includes(searchQuery.toLowerCase())
      // ||  token.about.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesType =
        tokenType === 'all' ||
        (tokenType === 'stable' && ['USDC', 'USDT'].includes(token.title)) ||
        (tokenType === 'native' && ['ETH', 'XDAI'].includes(token.title))
      return matchesSearch && matchesType
    })

    return result
  }, [tokens, searchQuery, tokenType])

  // --- Handlers ---
  const handleTokenSelect = async (token: TokenType) => {
    try {
      setIsLoading(true)
      setError(null)
      await setTokensData(token)
      handleClose()
    } catch (error) {
      console.error('Error selecting token:', error)
      setError('Failed to select token. Please try again.')
    } finally {
      setIsLoading(false)
    }
  }

  // --- Render ---
  return (
    <div className='absolute inset-0 z-10 p-5 bg-latest-grey-900 flex items-center'>
      <div className='w-full'>
        <div className='max-w-[344px] mx-auto w-full bg-white rounded-lg p-2.5'>
          {/* Header */}
          <div className='flex justify-between max-w-[200px]'>
            <button
              onClick={handleClose}
              className='p-1.5 rounded-full hover:bg-gray-200 transition-colors duration-200'
              aria-label='Close modal'>
              <StyledImage
                src={publicAsset('/assets/svg/cross.svg')}
                alt='Close'
                className='h-3 w-3'
              />
            </button>
            <p className='text-center text-latest-black-400 text-16 font-medium'>
              Select token
            </p>
          </div>

          {/* Search and Filters */}
          <div className='mt-2.5 space-y-2'>
            {/* Search */}
            <div className='bg-latest-grey-800 w-full flex justify-between items-center rounded-[8px] py-1.5 px-2.5'>
              <div className='flex gap-1 items-center w-full'>
                <StyledImage
                  src={publicAsset('/assets/svg/search.svg')}
                  alt='Search'
                  className='h-4 w-4'
                />
                <input
                  type='text'
                  placeholder='Search tokens'
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className='outline-none w-full bg-[transparent] text-neutral-600 text-16 font-medium focus:ring-2 focus:ring-latest-red-100'
                />
              </div>
            </div>
            {/* Token Type Filter */}
            {/* <div className='flex gap-2'>
              {(['all', 'stable', 'native'] as TokenTypeFilter[]).map(
                (type) => (
                  <FilterButton
                    key={type}
                    active={tokenType === type}
                    onClick={() => setTokenType(type)}>
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </FilterButton>
                )
              )}
            </div> */}
          </div>

          {/* Error Message */}
          {error && (
            <div className='text-red-500 text-sm mb-2 mt-2' role='alert'>
              {error}
            </div>
          )}

          {/* Token List */}
          <div className='h-[300px] overflow-y-auto mt-2'>
            {filteredTokens.map((token) => (
              <TokenListItem
                key={token.id}
                token={token}
                onClick={() => handleTokenSelect(token)}
                disabled={isLoading}
              />
            ))}
            {filteredTokens.length === 0 && (
              <p className='text-center text-latest-grey-500 py-4'>
                No tokens found
              </p>
            )}
          </div>

          {/* Loading Spinner */}
          {isLoading && (
            <div className='flex justify-center py-2'>
              <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-latest-red-100'></div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
