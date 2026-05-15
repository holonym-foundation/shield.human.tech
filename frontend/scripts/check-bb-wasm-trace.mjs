#!/usr/bin/env node
import { readFile, access } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(__dirname, '..')

const WASM_FILENAME = 'barretenberg-threads.wasm.gz'
const ROUTES_REQUIRING_WASM = [
  '.next/server/app/api/attestation/poch/route.js.nft.json',
  '.next/server/app/api/attestation/passport/route.js.nft.json',
]

let failed = false

for (const rel of ROUTES_REQUIRING_WASM) {
  const nftPath = join(projectDir, rel)
  let trace
  try {
    trace = JSON.parse(await readFile(nftPath, 'utf8'))
  } catch (err) {
    console.error(`✗ ${rel}: cannot read (${err.code ?? err.message})`)
    failed = true
    continue
  }

  const wasmEntries = (trace.files ?? []).filter((f) => f.endsWith(WASM_FILENAME))
  if (wasmEntries.length === 0) {
    console.error(`✗ ${rel}: trace is missing ${WASM_FILENAME}`)
    failed = true
    continue
  }

  let resolvedAny = false
  for (const entry of wasmEntries) {
    const absolute = resolve(dirname(nftPath), entry)
    try {
      await access(absolute)
      resolvedAny = true
      console.log(`✓ ${rel}: ${entry}`)
    } catch {
      console.error(`✗ ${rel}: trace references ${entry} but file is missing on disk`)
    }
  }
  if (!resolvedAny) failed = true
}

if (failed) {
  console.error('\nBarretenberg wasm is missing from at least one API route trace.')
  console.error('See frontend/next.config.ts -> outputFileTracingIncludes.')
  process.exit(1)
}
