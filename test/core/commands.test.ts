import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand, parseConta } from '../../src/core/commands.ts'

test('parseCommand: slash commands in any language, accents and case ignored, typos suggested', () => {
  assert.deepEqual(parseCommand('/Pagó luz 80'), { cmd: 'pago', arg: 'luz 80' })
  assert.deepEqual(parseCommand('*/PAID* water'), { cmd: 'pago', arg: 'water' })
  assert.deepEqual(parseCommand('/conta adiciona Luz'), { cmd: 'conta', arg: 'adiciona Luz' })
  assert.deepEqual(parseCommand('/pagp luz'), { cmd: 'unknown', typed: 'pagp', suggestion: 'pago' })
  assert.equal(parseCommand('paguei a luz'), null)
  assert.equal(parseCommand('/'), null)
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
  assert.deepEqual(parseConta('pausaa luz'), { sub: 'unknown', typed: 'pausaa', suggestion: 'pausa' })
})
