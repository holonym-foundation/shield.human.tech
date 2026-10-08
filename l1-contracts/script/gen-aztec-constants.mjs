// Aztec stopped committing ConstantsGen.sol (gitignored, generated at their build time) from v6.
// The lib/aztec-contracts sources import it, so regenerate it from the published codegen package
// pinned to the submodule's tag before compiling.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const aztecDir = resolve('lib/aztec-contracts')
const out = join(aztecDir, 'l1-contracts/src/core/libraries/ConstantsGen.sol')
const selection = join(aztecDir, 'l1-contracts/scripts/constants-codegen/solidity.json')
const tag = execFileSync('git', ['-C', aztecDir, 'describe', '--tags', '--exact-match'], { encoding: 'utf8' }).trim()
const version = tag.replace(/^v/, '')

if (!existsSync(selection)) {
  console.log(`[gen:constants] ${tag} ships no constants selection; nothing to generate`)
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'aztec-constants-'))
execFileSync('npm', ['install', '--silent', '--prefix', work, `@aztec-foundation/constants-codegen@${version}`], { stdio: 'inherit' })
execFileSync('node', [join(work, 'node_modules/@aztec-foundation/constants-codegen/dest/cli.js'), '--solidity', out, '--selection', selection], { stdio: 'inherit' })
execFileSync('forge', ['fmt', out], { stdio: 'inherit', cwd: join(aztecDir, 'l1-contracts') })
console.log(`[gen:constants] wrote ${out} for ${tag}`)
