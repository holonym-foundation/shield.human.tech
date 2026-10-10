import React from 'react'
import PaperBackground from '@/components/PaperBackground'

// Docs share the onboarding splash aesthetic: a light Shield-pink paper-shader field behind
// the guides. Pinned to 'light' because the docs copy is light-theme only (fixed dark text on
// white cards), matching ClientLayout keeping docs light even in Privacy Mode. A dark field
// would strand the black body text. The field sits fixed behind the content (negative z-index)
// and holds automatically under prefers-reduced-motion.
export default function DocsRouteLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <PaperBackground scheme="light" />
      {children}
    </>
  )
}
