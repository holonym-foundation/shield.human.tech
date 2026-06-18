'use client'

import Link from 'next/link'
import React from 'react'

interface FooterProps {
  className?: string
}

const Footer: React.FC<FooterProps> = ({ className }) => {
  return (
    <footer className={`relative w-full text-xs ${className || ''}`}>
      {/* Desktop Footer */}
      <div className='hidden md:flex justify-between items-center w-full px-10 relative'>
        {/* Left Side Links */}
        <div className='flex gap-x-4 gap-y-2 flex-wrap'>
          <Link
            href='https://x.com/0xHolonym'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Twitter (X)
          </Link>
          <Link
            href='https://bsky.app/profile/human.tech'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Bluesky
          </Link>
          <Link
            href='https://t.me/humantechofficial'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Telegram
          </Link>
          <Link
            href='https://www.youtube.com/channel/UCHxAfIjbgcWzYUepyvBdUZQ'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Youtube
          </Link>
          <Link
            href='https://discord.com/invite/zfGqjA5pxU'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Discord
          </Link>
        </div>

        {/* Center Text */}
        <div className='absolute left-1/2 transform -translate-x-1/2 text-latest-grey-700 whitespace-nowrap'>
          © 2025 Human Tech. All rights reserved.
        </div>

        {/* Right Side Links */}
        <div className='flex gap-x-4 gap-y-2 flex-wrap justify-end'>
          <Link href="/docs" className='text-latest-grey-600 hover:text-black'>
            Docs
          </Link>
          <Link href='https://blog.human.tech/' className='text-latest-grey-600 hover:text-black' target='_blank' rel='noopener noreferrer'>
            Blog
          </Link>
          <Link href='https://holonym.notion.site/human-tech-Media-Brand-Guidelines-18babe540a8f809f869ef817713db597' className='text-latest-grey-600 hover:text-black' target='_blank' rel='noopener noreferrer'>
            Press & Media Kit
          </Link>
        </div>
      </div>

      {/* Mobile Footer */}
      <div className='md:hidden flex flex-col items-center w-full px-4 py-6 gap-6'>
        {/* Top Social Links */}
        <div className='flex gap-4 flex-wrap justify-center'>
          <Link
            href='https://x.com/0xHolonym'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Twitter (X)
          </Link>
          <Link
            href='https://bsky.app/profile/human.tech'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Bluesky
          </Link>
          <Link
            href='https://t.me/humantechofficial'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Telegram
          </Link>
          <Link
            href='https://www.youtube.com/channel/UCHxAfIjbgcWzYUepyvBdUZQ'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Youtube
          </Link>
          <Link
            href='https://discord.com/invite/zfGqjA5pxU'
            target='_blank'
            rel='noopener noreferrer'
            className='text-latest-grey-600 hover:text-black'>
            Discord
          </Link>
        </div>

        {/* Middle Resource Links */}
        <div className='flex gap-4 flex-wrap justify-center'>
          <Link href="/docs" className='text-latest-grey-600 hover:text-black'>
            Docs
          </Link>
          <Link href='https://human.tech/blog/proof-of-clean-hands' className='text-latest-grey-600 hover:text-black' target='_blank' rel='noopener noreferrer'>
            Blog
          </Link>
          <Link href='https://holonym.notion.site/human-tech-Media-Brand-Guidelines-18babe540a8f809f869ef817713db597' className='text-latest-grey-600 hover:text-black' target='_blank' rel='noopener noreferrer'>
            Press & Media Kit
          </Link>
        </div>

        {/* Bottom Copyright */}
        <div className='text-latest-grey-700 text-center'>
          © 2025 Human Tech. All rights reserved.
        </div>
      </div>
    </footer>
  )
}

export default Footer
