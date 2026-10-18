// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const workflows = readdirSync(new URL('.github/workflows/', root)).filter(f => f.endsWith('.yml'))

const onMain = (src: string) => /\non:\n(?:[\s\S]*?)push:\n\s+branches: \[[^\]]*\bmain\b/.test(src)

test('promote dispatches every workflow that only runs on a push to main, since the bot merge fires no push event', () => {
  const promote = read('.github/workflows/promote.yml')
  const names = workflows
    .filter(f => f !== 'promote.yml' && onMain(read(`.github/workflows/${f}`)))
    .map(f => f.replace('.yml', ''))
  assert.ok(names.length >= 4)
  for (const name of names) {
    assert.match(
      read(`.github/workflows/${name}.yml`),
      /\n {2}workflow_dispatch:/,
      `${name} must accept workflow_dispatch`,
    )
    assert.match(promote, new RegExp(`\\b${name}\\b`), `promote must dispatch ${name}`)
  }
  assert.match(promote, /actions: write/)
})

test('ci-local drops the git hook environment so a linked worktree is not rewritten by the tests', () => {
  assert.match(read('scripts/ci-local.sh'), /\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n/)
})
