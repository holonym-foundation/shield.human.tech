'use client'

import React, { useEffect, useRef, useState } from 'react'
import { ALL_DEPLOYMENTS, ACTIVE_DEPLOYMENT_ID, DEPLOYMENT_ID } from '@/config'

const DeploymentSelector: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(DEPLOYMENT_ID)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelect = (id: string) => {
    if (id === selectedId) {
      setOpen(false)
      return
    }
    // Store selection (clear override if selecting the default active deployment)
    if (id === ACTIVE_DEPLOYMENT_ID) {
      localStorage.removeItem('selectedDeploymentId')
    } else {
      localStorage.setItem('selectedDeploymentId', id)
    }
    // Reload to apply new deployment config
    window.location.reload()
  }

  // Only show if there are multiple deployments
  if (ALL_DEPLOYMENTS.length <= 1) return null

  const currentDeployment = ALL_DEPLOYMENTS.find((d) => d.id === selectedId)
  const versionLabel = currentDeployment?.network.aztecVersion || selectedId

  return (
    <div className='relative' ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className='flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#D4D4D4] bg-white hover:shadow-sm transition-shadow duration-200'
        title='Switch deployment version'>
        <span className='text-gray-500'>v</span>
        <span className='text-[#0A0A0A] max-w-[140px] truncate'>
          {versionLabel}
        </span>
        <svg
          className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}
          fill='none'
          viewBox='0 0 24 24'
          stroke='currentColor'>
          <path
            strokeLinecap='round'
            strokeLinejoin='round'
            strokeWidth={2}
            d='M19 9l-7 7-7-7'
          />
        </svg>
      </button>

      {open && (
        <div className='absolute right-0 mt-1.5 w-[280px] rounded-lg border border-[#D4D4D4] bg-white shadow-lg z-50 py-1'>
          <div className='px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider'>
            Deployment Version
          </div>
          {ALL_DEPLOYMENTS.map((d) => {
            const isSelected = d.id === selectedId
            const isDefault = d.id === ACTIVE_DEPLOYMENT_ID
            return (
              <button
                key={d.id}
                onClick={() => handleSelect(d.id)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors flex flex-col gap-0.5 ${
                  isSelected ? 'bg-gray-50' : ''
                }`}>
                <div className='flex items-center gap-2'>
                  {isSelected && (
                    <span className='w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0' />
                  )}
                  <span
                    className={`font-medium ${isSelected ? 'text-[#0A0A0A]' : 'text-gray-700'}`}>
                    {d.network.aztecVersion}
                  </span>
                  {isDefault && (
                    <span className='text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium'>
                      latest
                    </span>
                  )}
                </div>
                <div className='text-[11px] text-gray-400 pl-3.5'>
                  {d.network.name} &middot; {new Date(d.deployedAt).toLocaleDateString()} &middot; L1:{d.network.l1ChainId} L2:{d.network.l2ChainId}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default DeploymentSelector
