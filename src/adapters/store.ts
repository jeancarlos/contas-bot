import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AmountStatus, Bill, GroupState, Payment } from '../core/types.ts'
import { fromV1, type GroupMeta, type ImportedGroup } from './v1.ts'

export type Store = {
  load(jid: string): GroupState | null
  commit(jid: string, state: GroupState): void
  meta(jid: string): GroupMeta | null
  setMeta(jid: string, meta: GroupMeta): void
  groups(): string[]
  close(): void
}
export type StoreOptions = { dbPath: string; v1Path: string; allowEmpty: boolean }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  jid TEXT PRIMARY KEY,
  invite TEXT,
  pinned_id TEXT,
  last_reset TEXT,
  next_bill_id INTEGER NOT NULL DEFAULT 1,
  announced_version TEXT,
  description_migrated INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bills (
  group_jid TEXT NOT NULL REFERENCES groups(jid),
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  paused INTEGER NOT NULL,
  removed INTEGER NOT NULL,
  PRIMARY KEY (group_jid, id)
);
CREATE TABLE IF NOT EXISTS payments (
  group_jid TEXT NOT NULL,
  month TEXT NOT NULL,
  bill_id INTEGER NOT NULL,
  amount INTEGER,
  amount_status TEXT NOT NULL CHECK (amount_status IN ('typed', 'read', 'pending', 'none')),
  paid_by TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (group_jid, month, bill_id),
  FOREIGN KEY (group_jid, bill_id) REFERENCES bills(group_jid, id)
);
CREATE TABLE IF NOT EXISTS handled (
  group_jid TEXT NOT NULL REFERENCES groups(jid),
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  changed_state INTEGER NOT NULL,
  warned INTEGER NOT NULL,
  PRIMARY KEY (group_jid, seq)
);
`

type GroupRow = {
  pinned_id: string | null
  last_reset: string | null
  next_bill_id: number
  invite: string | null
  announced_version: string | null
  description_migrated: number
}
type BillRow = { id: number; name: string; key: string; paused: number; removed: number }
type PaymentRow = {
  month: string
  bill_id: number
  amount: number | null
  amount_status: AmountStatus
  paid_by: string
  paid_at: number
  message_id: string
}
type HandledRow = { message_id: string; changed_state: number; warned: number }

function open(path: string) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  const sql = {
    group: db.prepare('SELECT * FROM groups WHERE jid = ?'),
    groups: db.prepare('SELECT jid FROM groups ORDER BY jid'),
    bills: db.prepare('SELECT id, name, key, paused, removed FROM bills WHERE group_jid = ? ORDER BY id'),
    payments: db.prepare('SELECT * FROM payments WHERE group_jid = ? ORDER BY month, bill_id'),
    handled: db.prepare('SELECT message_id, changed_state, warned FROM handled WHERE group_jid = ? ORDER BY seq'),
    upsertGroup: db.prepare(
      `INSERT INTO groups (jid, pinned_id, last_reset, next_bill_id) VALUES (?, ?, ?, ?)
       ON CONFLICT (jid) DO UPDATE SET pinned_id = excluded.pinned_id, last_reset = excluded.last_reset,
       next_bill_id = excluded.next_bill_id`,
    ),
    upsertMeta: db.prepare(
      `INSERT INTO groups (jid, invite, announced_version, description_migrated) VALUES (?, ?, ?, ?)
       ON CONFLICT (jid) DO UPDATE SET invite = excluded.invite, announced_version = excluded.announced_version,
       description_migrated = excluded.description_migrated`,
    ),
    clearPayments: db.prepare('DELETE FROM payments WHERE group_jid = ?'),
    clearBills: db.prepare('DELETE FROM bills WHERE group_jid = ?'),
    clearHandled: db.prepare('DELETE FROM handled WHERE group_jid = ?'),
    bill: db.prepare('INSERT INTO bills (group_jid, id, name, key, paused, removed) VALUES (?, ?, ?, ?, ?, ?)'),
    payment: db.prepare(
      `INSERT INTO payments (group_jid, month, bill_id, amount, amount_status, paid_by, paid_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    handle: db.prepare(
      'INSERT INTO handled (group_jid, seq, message_id, changed_state, warned) VALUES (?, ?, ?, ?, ?)',
    ),
  }

  const tx = (fn: () => void) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      fn()
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }

  const write = (jid: string, s: GroupState) => {
    sql.upsertGroup.run(jid, s.pinnedId, s.lastReset, s.nextBillId)
    sql.clearPayments.run(jid)
    sql.clearBills.run(jid)
    sql.clearHandled.run(jid)
    for (const b of s.bills) sql.bill.run(jid, b.id, b.name, b.key, Number(b.paused), Number(b.removed))
    for (const [month, paid] of Object.entries(s.months))
      for (const [billId, p] of Object.entries(paid))
        sql.payment.run(jid, month, Number(billId), p.amount, p.status, p.by, p.paidAt, p.messageId)
    s.handled.forEach((h, seq) => {
      sql.handle.run(jid, seq, h.id, Number(h.changed), Number(h.warned))
    })
  }

  const writeMeta = (jid: string, m: GroupMeta) => {
    sql.upsertMeta.run(jid, m.invite, m.announcedVersion, Number(m.descriptionMigrated))
  }

  const load = (jid: string): GroupState | null => {
    const g = sql.group.get(jid) as GroupRow | undefined
    if (!g) return null
    const bills = (sql.bills.all(jid) as BillRow[]).map(
      (b): Bill => ({ id: b.id, name: b.name, key: b.key, paused: b.paused === 1, removed: b.removed === 1 }),
    )
    const months: GroupState['months'] = {}
    for (const p of sql.payments.all(jid) as PaymentRow[]) {
      const pay: Payment = {
        amount: p.amount,
        status: p.amount_status,
        by: p.paid_by,
        paidAt: p.paid_at,
        messageId: p.message_id,
      }
      const month = months[p.month] ?? {}
      month[p.bill_id] = pay
      months[p.month] = month
    }
    const handled = (sql.handled.all(jid) as HandledRow[]).map(h => ({
      id: h.message_id,
      changed: h.changed_state === 1,
      warned: h.warned === 1,
    }))
    return { bills, nextBillId: g.next_bill_id, months, handled, pinnedId: g.pinned_id, lastReset: g.last_reset }
  }

  return {
    load,
    commit: (jid: string, state: GroupState) => tx(() => write(jid, state)),
    meta(jid: string): GroupMeta | null {
      const g = sql.group.get(jid) as GroupRow | undefined
      if (!g) return null
      return {
        invite: g.invite,
        announcedVersion: g.announced_version,
        descriptionMigrated: g.description_migrated === 1,
      }
    },
    setMeta: (jid: string, m: GroupMeta) => writeMeta(jid, m),
    groups: () => (sql.groups.all() as { jid: string }[]).map(r => r.jid),
    importAll: (groups: ImportedGroup[]) =>
      tx(() => {
        for (const g of groups) {
          writeMeta(g.jid, g.meta)
          write(g.jid, g.state)
        }
      }),
    close: () => db.close(),
  }
}

export function openStore(o: StoreOptions): { store: Store; imported: number | null } {
  const tmp = `${o.dbPath}.tmp`
  for (const f of [tmp, `${tmp}-journal`, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true })
  if (existsSync(o.dbPath)) return { store: open(o.dbPath), imported: null }
  if (existsSync(o.v1Path)) {
    const groups = fromV1(JSON.parse(readFileSync(o.v1Path, 'utf8')))
    const db = open(tmp)
    try {
      db.importAll(groups)
    } finally {
      db.close()
    }
    renameSync(tmp, o.dbPath)
    renameSync(o.v1Path, o.v1Path.replace(/(\.json)?$/, '.v1.json'))
    return { store: open(o.dbPath), imported: groups.length }
  }
  if (!o.allowEmpty)
    throw new Error(
      `neither ${o.dbPath} nor ${o.v1Path} exists: refusing to start with an empty history (set ALLOW_EMPTY_STATE=1 on a fresh install)`,
    )
  mkdirSync(dirname(o.dbPath), { recursive: true })
  return { store: open(o.dbPath), imported: null }
}
