// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIGNED = /^Signed-off-by:\s*\S.*<[^<>@\s]+@[^<>\s]+>\s*$/m
const EXEMPT = /^(jeancarlos@users\.noreply\.github\.com|jean\.co\.souza@gmail\.com|.*\[bot\]@users\.noreply\.github\.com)$/

export type Commit = { subject: string; body: string; email: string }

export function unsigned(commits: Commit[]): string[] {
  return commits
    .filter(c => !EXEMPT.test(c.email) && !SIGNED.test(c.body))
    .map(c => `${c.subject} <${c.email}>: no "Signed-off-by: Name <email>" line (use git commit -s)`)
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' })

function readRange(range: string): Commit[] {
  return git('rev-list', '--no-merges', range)
    .split('\n')
    .filter(Boolean)
    .map(h => ({
      subject: git('log', '-1', '--format=%s', h).trim(),
      body: git('log', '-1', '--format=%b', h),
      email: git('log', '-1', '--format=%ae', h).trim(),
    }))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const range = process.argv[2]
  if (!range) {
    process.stderr.write('usage: dco.ts <git-range>\n')
    process.exit(2)
  }
  const problems = unsigned(readRange(range))
  if (problems.length) {
    process.stderr.write(`${problems.join('\n')}\n`)
    process.exit(1)
  }
}
