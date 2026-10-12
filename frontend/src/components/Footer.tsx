'use client'

import Link from 'next/link'
import React from 'react'
import { Icon } from '@iconify/react'
import { useBridgeStore } from '@/stores/bridgeStore'

interface FooterProps {
  className?: string
  /** The support chat bubble is showing in the bottom-right corner: keep the links clear of it. */
  chatBubble?: boolean
}

// The footer has no surface of its own: no fill, no top border, no shadow. It
// sits directly on the page background (the light MeshGradient or the dark
// privacy field, rgba(31,8,22,0.66)) so it blends in with no band or edge line.
// Because there is no owned surface, the text must stay legible on BOTH fields,
// so tone is chosen from the same Privacy-Mode signal the Header reads. White
// alphas use the bracket form (`/[0.60]`) so they bypass the sparse opacity
// scale in tailwind.config.js and always compile (see Header note).

/** Muted footer tone — dark grey on light, near-white on the privacy field. */
function mutedText(isDark: boolean): string {
  return isDark ? 'text-white/[0.60]' : 'text-latest-grey-700'
}
/** Interactive link/icon tone + hover, legible on both fields. */
function linkText(isDark: boolean): string {
  return isDark ? 'text-white/[0.80] hover:text-white' : 'text-neutral-600 hover:text-black'
}
function iconText(isDark: boolean): string {
  return isDark ? 'text-white/[0.60] hover:text-white' : 'text-neutral-600 hover:text-shield'
}

interface SocialLink {
  label: string
  href: string
  icon: string
}

const SOCIAL_LINKS: SocialLink[] = [
  { label: 'X (Twitter)', href: 'https://x.com/0xHolonym', icon: 'simple-icons:x' },
  { label: 'Bluesky', href: 'https://bsky.app/profile/human.tech', icon: 'simple-icons:bluesky' },
  { label: 'Telegram', href: 'https://t.me/humantechofficial', icon: 'simple-icons:telegram' },
  {
    label: 'YouTube',
    href: 'https://www.youtube.com/channel/UCHxAfIjbgcWzYUepyvBdUZQ',
    icon: 'simple-icons:youtube',
  },
  { label: 'Discord', href: 'https://discord.com/invite/zfGqjA5pxU', icon: 'simple-icons:discord' },
  { label: 'GitHub', href: 'https://github.com/holonym-foundation', icon: 'simple-icons:github' },
]

interface TextLink {
  label: string
  href: string
  external?: boolean
}

const RESOURCE_LINKS: TextLink[] = [
  // NOTE: /privacy and /terms pages are assumed on human.tech and may not exist yet — confirm before shipping.
  { label: 'Privacy Policy', href: 'https://human.tech/policy', external: true },
  { label: 'Terms of Use', href: 'https://human.tech/terms', external: true },
]

const SocialIcons: React.FC<{ className?: string; isDark: boolean }> = ({ className, isDark }) => (
  <div className={`flex items-center gap-x-4 ${className || ''}`}>
    {SOCIAL_LINKS.map(({ label, href, icon }) => (
      <Link
        key={label}
        href={href}
        target='_blank'
        rel='noopener noreferrer'
        aria-label={label}
        title={label}
        className={`${iconText(isDark)} transition-colors`}>
        <Icon icon={icon} width={16} height={16} aria-hidden='true' />
      </Link>
    ))}
  </div>
)

const ResourceLinks: React.FC<{ className?: string; isDark: boolean }> = ({ className, isDark }) => (
  <div className={`flex gap-x-4 gap-y-2 flex-wrap ${className || ''}`}>
    {RESOURCE_LINKS.map(({ label, href, external }) => (
      <Link
        key={label}
        href={href}
        className={`${linkText(isDark)} transition-colors`}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {label}
      </Link>
    ))}
  </div>
)

const Footer: React.FC<FooterProps> = ({ className, chatBubble = false }) => {
  const { isPrivacyModeEnabled } = useBridgeStore()
  const isDark = isPrivacyModeEnabled

  return (
    // No bg, border, or shadow: the footer is transparent so it blends into the
    // page background instead of reading as its own band with an edge line.
    <footer className={`relative w-full text-xs ${className || ''}`}>
      {/* Desktop Footer — single row, already compact vertically. */}
      {/* With the chat bubble showing, the right padding keeps Terms of Use out from under it. */}
      <div className={`hidden md:flex flex-col w-full pl-10 ${chatBubble ? 'pr-24' : 'pr-10'} pb-8 gap-4`}>
        <div className='flex justify-between items-center w-full relative'>
          {/* Left Side Social Icons */}
          <SocialIcons isDark={isDark} />

          {/* Center Text */}
          <div className={`absolute left-1/2 transform -translate-x-1/2 ${mutedText(isDark)} whitespace-nowrap`}>
            © 2025 human.tech. All rights reserved.
          </div>

          {/* Right Side Links */}
          <ResourceLinks className='justify-end' isDark={isDark} />
        </div>
      </div>

      {/* Mobile Footer (below md): one compact row, at every height. The card is the
          priority surface. A stacked footer with the social row (once shown from 821px
          tall) needed ~150px, more than the card's height formula leaves, so it covered
          the card's CTA and took its taps (#150). The bottom padding keeps the links above
          the fixed bottom strip: the binder dock on the left (bottom-4 + 44px tabs) and,
          when it shows, the support chat bubble on the right (56px, 20px up). */}
      <div className='md:hidden w-full'>
        <div
          className={`flex flex-wrap items-center justify-center gap-x-4 gap-y-1 w-full px-4 pt-3 ${
            chatBubble ? 'pb-[5.25rem]' : 'pb-[4.25rem]'
          }`}>
          <ResourceLinks className='justify-center' isDark={isDark} />
          <span className={`${mutedText(isDark)} text-center`}>
            © 2025 human.tech. All rights reserved.
          </span>
        </div>
      </div>
    </footer>
  )
}

export default Footer
