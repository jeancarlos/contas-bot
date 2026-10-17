import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeLocale, render } from '../../src/core/i18n.ts'
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
    { k: 'unknownSub', typed: 'x', suggestion: 'pause' },
    { k: 'updated' },
    { k: 'askAmount', bill: 'Luz', read: true },
    { k: 'askAmount', bill: 'Luz', read: false },
    { k: 'askConfirm', cmd: 'pago', bill: 'Luz', amount: 8000, month: null },
    { k: 'askBill', names: ['Luz', 'Água'] },
    { k: 'askOneOff', name: 'Farmácia' },
    { k: 'editIgnored', payment: true },
    { k: 'editIgnored', payment: false },
    { k: 'nameTaken', name: 'Luz' },
    { k: 'nameInvalid' },
    { k: 'intro' },
    { k: 'saveFailed' },
    { k: 'descriptionNotice' },
    { k: 'descLine' },
    { k: 'moreChanges', n: 2 },
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

test('an edit of a bill command is answered without the /despago hint', () => {
  assert.match(render({ k: 'editIgnored', payment: true }, loc('pt-BR')), /\/despago/)
  for (const lang of ['pt-BR', 'en', 'es'] as const)
    assert.doesNotMatch(render({ k: 'editIgnored', payment: false }, loc(lang)), /despag|unpaid/)
})

test('the description line points at the bill commands in the group language', () => {
  assert.equal(render({ k: 'descLine' }, loc('pt-BR')), '📋 contas: /conta · /lista · /ajuda')
  assert.equal(render({ k: 'descLine' }, loc('en')), '📋 bills: /bill · /list · /help')
  assert.equal(render({ k: 'descLine' }, loc('es')), '📋 cuentas: /cuenta · /lista · /ayuda')
})

test('the intro teaches /conta adiciona and never mentions the description', () => {
  assert.match(render({ k: 'intro' }, loc('pt-BR')), /\/conta adiciona/)
  assert.match(render({ k: 'intro' }, loc('en')), /\/bill add/)
  assert.match(render({ k: 'intro' }, loc('es')), /\/cuenta agrega/)
  for (const lang of ['pt-BR', 'en', 'es'] as const) assert.doesNotMatch(render({ k: 'intro' }, loc(lang)), /descri/)
})

test('makeLocale reads language, currency and time zone, falling back to Sao Paulo', () => {
  assert.deepEqual(makeLocale('en', 'usd', 'Europe/Lisbon'), {
    lang: 'en',
    currency: 'USD',
    decimal: '.',
    timeZone: 'Europe/Lisbon',
  })
  assert.equal(makeLocale('pt-BR', 'BRL', '').timeZone, 'America/Sao_Paulo')
  assert.equal(makeLocale('es', 'EUR', 'Not/AZone').timeZone, 'America/Sao_Paulo')
  assert.equal(makeLocale('es', 'EUR', '').decimal, ',')
  assert.throws(() => makeLocale('fr', 'EUR', ''), /BOT_LANG/)
  assert.throws(() => makeLocale('pt-BR', 'R$', ''), /BOT_CURRENCY/)
})

test('the amount question claims a failed read only when the AI tried one', () => {
  assert.equal(
    render({ k: 'askAmount', bill: 'Luz', read: false }, loc('pt-BR')),
    'qual foi o valor de Luz? Responda só o valor, ex: 80,00',
  )
  assert.match(render({ k: 'askAmount', bill: 'Luz', read: true }, loc('pt-BR')), /não consegui ler/)
  assert.doesNotMatch(render({ k: 'askAmount', bill: 'Power', read: false }, loc('en', 'USD', '.')), /read/)
  assert.match(render({ k: 'askAmount', bill: 'Power', read: false }, loc('en', 'USD', '.')), /80\.00/)
  assert.doesNotMatch(render({ k: 'askAmount', bill: 'Luz', read: false }, loc('es')), /leer/)
})

test('help names the despago aliases in every language', () => {
  assert.match(render({ k: 'help' }, loc('pt-BR')), /\/despago .*\/reverter/)
  assert.match(render({ k: 'help' }, loc('en')), /\/unpaid .*\/revert\b/)
  assert.match(render({ k: 'help' }, loc('es')), /\/despagado .*\/revertir/)
})
