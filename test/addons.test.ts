import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('home assistant package polls the summary endpoint', () => {
  const y = readFileSync(new URL('../addons/home-assistant/contas_bot.yaml', import.meta.url), 'utf8')
  for (const s of [
    'rest:',
    '!secret contas_bot_summary_url',
    'unique_id: contas_bot_unpaid',
    'unique_id: contas_bot_month_total',
    'value_json.groups[0].unpaid',
    'value_json.groups[0].total',
  ])
    assert.ok(y.includes(s), s)
})
