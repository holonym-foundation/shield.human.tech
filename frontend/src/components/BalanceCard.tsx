'use client'

import { useL1TokenBalance } from '@/hooks/useL1Operations'
import { L2TokenBalanceData, useL2TokenBalance } from '@/hooks/useL2Operations'
import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'

export const BalanceCard = () => {
  // Get L1 token balance (feat/sdk uses useL1TokenBalance for ERC20)
  const {
    data: l1TokenBalance,
    isLoading: l1TokenIsLoading,
    isFetching: l1TokenIsFetching,
    error: l1TokenError,
    refetch: refetchL1Token,
  } = useL1TokenBalance()

  // Get L2 token balance
  const {
    data: l2Data,
    isLoading: l2IsLoading,
    isFetching: l2IsFetching,
    error: l2Error,
    refetch: refetchL2,
  } = useL2TokenBalance()

  // State for last refresh time
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null)
  const [timeAgo, setTimeAgo] = useState<string>('')

  // Function to handle manual refresh
  const handleRefresh = async () => {
    await Promise.all([refetchL1Token(), refetchL2()])
    setLastRefreshTime(new Date())
  }

  // Update the time ago display every minute
  useEffect(() => {
    if (!lastRefreshTime) {
      setLastRefreshTime(new Date())
    }
    updateTimeAgo()
    const interval = setInterval(() => {
      updateTimeAgo()
    }, 60000)
    return () => clearInterval(interval)
  }, [lastRefreshTime])

  const updateTimeAgo = () => {
    if (lastRefreshTime) {
      setTimeAgo(formatDistanceToNow(lastRefreshTime, { addSuffix: true }))
    }
  }

  const hasL1TokenData = !!l1TokenBalance
  const hasL2Data = !!l2Data && (!!l2Data.publicBalance || !!l2Data.privateBalance)
  const isRefreshing = l1TokenIsFetching || l2IsFetching
  const isLoading = l1TokenIsLoading || l2IsLoading

  useEffect(() => {
    if ((hasL1TokenData || hasL2Data) && !lastRefreshTime) {
      setLastRefreshTime(new Date())
    }
  }, [hasL1TokenData, hasL2Data, lastRefreshTime])

  return (
    <div className="p-6 border rounded-lg shadow-sm bg-white">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Your Balances</h2>
        <button
          onClick={handleRefresh}
          disabled={isRefreshing}
          className={`px-3 py-1 rounded text-sm font-medium flex items-center ${
            isRefreshing
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
          }`}
        >
          {isRefreshing ? (
            <>
              <span className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full inline-block animate-spin mr-2"></span>
              Refreshing...
            </>
          ) : (
            'Refresh'
          )}
        </button>
      </div>

      {isLoading && !hasL1TokenData && !hasL2Data && (
        <div className="text-center py-8">
          <div className="animate-pulse">Loading balances...</div>
        </div>
      )}

      {(l1TokenError || l2Error) && (
        <div className="bg-red-50 p-4 rounded-md text-red-700 mb-4">Error loading balances. Please try again.</div>
      )}

      {(hasL1TokenData || hasL2Data) && (
        <>
          <div className="space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <div>
                <div className="text-sm text-gray-500">Ethereum Token Balance</div>
                <div className="text-lg font-medium">
                  {l1TokenBalance || '0'} TEST
                  {l1TokenIsFetching && <span className="ml-2 text-xs text-blue-500 animate-pulse">refreshing...</span>}
                </div>
              </div>
              <div className="bg-purple-100 text-purple-800 px-3 py-1 rounded-full text-xs">L1</div>
            </div>

            {l2Data && (
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-sm text-gray-500">Aztec Balance</div>
                  <div className="text-lg font-medium">
                    <div>
                      {l2Data.publicBalance || '0'} TEST (Public)
                      {l2IsFetching && <span className="ml-2 text-xs text-blue-500 animate-pulse">refreshing...</span>}
                    </div>
                    <div>{l2Data.privateBalance || '0'} TEST (Private)</div>
                  </div>
                </div>
                <div className="bg-green-100 text-green-800 px-3 py-1 rounded-full text-xs">L2</div>
              </div>
            )}
          </div>

          {timeAgo && <div className="mt-6 text-xs text-gray-500 text-right">Last updated: {timeAgo}</div>}
        </>
      )}
    </div>
  )
}

export default BalanceCard
