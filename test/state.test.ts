import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openState } from '../src/state.ts'

const tmp = async () => join(await mkdtemp(join(tmpdir(), 'state-')), 'state.json')

test('groups are stored separately and survive a reopen', async () => {
  const path = await tmp()
  const store = await openState(path)
  store.forGroup('a@g.us').get()._meta.last_reset = '2026-09'
  store.forGroup('b@g.us').get().months['2026-09'] = {}
  await store.forGroup('a@g.us').save()
  const again = await openState(path)
  assert.equal(again.forGroup('a@g.us').get()._meta.last_reset, '2026-09')
  assert.deepEqual(again.forGroup('b@g.us').get().months, { '2026-09': {} })
  assert.deepEqual(again.jids().sort(), ['a@g.us', 'b@g.us'])
})

test('a malformed group entry loads as empty instead of crashing', async () => {
  const path = await tmp()
  await writeFile(path, JSON.stringify({ groups: { 'a@g.us': { _meta: null, months: [] } } }))
  const store = await openState(path)
  assert.deepEqual(store.forGroup('a@g.us').get(), { _meta: {}, months: {} })
})

test('a corrupt month value is dropped; other months load unchanged', async () => {
  const path = await tmp()
  await writeFile(path, JSON.stringify({
    groups: { 'a@g.us': { _meta: {}, months: { '2026-09': [], '2026-08': { luz: { name: 'Luz' } } } } },
  }))
  const store = await openState(path)
  assert.deepEqual(store.forGroup('a@g.us').get().months, { '2026-08': { luz: { name: 'Luz' } } })
})

test('concurrent saves from two groups both land', async () => {
  const path = await tmp()
  const store = await openState(path)
  store.forGroup('a@g.us').get()._meta.last_reset = '2026-09'
  store.forGroup('b@g.us').get()._meta.last_reset = '2026-10'
  await Promise.all([store.forGroup('a@g.us').save(), store.forGroup('b@g.us').save()])
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(onDisk.groups['a@g.us']._meta.last_reset, '2026-09')
  assert.equal(onDisk.groups['b@g.us']._meta.last_reset, '2026-10')
})

test('listed is backfilled from pinned on load', async () => {
  const path = await tmp()
  await writeFile(path, JSON.stringify({ groups: { 'a@g.us': { _meta: { pinned: { id: 'msg1', fromMe: true, remoteJid: 'a@g.us' } }, months: {} } } }))
  const store = await openState(path)
  assert.equal(store.forGroup('a@g.us').get()._meta.listed, true)
})

test('listed remains undefined when pinned is absent', async () => {
  const path = await tmp()
  await writeFile(path, JSON.stringify({ groups: { 'a@g.us': { _meta: { last_reset: '2026-09' }, months: {} } } }))
  const store = await openState(path)
  assert.equal(store.forGroup('a@g.us').get()._meta.listed, undefined)
})

test('a corrupt month is reported through the given logger, not console.warn', async () => {
  const path = await tmp()
  await writeFile(path, JSON.stringify({
    groups: { 'a@g.us': { _meta: {}, months: { '2026-09': [] } } },
  }))
  const warnings: unknown[] = []
  await openState(path, { warn: (o: unknown) => warnings.push(o) })
  assert.equal(warnings.length, 1)
})
