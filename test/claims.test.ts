// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
const source = tracked.filter(f => /^src\/.*\.ts$/.test(f)).map(f => ({ f, text: readFileSync(join(ROOT, f), 'utf8') }))
const offenders = (re: RegExp) => source.filter(s => re.test(s.text)).map(s => s.f)

test('the source never spawns a shell: child processes take an argument array', () => {
  assert.deepEqual(offenders(/shell:\s*true|\bexecSync\b|\bspawnSync\b|\bchild_process\b[^;]*\bexec\b[^FS]/), [])
})

test('the source has no weak or home-made cryptography and no Math.random', () => {
  assert.deepEqual(offenders(/createCipher\b|createDecipher\b|\bmd5\b|\bsha1\b|Math\.random/i), [])
})

test('SQL is never built from variables: only constants are interpolated into a statement', () => {
  const interpolated = source.flatMap(s =>
    [...s.text.matchAll(/\.(?:prepare|exec)\(`[^`]*\$\{([^}]*)\}/g)].map(m => `${s.f}: ${m[1]}`),
  )
  assert.deepEqual(interpolated, ['src/adapters/store.ts: SCHEMA_VERSION'])
})

test('the read-only HTTP add-ons answer GET and refuse every other method', () => {
  const http = source.find(s => s.f === 'src/adapters/http.ts')?.text ?? ''
  assert.match(http, /method !== 'GET'\) return text\(405/)
  assert.doesNotMatch(http, /req\.on\('data'/)
})
