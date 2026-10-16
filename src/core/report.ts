import { listMsg } from './decide.ts'
import type { AmountStatus, GroupState } from './types.ts'

export type MonthTotal = { month: string; total: number; paid: number; unpaid: number }
export type PaymentRow = {
  month: string
  bill: string
  amountCents: number | null
  status: AmountStatus
  by: string
  paidAt: number
}

export const slug = (jid: string): string => (jid.split('@')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '_')

export function lastMonths(current: string, n: number): string[] {
  const [y = 0, m = 1] = current.split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const idx = y * 12 + (m - 1) - (n - 1 - i)
    return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
  })
}

export function monthTotals(state: GroupState, months: readonly string[]): MonthTotal[] {
  return months.map(month => {
    const active = listMsg(state, month).items.filter(i => !i.paused)
    const done = active.filter(i => i.paid)
    return {
      month,
      total: done.reduce((sum, i) => sum + (i.amount ?? 0), 0),
      paid: done.length,
      unpaid: active.length - done.length,
    }
  })
}

export function paymentRows(state: GroupState, from: string, to: string): PaymentRow[] {
  const rows: PaymentRow[] = []
  for (const [month, paid] of Object.entries(state.months)) {
    if (month < from || month > to) continue
    for (const bill of state.bills) {
      const p = paid[bill.id]
      if (p) rows.push({ month, bill: bill.name, amountCents: p.amount, status: p.status, by: p.by, paidAt: p.paidAt })
    }
  }
  return rows.sort((a, b) => a.month.localeCompare(b.month) || a.bill.localeCompare(b.bill))
}
