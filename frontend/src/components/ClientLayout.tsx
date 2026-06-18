'use client'

import BannerAztecNodeError from '@/components/BannerAztecNodeError'
import BannerAztecTestnet from '@/components/BannerAztecTestnet'
import Footer from '@/components/Footer'
import Header from '@/components/Header'
import { useBridgeStore } from '@/stores/bridgeStore'
import { motion } from 'framer-motion'
import { usePathname } from 'next/navigation'
export default function ClientLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { isPrivacyModeEnabled } = useBridgeStore()
  const pathname = usePathname()
  // Docs is a neutral reading view — keep the light background even when privacy mode is on.
  const showPrivacyBackground = isPrivacyModeEnabled && !(pathname?.startsWith('/docs') ?? false)
  return (
    <div className="relative min-h-screen flex flex-col w-full min-w-0" style={{ minHeight: '100vh', minWidth: 0 }}>
      {/* Gradient background */}
      <motion.div
        className="absolute inset-0 z-0"
        animate={{
          background: showPrivacyBackground
            ? 'radial-gradient(#6B6E88, #8B89A8)'
            : 'radial-gradient(#E3E6FF, #FFFFFF)',
        }}
        transition={{ duration: 0.7, ease: 'easeInOut' }}
        style={{ willChange: 'background' }}
      />
      {/* Grain overlay */}
      {/* <motion.div
        className="absolute inset-0 z-10 pointer-events-none"
        animate={{
          opacity: isPrivacyModeEnabled ? 1 : 0,
        }}
        transition={{ duration: 0.7, ease: 'easeInOut' }}
        style={{
          backgroundImage: 'url(assets/images/bgGrain.png)',
          backgroundSize: 'cover',
          backgroundRepeat: 'no-repeat',
          willChange: 'opacity',
        }}
      /> */}
      {/* Main content */}
      <div className="relative z-20 flex flex-col min-h-screen">
        <BannerAztecTestnet />
        <BannerAztecNodeError />
        <Header />
        <div className='flex-grow'>{children}</div>
        <Footer className='' />
      </div>
    </div>
  )
}
