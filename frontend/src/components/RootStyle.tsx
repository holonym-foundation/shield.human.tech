import clsxm from '@/utils/clsxm'
import React from 'react'

interface RootStyleProps extends React.PropsWithChildren {
  className?: string
}

// Just the centered card. The side drawers (Tutorial / Activity) no longer live
// here — they're hoisted into a single fixed dock in ClientLayout so they persist
// across every app screen (bridge, progress, activity) instead of only the page
// that renders this card. That keeps card centering completely independent of the
// drawers: this wrapper is sized to the card, so the card is always centered.
export default function RootStyle({ children, className }: RootStyleProps) {
  return (
    // The wrapper fills the content column between the header and the footer (ClientLayout
    // passes its height down), so the card's max-h-full is the room that is actually left.
    // The 11rem reserve below fits the desktop nav and footer; on phones the header, a
    // network banner or the footer can need more, and the card then shrinks to fit instead
    // of reaching under the footer (#150). pt-6 only: the footer's own padding is the gap
    // below the card.
    <div className={`flex min-h-0 flex-1 items-start justify-center pt-6`}>
      <div
        className={clsxm(
          `relative rounded-xl bg-white shadow-[0px_383px_107px_0px_rgba(0,0,0,0),0px_245px_98px_0px_rgba(0,0,0,0.01),0px_138px_83px_0px_rgba(0,0,0,0.05),0px_61px_61px_0px_rgba(0,0,0,0.09),0px_15px_34px_0px_rgba(0,0,0,0.10)]`,
          // UNIFORM app-shell height (SOP §4): the card is a FIXED height, identical on every
          // route, so switching bridge <-> activity <-> fee-juice <-> progress never resizes the
          // frame. It is NOT content-driven. Each page fills this fixed card (flex column, its own
          // internal scroll region for overflow) rather than growing/shrinking the card. The height
          // is sized to fit under the nav within one viewport (11rem reserves nav + footer), and
          // never exceeds the space left between them (max-h-full).
          'w-[360px] shrink-0 min-w-0 h-[min(85vh,calc(100dvh-11rem))] max-h-full flex flex-col overflow-hidden',
          className
        )}>
        {children}
      </div>
    </div>
  )
}
