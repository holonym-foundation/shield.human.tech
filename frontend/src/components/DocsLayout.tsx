'use client'

import Link from 'next/link'
import React, { useEffect, useState } from 'react'

export interface DocsSection {
  id: string
  label: string
  content: React.ReactNode
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-latest-grey-200 px-1.5 py-0.5 text-14 font-medium text-latest-black-100 break-words">
      {children}
    </code>
  )
}

type Tone = 'info' | 'warning' | 'danger'

const TONE_STYLES: Record<Tone, string> = {
  info: 'bg-latest-blue-200 border-blue-200 text-latest-blue-100',
  warning: 'bg-warn-200 border-warn-400 text-warn-main',
  danger: 'bg-error-200 border-error-400 text-error-main',
}

export function Callout({ tone = 'info', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <div className={`my-4 rounded-md border-l-4 px-4 py-3 text-14 leading-relaxed ${TONE_STYLES[tone]}`}>
      {children}
    </div>
  )
}

export function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-4 overflow-x-auto scrollbar-thin">
      <table className="w-full border-collapse text-14">{children}</table>
    </div>
  )
}

export function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="border-b border-latest-grey-300 px-3 py-2 text-left font-semibold text-latest-black-100">
      {children}
    </th>
  )
}

export function Td({ children }: { children: React.ReactNode }) {
  return <td className="border-b border-latest-grey-300 px-3 py-2 align-top text-latest-grey-500">{children}</td>
}

export function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="mt-6 mb-2 text-18 font-semibold text-latest-black-100">{children}</h3>
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="my-3 text-14 leading-relaxed text-latest-grey-500">{children}</p>
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="my-3 list-disc space-y-1.5 pl-5 text-14 leading-relaxed text-latest-grey-500">{children}</ul>
}

export default function DocsLayout({
  title,
  subtitle,
  sections,
}: {
  title: string
  subtitle?: string
  sections: DocsSection[]
}) {
  const [activeId, setActiveId] = useState(sections[0]?.id)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveId(visible[0].target.id)
      },
      { rootMargin: '-100px 0px -65% 0px', threshold: 0 },
    )
    sections.forEach((s) => {
      const el = document.getElementById(s.id)
      if (el) observer.observe(el)
    })
    return () => observer.disconnect()
  }, [sections])

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 md:px-8">
      <div className="mb-6">
        <Link href="/docs" className="text-12 text-latest-grey-600 hover:text-black">
          ← All docs
        </Link>
        <h1 className="mt-2 text-30 font-bold text-latest-black-100">{title}</h1>
        {subtitle && <p className="mt-1 text-16 text-latest-grey-500">{subtitle}</p>}
      </div>

      <div className="flex gap-10">
        <aside className="hidden w-56 shrink-0 lg:block">
          <nav className="sticky top-24 flex flex-col gap-1">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className={`rounded px-3 py-1.5 text-12 transition-colors ${
                  activeId === s.id
                    ? 'bg-latest-blue-200 font-semibold text-latest-blue-100'
                    : 'text-latest-grey-500 hover:bg-latest-grey-200 hover:text-black'
                }`}>
                {s.label}
              </a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 flex-1">
          <details className="mb-6 rounded-md border border-latest-grey-300 p-3 lg:hidden">
            <summary className="cursor-pointer text-14 font-semibold text-latest-black-100">On this page</summary>
            <nav className="mt-2 flex flex-col gap-1">
              {sections.map((s) => (
                <a key={s.id} href={`#${s.id}`} className="px-2 py-1 text-12 text-latest-grey-500 hover:text-black">
                  {s.label}
                </a>
              ))}
            </nav>
          </details>

          {sections.map((s) => (
            <section key={s.id} id={s.id} className="mb-12 scroll-mt-24">
              <h2 className="mb-3 border-b border-latest-grey-300 pb-2 text-24 font-bold text-latest-black-100">
                {s.label}
              </h2>
              {s.content}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
