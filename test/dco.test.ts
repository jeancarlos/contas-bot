// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { unsigned } from '../scripts/dco.ts'

const c = (email: string, body = '') => ({ subject: 'fix: x', body, email })

test('an outside contributor commit without a sign-off is named', () => {
  const out = unsigned([c('ana@example.org')])
  assert.equal(out.length, 1)
  assert.match(out[0] ?? '', /git commit -s/)
})

test('a Signed-off-by trailer passes', () => {
  assert.deepEqual(unsigned([c('ana@example.org', 'why\n\nSigned-off-by: Ana Silva <ana@example.org>\n')]), [])
})

test('a malformed sign-off does not pass', () => {
  assert.equal(unsigned([c('ana@example.org', 'Signed-off-by: Ana')]).length, 1)
})

test('the maintainer and bots are exempt', () => {
  assert.deepEqual(
    unsigned([
      c('jeancarlos@users.noreply.github.com'),
      c('jean.co.souza@gmail.com'),
      c('49699333+dependabot[bot]@users.noreply.github.com'),
    ]),
    [],
  )
})

const script = join(import.meta.dirname, '..', 'scripts', 'dco.ts')
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, encoding: 'utf8' })

test('cli fails on an unsigned outside commit and passes once signed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dco-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'ana@example.org')
  git(dir, 'config', 'user.name', 'Ana')
  git(dir, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a'), '1')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'base')
  writeFileSync(join(dir, 'a'), '2')
  git(dir, 'commit', '-qam', 'fix: one')
  const bad = spawnSync('node', [script, 'HEAD~1..HEAD'], { cwd: dir, encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /fix: one/)
  git(dir, 'commit', '-q', '--amend', '-s', '--no-edit')
  assert.equal(spawnSync('node', [script, 'HEAD~1..HEAD'], { cwd: dir }).status, 0)
  assert.equal(spawnSync('node', [script], { cwd: dir, encoding: 'utf8' }).status, 2)
})
