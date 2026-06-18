import React from 'react'
import { createHighlighter, type Highlighter } from 'shiki'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import CopyButton from './CopyButton'

type Lang = 'typescript' | 'bash'

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark'],
      langs: ['typescript', 'bash'],
      engine: createJavaScriptRegexEngine(),
    })
  }
  return highlighterPromise
}

export default async function CodeBlock({
  children,
  lang = 'typescript',
}: {
  children: string
  lang?: Lang
}) {
  const code = children.trim()
  const highlighter = await getHighlighter()
  const html = highlighter.codeToHtml(code, { lang, theme: 'github-dark' })

  return (
    <div className="group relative my-4">
      <CopyButton text={code} />
      <div
        className="text-14 leading-relaxed [&>pre]:m-0 [&>pre]:overflow-x-auto [&>pre]:rounded-md [&>pre]:p-4 [&>pre]:font-mono [&>pre]:scrollbar-thin"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
