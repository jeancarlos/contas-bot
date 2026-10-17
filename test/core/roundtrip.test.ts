import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand } from '../../src/core/commands.ts'
import { type Ctx, decide } from '../../src/core/decide.ts'
import { render } from '../../src/core/i18n.ts'
import { resolve } from '../../src/core/resolve.ts'
import type { Bill, Msg } from '../../src/core/types.ts'
import { ctxEn, ctxPt, NAMES, OCT, rng, state, text } from './gen.ts'

const SEEDS = 2000
type Offer = Extract<Msg, { k: 'suggest' | 'askConfirm' }>
const isOffer = (m: Msg): m is Offer => m.k === 'suggest' || m.k === 'askConfirm'

function mismatch(m: Offer, bills: readonly Bill[], ctx: Ctx): string | null {
  const code = /`([^`]*)`/.exec(render(m, ctx.locale))?.[1] ?? ''
  const c = parseCommand(code)
  const rr = c && 'arg' in c ? resolve(c.arg, bills, '2026-10', ctx.locale.decimal) : null
  const ok = rr?.ok && rr.bill.name === m.bill && rr.amount === m.amount && rr.month === m.month
  return ok ? null : `${code} -> ${JSON.stringify(rr)}`
}

test('every copy-ready suggestion resolves to the same bill, amount and month', () => {
  const bad: string[] = []
  for (const ctx of [ctxPt, ctxEn]) {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed)
      const s = state(NAMES.filter(() => r.next() < 0.5))
      const t = `/pago ${text(r)}`
      const key = { id: 'x', fromMe: false, remoteJid: 'g', participant: 'p' }
      const res = decide(s, { kind: 'message', key, sender: 'p', text: t, at: OCT }, ctx)
      for (const e of res.effects) {
        const wrong = 'msg' in e && isOffer(e.msg) ? mismatch(e.msg, s.bills, ctx) : null
        if (wrong) bad.push(`${ctx.locale.lang} ${t}: ${wrong} bills=${s.bills.map(b => b.name)}`)
      }
    }
  }
  assert.deepEqual(bad.slice(0, 15), [])
})
