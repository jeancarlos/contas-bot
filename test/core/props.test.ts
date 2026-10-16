import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand } from '../../src/core/commands.ts'
import { decide, listMsg, type Result } from '../../src/core/decide.ts'
import { formatMoney, render } from '../../src/core/i18n.ts'
import { monthOf } from '../../src/core/month.ts'
import { monthTotals } from '../../src/core/report.ts'
import { oldest, resolve } from '../../src/core/resolve.ts'
import type { GroupState, Input } from '../../src/core/types.ts'
import { ctxEn, ctxPt, input, NAMES, OCT, rng, state } from './gen.ts'
import type { Ctx } from '../../src/core/decide.ts'

const SEEDS = 300
const STEPS = 25
const DAY = 86_400_000

const paidBy = (s: GroupState, id: string) =>
  Object.entries(s.months).flatMap(([m, ps]) =>
    Object.entries(ps)
      .filter(([, p]) => p.messageId === id)
      .map(([b]) => `${m}:${b}`),
  )

type Step = { s: GroupState; n: GroupState; inp: Input; res: Result; ctx: Ctx; now: string; where: string }

function paymentsAreSound({ s, n, inp, now, where }: Step) {
  for (const [month, ps] of Object.entries(n.months)) {
    assert.match(month, /^\d{4}-(0[1-9]|1[0-2])$/, where)
    for (const [bid, p] of Object.entries(ps)) {
      assert.ok(
        n.bills.some(b => b.id === Number(bid)),
        `orphan payment ${bid} ${where}`,
      )
      assert.ok(
        p.amount === null || (Number.isSafeInteger(p.amount) && p.amount > 0),
        `bad amount ${p.amount} ${where}`,
      )
      const changed = JSON.stringify(s.months[month]?.[Number(bid)]) !== JSON.stringify(p)
      if ((inp.kind === 'message' || inp.kind === 'edit') && changed)
        assert.ok(month >= oldest(now), `too old ${where}`)
    }
  }
}

function keysAreUnique({ n, now, where }: Step) {
  const keys = n.bills.filter(b => !b.removed).map(b => b.key)
  assert.equal(new Set(keys).size, keys.length, `dup active key ${where}`)
  const recent = Object.entries(n.months).filter(([m]) => m >= oldest(now))
  const reachable = n.bills.filter(b => !b.removed || recent.some(([, ps]) => ps[b.id])).map(b => b.key)
  assert.equal(new Set(reachable).size, reachable.length, `two /despago-reachable bills share a key ${where}`)
}

function chatIsSilent({ s, n, inp, res, where }: Step) {
  if (inp.kind !== 'message' || inp.key.fromMe || parseCommand(inp.text)) return
  const who = inp.key.participant ?? inp.sender
  if (s.asks.some(a => a.who === who && a.q !== 'pick')) return
  assert.deepEqual(res.effects, [], `chat answered ${where}`)
  assert.deepEqual(n.months, s.months, `chat changed months ${where}`)
}

function pagoPaysWhatItNames({ s, n, inp, ctx, where }: Step) {
  if (inp.kind !== 'message' || inp.key.fromMe) return
  const c = parseCommand(inp.text)
  if (c?.cmd !== 'pago') return
  const before = paidBy(s, inp.key.id)
  const fresh = paidBy(n, inp.key.id).filter(x => !before.includes(x))
  const rr = resolve(c.arg, s.bills, monthOf(inp.at, ctx.locale.timeZone), ctx.locale.decimal)
  for (const f of fresh) {
    const bid = Number(f.split(':')[1])
    if (rr.ok) assert.equal(bid, rr.bill.id, `paid other bill ${where}`)
    else assert.ok(n.bills.find(b => b.id === bid)?.removed, `paid non-one-off on unresolved ${where}`)
  }
}

function step(s: GroupState, inp: Input, ctx: Ctx, at: number, where: string): GroupState {
  let res: Result
  try {
    res = decide(s, inp, ctx)
    for (const e of res.effects) if ('msg' in e) render(e.msg, ctx.locale)
  } catch (err) {
    assert.fail(`threw ${err} at ${where}`)
  }
  const now = monthOf('at' in inp ? inp.at : at, ctx.locale.timeZone)
  const st: Step = { s, n: res.state, inp, res, ctx, now, where }
  for (const check of [paymentsAreSound, keysAreUnique, chatIsSilent, pagoPaysWhatItNames]) check(st)
  return res.state
}

for (const ctx of [ctxPt, ctxEn]) {
  test(`random input sequences: decide never throws, renders, keeps invariants (${ctx.locale.lang})`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      let s = state(NAMES.filter(() => r.next() < 0.5))
      const ids: string[] = []
      let at = OCT + r.int(30) * DAY
      for (let i = 0; i < STEPS; i++) {
        at += r.int(3) === 0 ? r.int(40 * DAY) : r.int(15 * 60_000)
        const inp = input(r, ids, s, at)
        s = step(s, inp, ctx, at, `seed ${seed} step ${i} ${JSON.stringify(inp)}`)
      }
    }
  })
}

function randomState(seed: number): GroupState {
  const r = rng(seed)
  const s = state(NAMES.filter(() => r.next() < 0.6))
  for (const b of s.bills) {
    b.paused = r.next() < 0.2
    b.removed = r.next() < 0.15
  }
  for (const month of ['2026-09', '2026-10']) {
    const paid: GroupState['months'][string] = {}
    for (const b of s.bills) {
      const amount = r.next() < 0.3 ? null : r.int(1e9) + 1
      if (r.next() < 0.5) paid[b.id] = { amount, status: 'typed', by: 'x', paidAt: 0, messageId: 'm' }
    }
    s.months[month] = paid
  }
  return s
}

test('random states: report totals equal the rendered list footer', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const s = randomState(seed)
    for (const t of monthTotals(s, ['2026-09', '2026-10'])) {
      for (const ctx of [ctxPt, ctxEn]) {
        const text = render(listMsg(s, t.month), ctx.locale)
        const footer = text.split('\n').at(-1) ?? ''
        assert.ok(footer.includes(formatMoney(t.total, ctx.locale)), `seed ${seed}: ${footer} vs ${t.total}`)
        assert.ok(footer.includes(`${t.paid}/${t.paid + t.unpaid}`), `seed ${seed}: ${footer}`)
        assert.equal(text.split('\n').filter(l => l.startsWith('✅')).length, t.paid)
      }
    }
  }
})
