// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOGGED = /^(feat|fix)(\(.+\))?!?:/
const EXEMPT = /^No-Test:\s*\S/m

export type Change = { subject: string; body: string; files: string[] }

export function missingTests(changes: Change[]): string[] {
  return changes
    .filter(c => LOGGED.test(c.subject) && !EXEMPT.test(c.body) && !c.files.some(f => f.startsWith('test/')))
    .map(c => `${c.subject}: no change under test/ (add a test, or a "No-Test: <reason>" line)`)
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' })

function readRange(range: string): Change[] {
  return git('rev-list', '--no-merges', range)
    .split('\n')
    .filter(Boolean)
    .map(h => ({
      subject: git('log', '-1', '--format=%s', h).trim(),
      body: git('log', '-1', '--format=%b', h),
      files: git('show', '--name-only', '--format=', h).split('\n').filter(Boolean),
    }))
}

function readStaged(msgFile: string): Change[] {
  const [subject = '', ...rest] = readFileSync(msgFile, 'utf8').split('\n')
  return [{ subject, body: rest.join('\n'), files: git('diff', '--cached', '--name-only').split('\n').filter(Boolean) }]
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, arg] = process.argv.slice(2)
  if (!mode) {
    process.stderr.write('usage: test-policy.ts <git-range> | --staged <commit-message-file>\n')
    process.exit(2)
  }
  const problems = missingTests(mode === '--staged' ? readStaged(arg ?? '') : readRange(mode))
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`)
    process.exit(1)
  }
}
