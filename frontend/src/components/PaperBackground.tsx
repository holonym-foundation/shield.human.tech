'use client'

import { useEffect, useId, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { MeshGradient } from '@paper-design/shaders-react'

// The shader colors are a JS prop, so a CSS dark-mode block can't reach them. Deriving the
// palette, veil, and grain from one JS-computed `dark` boolean keeps all three in sync
// instead of letting a CSS media query drift out of step with the mesh colors.
function usePrefersDark() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setDark(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return dark
}

type Scheme = 'auto' | 'light' | 'dark'

/* Reusable paper-shader field: a real @paper-design MeshGradient in Shield tones, softened by
   a translucent veil so overlaid copy stays legible, plus a fine grain for paper texture.
   Mirrors ShieldOnboarding's PaperField so app surfaces share the onboarding splash aesthetic.
   Fixed behind the content (negative z-index), aria-hidden, and non-interactive.

   `scheme` pins the palette: 'auto' follows the OS colour scheme (use where the overlaid
   content is itself dark-aware); 'light'/'dark' force it (docs pins 'light' because its copy is
   light-theme only). `still` forces the shader to hold; when omitted it holds automatically
   under prefers-reduced-motion. */
export default function PaperBackground({
  still,
  scheme = 'auto',
}: {
  still?: boolean
  scheme?: Scheme
}) {
  const systemDark = usePrefersDark()
  const reduce = useReducedMotion() ?? false
  const dark = scheme === 'auto' ? systemDark : scheme === 'dark'
  const isStill = still ?? reduce
  const rawId = useId()
  const filterId = `pb-noise-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`

  const veil = dark
    ? 'radial-gradient(120% 90% at 50% 46%, rgba(21,10,15,0.52), rgba(21,10,15,0) 70%), linear-gradient(180deg, rgba(21,10,15,0.30), rgba(21,10,15,0.70))'
    : 'linear-gradient(180deg, rgba(255,246,250,0.38), rgba(255,246,250,0.78))'

  return (
    <div className="pb-field" aria-hidden="true">
      <MeshGradient
        colors={dark ? ['#1c0710', '#3d0e21', '#5a1327', '#81133b'] : ['#fff6fa', '#fde7f3', '#fcd4ea', '#fa8fc4']}
        speed={isStill ? 0 : 0.16}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <div className="pb-veil" style={{ background: veil }} />
      <svg
        className="pb-grain"
        width="100%"
        height="100%"
        style={{ mixBlendMode: dark ? 'screen' : 'multiply', opacity: dark ? 0.06 : 0.05 }}
      >
        <filter id={filterId}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${filterId})`} />
      </svg>
      <style>{`
        .pb-field { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
        .pb-field canvas { position: absolute; inset: 0; width: 100% !important; height: 100% !important; }
        .pb-veil { position: absolute; inset: 0; pointer-events: none; }
        .pb-grain { position: absolute; inset: 0; pointer-events: none; }
      `}</style>
    </div>
  )
}
