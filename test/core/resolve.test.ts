// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from '../../src/core/resolve.ts'
import { normalize } from '../../src/core/text.ts'
import type { Bill } from '../../src/core/types.ts'

const bills = (...names: string[]): Bill[] =>
  names.map((name, i) => ({ id: i + 1, name, key: normalize(name), paused: false, removed: false }))

const BILLS = bills('Luz', 'Água', 'Cartão Nu', 'Cartão C6', 'Apto', 'Apto 101', 'Conta de Luz', 'Maio')
const NOW = '2026-10'

type Want = { bill: string; amount: number | null; month: string | null } | string
const run = (arg: string, list = BILLS) => {
  const r = resolve(arg, list, NOW, ',')
  if (r.ok) return { bill: r.bill.name, amount: r.amount, month: r.month }
  return r.why === 'suggest' ? `suggest:${r.bill.name}:${r.amount}:${r.month}` : r.why
}

test('resolve /pago arguments, happy path and off path', () => {
  const cases: [string, Want][] = [
    ['luz', { bill: 'Luz', amount: null, month: null }],
    ['luz 80', { bill: 'Luz', amount: 8000, month: null }],
    ['80 luz', { bill: 'Luz', amount: 8000, month: null }],
    ['R$80 luz', { bill: 'Luz', amount: 8000, month: null }],
    ['luz 80 reais', { bill: 'Luz', amount: 8000, month: null }],
    ['a luz de setembro 80', { bill: 'Luz', amount: 8000, month: '2026-09' }],
    ['luz 80 09/2026', { bill: 'Luz', amount: 8000, month: '2026-09' }],
    ['09/2026 luz R$ 80', { bill: 'Luz', amount: 8000, month: '2026-09' }],
    ['luz set/26', { bill: 'Luz', amount: null, month: '2026-09' }],
    ['Agua', { bill: 'Água', amount: null, month: null }],
    ['cartão nu 6.237,60', { bill: 'Cartão Nu', amount: 623760, month: null }],
    ['nu cartao', { bill: 'Cartão Nu', amount: null, month: null }],
    ['apto 101', { bill: 'Apto 101', amount: null, month: null }],
    ['apto 101 80', { bill: 'Apto 101', amount: 8000, month: null }],
    ['apto 80', { bill: 'Apto', amount: 8000, month: null }],
    ['conta de luz', { bill: 'Conta de Luz', amount: null, month: null }],
    ['maio 80', { bill: 'Maio', amount: 8000, month: null }],
    ['luz maio', 'onePerCommand'],
    ['cart', 'onePerCommand'],
    ['lux 80', 'suggest:Luz:8000:null'],
    ['luz não paguei ainda', 'suggest:Luz:null:null'],
    ['luz e agua', 'onePerCommand'],
    ['netflix', 'notFound'],
    ['', 'missingBill'],
    ['80', 'missingBill'],
    ['R$ 150', 'missingBill'],
    ['setembro', 'missingBill'],
    ['luz R$80 R$90', 'pagoSyntax'],
    ['luz 09/2026 08/2026', 'pagoSyntax'],
    ['luz 12/2026', 'futureMonth'],
    ['80 apto 101', { bill: 'Apto 101', amount: 8000, month: null }],
    ['o apto 101', { bill: 'Apto 101', amount: null, month: null }],
    ['luz setembro 2026', { bill: 'Luz', amount: null, month: '2026-09' }],
    ['luz setembro de 2025', { bill: 'Luz', amount: null, month: '2025-09' }],
    ['luz 80 setembro 2026', { bill: 'Luz', amount: 8000, month: '2026-09' }],
    ['maio 2026', { bill: 'Maio', amount: 202600, month: null }],
    ['luz 05/10', 'suggest:Luz:null:null'],
    ['luz set/2010', 'suggest:Luz:null:null'],
    ['apto 101 R$ 80', { bill: 'Apto 101', amount: 8000, month: null }],
    ['a conta de luz', { bill: 'Conta de Luz', amount: null, month: null }],
    ['conta de luz de setembro', { bill: 'Conta de Luz', amount: null, month: '2026-09' }],
  ]
  for (const [arg, want] of cases) assert.deepEqual(run(arg), want, arg)
})

test('removed bills never resolve', () => {
  const list = bills('Luz', 'Água').map(b => (b.name === 'Luz' ? { ...b, removed: true } : b))
  assert.equal(run('luz', list), 'notFound')
})
test('filler words in a bill name do not hide it', () => {
  const list = bills('Conta de Luz', 'Água')
  assert.deepEqual(run('luz', list), { bill: 'Conta de Luz', amount: null, month: null })
  assert.equal(run('conta de luz e agua', list), 'onePerCommand')
})
test('apto 101 R$ 80 resolves with only Apto and Apto 101', () => {
  assert.deepEqual(run('apto 101 R$ 80', bills('Apto', 'Apto 101')), { bill: 'Apto 101', amount: 8000, month: null })
})
test('the full key wins over the filler-stripped core regardless of order', () => {
  const list = bills('Conta de Luz', 'Luz')
  assert.deepEqual(run('luz', list), { bill: 'Luz', amount: null, month: null })
  assert.deepEqual(run('luz', bills('Luz', 'Conta de Luz')), { bill: 'Luz', amount: null, month: null })
})
