// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FREE = /^(chore|ci|test|docs|refactor|style|build|perf)(\(.+\))?!?:/
const LOGGED = /^(feat|fix)(\(.+\))?!?:\s*(.*)$/
const MAX = 72
export const TRAILERS = ['Changelog-pt-BR', 'Changelog-es'] as const

const clean = (msg: string) => msg.split(/\r?\n/).filter(l => !l.startsWith('#')).join('\n').trim()

export function parseTrailers(msg: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of clean(msg).split('\n')) {
    const [, name = '', value = ''] = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line.trim()) ?? []
    if (TRAILERS.includes(name as (typeof TRAILERS)[number])) out[name] = value.trim()
  }
  return out
}

export function lintCommitMessage(msg: string): string[] {
  const text = clean(msg)
  const subject = text.split('\n')[0] ?? ''
  if (/^Merge /.test(subject) || /^(fixup|squash)! /.test(subject) || FREE.test(subject)) return []
  const m = LOGGED.exec(subject)
  if (!m) return []
  return [...titleErrors(m[3] ?? ''), ...trailerErrors(text)]
}

function titleErrors(title: string): string[] {
  const errors: string[] = []
  if (title.trim() === '') errors.push('subject is empty')
  if (title.length > MAX) errors.push(`subject is ${title.length} chars after the prefix (max ${MAX})`)
  return errors
}

function trailerErrors(text: string): string[] {
  const errors: string[] = []
  const lines = text.split('\n')
  const folded = lines.some((l, i) => i > 0 && /^[ \t]+\S/.test(l) && /^Changelog-(pt-BR|es):/.test(lines[i - 1] ?? ''))
  if (folded) errors.push('trailer must fit on one line')
  const t = parseTrailers(text)
  for (const name of TRAILERS) errors.push(...trailerLengthErrors(name, t[name]))
  return errors
}

function trailerLengthErrors(name: string, v: string | undefined): string[] {
  if (!v) return [`missing ${name}: <one line for the group, ≤ ${MAX} chars>`]
  return v.length > MAX ? [`${name} is ${v.length} chars (max ${MAX})`] : []
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('usage: changelog-lint.ts <commit-message-file>\n')
    process.exit(2)
  }
  const errors = lintCommitMessage(readFileSync(file, 'utf8'))
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n\nexample:\n  feat: bot announces new versions in the group\n\n  Changelog-pt-BR: o bot anuncia versões novas no grupo\n  Changelog-es: el bot anuncia versiones nuevas en el grupo\n`)
    process.exit(1)
  }
}
