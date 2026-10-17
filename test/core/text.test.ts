// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clean, closest, normalize } from '../../src/core/text.ts'

test('clean strips WhatsApp formatting, emoji and line breaks and joins "/ pago"', () => {
  assert.equal(clean('*/pago* _luz_\n80 ✅'), '/pago luz 80')
  assert.equal(clean('/ pago luz'), '/pago luz')
  assert.equal(clean('👍🏽 /pago luz'), '/pago luz')
  assert.equal(normalize('Cartão  NU!'), 'cartao nu')
})

test('closest returns the single nearest key within a third of its length, else null', () => {
  assert.equal(
    closest(['luz', 'agua'], x => x, 'lux'),
    'luz',
  )
  assert.equal(
    closest(['luz', 'lua'], x => x, 'lus'),
    null,
  )
  assert.equal(
    closest(['internet'], x => x, 'xyz'),
    null,
  )
})

test('clean drops invisible format characters, so a zero-width space cannot fake a new name', () => {
  const [zwsp, shy, lrm, wj, bom, zwj] = [0x200b, 0xad, 0x200e, 0x2060, 0xfeff, 0x200d].map(c =>
    String.fromCodePoint(c),
  )
  assert.equal(clean(`Lu${zwsp}z`), 'Luz')
  assert.equal(clean(`a${shy}b${lrm}c${wj}d${bom}e`), 'abcde')
  assert.equal(clean(`👨${zwj}👩${zwj}👧 /pago luz`), '/pago luz')
})

test('closest skips keys whose length alone rules them out, so a huge query costs nothing', () => {
  const keys = ['luz', 'agua', 'internet', 'aluguel', 'gas', 'cartao nu', 'cartao c6', 'condominio', 'netflix', 'iptu']
  const t0 = performance.now()
  assert.equal(
    closest(keys, x => x, 'x'.repeat(2_000_000)),
    null,
  )
  assert.ok(performance.now() - t0 < 1000, `took ${Math.round(performance.now() - t0)} ms`)
  assert.equal(
    closest(keys, x => x, 'internt'),
    'internet',
  )
  assert.equal(
    closest(keys, x => x, 'cartao n'),
    'cartao nu',
  )
})
