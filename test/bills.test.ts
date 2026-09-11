import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalize, parseDescription, resolveBill, parseAmount, formatMoney,
  monthKey, monthTitle, renderList, parseCommand, matchPlainText,
  DEMO_BILLS, splitDescription, renderSection, composeDescription, isGreeting,
  type Bill, type Payment,
} from '../src/bills.ts'
import { makeLocale } from '../src/i18n.ts'

const desc = `# Contas do mês
Luz
Água
Aluguel
Condomínio
Carro
Mãe Carme (pausado)
Mercado Pago
Cartão Nu

HBO
Spotify`

test('normalize strips accents, case, punctuation and extra spaces', () => {
  assert.equal(normalize('  Cartão   Nu! '), 'cartao nu')
  assert.equal(normalize('Mãe Carme'), 'mae carme')
})

test('parseDescription skips comments and blanks, flags paused', () => {
  const bills = parseDescription(desc)
  assert.equal(bills.length, 10)
  assert.deepEqual(bills[0], { name: 'Luz', key: 'luz', paused: false })
  assert.deepEqual(bills[5], { name: 'Mãe Carme', key: 'mae carme', paused: true })
  assert.equal(bills[7].key, 'cartao nu')
})

test('resolveBill: exact, prefix, ambiguous, unknown', () => {
  const bills = parseDescription(desc)
  assert.equal(resolveBill(bills, 'cartao nu')?.name, 'Cartão Nu')
  assert.equal(resolveBill(bills, 'CARTÃO NU')?.name, 'Cartão Nu')
  assert.equal(resolveBill(bills, 'cond')?.name, 'Condomínio')
  assert.equal(resolveBill(bills, 'a'), null) // Água, Aluguel
  assert.equal(resolveBill(bills, 'netflix'), null)
  assert.equal(resolveBill([bills[0]], '!'), null) // an empty query is not a prefix of everything
})

test('parseAmount accepts BR and dot formats', () => {
  assert.equal(parseAmount('231,45'), 231.45)
  assert.equal(parseAmount('R$ 6.237,60'), 6237.6)
  assert.equal(parseAmount('6237.6'), 6237.6)
  assert.equal(parseAmount('1.234'), 1234)
  assert.equal(parseAmount('abc'), null)
})

test('formatMoney', () => {
  assert.equal(formatMoney(6237.6), 'R$ 6.237,60')
  assert.equal(formatMoney(231.45), 'R$ 231,45')
  assert.equal(formatMoney(1234567.5), 'R$ 1.234.567,50')
})

test('monthKey uses America/Sao_Paulo', () => {
  // 2026-10-01T02:30Z is still 2026-09-30 23:30 in São Paulo (UTC-3)
  assert.equal(monthKey(new Date('2026-10-01T02:30:00Z')), '2026-09')
  assert.equal(monthKey(new Date('2026-10-01T03:30:00Z')), '2026-10')
})

test('monthTitle', () => {
  assert.equal(monthTitle('2026-09'), 'Setembro/2026')
  assert.equal(monthTitle('2027-01'), 'Janeiro/2027')
})

test('renderList: paid first, pending, paused, total with missing amounts', () => {
  const bills = parseDescription(desc)
  const paid: Record<string, Payment> = {
    luz: { name: 'Luz', paid_at: 'x', amount: 231.45, by: 'Gabi', message_id: '1' },
    'cartao nu': { name: 'Cartão Nu', paid_at: 'x', amount: 6237.6, by: 'Jean', message_id: '2' },
    aluguel: { name: 'Aluguel', paid_at: 'x', amount: null, by: 'Gabi', message_id: '3' },
  }
  const out = renderList('2026-09', bills, paid)
  assert.equal(out, [
    '📋 *Contas — Setembro/2026*',
    '',
    '✅ Luz — R$ 231,45',
    '✅ Aluguel',
    '✅ Cartão Nu — R$ 6.237,60',
    '⬜ Água',
    '⬜ Condomínio',
    '⬜ Carro',
    '⬜ Mercado Pago',
    '⬜ HBO',
    '⬜ Spotify',
    '⏸️ Mãe Carme',
    '',
    '*Pago:* 3/9 · *Total:* R$ 6.469,05 (1 sem valor)',
  ].join('\n'))
})

test('renderList without missing amounts has no footnote', () => {
  const bills: Bill[] = [{ name: 'Luz', key: 'luz', paused: false }]
  const paid = { luz: { name: 'Luz', paid_at: 'x', amount: 10, by: 'J', message_id: '1' } }
  assert.match(renderList('2026-09', bills, paid), /\*Pago:\* 1\/1 · \*Total:\* R\$ 10,00$/)
})

test('parseCommand', () => {
  assert.deepEqual(parseCommand('/pago luz'), { cmd: 'pago', name: 'luz', amount: null })
  assert.deepEqual(parseCommand('/pago cartão nu R$ 6.237,60'), { cmd: 'pago', name: 'cartão nu', amount: 6237.6 })
  assert.deepEqual(parseCommand('/pago luz 231,45'), { cmd: 'pago', name: 'luz', amount: 231.45 })
  assert.deepEqual(parseCommand('/despago Luz'), { cmd: 'despago', name: 'Luz' })
  assert.deepEqual(parseCommand('/lista'), { cmd: 'lista' })
  assert.deepEqual(parseCommand('/ajuda'), { cmd: 'ajuda' })
  assert.deepEqual(parseCommand('/foo'), { cmd: 'unknown', raw: '/foo' })
  assert.equal(parseCommand('oi'), null)
})

test('matchPlainText', () => {
  const bills = parseDescription(desc)
  assert.equal(matchPlainText(bills, 'luz')?.name, 'Luz')
  assert.equal(matchPlainText(bills, 'pago luz')?.name, 'Luz')
  assert.equal(matchPlainText(bills, 'Paguei a luz')?.name, 'Luz')
  assert.equal(matchPlainText(bills, 'pago agua')?.name, 'Água') // the article is a whole word, not the bill's first letter
  assert.equal(matchPlainText(bills, 'paguei aluguel')?.name, 'Aluguel')
  assert.equal(matchPlainText(bills, 'paguei a luz e a água'), null)
  assert.equal(matchPlainText(bills, 'bom dia'), null)
})

test('parseDescription takes the group description as people actually write it', () => {
  const bills = parseDescription('Conta:\nLuz\nMãe Carme - pausado\nHBO pausada\nSpotify')
  assert.deepEqual(bills.map(b => [b.name, b.paused]), [
    ['Luz', false], ['Mãe Carme', true], ['HBO', true], ['Spotify', false],
  ])
  assert.equal(parseDescription('Luz\nLUZ').length, 1)
})

test('parseDescription stops at a divider so the description can carry help text', () => {
  const bills = parseDescription('Contas:\nLuz\n/pago luz 10\nÁgua\n───────\nBot das contas\nMande o comprovante')
  assert.deepEqual(bills.map(b => b.name), ['Luz', 'Água'])
})

test('splitDescription finds the bot section by its marker', () => {
  assert.deepEqual(splitDescription('Casa\nLuz'), { original: 'Casa\nLuz', section: null })
  const d = 'Grupo da casa\n\n──── 🤖 contas-bot ────\nContas (edite esta lista):\nLuz'
  assert.deepEqual(splitDescription(d), { original: 'Grupo da casa\n', section: 'Contas (edite esta lista):\nLuz' })
  assert.equal(splitDescription('-- 🤖 contas-bot --\nLuz').section, 'Luz') // retyped dashes still match
  // prose that merely mentions the bot is not the header
  assert.equal(splitDescription('Este grupo usa o 🤖 contas-bot\nLuz').section, null)
})

test('renderSection is the canonical text and parses back to the same bills', () => {
  const bills = parseDescription(DEMO_BILLS)
  assert.equal(renderSection(bills), [
    '──── 🤖 contas-bot ────',
    'Contas (edite esta lista):',
    'Luz', 'Água', 'Internet', 'Aluguel', 'Academia (pausado)',
    '──────────────',
    '/pago <conta> [valor] · /lista · /help',
  ].join('\n'))
  assert.deepEqual(parseDescription(splitDescription(renderSection(bills)).section!), bills)
})

test('composeDescription keeps the original text above and is idempotent', () => {
  const bills = parseDescription('Luz\nÁgua')
  const once = composeDescription('Grupo da casa 🏠  \n', bills)!
  assert.ok(once.startsWith('Grupo da casa 🏠\n\n──── 🤖 contas-bot ────\n'))
  const { original, section } = splitDescription(once)
  assert.equal(composeDescription(original, parseDescription(section!)), once)
  assert.ok(composeDescription('', bills)!.startsWith('──── 🤖 contas-bot ────'))
})

test('composeDescription drops the help line first when over 2048 characters', () => {
  const bills = parseDescription('Luz\nÁgua')
  const long = 'x'.repeat(2048 - renderSection(bills).length)
  const d = composeDescription(long, bills)!
  assert.ok(d.length <= 2048)
  assert.ok(!d.includes('/help'))
  assert.deepEqual(parseDescription(splitDescription(d).section!), bills)
})

test('composeDescription returns null instead of cutting the group text or the list', () => {
  const bills = parseDescription('Luz\nÁgua')
  for (const original of ['y'.repeat(2100), 'a'.repeat(1990) + '\n' + 'b'.repeat(100)]) {
    assert.equal(composeDescription(original, bills), null)
  }
})

test('parseDescription strips list markers and needs a separator before pausado', () => {
  const bills = parseDescription('- Luz\n1. Água\n• Gás\n2) Aluguel\nDespausado\nHBO - pausado')
  assert.deepEqual(bills.map(b => [b.name, b.paused]), [
    ['Luz', false], ['Água', false], ['Gás', false], ['Aluguel', false], ['Despausado', false], ['HBO', true],
  ])
})

test('parseAmount rejects zero', () => {
  assert.equal(parseAmount('0'), null)
  assert.equal(parseAmount('0,00'), null)
})

test('isGreeting needs a greeting that names the bot, in four words or fewer', () => {
  for (const t of ['oi bot', 'Olá contas-bot', 'bom dia bot', 'e aí bot!']) assert.equal(isGreeting(t), true, t)
  for (const t of ['oi', 'oi amor', 'o bot pagou a luz ontem de manhã', 'bot']) assert.equal(isGreeting(t), false, t)
})

test('/help and /ajuda are the same command', () => {
  assert.deepEqual(parseCommand('/help'), { cmd: 'ajuda' })
  assert.deepEqual(parseCommand('/AJUDA'), { cmd: 'ajuda' })
})

const EN = makeLocale('en', 'USD')
const ES = makeLocale('es', 'EUR')

test('formatMoney follows the locale and never emits no-break spaces', () => {
  assert.equal(formatMoney(6237.6), 'R$ 6.237,60')
  assert.equal(formatMoney(6237.6, EN), '$6,237.60')
  assert.equal(formatMoney(6237.6, ES), '6237,60 €')
  for (const s of [formatMoney(1, EN), formatMoney(1), formatMoney(1234.5, ES)]) assert.ok(!/[\u00a0\u202f]/.test(s), s)
})

test('monthTitle in every language', () => {
  assert.equal(monthTitle('2026-09'), 'Setembro/2026')
  assert.equal(monthTitle('2026-09', EN), 'September/2026')
  assert.equal(monthTitle('2026-09', ES), 'Septiembre/2026')
})

test('parseAmount is currency-agnostic and uses the locale only for ambiguity', () => {
  const cases: [string, number | null, number | null][] = [
    // input, pt-BR, en
    ['231,45', 231.45, 231.45],
    ['231.45', 231.45, 231.45],
    ['R$ 6.237,60', 6237.6, 6237.6],
    ['$6,237.60', 6237.6, 6237.6],
    ['6.237,60 €', 6237.6, 6237.6],
    ['USD 10', 10, 10],
    ['1.234', 1234, 1.234],
    ['1,234', 1.234, 1234],
    ['1.234.567', 1234567, 1234567],
    ['abc', null, null],
    ['0', null, null],
    ['.5', null, null],
    ['-10', null, null],
  ]
  for (const [s, pt, en] of cases) {
    assert.equal(parseAmount(s), pt, `pt ${s}`)
    assert.equal(parseAmount(s, EN), en, `en ${s}`)
  }
})

test('commands in every language map to the same actions', () => {
  for (const c of ['/pago luz 10', '/paid luz 10', '/pagado luz 10']) assert.deepEqual(parseCommand(c), { cmd: 'pago', name: 'luz', amount: 10 }, c)
  for (const c of ['/despago luz', '/despagado luz', '/unpaid luz', '/reverter luz', '/revert luz', '/revertir luz']) assert.deepEqual(parseCommand(c), { cmd: 'despago', name: 'luz' }, c)
  for (const c of ['/lista', '/list']) assert.deepEqual(parseCommand(c), { cmd: 'lista' }, c)
  for (const c of ['/ajuda', '/help', '/ayuda']) assert.deepEqual(parseCommand(c), { cmd: 'ajuda' }, c)
  assert.deepEqual(parseCommand('/paid water $80.10', EN), { cmd: 'pago', name: 'water', amount: 80.1 })
  assert.deepEqual(parseCommand('/pagado luz 80 €', ES), { cmd: 'pago', name: 'luz', amount: 80 })
})

test('parseCommand keeps the full multi-word bill name and only swallows currency tokens', () => {
  assert.deepEqual(parseCommand('/pago cartão nu 500'), { cmd: 'pago', name: 'cartão nu', amount: 500 })
  assert.deepEqual(parseCommand('/pago conta de luz 150'), { cmd: 'pago', name: 'conta de luz', amount: 150 })
  // "101" here is the bill's own name, not an amount: no currency token follows it, so nothing parses as money.
  assert.deepEqual(parseCommand('/pago apto 101 luz'), { cmd: 'pago', name: 'apto 101 luz', amount: null })
  assert.deepEqual(parseCommand('/pago luz r$ 10'), { cmd: 'pago', name: 'luz', amount: 10 })
  assert.deepEqual(parseCommand('/paid water USD 80'), { cmd: 'pago', name: 'water', amount: 80 })
})

test('plain-text payments, pause tags and greetings in every language', () => {
  const bills = parseDescription('Luz\nWater\nAgua\nHBO (paused)\nNetflix - pausada\nDespausado')
  assert.deepEqual(bills.map(b => [b.name, b.paused]), [['Luz', false], ['Water', false], ['Agua', false], ['HBO', true], ['Netflix', true], ['Despausado', false]])
  assert.equal(matchPlainText(bills, 'paid the water')?.name, 'Water')
  assert.equal(matchPlainText(bills, 'pagué la luz')?.name, 'Luz')
  assert.equal(matchPlainText(bills, 'pagado agua')?.name, 'Agua')
  for (const t of ['hey bot', 'good morning bot', 'hola bot', 'buenos días bot']) assert.equal(isGreeting(t), true, t)
  assert.equal(isGreeting('hola'), false)
})

test('renderSection and renderList speak the locale', () => {
  const bills = parseDescription('Power\nGym (pausado)')
  assert.equal(renderSection(bills, EN), [
    '──── 🤖 contas-bot ────', 'Bills (edit this list):', 'Power', 'Gym (paused)', '──────────────', '/paid <bill> [amount] · /list · /help',
  ].join('\n'))
  const out = renderList('2026-09', bills, { power: { name: 'Power', paid_at: '', amount: 10, by: 'x', message_id: 'm' } }, EN)
  assert.ok(out.startsWith('📋 *Bills — September/2026*'), out)
  assert.ok(out.endsWith('*Paid:* 1/1 · *Total:* $10.00'), out)
  const missing = renderList('2026-09', bills, { power: { name: 'Power', paid_at: '', amount: null, by: 'x', message_id: 'm' } }, ES)
  assert.ok(missing.endsWith('*Pagado:* 1/1 · *Total:* 0,00 € (1 sin monto)'), missing)
})
