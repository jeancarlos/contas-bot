import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fromV1 } from '../../src/adapters/v1.ts'
import { normalize } from '../../src/core/text.ts'

const FIXTURE = new URL('../fixtures/state.v1.json', import.meta.url)
const raw = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const JID = '120363000000000001@g.us'

test('fromV1 imports the real fixture: bills, ids, paused, pinned, handled, meta', () => {
  const groups = fromV1(raw)
  assert.equal(groups.length, 1)
  const [g] = groups
  assert.ok(g)
  assert.equal(g.jid, JID)
  const s = g.state
  assert.deepEqual(
    s.bills.map(b => b.name),
    [
      'Luz',
      'Água',
      'Aluguel',
      'Condomínio',
      'Carro',
      'Academia',
      'Mercado pago',
      'Cartão nu',
      'Algar telefone',
      'Algar internet',
      'HBO',
      'Spotify',
      'Aqua',
    ],
  )
  assert.deepEqual(
    s.bills.map(b => b.id),
    Array.from({ length: 13 }, (_, i) => i + 1),
  )
  assert.equal(s.nextBillId, 14)
  assert.deepEqual(
    s.bills.filter(b => b.paused).map(b => b.name),
    ['Academia'],
  )
  assert.deepEqual(
    s.bills.filter(b => b.removed).map(b => b.name),
    ['Aqua'],
  )
  assert.equal(s.bills.find(b => b.name === 'Cartão nu')?.key, 'cartao nu')
  assert.equal(s.lastReset, '2026-10')
  assert.equal(s.pinnedId, raw.groups[JID]._meta.pinned.id)
  assert.equal(s.handled.length, raw.groups[JID]._meta.handled.length)
  assert.ok(s.handled.every(h => h.changed && !h.warned))
  assert.deepEqual(
    s.handled.map(h => h.id),
    raw.groups[JID]._meta.handled,
  )
  assert.deepEqual(g.meta, {
    invite: null,
    announcedVersion: raw.groups[JID]._meta.announced_version,
    descriptionMigrated: false,
  })
})

test('fromV1 keeps every v1 payment, in cents rounded from the float, under the right bill', () => {
  const [g] = fromV1(raw)
  assert.ok(g)
  const v1Months: Record<
    string,
    Record<string, { name: string; amount: number; by: string; paid_at: string; message_id: string }>
  > = raw.groups[JID].months
  let count = 0
  for (const [month, rows] of Object.entries(v1Months))
    for (const [key, p] of Object.entries(rows)) {
      const bill = g.state.bills.find(b => b.key === normalize(key))
      assert.ok(bill, key)
      const got: unknown = g.state.months[month]?.[bill.id]
      assert.deepEqual(
        got,
        {
          amount: Math.round(p.amount * 100),
          status: 'typed',
          by: p.by,
          paidAt: Date.parse(p.paid_at),
          messageId: p.message_id,
        },
        `${month} ${key}`,
      )
      count++
    }
  const imported = Object.values(g.state.months).reduce((n, m) => n + Object.keys(m).length, 0)
  assert.equal(imported, count)
  const carro = g.state.bills.find(b => b.name === 'Carro')
  assert.ok(carro)
  assert.equal(g.state.months['2026-09']?.[carro.id]?.amount, 216120)
})

test('fromV1 off path: missing amount, no bill list, junk entries, no groups', () => {
  const [g] = fromV1({
    groups: {
      'g@g.us': {
        _meta: { pinned: 'not an object', handled: ['a', 3, 'b'] },
        months: {
          '2026-09': {
            luz: { name: 'Luz', paid_at: 'garbage', amount: null, by: 'Ana', message_id: 'M1' },
            agua: 'not an object',
          },
          junk: { luz: { name: 'Luz', amount: 1 } },
        },
      },
      'bad@g.us': 'not an object',
    },
  })
  assert.ok(g)
  assert.deepEqual(g.state.bills, [{ id: 1, name: 'Luz', key: 'luz', paused: false, removed: false }])
  assert.deepEqual(g.state.months, {
    '2026-09': { 1: { amount: null, status: 'none', by: 'Ana', paidAt: 0, messageId: 'M1' } },
  })
  assert.equal(g.state.pinnedId, null)
  assert.deepEqual(
    g.state.handled.map(h => h.id),
    ['a', 'b'],
  )
  assert.throws(() => fromV1({}), /groups/)
  assert.throws(() => fromV1(null), /groups/)
})

test('fromV1 merges bill lines that normalize to the same key', () => {
  const [g] = fromV1({ groups: { 'g@g.us': { _meta: { bills: ['Água', 'agua (pausado)', 'Luz'] }, months: {} } } })
  assert.deepEqual(
    g?.state.bills.map(b => [b.name, b.paused]),
    [
      ['Água', false],
      ['Luz', false],
    ],
  )
})
