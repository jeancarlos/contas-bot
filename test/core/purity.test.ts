import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '../..')
const biome = join(root, 'node_modules/.bin/biome')

function lintProbe(path: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'purity-'))
  copyFileSync(join(root, 'biome.json'), join(dir, 'biome.json'))
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), source)
  const r = spawnSync(biome, ['lint', path], { cwd: dir, encoding: 'utf8' })
  return `${r.stdout}${r.stderr}`
}

const PROBE = [
  "import { readFile } from 'node:fs'",
  "import pino from 'pino'",
  "import { x } from '../bot.ts'",
  'export const n = Date.now() + readFile.length + x + String(pino) + String(process.env.TZ)',
  '',
].join('\n')

test('core may not import Node, pino, Baileys or code outside core, nor read the clock or process', () => {
  const out = lintProbe('src/core/probe.ts', PROBE)
  assert.equal(out.match(/lint\/style\/noRestrictedImports/g)?.length, 3, out)
  assert.equal(out.match(/lint\/style\/noRestrictedGlobals/g)?.length, 2, out)
})

test('core may not import a bare Node builtin either', () => {
  const bare = "import { readFile } from 'fs'\nexport const f = readFile\n"
  assert.match(lintProbe('src/core/probe.ts', bare), /lint\/correctness\/noNodejsModules/)
  assert.doesNotMatch(lintProbe('src/probe.ts', bare), /noNodejsModules/)
})

test('the same code outside core is allowed', () => {
  const out = lintProbe('src/probe.ts', PROBE)
  assert.doesNotMatch(out, /noRestricted/)
})
test('core never uses Math.random', () => {
  const dir = join(root, 'src/core')
  for (const f of readdirSync(dir).filter(n => n.endsWith('.ts')))
    assert.ok(!readFileSync(join(dir, f), 'utf8').includes('Math.random'), f)
})
