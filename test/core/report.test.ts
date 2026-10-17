import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastMonths, monthTotals, paymentRows, slug } from '../../src/core/report.ts'
import { emptyState, type GroupState, type Payment } from '../../src/core/types.ts'

const pay = (amount: number | null, status: Payment['status'], paidAt: number): Payment => ({
  amount,
  status,
  by: 'Ana',
  paidAt,
  messageId: `m${paidAt}`,
  byJid: null,
})

function sample(): GroupState {
  const s = emptyState()
  s.bills = [
    { id: 1, name: 'Luz', key: 'luz', paused: false, removed: false },
    { id: 2, name: 'Água', key: 'agua', paused: false, removed: false },
    { id: 3, name: 'Academia', key: 'academia', paused: true, removed: false },
    { id: 4, name: 'Farmácia', key: 'farmacia', paused: false, removed: true },
    { id: 5, name: 'Internet', key: 'internet', paused: false, removed: true },
  ]
  s.months['2026-09'] = {
    1: pay(8000, 'typed', 1),
    4: pay(2550, 'read', 2),
    2: pay(null, 'none', 3),
  }
  return s
}

test('slug: part before @, lowercased, non-alphanumerics become underscores', () => {
  assert.equal(slug('120363000000000001@g.us'), '120363000000000001')
  assert.equal(slug('Grupo-X@g.us'), 'grupo_x')
})

test('lastMonths: oldest first, current last, crosses years', () => {
  assert.deepEqual(lastMonths('2026-02', 3), ['2025-12', '2026-01', '2026-02'])
  assert.equal(lastMonths('2026-10', 24).length, 24)
})

test('monthTotals: removed paid bills count in the total, removed or paused unpaid never as unpaid', () => {
  assert.deepEqual(monthTotals(sample(), ['2026-09', '2026-10']), [
    { month: '2026-09', total: 10550, paid: 3, unpaid: 0 },
    { month: '2026-10', total: 0, paid: 0, unpaid: 2 },
  ])
})

test('paymentRows: inclusive range ordered by month then bill, current bill name, null amount kept', () => {
  const s = sample()
  s.months['2026-10'] = { 1: pay(9000, 'typed', 4) }
  const bill = s.bills[0]
  if (bill) bill.name = 'Energia'
  assert.deepEqual(paymentRows(s, '2026-09', '2026-10'), [
    { month: '2026-09', bill: 'Água', amountCents: null, status: 'none', by: 'Ana', paidAt: 3 },
    { month: '2026-09', bill: 'Energia', amountCents: 8000, status: 'typed', by: 'Ana', paidAt: 1 },
    { month: '2026-09', bill: 'Farmácia', amountCents: 2550, status: 'read', by: 'Ana', paidAt: 2 },
    { month: '2026-10', bill: 'Energia', amountCents: 9000, status: 'typed', by: 'Ana', paidAt: 4 },
  ])
  assert.equal(paymentRows(s, '2026-10', '2026-10').length, 1)
})

test('monthTotals: a paused paid bill counts as paid and in the total', () => {
  const s = sample()
  s.months['2026-09'] = { ...s.months['2026-09'], 3: pay(5000, 'typed', 4) }
  assert.deepEqual(monthTotals(s, ['2026-09']), [{ month: '2026-09', total: 15550, paid: 4, unpaid: 0 }])
})
