import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'

interface Step {
  id: number
  label: string
  status: 'pending' | 'active' | 'completed' | 'error'
}

interface LoadingStepsBarsProps {
  steps: Step[]
  currentStep: number
}

const LoadingStepsBars: React.FC<LoadingStepsBarsProps> = ({
  steps,
  currentStep,
}) => {
  const allCompleted = steps.every((s) => s.status === 'completed')

  return (
    <div className='w-full max-w-md mx-auto'>
      {/* Progress segments container */}
      <div className='flex gap-2 mb-2'>
        {steps.map((step, index) => {
          const isCompleted = step.status === 'completed'
          const isActive = step.status === 'active'
          const isError = step.status === 'error'

          return (
            <div key={index} className='relative flex-1'>
              {/* Background bar */}
              <div className='h-1 w-full rounded-full bg-[#E5E5E5]' />

              {/* Animated fill */}
              {(isActive || isCompleted || isError) && (
                <motion.div
                  key={`${index}-${step.status}`}
                  className={`absolute top-0 left-0 h-1 rounded-full ${
                    isError
                      ? 'bg-red'
                      : isCompleted
                      ? allCompleted
                        ? 'bg-[#22C55E]'
                        : 'bg-[#FF990A]'
                      : 'bg-[#9D9D9D]'
                  }`}
                  initial={{ width: 0 }}
                  animate={
                    isCompleted || isError
                      ? { width: '100%' }
                      : {
                          width: ['0%', '100%'],
                        }
                  }
                  transition={
                    isCompleted || isError
                      ? {
                          duration: 0.5,
                          ease: 'easeInOut',
                        }
                      : {
                          duration: 2,
                          repeat: Infinity,
                          ease: 'linear',
                        }
                  }
                />
              )}
            </div>
          )
        })}
      </div>

      {/* Current step label */}
      <AnimatePresence mode='wait'>
        <motion.div
          key={steps[currentStep]?.label}
          className='text-center'
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.3 }}>
          <p
            className={`text-sm ${
              steps[currentStep]?.status === 'error'
                ? 'text-red'
                : 'text-neutral-600'
            }`}>
            {/* {steps[currentStep]?.label || 'Processing...'} */}
            {steps[currentStep]?.label}
          </p>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

export default LoadingStepsBars
