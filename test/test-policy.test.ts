// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { missingTests } from '../scripts/test-policy.ts'

const change = (subject: string, files: string[], body = '') => ({ subject, body, files })

test('a fix or feat with no test file is named, with the way out', () => {
  const out = missingTests([change('fix: stop the crash', ['src/a.ts']), change('feat(x)!: new', ['src/b.ts'])])
  assert.equal(out.length, 2)
  assert.match(out[0] ?? '', /No-Test/)
})

test('a fix or feat that touches test/ passes', () => {
  assert.deepEqual(missingTests([change('fix: x', ['src/a.ts', 'test/a.test.ts'])]), [])
})

test('chore, ci, docs and merges need no test', () => {
  assert.deepEqual(
    missingTests([
      change('chore: x', ['src/a.ts']),
      change('ci: x', []),
      change('docs: x', ['README.md']),
      change('Merge pull request #1', []),
    ]),
    [],
  )
})

test('a No-Test line with a reason exempts the commit, an empty one does not', () => {
  assert.deepEqual(missingTests([change('fix: x', ['src/a.ts'], 'No-Test: wording only')]), [])
  assert.equal(missingTests([change('fix: x', ['src/a.ts'], 'No-Test:')]).length, 1)
})

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'test-policy.ts')
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  })

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'))
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'a.txt'), 'a')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'chore: base')
  return dir
}

test('cli exits 2 with usage when called with nothing', () => {
  const r = run(repo())
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage/)
})

test('cli over a range fails for a fix without a test and passes once a test is added', () => {
  const dir = repo()
  writeFileSync(join(dir, 'a.txt'), 'b')
  git(dir, 'commit', '-qam', 'fix: change a')
  const bad = run(dir, 'HEAD~1..HEAD')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /fix: change a/)
  writeFileSync(join(dir, 'test', 'a.test.ts'), 'x')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'fix: change a again')
  assert.equal(run(dir, 'HEAD~1..HEAD').status, 0)
})

test('cli --staged judges the staged files against the message file', () => {
  const dir = repo()
  const msg = join(dir, 'MSG')
  writeFileSync(msg, 'fix: needs a test\n')
  writeFileSync(join(dir, 'a.txt'), 'c')
  git(dir, 'add', 'a.txt')
  assert.equal(run(dir, '--staged', msg).status, 1)
  writeFileSync(join(dir, 'test', 'a.test.ts'), 'x')
  git(dir, 'add', '.')
  assert.equal(run(dir, '--staged', msg).status, 0)
  writeFileSync(msg, 'chore: no test needed\n')
  assert.equal(run(dir, '--staged', msg).status, 0)
})
