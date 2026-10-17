import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8')

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-3-Clause',
  '0BSD',
  'BlueOak-1.0.0',
  'Apache-2.0',
  'MIT OR Apache-2.0',
  'LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later',
  'Apache-2.0 AND LGPL-3.0-or-later AND MIT',
  'GPL-3.0',
])

test('the project is GPL-3.0-or-later, which libsignal (GPL-3.0) requires', () => {
  assert.equal(JSON.parse(read('package.json')).license, 'GPL-3.0-or-later')
  assert.match(read('LICENSE'), /^\s*GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/)
})

test('every locked dependency carries an allowed license', () => {
  const lock: { packages: Record<string, { license?: string }> } = JSON.parse(read('package-lock.json'))
  const bad = Object.entries(lock.packages)
    .filter(([name, p]) => name && !ALLOWED.has(p.license ?? ''))
    .map(([name, p]) => `${name}: ${p.license}`)
  assert.deepEqual(bad, [])
})
