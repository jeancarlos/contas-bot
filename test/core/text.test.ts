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
