#!/usr/bin/env node
/**
 * design-lint.mjs — Shield pre-deploy design lint (first pass, advisory).
 *
 * Enforces the mechanical subset of the Shield Design & Brand SOP:
 *   holonym-foundation/internal-docs → products/shield/design-sop.md
 *
 * This is a lightweight static (regex) pass — NO heavy deps, no AST/browser.
 * It reliably catches only the mechanical rules. Contrast-in-context,
 * no-contradictions, and state-completeness still need human review (SOP §11).
 *
 * Rendered-geometry rules that CAN'T be statically checked are printed as a
 * manual reviewer-checklist reminder (not a pass): the back-action ~80/20
 * layout (#194) and minimum edge/neighbor spacing (#211/#208).
 *
 * Run:   cd frontend && pnpm design-lint
 *
 * ── CI wiring (advisory first) ────────────────────────────────────────────
 * Add an advisory (non-blocking) step to
 * .github/workflows/vercel-deploy-bridge.yml, before "Build Next App":
 *
 *     - name: Design lint (advisory)
 *       working-directory: ./frontend
 *       run: pnpm design-lint || true
 *
 * The `|| true` keeps findings visible in the deploy log without blocking.
 *
 * ── Promote to blocking (later, once the tree is clean) ───────────────────
 *   1. Flip ADVISORY below to `false`  (script then exits non-zero on findings)
 *   2. Drop the `|| true` from the CI step
 *   3. Make it a required check ahead of the frontend build
 * Do this only after triaging the current findings — don't block a dirty tree.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

// When false, the script exits non-zero if there are any findings (blocking).
const ADVISORY = false
// Rules that FAIL the build (the mechanical design-system rules — colors, contrast,
// opacity scale). The tree is clean for these, so a new violation blocks the merge.
// `copy` (em/long dash, mostly long-form docs prose) and `states` (disabled-button
// aria heuristic) stay advisory/review per SOP §12 — they print but don't block.
const BLOCKING_RULES = new Set(['contrast', 'opacity'])

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'src')
const ROOT = join(__dirname, '..')

// ── file walk ───────────────────────────────────────────────────────────────
function walk(dir, exts, out = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    let s
    try {
      s = statSync(p)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (name === 'node_modules' || name === '.next' || name === 'dist') continue
      walk(p, exts, out)
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(p)
    }
  }
  return out
}

// Strip // line comments and /* */ block comments so code-comment prose
// (which legitimately uses em-dashes) doesn't produce false positives.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}

const findings = []
function add(rule, file, line, msg, snippet) {
  findings.push({ rule, file, line, msg, snippet: snippet.trim().slice(0, 120) })
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

// ── rule config ───────────────────────────────────────────────────────────
// Tailwind opacity scale actually defined in tailwind.config.js:
const ALLOWED_OPACITY = new Set(['0', '20', '40', '60', '80', '100'])

// Low-contrast text tokens that fail 4.5:1 on white/light surfaces (SOP §2).
const LOW_CONTRAST_TEXT = [
  'text-gray-light',
  'text-grayTwo',
  'text-neutral-400',
  'text-neutral-300',
  'text-latest-grey-400',
  'text-latest-grey-600',
  'text-base-600',
]

// Light background tokens that must never carry white text (SOP §2).
const LIGHT_BG = [
  'bg-white',
  'bg-neutral-100',
  'bg-neutral-200',
  'bg-pink-5',
  'bg-pink-10',
  'bg-pink-20',
  'bg-base-100',
  'bg-base-300',
]

const files = walk(SRC, ['.tsx'])

for (const file of files) {
  const raw = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  const noComments = stripComments(raw)

  // 1) Low-contrast text tokens (SOP §2)
  for (const cls of LOW_CONTRAST_TEXT) {
    const re = new RegExp(`\\b${cls.replace(/[-]/g, '\\-')}\\b`, 'g')
    let m
    while ((m = re.exec(noComments))) {
      add('contrast', rel, lineOf(noComments, m.index), `low-contrast text token \`${cls}\` (fails 4.5:1 on light)`, lineText(raw, lineOf(raw, m.index)))
    }
  }

  // 2) White text on a light fill in the same className string (SOP §2, §6)
  //    Heuristic: a className with text-white AND (a light bg token OR a
  //    translucent bg with low alpha like bg-*/[0.08] or bg-*/10).
  const classRe = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g
  let cm
  while ((cm = classRe.exec(noComments))) {
    const cls = cm[1] || cm[2] || cm[3] || ''
    // Split into ternary/branch segments so mutually-exclusive branches
    // (e.g. `bg-black text-white` : `bg-white text-neutral-900`) aren't
    // falsely paired. `(?!/)` skips opacity-modified tokens (bg-white/[0.12]).
    const solidWhiteText = /\btext-white\b(?!\/)/
    // Harsh pure-black text on white (SOP §2 / #189). On white/neutral-100 this
    // clears WCAG but reads harsh against Shield's warmer neutrals — flag for
    // review; prefer text-neutral-900 (#171717). Scoped to the same ternary
    // segment as a white bg so mutually-exclusive branches aren't paired.
    const harshBlackText = /\btext-black\b|\btext-\[#(?:000|000000|111|111111)\]/i
    for (const seg of cls.split(/[?:]|\$\{|\}|['"`]/)) {
      if (solidWhiteText.test(seg)) {
        const lightBg = LIGHT_BG.find((b) => new RegExp(`\\b${b}\\b(?!\\/)`).test(seg))
        const translucent = seg.match(/\bbg-[^\s/]*\/(?:\[0?\.0[0-9]\]|5|10|20)\b/)
        if (lightBg || translucent) {
          add('contrast', rel, lineOf(noComments, cm.index), `white text on a light/translucent fill (${lightBg || translucent[0]}) — unreadable`, seg.trim())
        }
      }
      if (harshBlackText.test(seg) && /\b(?:bg-white|bg-neutral-100)\b(?!\/)/.test(seg)) {
        add('contrast', rel, lineOf(noComments, cm.index), 'harsh pure-black text on white (#189) — prefer text-neutral-900 (#171717)', seg.trim())
      }
    }
  }

  // 3) Off-scale opacity utilities (SOP §2). Includes variants (disabled:, hover:…).
  const opRe = /(?:^|[\s"'`{])(?:[a-z-]+:)*opacity-(\[[^\]]+\]|\d+)/g
  let om
  while ((om = opRe.exec(noComments))) {
    const val = om[1]
    if (val.startsWith('[')) continue // arbitrary value — reviewed by eye
    if (!ALLOWED_OPACITY.has(val)) {
      add('opacity', rel, lineOf(noComments, om.index), `off-scale opacity-${val} (scale is 0/20/40/60/80/100)`, lineText(raw, lineOf(raw, om.index)))
    }
  }

  // 4) Em-dash / long-dash in rendered strings (SOP §10). Comments stripped.
  const dashRe = /[—–‒]/g
  let dm
  while ((dm = dashRe.exec(noComments))) {
    add('copy', rel, lineOf(noComments, dm.index), 'em/long dash in UI string — split into two sentences (review)', lineText(raw, lineOf(raw, dm.index)))
  }

  // 5) Disabled <button> with no reason surfaced (SOP §6).
  //    Match each <button ...> opening tag; flag if it has `disabled`
  //    but no aria-label / title.
  const btnRe = /<button\b[\s\S]*?>/g
  let bm
  while ((bm = btnRe.exec(noComments))) {
    const tag = bm[0]
    if (/\bdisabled\b/.test(tag) && !/\baria-label\b/.test(tag) && !/\btitle\b/.test(tag)) {
      add('states', rel, lineOf(noComments, bm.index), 'disabled <button> without aria-label/title — add a reason or prefer an actionable prompt', tag.replace(/\s+/g, ' '))
    }
  }
}

function lineText(src, ln) {
  return src.split('\n')[ln - 1] || ''
}

// ── no-scroll check (SOP §5) — DOCUMENTED STUB, not a fake pass ─────────────
const NO_SCROLL_ROUTES = ['/', '/progress', '/activity', '/fee-juice']
function reportNoScrollStub() {
  console.log('')
  console.log('── no-scroll check (SOP §5) ──────────────────────────────────')
  console.log('STATUS: NOT RUN (stub). This needs a headless browser (Playwright).')
  console.log('Routes that must fit with no page scroll / no internal scrollbar')
  console.log('at innerHeight 720 / 800 / 900:')
  console.log('  ' + NO_SCROLL_ROUTES.join('   '))
  console.log('To enable (do NOT mark these routes green until then):')
  console.log('  cd frontend && pnpm add -D @playwright/test && npx playwright install chromium')
  console.log('  # then implement the height assertion in scripts/design-lint.mjs (see TODO)')
  console.log('')
  // TODO(no-scroll): with @playwright/test installed and `pnpm dev` (or a preview
  // URL) running, for each route and each height in [720, 800, 900]:
  //   const page = await browser.newPage()
  //   await page.setViewportSize({ width: 420, height })
  //   await page.goto(base + route)
  //   const overflow = await page.evaluate(() =>
  //     document.documentElement.scrollHeight > window.innerHeight ||
  //     [...document.querySelectorAll('*')].some(el => el.scrollHeight > el.clientHeight + 1 &&
  //       getComputedStyle(el).overflowY.match(/auto|scroll/)))
  //   assert(!overflow, `${route} scrolls at ${height}px`)
}

// ── report ──────────────────────────────────────────────────────────────────
// ── orphaned-component check ─────────────────────────────────────────────────
// A component under src/components that NOTHING imports is a red flag it was
// reverted or duplicated — the AccountChip regression: a nav refactor
// reimplemented the chip inline and left the real component dead. SOP §1:
// reuse, don't reimplement; never orphan a component.
function reportOrphanedComponents() {
  const all = walk(SRC, ['.tsx', '.ts'])
  const texts = all.map((f) => [f, readFileSync(f, 'utf8')])
  const comps = all.filter((f) => f.includes('/components/') && f.endsWith('.tsx'))
  for (const file of comps) {
    const base = file.split('/').pop().replace(/\.tsx$/, '')
    if (base === 'index') continue
    const re = new RegExp(`from\\s+['"][^'"]*/${base}['"]|import\\s*\\(\\s*['"][^'"]*/${base}['"]`)
    const imported = texts.some(([f, t]) => f !== file && re.test(t))
    if (!imported) {
      add(
        'orphaned',
        relative(ROOT, file),
        1,
        'component is never imported — orphaned/dead code (reverted or duplicated?). Reuse it or delete it (SOP §1: reuse, do not reimplement).',
        base,
      )
    }
  }
}
reportOrphanedComponents()

const byRule = findings.reduce((acc, f) => ((acc[f.rule] = (acc[f.rule] || 0) + 1), acc), {})
const RULE_TITLES = {
  contrast: 'Contrast / readability (SOP §2)',
  opacity: 'Off-scale opacity (SOP §2/§6)',
  copy: 'Copy — em/long dash (SOP §10)',
  states: 'Graceful states — disabled buttons (SOP §6)',
  orphaned: 'Orphaned component — never imported (SOP §1: reuse, do not reimplement)',
}

console.log('Shield design-lint — SOP: internal-docs products/shield/design-sop.md')
console.log(`Scanned ${files.length} .tsx files under src/`)
console.log('')

if (findings.length === 0) {
  console.log('No static findings.')
} else {
  const order = ['orphaned', 'contrast', 'opacity', 'states', 'copy']
  for (const rule of order) {
    const items = findings.filter((f) => f.rule === rule)
    if (!items.length) continue
    console.log(`▸ ${RULE_TITLES[rule]} — ${items.length}`)
    for (const f of items) {
      console.log(`    ${f.file}:${f.line}  ${f.msg}`)
      if (f.snippet) console.log(`      ${f.snippet}`)
    }
    console.log('')
  }
  console.log(`Total: ${findings.length} finding(s) — ${Object.entries(byRule).map(([k, v]) => `${k}:${v}`).join(', ')}`)
}

reportNoScrollStub()

// ── manual reviewer checklist (SOP §11) — rules that need rendered geometry ──
function reportManualChecklist() {
  console.log('── manual reviewer checklist (SOP §11) — not statically checkable ──')
  console.log('These depend on rendered layout, so confirm by eye (the lint can NOT):')
  console.log('  [ ] Back-action (#194): where a screen has a primary CTA + back, back is a')
  console.log('      small in-row button (~80/20), never a stacked full-width button (SOP §4)')
  console.log('  [ ] Edge/neighbor spacing (#211/#208): no nav segment, card, or message row')
  console.log('      crowds a border/neighbor; pinned-edge segments get extra inset (SOP §3)')
  console.log('  [ ] Overlay geometry (#438/#454): connectors/rails/badges take percent insets')
  console.log('      from a wrapper of exactly the elements they align to — never a hardcoded')
  console.log('      row height (the type scale has no paired line-heights) (SOP §3)')
  console.log('  [ ] Motion (#454): checked in a real render — nothing animates where a')
  console.log('      positioned neighbor paints over it; reduced-motion collapses it (SOP §3)')
  console.log('')
}
reportManualChecklist()

const blocking = findings.filter((f) => BLOCKING_RULES.has(f.rule))
const advisoryCount = findings.length - blocking.length
if (!ADVISORY && blocking.length > 0) {
  console.log(
    `design-lint: BLOCKING — ${blocking.length} finding(s) in enforced rules (${[...BLOCKING_RULES].join(', ')}). ` +
      `Fix these to merge. ${advisoryCount} advisory finding(s) (copy/states) shown above are non-blocking.`,
  )
  process.exit(1)
}
console.log(
  `design-lint: enforced rules (${[...BLOCKING_RULES].join(', ')}) are clean. ` +
    `${advisoryCount} advisory finding(s) (copy/states) shown above do not block.`,
)
process.exit(0)
