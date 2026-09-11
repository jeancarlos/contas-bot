import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLocale, CATALOGS, DEFAULT_LOCALE } from '../src/i18n.ts'

test('makeLocale accepts the three languages and upper-cases the currency', () => {
  assert.deepEqual([makeLocale('pt-BR', 'brl').currency, makeLocale('en', 'usd').lang, makeLocale('es', 'EUR').lang], ['BRL', 'en', 'es'])
  assert.equal(makeLocale('en', 'USD').decimal, '.')
  assert.equal(makeLocale('pt-BR', 'BRL').decimal, ',')
  assert.equal(makeLocale('es', 'EUR').decimal, ',')
  assert.equal(DEFAULT_LOCALE.lang, 'pt-BR')
  assert.equal(DEFAULT_LOCALE.currency, 'BRL')
})

test('makeLocale rejects bad values with a clear message', () => {
  assert.throws(() => makeLocale('fr', 'EUR'), { message: 'unsupported BOT_LANG "fr": use pt-BR, en or es' })
  for (const lang of ['toString', 'constructor']) assert.throws(() => makeLocale(lang, 'BRL'), { message: `unsupported BOT_LANG "${lang}": use pt-BR, en or es` })
  assert.throws(() => makeLocale('en', 'US'), { message: 'invalid BOT_CURRENCY "US": use an ISO 4217 code like BRL, USD, EUR' })
  assert.throws(() => makeLocale('en', 'U$D'), /invalid BOT_CURRENCY/)
})

test('every catalog has the same keys and no empty strings', () => {
  const keys = Object.keys(CATALOGS['pt-BR']).sort()
  for (const [lang, cat] of Object.entries(CATALOGS)) {
    assert.deepEqual(Object.keys(cat).sort(), keys, lang)
    for (const [k, v] of Object.entries(cat) as [string, unknown][]) {
      const s = typeof v === 'function' ? v(1, 'x') : v
      assert.ok(typeof s === 'string' && s.length > 0, `${lang}.${k}`)
    }
    assert.ok(cat.sectionTitle.endsWith(':'), `${lang}.sectionTitle`)
    assert.ok(cat.sectionHelp.startsWith('/'), `${lang}.sectionHelp`)
    assert.ok(!cat.descPlaceholder.includes('contas-bot'), `${lang}.descPlaceholder must not read as the section header`)
  }
})
