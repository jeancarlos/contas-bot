import assert from 'node:assert/strict'
import { test } from 'node:test'
import fc from 'fast-check'
import { findMoney, parseNumber } from '../../src/core/money.ts'

const decimal = fc.constantFrom(',' as const, '.' as const)

test('parseNumber never throws and only returns positive safe integer cents', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 40 }), decimal, (s, dec) => {
      const cents = parseNumber(s, dec)
      assert.ok(cents === null || (Number.isSafeInteger(cents) && cents > 0))
    }),
    { numRuns: 2000 },
  )
})

test('parseNumber reads back any amount written as digits and a decimal separator', () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 99_999_999 }), decimal, (cents, dec) => {
      const text = `${Math.floor(cents / 100)}${dec}${String(cents % 100).padStart(2, '0')}`
      assert.equal(parseNumber(text, dec), cents)
    }),
    { numRuns: 2000 },
  )
})

test('findMoney never throws on arbitrary tokens', () => {
  fc.assert(
    fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 12 }), decimal, (tokens, dec) => {
      const { marked, bare } = findMoney(tokens, dec)
      for (const hit of [...marked, ...bare]) {
        assert.ok(hit.start >= 0 && hit.end <= tokens.length && hit.start < hit.end)
        assert.ok(Number.isSafeInteger(hit.cents) && hit.cents > 0)
      }
    }),
    { numRuns: 1000 },
  )
})
