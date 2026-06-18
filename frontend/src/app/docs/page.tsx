import Link from 'next/link'
import React from 'react'

export const metadata = {
  title: 'Docs · Aztec Bridge',
  description: 'Documentation for the Aztec Token Bridge — user guides and SDK reference.',
}

interface DocCard {
  href: string
  title: string
  blurb: string
  items: string[]
}

const CARDS: DocCard[] = [
  {
    href: '/docs/users',
    title: 'For Users',
    blurb: 'Everything you need to bridge safely on Mainnet Alpha.',
    items: ['Mainnet Alpha risks', 'Rate limits & deposit caps', 'Private vs public mode', 'Backup & resuming'],
  },
  {
    href: '/docs/developers',
    title: 'For Developers',
    blurb: 'Integrate the bridge SDK into your own dapp.',
    items: ['Install & initialize', 'Bridge L1↔L2', 'Events & error handling', 'TypeScript reference'],
  },
]

export default function DocsLandingPage() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-12 md:px-8">
      <h1 className="text-36 font-bold text-latest-black-100">Documentation</h1>
      <p className="mt-2 text-16 text-latest-grey-500">
        Guides for bridging ERC-20 tokens from Ethereum to Aztec, and a reference for the{' '}
        <span className="font-medium text-latest-black-100">@human.tech/shield.human.sdk</span>.
      </p>

      <div className="mt-10 grid gap-6 md:grid-cols-2">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group rounded-xl border border-latest-grey-300 bg-white/70 p-6 transition-all hover:border-latest-blue-100 hover:shadow-md">
            <h2 className="text-20 font-semibold text-latest-black-100 group-hover:text-latest-blue-100">
              {card.title}
            </h2>
            <p className="mt-1 text-14 text-latest-grey-500">{card.blurb}</p>
            <ul className="mt-4 space-y-1.5 text-12 text-latest-grey-500">
              {card.items.map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span className="text-latest-blue-100">→</span>
                  {item}
                </li>
              ))}
            </ul>
          </Link>
        ))}
      </div>
    </div>
  )
}
