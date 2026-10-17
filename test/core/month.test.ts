// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { monthOf, monthTitle, parseMonthToken } from '../../src/core/month.ts'

test('month tokens: numeric, named, abbreviated and bare names never in the future', () => {
  const now = '2026-10'
  const cases: [string, string | null][] = [
    ['09/2026', '2026-09'],
    ['9/26', '2026-09'],
    ['set/2026', '2026-09'],
    ['setembro/2026', '2026-09'],
    ['sep/2026', '2026-09'],
    ['setembro', '2026-09'],
    ['september', '2026-09'],
    ['dezembro', '2025-12'],
    ['outubro', '2026-10'],
    ['13/2026', null],
    ['set', null],
    ['luz', null],
  ]
  for (const [tok, want] of cases) assert.equal(parseMonthToken(tok, now), want, tok)
})

test('monthOf uses the configured time zone and monthTitle the language', () => {
  const midnightUtcNov1 = Date.UTC(2026, 10, 1, 2, 0)
  assert.equal(monthOf(midnightUtcNov1, 'America/Sao_Paulo'), '2026-10')
  assert.equal(monthOf(midnightUtcNov1, 'UTC'), '2026-11')
  assert.equal(monthTitle('2026-09', 'pt-BR'), 'Setembro/2026')
  assert.equal(monthTitle('2026-09', 'en'), 'September/2026')
})
