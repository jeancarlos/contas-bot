import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalize, parseDescription, resolveBill, parseAmount, formatBRL,
  monthKey, monthTitle, renderList, parseCommand, matchPlainText,
  DEMO_BILLS, splitDescription, renderSection, composeDescription, isGreeting,
  type Bill, type Payment,
} from '../src/bills.ts'

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

test('formatBRL', () => {
  assert.equal(formatBRL(6237.6), 'R$ 6.237,60')
  assert.equal(formatBRL(231.45), 'R$ 231,45')
  assert.equal(formatBRL(1234567.5), 'R$ 1.234.567,50')
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
