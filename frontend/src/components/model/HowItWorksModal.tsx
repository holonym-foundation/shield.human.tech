'use client'

import React from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { Icon } from '@iconify/react'
import StyledImage from '../StyledImage'
import TextButton from '../TextButton'
import { useExplainerStore } from '@/stores/useExplainerStore'
import { publicAsset } from '@/config'

export const EXPLAINER_STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Connect two wallets',
    body: 'An Ethereum (L1) wallet funds the deposit; a separate Aztec (L2) wallet receives and claims your tokens.',
  },
  {
    title: 'Verify you’re human, once',
    body: 'A one-time privacy-preserving check (Proof of Clean Hands, or a Human Passport score) is required before your first bridge.',
  },
  {
    title: 'Pick a token and amount',
    body: 'Optionally top up Aztec gas (FeeJuice) in the same transaction, so you can transact as soon as your tokens land.',
  },
  {
    title: 'Deposit, then claim on Aztec',
    body: 'Approve the deposit on Ethereum. Your tokens arrive on Aztec and are claimed for you (~15–50 min). Keep the tab open, or resume from Activity.',
  },
]

const HowItWorksModal: React.FC = () => {
  const { isModalOpen, closeModal } = useExplainerStore()

  return (
    <AnimatePresence>
      {isModalOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={closeModal}
          className="fixed inset-0 z-[140] flex items-center justify-center bg-black/40 px-4 py-6"
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-[440px] max-h-[85vh] overflow-y-auto rounded-[16px] bg-white p-6 shadow-[0px_0px_16px_0px_rgba(0,0,0,0.16)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-[#E5EFFF]">
                  <StyledImage src={publicAsset('/assets/svg/shield.svg')} alt="" className="h-[18px] w-[18px]" />
                </span>
                <h2 className="text-[18px] font-semibold text-[#0A0A0A]">How the Shield Bridge works</h2>
              </div>
              <button
                onClick={closeModal}
                aria-label="Close"
                className="mt-1 rounded-md p-1 text-[#737373] hover:bg-[#F5F5F5] transition-colors"
              >
                <StyledImage src={publicAsset('/assets/svg/cross.svg')} alt="" className="h-[14px] w-[14px]" />
              </button>
            </div>

            <p className="mt-4 text-[14px] leading-[20px] text-[#737373]">
              Shield moves your ERC-20 tokens from Ethereum into the Aztec network, where you can hold and pay
              privately. It’s non-custodial: only the protocol’s smart contracts touch your funds in transit, never
              Human Tech.
            </p>

            <ol className="mt-5 flex flex-col gap-3">
              {EXPLAINER_STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[#0A0A0A] text-[12px] font-semibold text-white">
                    {i + 1}
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-[#0A0A0A]">{step.title}</p>
                    <p className="text-[13px] leading-[19px] text-[#737373]">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-5 flex items-start gap-2 rounded-[10px] bg-[#E5EFFF] px-3 py-2.5">
              <Icon icon="ph:shield-check" width={18} height={18} className="mt-0.5 flex-shrink-0 text-[#0A0A0A]" />
              <p className="text-[13px] leading-[18px] text-[#737373]">
                Turn on <span className="font-medium text-[#0A0A0A]">Privacy Mode</span> to make your Aztec
                transactions private and untraceable.
              </p>
            </div>

            <p className="mt-4 text-[12px] leading-[17px] text-[#737373]">
              You’re moving real assets on an Alpha network, so treat every transaction as final, and bridge only what
              you can afford to lose.
            </p>

            <div className="mt-5 grid grid-cols-[1fr_max-content] gap-2">
              <Link href="/docs/users" onClick={closeModal} className="w-full">
                <TextButton className="bg-[#F5F5F5] text-black hover:bg-[#e5e5e5]">Read the full guide</TextButton>
              </Link>
              <TextButton onClick={closeModal} className="px-6">
                Got it
              </TextButton>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default HowItWorksModal
