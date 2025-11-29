'use client'

import { motion } from 'framer-motion'

const AppLoadingScreen = () => {
  return (
    <div 
      className="min-h-screen flex items-center justify-center"
      style={{ 
        background: 'radial-gradient(#E3E6FF, #FFFFFF)' 
      }}
    >
      <div className="text-center">
        {/* Logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="mb-8"
        >
          <img
            src="/assets/svg/aztec-wallet-logo.svg"
            alt="Aztec Bridge"
            width={120}
            height={120}
            className="mx-auto"
          />
        </motion.div>

        {/* App Title */}
        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="text-2xl font-semibold text-gray-900 mb-2"
          style={{ fontFamily: 'Suisse Intl, sans-serif' }}
        >
          Bridge to Aztec
        </motion.h1>

        {/* Subtitle */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="text-gray-600 mb-8"
          style={{ fontFamily: 'Suisse Intl, sans-serif' }}
        >
          Pay and Transact Privately
        </motion.p>

        {/* Loading Animation */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="flex justify-center"
        >
          <div className="flex space-x-2">
            {[0, 1, 2].map((index) => (
              <motion.div
                key={index}
                className="w-2 h-2 bg-[#FF990A] rounded-full"
                animate={{
                  scale: [1, 1.2, 1],
                  opacity: [0.5, 1, 0.5],
                }}
                transition={{
                  duration: 1.2,
                  repeat: Infinity,
                  delay: index * 0.2,
                  ease: "easeInOut",
                }}
              />
            ))}
          </div>
        </motion.div>

        {/* Loading Text */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.5 }}
          className="text-gray-500 text-sm mt-4"
          style={{ fontFamily: 'Suisse Intl, sans-serif' }}
        >
          Initializing...
        </motion.p>
      </div>
    </div>
  )
}

export default AppLoadingScreen
