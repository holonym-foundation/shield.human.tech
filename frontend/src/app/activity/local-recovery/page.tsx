'use client'

import React from 'react'
import RootStyle from '@/components/RootStyle'
import { LocalRecoveryPanel } from '@/components/LocalRecoveryPanel'

export default function LocalRecoveryPage() {
  return (
    <RootStyle className="min-h-0 overflow-hidden">
      <LocalRecoveryPanel variant="page" />
    </RootStyle>
  )
}
