'use client'

import React, { useEffect, useRef, useState } from 'react'
import { ALL_DEPLOYMENTS, ACTIVE_DEPLOYMENT_ID, DEPLOYMENT_ID } from '@/config'

const DeploymentSelector: React.FC = () => {
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(DEPLOYMENT_ID)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
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

  if (ALL_DEPLOYMENTS.length === 0) return null

  const currentDeployment = ALL_DEPLOYMENTS.find((d) => d.id === selectedId)
  const versionLabel = currentDeployment?.network.aztecVersion || selectedId
  const hasMultiple = ALL_DEPLOYMENTS.length > 1

  return (
    <div className='relative' ref={dropdownRef}>
      <button
        onClick={() => hasMultiple && setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#D4D4D4] bg-white transition-shadow duration-200 ${hasMultiple ? 'hover:shadow-sm cursor-pointer' : 'cursor-default'}`}
        title={hasMultiple ? 'Switch deployment version' : `Deployment: ${versionLabel}`}>
        <span className='text-gray-500'>v</span>
        <span className='text-[#0A0A0A] max-w-[140px] truncate'>
          {versionLabel}
        </span>
        {hasMultiple && (
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
        )}
      </button>

      {open && (
        <div className='absolute right-0 mt-1.5 w-[300px] rounded-lg border border-[#E0E0E0] bg-white shadow-lg z-50 py-1.5'>
          <div className='px-3 py-1.5 text-[10px] font-semibold text-gray-400 uppercase tracking-wider'>
            Deployment Version
          </div>
          {ALL_DEPLOYMENTS.map((d) => {
            const isSelected = d.id === selectedId
            const isDefault = d.id === ACTIVE_DEPLOYMENT_ID
            const deployDate = new Date(d.deployedAt)
            const dateStr = deployDate.toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
            return (
              <button
                key={d.id}
                onClick={() => handleSelect(d.id)}
                onMouseEnter={() => setHoveredId(d.id)}
                onMouseLeave={() => setHoveredId(null)}
                className='w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3'
                style={{
                  backgroundColor: isSelected
                    ? hoveredId === d.id ? '#E5E5E5' : '#F0F0F0'
                    : hoveredId === d.id ? '#F5F5F5' : 'transparent',
                }}>
                {/* Selection indicator */}
                <div className='flex-shrink-0 w-4 flex items-center justify-center'>
                  {isSelected ? (
                    <svg className='w-4 h-4 text-gray-700' fill='none' viewBox='0 0 24 24' stroke='currentColor' strokeWidth={2.5}>
                      <path strokeLinecap='round' strokeLinejoin='round' d='M5 13l4 4L19 7' />
                    </svg>
                  ) : (
                    <span className='w-4 h-4 rounded-full border border-gray-300' />
                  )}
                </div>

                {/* Content */}
                <div className='flex-1 min-w-0'>
                  <div className='flex items-center gap-2'>
                    <span className={`font-medium text-[13px] ${isSelected ? 'text-[#0A0A0A]' : 'text-gray-700'}`}>
                      {d.network.aztecVersion}
                    </span>
                    {isDefault && (
                      <span className='text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-600 font-semibold'>
                        latest
                      </span>
                    )}
                  </div>
                  <div className='text-[11px] text-gray-400 mt-0.5'>
                    {d.network.name} &middot; {dateStr}
                  </div>
                </div>

                {/* Chain IDs */}
                <div className='flex-shrink-0 text-[10px] text-gray-400 text-right leading-tight'>
                  <div>L1:{d.network.l1ChainId}</div>
                  <div>L2:{d.network.l2ChainId}</div>
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
