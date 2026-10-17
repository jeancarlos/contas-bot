// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand, parseConta } from '../../src/core/commands.ts'

test('parseCommand: slash commands in any language, accents and case ignored, typos suggested', () => {
  assert.deepEqual(parseCommand('/Pagó luz 80'), { cmd: 'pago', arg: 'luz 80' })
  assert.deepEqual(parseCommand('*/PAID* water'), { cmd: 'pago', arg: 'water' })
  assert.deepEqual(parseCommand('/paguei luz 80'), { cmd: 'pago', arg: 'luz 80' })
  assert.deepEqual(parseCommand('/Pagar água'), { cmd: 'pago', arg: 'água' })
  assert.deepEqual(parseCommand('/conta adiciona Luz'), { cmd: 'conta', arg: 'adiciona Luz' })
  assert.deepEqual(parseCommand('/pagp luz'), { cmd: 'unknown', typed: 'pagp', suggestion: 'pago' })
  assert.equal(parseCommand('paguei a luz'), null)
  assert.deepEqual(parseCommand('/'), { cmd: 'unknown', typed: '', suggestion: null })
})

test('typos up to two edits from one command suggest that command, ties and far words suggest nothing', () => {
  const cases: [string, string | null][] = [
    ['pgao', 'pago'],
    ['apgo', 'pago'],
    ['lsita', 'lista'],
    ['ajdua', 'ajuda'],
    ['aydua', 'ajuda'],
    ['hlep', 'ajuda'],
    ['despaog', 'despago'],
    ['xyz', null],
    ['cotna', 'conta'],
  ]
  for (const [typed, suggestion] of cases) {
    assert.deepEqual(parseCommand(`/${typed} luz`), { cmd: 'unknown', typed, suggestion }, typed)
  }
  assert.deepEqual(parseCommand('/paist'), { cmd: 'unknown', typed: 'paist', suggestion: null })
  assert.deepEqual(parseConta('pasua luz'), { sub: 'unknown', typed: 'pasua', suggestion: 'pause' })
  assert.deepEqual(parseConta('renmoear a = b'), { sub: 'unknown', typed: 'renmoear', suggestion: 'rename' })
  assert.deepEqual(parseConta('zzz luz'), { sub: 'unknown', typed: 'zzz', suggestion: null })
})

test('parseConta: subcommands in any language, rename needs exactly one "="', () => {
  assert.deepEqual(parseConta(''), { sub: 'list' })
  assert.deepEqual(parseConta('adiciona Conta de Luz'), { sub: 'add', name: 'Conta de Luz' })
  assert.deepEqual(parseConta('adicionar Luz'), { sub: 'add', name: 'Luz' })
  assert.deepEqual(parseConta('renombrar a = b'), { sub: 'rename', from: 'a', to: 'b' })
  assert.deepEqual(parseConta('pause Gym'), { sub: 'pause', name: 'Gym' })
  assert.deepEqual(parseConta('continua academia'), { sub: 'resume', name: 'academia' })
  assert.deepEqual(parseConta('renomeia Cartão Nu = Nubank'), { sub: 'rename', from: 'Cartão Nu', to: 'Nubank' })
  assert.deepEqual(parseConta('renomeia Cartão Nu'), { sub: 'help' })
  assert.deepEqual(parseConta('renomeia a = b = c'), { sub: 'help' })
  assert.deepEqual(parseConta('remove'), { sub: 'help' })
  assert.deepEqual(parseConta('pausaa luz'), { sub: 'unknown', typed: 'pausaa', suggestion: 'pause' })
})
