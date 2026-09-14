'use client'

import ClientLayout from '@/components/ClientLayout'
import AppLoadingScreen from '@/components/AppLoadingScreen'
import { Providers } from '@/providers'
import { useEffect, useState } from 'react'
import './globals.css'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Iris chat widget, top frame only.
  //
  // The widget auto-hides its own launcher whenever it finds any div/iframe that is
  // position:fixed|absolute and covers more than half the viewport, assuming that can
  // only be an open modal. Shield's full-bleed MeshGradient background (ClientLayout)
  // matches that test on every route, so the launcher is hidden permanently — the bug
  // is the widget's heuristic, not script loading, and it does not reproduce on a bare
  // page. It hides by writing an inline style onto a node in a CLOSED shadow root, so
  // the only override available to us is to open that root and outrank the inline
  // style with !important. The widget assigns the host id before calling attachShadow,
  // which is what makes this interception possible; if that ever stops holding, the
  // patch no-ops and we are back to today's behaviour rather than something worse.
  //
  // Deliberately no cleanup that restores attachShadow: under StrictMode the effect's
  // unmount/remount would tear the patch down before the async script ever runs.
  useEffect(() => {
    if (!mounted || window.self !== window.top) return
    if (document.getElementById('iris-widget-loader')) return

    const nativeAttachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
      if (this.id !== 'iris-widget-host') return nativeAttachShadow.call(this, init)
      Element.prototype.attachShadow = nativeAttachShadow
      const root = nativeAttachShadow.call(this, { ...init, mode: 'open' })
      const style = document.createElement('style')
      style.textContent = '.iris-bubble { display: flex !important }'
      root.appendChild(style)
      return root
    }

    const s = document.createElement('script')
    s.id = 'iris-widget-loader'
    s.src = 'https://iris-v2-fqgd.onrender.com/widget/iris-widget.js'
    s.async = true
    s.setAttribute('data-iris-key', 'shield')
    s.addEventListener('error', () => {
      Element.prototype.attachShadow = nativeAttachShadow
    })
    document.body.appendChild(s)
  }, [mounted])

  // One <html>/<head>/<body> shell with only the inner content swapping on `mounted`,
  // rather than returning two separate trees: the mount flip stays an ordinary state
  // update instead of a full-body replacement. The app is still client-only, gated on
  // `mounted`, so the SSR-safety intent is unchanged.
  return (
    <html lang="en">
      <head>
        <title>Shield | Private Transactions via Aztec</title>
        <meta
          name="description"
          content="Move your funds between Ethereum and Aztec with privacy. Shield is human.tech's programmable privacy bridge."
        />
      </head>
      <body className="">
        {mounted ? (
          <Providers>
            <ClientLayout>{children}</ClientLayout>
          </Providers>
        ) : (
          <AppLoadingScreen />
        )}
      </body>
    </html>
  )
}
