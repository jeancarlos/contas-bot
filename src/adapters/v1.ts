import { normalize } from '../core/text.ts'
import type { Bill, GroupState, Payment } from '../core/types.ts'

export type GroupMeta = { invite: string | null; announcedVersion: string | null; descriptionMigrated: boolean }
export type ImportedGroup = { jid: string; state: GroupState; meta: GroupMeta }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function payment(p: Obj): Payment {
  const amount =
    typeof p.amount === 'number' && p.amount > 0 && p.amount < 1e12 ? Math.round(p.amount * 100) || null : null
  const paidAt = Date.parse(str(p.paid_at) ?? '')
  return {
    amount,
    status: amount === null ? 'none' : 'typed',
    by: str(p.by) ?? '',
    paidAt: Number.isNaN(paidAt) ? 0 : paidAt,
    messageId: str(p.message_id) ?? '',
  }
}

const PAUSED = /^(.*?)\s*\((?:pausad[oa]|paused)\)$/i

function billsFrom(lines: string[]): Bill[] {
  const bills: Bill[] = []
  for (const line of lines) {
    const m = PAUSED.exec(line.trim())
    const name = (m?.[1] ?? line).trim()
    const key = normalize(name)
    if (key && !bills.some(b => b.key === key))
      bills.push({ id: bills.length + 1, name, key, paused: Boolean(m), removed: false })
  }
  return bills
}

function monthsFrom(raw: unknown, billFor: (key: string, name: string) => Bill): GroupState['months'] {
  const months: GroupState['months'] = {}
  for (const [month, rows] of Object.entries(isObj(raw) ? raw : {})) {
    if (!/^\d{4}-\d{2}$/.test(month) || !isObj(rows)) continue
    const paid: Record<number, Payment> = {}
    for (const [key, p] of Object.entries(rows)) {
      if (isObj(p)) paid[billFor(normalize(key), str(p.name) ?? key).id] = payment(p)
    }
    months[month] = paid
  }
  return months
}

function group(jid: string, g: Obj): ImportedGroup {
  const meta = isObj(g._meta) ? g._meta : {}
  const lines = Array.isArray(meta.bills) ? meta.bills.filter(b => typeof b === 'string') : null
  const bills = billsFrom(lines ?? [])
  const billFor = (key: string, name: string): Bill => {
    const found = bills.find(b => b.key === key)
    if (found) return found
    const orphan = { id: bills.length + 1, name, key, paused: false, removed: lines !== null }
    bills.push(orphan)
    return orphan
  }
  const months = monthsFrom(g.months, billFor)
  const handled = Array.isArray(meta.handled) ? meta.handled.filter(h => typeof h === 'string') : []
  return {
    jid,
    state: {
      bills,
      nextBillId: bills.length + 1,
      months,
      handled: handled.map(id => ({ id, changed: true, warned: false })),
      pinnedId: isObj(meta.pinned) ? str(meta.pinned.id) : null,
      lastReset: str(meta.last_reset),
      asks: [],
    },
    meta: { invite: str(meta.invite), announcedVersion: str(meta.announced_version), descriptionMigrated: false },
  }
}

export function fromV1(raw: unknown): ImportedGroup[] {
  if (!isObj(raw) || !isObj(raw.groups)) throw new Error('state.json has no "groups" object')
  return Object.entries(raw.groups).flatMap(([jid, g]) => (isObj(g) ? [group(jid, g)] : []))
}
