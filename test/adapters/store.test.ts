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
      1: { amount: 25959, status: 'typed', by: 'Ana', paidAt: 1790000000000, messageId: 'M1' },
      4: { amount: null, status: 'none', by: 'Beto', paidAt: 1790000000001, messageId: 'M2' },
    },
    '2026-10': { 1: { amount: null, status: 'pending', by: 'Ana', paidAt: 1792000000000, messageId: 'M3' } },
  },
  handled: [
    { id: 'C', changed: true, warned: true },
    { id: 'A', changed: false, warned: false },
    { id: 'B', changed: true, warned: false },
  ],
  pinnedId: 'P1',
  lastReset: '2026-10',
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
    months: { '2026-10': { 99: { amount: 1, status: 'typed', by: 'Ana', paidAt: 1, messageId: 'X' } } },
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
  assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1)
  db.close()
})

test('a fractional amount is rejected and leaves the previous state', () => {
  const { store } = fresh()
  store.commit(JID, STATE)
  const bad: GroupState = {
    ...STATE,
    months: { '2026-10': { 1: { amount: 2161.2, status: 'typed', by: 'Ana', paidAt: 1, messageId: 'X' } } },
  }
  assert.throws(() => store.commit(JID, bad))
  assert.deepEqual(store.load(JID), STATE)
})
