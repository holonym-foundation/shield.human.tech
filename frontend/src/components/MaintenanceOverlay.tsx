'use client'

import { motion, AnimatePresence } from 'framer-motion'
import StyledImage from './StyledImage'

interface MaintenanceOverlayProps {
  message?: string
  title?: string
}

export default function MaintenanceOverlay({
  message = 'We are currently performing scheduled maintenance. The bridge will be available shortly.',
  title = 'Bridge Under Maintenance',
}: MaintenanceOverlayProps) {
  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 bg-latest-grey-1000 z-[9999] flex items-center justify-center"
        style={{ pointerEvents: 'auto' }}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          transition={{
            type: 'spring',
            damping: 25,
            stiffness: 300,
          }}
          className="relative mx-4 max-w-md w-full bg-white rounded-lg px-2.5 py-3"
        >
          {/* Header */}
          <div className="flex justify-center items-center mb-4">
            <div className="w-16 h-16 rounded-full bg-warn-200 flex items-center justify-center">
              <StyledImage
                src="/assets/svg/shield.svg"
                alt="Maintenance"
                className="w-8 h-8"
              />
            </div>
          </div>

          {/* Title */}
          <div className="mx-2.5 mb-4">
            <p className="text-latest-black-300 font-semibold text-16 text-center">
              {title}
            </p>
          </div>

          {/* Message */}
          <div className="mx-2.5 mb-6">
            <p className="text-latest-grey-600 text-14 text-center leading-relaxed">
              {message}
            </p>
          </div>

          {/* Info Box */}
          <div className="mx-2.5 mb-6">
            <div className="bg-latest-grey-200 p-4 rounded-lg">
              <p className="text-latest-black-300 text-14 font-medium text-center">
                We appreciate your patience while we improve the bridge experience.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-center gap-2 mt-6">
            <StyledImage
              src="/assets/svg/silk0.4.svg"
              alt=""
              className="h-4 w-[14px]"
            />
            <p className="text-12 font-medium text-latest-grey-600">
              Secured by human.tech
            </p>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

