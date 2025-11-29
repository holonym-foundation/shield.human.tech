'use client'

import ClientLayout from '@/components/ClientLayout'
import AppLoadingScreen from '@/components/AppLoadingScreen'
import { Providers } from '@/providers'
import type { Metadata } from 'next'
import { useEffect, useState } from 'react'
import './globals.css'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Don't render anything on the server
  if (!mounted) {
    return (
      <html lang='en'>
        <head>
          <title>Bridge to Aztec</title>
          <meta
            name='description'
            content='Pay and Transact Privately by Bridging to Aztec with human.tech'
          />
        </head>
        <body className=''>
          <AppLoadingScreen />
        </body>
      </html>
    )
  }

  return (
    <html lang='en'>
      <head>
        <title>Bridge to Aztec</title>
        <meta
          name='description'
          content='Pay and Transact Privately by Bridging to Aztec with human.tech'
        />
      </head>
      <body className=''>
        <Providers>
          <ClientLayout>{children}</ClientLayout>
        </Providers>
      </body>
    </html>
  )
}
