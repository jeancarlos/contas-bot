import assert from 'node:assert/strict'
import { test } from 'node:test'
import { render } from '../../src/core/i18n.ts'
import type { Lang, Locale, Msg } from '../../src/core/types.ts'

const loc = (lang: Lang, currency = 'BRL', decimal: ',' | '.' = ','): Locale => ({
  lang,
  currency,
  decimal,
  timeZone: 'UTC',
})

test('the month list renders paid, pending and paused bills with the total', () => {
  const msg: Msg = {
    k: 'list',
    month: '2026-09',
    items: [
      { name: 'Luz', paused: false, paid: true, amount: 8010 },
      { name: 'Água', paused: false, paid: true, amount: null },
      { name: 'Internet', paused: false, paid: false, amount: null },
      { name: 'Academia', paused: true, paid: false, amount: null },
    ],
  }
  assert.equal(
    render(msg, loc('pt-BR')),
    [
      '📋 *Contas — Setembro/2026*',
      '',
      '✅ Luz — R$ 80,10',
      '✅ Água',
      '⬜ Internet',
      '⏸️ Academia',
      '',
      '*Pago:* 2/3 · *Total:* R$ 80,10 (1 sem valor)',
    ].join('\n'),
  )
})

test('a suggestion is a copy-ready command in the group language', () => {
  const msg: Msg = { k: 'suggest', cmd: 'pago', bill: 'Luz', amount: 8000, month: '2026-09' }
  assert.equal(render(msg, loc('pt-BR')), 'você quis dizer `/pago luz 80,00 09/2026`?')
  assert.equal(render(msg, loc('en', 'USD', '.')), 'did you mean `/paid luz 80.00 09/2026`?')
  assert.equal(render(msg, loc('es', 'EUR')), '¿quisiste decir `/pagado luz 80,00 09/2026`?')
})

test('every message kind renders in every language', () => {
  const all: Msg[] = [
    { k: 'list', month: '2026-10', items: [] },
    { k: 'bills', bills: [{ name: 'Luz', paused: true }] },
    { k: 'help' },
    { k: 'contaHelp' },
    { k: 'suggest', cmd: 'despago', bill: 'Luz', amount: null, month: null },
    { k: 'notFound', q: 'x', names: ['Luz'] },
    { k: 'missingBill', cmd: 'pago' },
    { k: 'onePerCommand', cmd: 'pago', bills: ['Luz', 'Água'] },
    { k: 'pagoSyntax' },
    { k: 'futureMonth' },
    { k: 'unknownCmd', typed: 'x', suggestion: null },
    { k: 'unknownSub', typed: 'x', suggestion: 'pausa' },
    { k: 'updated' },
    { k: 'askAmount', bill: 'Luz' },
    { k: 'askConfirm', cmd: 'pago', bill: 'Luz', amount: 8000, month: null },
    { k: 'askBill', names: ['Luz', 'Água'] },
    { k: 'askOneOff', name: 'Farmácia' },
    { k: 'noAmount' },
    { k: 'editIgnored' },
    { k: 'nameTaken', name: 'Luz' },
    { k: 'nameInvalid' },
  ]
  for (const lang of ['pt-BR', 'en', 'es'] as const) {
    for (const m of all) assert.ok(render(m, loc(lang)).length > 0, `${lang} ${m.k}`)
  }
})
test('onePerCommand names the command of the failed message', () => {
  const m: Msg = { k: 'onePerCommand', cmd: 'despago', bills: ['Luz', 'Água'] }
  assert.match(render(m, loc('pt-BR')), /\/despago luz/)
  assert.match(render(m, loc('en')), /\/unpaid luz/)
  assert.match(render(m, loc('es')), /\/despagado luz/)
})
