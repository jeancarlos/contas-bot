import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateDescription, reconcileBills } from '../../src/core/description.ts'
import { emptyState, type GroupState } from '../../src/core/types.ts'

const LINE = '📋 contas: /conta · /lista · /ajuda'
const section = (...bills: string[]) =>
  [
    '──── 🤖 contas-bot ────',
    'Contas (edite esta lista):',
    ...bills,
    '──────────────',
    '/pago <conta> [valor] · /lista · /help',
  ].join('\n')

test('the migration reads the bills from the bot section and keeps only the group text', () => {
  const m = migrateDescription(`Casa da praia\n\n${section('Luz', 'Água', 'Academia (pausado)')}`, LINE)
  assert.deepEqual(m.bills, [
    { name: 'Luz', paused: false },
    { name: 'Água', paused: false },
    { name: 'Academia', paused: true },
  ])
  assert.equal(m.text, `Casa da praia\n\n${LINE}`)
})

test('text typed below the section is kept, a pasted duplicate section is dropped', () => {
  const m = migrateDescription(`Grupo\n\n${section('Luz', 'Água')}\nPix: chave 123\n${section('Água')}`, LINE)
  assert.deepEqual(
    m.bills.map(b => b.name),
    ['Luz', 'Água'],
  )
  assert.equal(m.text, `Grupo\n\nPix: chave 123\n\n${LINE}`)
  const noDivider = `Grupo\n\n${section('Luz').replace('\n──────────────', '')}\nPix: chave 123`
  assert.deepEqual(migrateDescription(noDivider, LINE), {
    bills: [{ name: 'Luz', paused: false }],
    text: `Grupo\n\nPix: chave 123\n\n${LINE}`,
  })
})

test('the 1.x placeholder is dropped in any language, so an untouched group keeps only the line', () => {
  const placeholders = [
    '✏\uFE0F Escreva aqui a descrição do grupo (apague estas linhas).\n⚠\uFE0F Abaixo é do bot: mude só a lista de contas.',
    "✏\uFE0F Write the group description here (delete these lines).\n⚠\uFE0F Below is the bot's part: change only the bill list.",
    '✏ Escribe aquí la descripción del grupo (borra estas líneas).\n⚠ Abajo es la parte del bot: cambia solo la lista de cuentas.',
  ]
  for (const ph of placeholders) assert.equal(migrateDescription(`${ph}\n\n${section('Luz')}`, LINE).text, LINE)
})

test('bill lines are read as 1.x read them: markers, comments, headings and pausado variants', () => {
  const m = migrateDescription(
    section(
      '- Luz',
      '1. Água',
      '• Gás',
      '2) Aluguel',
      'Despausado',
      'HBO - pausado',
      'Mãe Carme pausada',
      '# nota',
      'LUZ',
    ),
    LINE,
  )
  assert.deepEqual(
    m.bills.map(b => [b.name, b.paused]),
    [
      ['Luz', false],
      ['Água', false],
      ['Gás', false],
      ['Aluguel', false],
      ['Despausado', false],
      ['HBO', true],
      ['Mãe Carme', true],
    ],
  )
})

test('without a bot section there are no bills and the line goes under the group text', () => {
  assert.deepEqual(migrateDescription('Casa\nLuz', LINE), { bills: [], text: `Casa\nLuz\n\n${LINE}` })
  assert.deepEqual(migrateDescription('Este grupo usa o 🤖 contas-bot\nLuz', LINE).bills, [])
  assert.deepEqual(migrateDescription('-- 🤖 contas-bot --\nLuz', LINE), {
    bills: [{ name: 'Luz', paused: false }],
    text: LINE,
  })
  assert.equal(migrateDescription('', LINE).text, LINE)
})

function imported(): GroupState {
  const s = emptyState()
  s.bills = [
    { id: 1, name: 'Luz', key: 'luz', paused: false, removed: false },
    { id: 2, name: 'Água', key: 'agua', paused: false, removed: false },
    { id: 3, name: 'Gás', key: 'gas', paused: false, removed: true },
  ]
  s.nextBillId = 4
  s.lastReset = '2026-10'
  s.months = { '2026-09': { 2: { amount: 5000, status: 'typed', by: 'Ana', paidAt: 1, messageId: 'x', byJid: null } } }
  return s
}

test('reconcile keeps ids, revives, relabels, removes what the description dropped and adds the new', () => {
  const s = imported()
  const before = structuredClone(s)
  const r = reconcileBills(s, [
    { name: 'LUZ', paused: true },
    { name: 'Gás', paused: false },
    { name: 'Internet', paused: false },
  ])
  assert.deepEqual(r.bills, [
    { id: 1, name: 'LUZ', key: 'luz', paused: true, removed: false },
    { id: 2, name: 'Água', key: 'agua', paused: false, removed: true },
    { id: 3, name: 'Gás', key: 'gas', paused: false, removed: false },
    { id: 4, name: 'Internet', key: 'internet', paused: false, removed: false },
  ])
  assert.equal(r.nextBillId, 5)
  assert.deepEqual(r.months, before.months)
  assert.deepEqual(s, before)
})

test('an empty description list keeps the imported bills untouched', () => {
  const s = imported()
  assert.equal(reconcileBills(s, []), s)
})

test('bill names lose WhatsApp formatting, a name over 40 characters is skipped, and Pausado alone is a name', () => {
  const zwsp = String.fromCodePoint(0x200b)
  const m = migrateDescription(
    section(
      '*Luz*',
      '_Água_ (pausado)',
      '~Gás~',
      '`Net`',
      'x'.repeat(41),
      'Pausada',
      'Pausado',
      'Academia pausado',
      `Lu${zwsp}z`,
      'Aluguel',
    ),
    LINE,
  )
  assert.deepEqual(
    m.bills.map(b => [b.name, b.paused]),
    [
      ['Luz', false],
      ['Água', true],
      ['Gás', false],
      ['Net', false],
      ['Pausada', false],
      ['Pausado', false],
      ['Academia', true],
      ['Aluguel', false],
    ],
  )
})
