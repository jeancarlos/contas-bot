import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findMoney, parseNumber } from '../../src/core/money.ts'

test('parseNumber reads amounts as integer cents with locale-driven ambiguity', () => {
  const cases: [string, ',' | '.', number | null][] = [
    ['80', ',', 8000],
    ['80,10', ',', 8010],
    ['80.10', ',', 8010],
    ['6.237,60', ',', 623760],
    ['6,237.60', '.', 623760],
    ['1.234', ',', 123400],
    ['1.234', '.', 123],
    ['0,004', ',', null],
    ['1.234.56', ',', null],
    ['1000000000000', ',', null],
    ['abc', ',', null],
    ['09/2026', ',', null],
  ]
  for (const [s, dec, want] of cases) assert.equal(parseNumber(s, dec), want, s)
})

test('findMoney marks currency tokens anywhere and keeps bare numbers apart', () => {
  const tok = (s: string) => s.split(' ')
  assert.deepEqual(findMoney(tok('luz R$80'), ',').marked, [{ start: 1, end: 2, cents: 8000 }])
  assert.deepEqual(findMoney(tok('R$ 80 luz'), ',').marked, [{ start: 0, end: 2, cents: 8000 }])
  assert.deepEqual(findMoney(tok('luz 80 reais'), ',').marked, [{ start: 1, end: 3, cents: 8000 }])
  assert.deepEqual(findMoney(tok('luz USD 80'), ',').marked, [{ start: 1, end: 3, cents: 8000 }])
  assert.deepEqual(findMoney(tok('luz 80\u20ac'), ',').marked, [{ start: 1, end: 2, cents: 8000 }])
  assert.deepEqual(findMoney(tok('apto 101 luz'), ','), { marked: [], bare: [{ start: 1, end: 2, cents: 10100 }] })
  assert.equal(findMoney(tok('luz R$80 R$90'), ',').marked.length, 2)
  assert.deepEqual(findMoney(tok('plano top'), ',').marked, [])
})
