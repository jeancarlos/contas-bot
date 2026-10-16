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

test('an ISO code attached to the number marks money like a symbol does', () => {
  const tok = (s: string) => s.split(' ')
  for (const t of ['80USD', 'USD80', '80brl', 'eur80,50']) {
    const [hit] = findMoney(tok(`luz ${t}`), ',').marked
    assert.deepEqual(hit && { start: hit.start, end: hit.end }, { start: 1, end: 2 }, t)
  }
  assert.equal(findMoney(tok('luz 80USD'), ',').marked[0]?.cents, 8000)
  assert.equal(findMoney(tok('luz eur80,50'), ',').marked[0]?.cents, 8050)
  assert.deepEqual(findMoney(tok('luz abc80'), ','), { marked: [], bare: [] })
})

test('a currency word that is a word of a bill name is not a money marker', () => {
  const tok = (s: string) => s.split(' ')
  const bills = new Set(['top', 'real', 'usd'])
  assert.deepEqual(findMoney(tok('top 80'), ',', bills), { marked: [], bare: [{ start: 1, end: 2, cents: 8000 }] })
  assert.deepEqual(findMoney(tok('80 real'), ',', bills), { marked: [], bare: [{ start: 0, end: 1, cents: 8000 }] })
  assert.deepEqual(findMoney(tok('luz usd80'), ',', bills), { marked: [], bare: [] })
  assert.deepEqual(findMoney(tok('top R$ 80'), ',', bills).marked, [{ start: 1, end: 3, cents: 8000 }])
})
