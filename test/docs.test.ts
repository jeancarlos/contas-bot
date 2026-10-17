// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
const docs = tracked
  .filter(f => /\.md$/.test(f) && !f.startsWith('site/'))
  .map(f => ({ f, text: readFileSync(join(ROOT, f), 'utf8') }))
const scripts = Object.keys(
  (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: object }).scripts,
)

test('every npm script the docs tell you to run exists', () => {
  const missing = docs.flatMap(d =>
    [...d.text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)]
      .filter(m => !scripts.includes(m[1] ?? ''))
      .map(m => `${d.f}: npm run ${m[1]}`),
  )
  assert.deepEqual(missing, [])
})

test('every repository path the docs point to exists', () => {
  const missing = docs.flatMap(d =>
    [...d.text.matchAll(/`((?:src|test|scripts|docs|addons|bin|\.github|\.githooks)\/[A-Za-z0-9_./-]+)`/g)]
      .map(m => m[1] ?? '')
      .filter(p => !p.endsWith('/') && !existsSync(join(ROOT, p)))
      .map(p => `${d.f}: ${p}`),
  )
  assert.deepEqual(missing, [])
})

test('every relative link in the docs resolves', () => {
  const missing = docs.flatMap(d =>
    [...d.text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)/g)]
      .map(m => m[1] ?? '')
      .filter(p => !existsSync(join(ROOT, d.f.includes('/') ? d.f.replace(/\/[^/]*$/, '') : '.', p)))
      .map(p => `${d.f}: ${p}`),
  )
  assert.deepEqual(missing, [])
})
