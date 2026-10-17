// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../../src/adapters/store.ts'
import { fromV1 } from '../../src/adapters/v1.ts'
import type { GroupState } from '../../src/core/types.ts'

const FIXTURE = new URL('../fixtures/state.v1.json', import.meta.url)
const JID = '120363000000000001@g.us'

function dir() {
  const d = mkdtempSync(join(tmpdir(), 'store-'))
  return { d, dbPath: join(d, 'contas.db'), v1Path: join(d, 'state.json') }
}

const STATE: GroupState = {
  bills: [
    { id: 1, name: 'Luz', key: 'luz', paused: false, removed: false },
    { id: 2, name: 'Academia', key: 'academia', paused: true, removed: false },
    { id: 4, name: 'Aqua', key: 'aqua', paused: false, removed: true },
  ],
  nextBillId: 5,
  months: {
    '2026-09': {
      1: {
        amount: 25959,
        status: 'typed',
        by: 'Ana',
        paidAt: 1790000000000,
        messageId: 'M1',
        byJid: 'ana@s.whatsapp.net',
      },
      4: { amount: null, status: 'none', by: 'Beto', paidAt: 1790000000001, messageId: 'M2', byJid: null },
    },
    '2026-10': {
      1: { amount: null, status: 'pending', by: 'Ana', paidAt: 1792000000000, messageId: 'M3', byJid: null },
    },
  },
  handled: [
    { id: 'C', changed: true, warned: true },
    { id: 'A', changed: false, warned: false },
    { id: 'B', changed: true, warned: false },
  ],
  pinnedId: 'P1',
  lastReset: '2026-10',
  asks: [],
}

function fresh() {
  const p = dir()
  return { ...p, store: openStore({ ...p, allowEmpty: true }).store }
}

test('commit then load returns the same state, handled order kept', () => {
  const { store } = fresh()
  assert.equal(store.load(JID), null)
  store.commit(JID, STATE)
  assert.deepEqual(store.load(JID), STATE)
  assert.deepEqual(store.groups(), [JID])
})

test('a later commit replaces rows: a removed payment is gone, a new bill appears', () => {
  const { store } = fresh()
  store.commit(JID, STATE)
  const next: GroupState = {
    ...STATE,
    bills: [...STATE.bills, { id: 5, name: 'Gás', key: 'gas', paused: false, removed: false }],
    nextBillId: 6,
    months: { '2026-09': STATE.months['2026-09'] ?? {} },
    pinnedId: null,
  }
  store.commit(JID, next)
  assert.deepEqual(store.load(JID), next)
})

test('a failed commit rolls back and leaves the previous state', () => {
  const { store } = fresh()
  store.commit(JID, STATE)
  const broken: GroupState = {
    ...STATE,
    bills: [],
    months: { '2026-10': { 99: { amount: 1, status: 'typed', by: 'Ana', paidAt: 1, messageId: 'X', byJid: null } } },
  }
  assert.throws(() => store.commit(JID, broken))
  assert.deepEqual(store.load(JID), STATE)
  store.commit(JID, { ...STATE, lastReset: '2026-11' })
  assert.equal(store.load(JID)?.lastReset, '2026-11')
})

test('group meta is kept apart from commits', () => {
  const { store } = fresh()
  assert.equal(store.meta(JID), null)
  store.setMeta(JID, { invite: 'ABC', announcedVersion: '2.0.0', descriptionMigrated: false })
  store.commit(JID, STATE)
  store.setMeta(JID, { invite: 'ABC', announcedVersion: '2.0.0', descriptionMigrated: true })
  store.commit(JID, STATE)
  assert.deepEqual(store.meta(JID), { invite: 'ABC', announcedVersion: '2.0.0', descriptionMigrated: true })
  assert.deepEqual(store.load(JID), STATE)
})

test('first start with state.json imports it, renames it and survives a reopen', () => {
  const p = dir()
  copyFileSync(FIXTURE, p.v1Path)
  const want = fromV1(JSON.parse(readFileSync(FIXTURE, 'utf8')))[0]
  assert.ok(want)
  const first = openStore({ ...p, allowEmpty: false })
  assert.equal(first.imported, 1)
  assert.deepEqual(first.store.load(JID), want.state)
  assert.deepEqual(first.store.meta(JID), want.meta)
  first.store.close()
  assert.ok(existsSync(p.dbPath))
  assert.ok(!existsSync(p.v1Path))
  assert.ok(existsSync(join(p.d, 'state.v1.json')))
  assert.ok(!existsSync(`${p.dbPath}.tmp`))
  const again = openStore({ ...p, allowEmpty: false })
  assert.equal(again.imported, null)
  assert.deepEqual(again.store.load(JID), want.state)
})

test('a leftover .tmp and its journal from a crashed import are discarded and the import runs again', () => {
  const p = dir()
  copyFileSync(FIXTURE, p.v1Path)
  writeFileSync(`${p.dbPath}.tmp`, 'half-written garbage')
  writeFileSync(`${p.dbPath}.tmp-journal`, 'stale journal')
  const { store, imported } = openStore({ ...p, allowEmpty: false })
  assert.equal(imported, 1)
  assert.equal(store.load(JID)?.bills.length, 13)
  assert.ok(!existsSync(`${p.dbPath}.tmp-journal`))
})

test('an unreadable state.json fails loudly and touches nothing', () => {
  const p = dir()
  writeFileSync(p.v1Path, '{"groups": {')
  assert.throws(() => openStore({ ...p, allowEmpty: true }), SyntaxError)
  assert.ok(existsSync(p.v1Path))
  assert.ok(!existsSync(p.dbPath))
  assert.ok(!existsSync(`${p.dbPath}.tmp`))
})

test('no database and no state.json refuses to start unless ALLOW_EMPTY_STATE', () => {
  const p = dir()
  assert.throws(() => openStore({ ...p, allowEmpty: false }), /ALLOW_EMPTY_STATE=1/)
  assert.ok(!existsSync(p.dbPath))
  const nested = join(p.d, 'data', 'contas.db')
  const { store, imported } = openStore({ dbPath: nested, v1Path: join(p.d, 'data', 'state.json'), allowEmpty: true })
  assert.equal(imported, null)
  assert.deepEqual(store.groups(), [])
  assert.ok(existsSync(nested))
})

test('an existing database wins over a state.json next to it', () => {
  const p = dir()
  const first = openStore({ ...p, allowEmpty: true })
  first.store.commit(JID, STATE)
  first.store.close()
  copyFileSync(FIXTURE, p.v1Path)
  const { store, imported } = openStore({ ...p, allowEmpty: false })
  assert.equal(imported, null)
  assert.deepEqual(store.load(JID), STATE)
  assert.ok(existsSync(p.v1Path))
})

test('a valid leftover .tmp survives a start that has nothing to import', () => {
  const src = fresh()
  src.store.commit(JID, STATE)
  src.store.close()
  const p = dir()
  copyFileSync(src.dbPath, `${p.dbPath}.tmp`)
  openStore({ ...p, allowEmpty: true }).store.close()
  assert.ok(existsSync(`${p.dbPath}.tmp`))
})

test('the schema is versioned', () => {
  const { store, dbPath } = fresh()
  store.close()
  const db = new DatabaseSync(dbPath)
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2)
  db.close()
})

const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const schema = (db: DatabaseSync) => db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()

test('a schema 1 database gains the payer id column once, its rows read as null, and new ids round-trip', () => {
  const { store, dbPath, ...p } = fresh()
  store.commit(JID, STATE)
  store.close()
  const old = new DatabaseSync(dbPath)
  old.exec('ALTER TABLE payments DROP COLUMN paid_by_jid')
  old.exec('PRAGMA user_version = 1')
  old.close()
  const migrated = openStore({ ...p, dbPath, allowEmpty: false }).store
  const legacy = migrated.load(JID)
  assert.deepEqual(legacy?.months['2026-09']?.[1]?.byJid, null)
  const withJid = structuredClone(STATE)
  migrated.commit(JID, withJid)
  migrated.close()
  const again = openStore({ ...p, dbPath, allowEmpty: false }).store
  assert.deepEqual(again.load(JID), withJid)
  again.close()
  const db = new DatabaseSync(dbPath)
  assert.equal(version(db), 2)
  const cols = (db.prepare('PRAGMA table_info(payments)').all() as { name: string }[]).map(c => c.name)
  assert.equal(cols.filter(c => c === 'paid_by_jid').length, 1)
  db.close()
})

test('a schema 2 database opens untouched', () => {
  const { store, dbPath, ...p } = fresh()
  store.commit(JID, STATE)
  store.close()
  const before = new DatabaseSync(dbPath)
  const shape = schema(before)
  before.close()
  const reopened = openStore({ ...p, dbPath, allowEmpty: false }).store
  assert.deepEqual(reopened.load(JID), STATE)
  reopened.close()
  const after = new DatabaseSync(dbPath)
  assert.deepEqual(schema(after), shape)
  assert.equal(version(after), 2)
  after.close()
})

test('a fractional amount is rejected and leaves the previous state', () => {
  const { store } = fresh()
  store.commit(JID, STATE)
  const bad: GroupState = {
    ...STATE,
    months: {
      '2026-10': { 1: { amount: 2161.2, status: 'typed', by: 'Ana', paidAt: 1, messageId: 'X', byJid: null } },
    },
  }
  assert.throws(() => store.commit(JID, bad))
  assert.deepEqual(store.load(JID), STATE)
})

test('a database from a newer schema is refused and left as it was; an unversioned one is stamped', () => {
  const p = dir()
  const db = new DatabaseSync(p.dbPath)
  db.exec('PRAGMA user_version = 3')
  db.close()
  assert.throws(() => openStore({ ...p, allowEmpty: false }), /schema 3/)
  const after = new DatabaseSync(p.dbPath)
  assert.equal(version(after), 3)
  assert.equal(after.prepare("SELECT name FROM sqlite_master WHERE name = 'groups'").get(), undefined)
  after.close()
  const q = dir()
  new DatabaseSync(q.dbPath).close()
  openStore({ ...q, allowEmpty: false }).store.close()
  const stamped = new DatabaseSync(q.dbPath)
  assert.equal(version(stamped), 2)
  stamped.close()
})

test('a v1 amount too large to keep in cents imports as no amount and the group stays loadable', () => {
  const p = dir()
  const row = (amount: unknown) => ({
    name: 'Luz',
    amount,
    by: 'Ana',
    paid_at: '2026-10-01T00:00:00Z',
    message_id: 'M',
  })
  writeFileSync(
    p.v1Path,
    JSON.stringify({
      groups: {
        [JID]: { _meta: { bills: ['Luz'], last_reset: '2026-10' }, months: { '2026-10': { luz: row(1e14) } } },
      },
    }),
  )
  const { store, imported } = openStore({ ...p, allowEmpty: false })
  assert.equal(imported, 1)
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, null)
})

test('the import warns through the store log about corrupt months it drops', () => {
  const p = dir()
  writeFileSync(
    p.v1Path,
    JSON.stringify({ groups: { [JID]: { _meta: { bills: ['Luz'] }, months: { '2026-09': 1 } } } }),
  )
  const warnings: object[] = []
  const { imported } = openStore({ ...p, allowEmpty: false, log: { warn: o => warnings.push(o) } })
  assert.equal(imported, 1)
  assert.deepEqual(warnings, [{ jid: JID, month: '2026-09' }])
})
