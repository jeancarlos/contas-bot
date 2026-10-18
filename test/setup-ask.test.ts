// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import type { Answers } from '../src/setup/core.ts'
import { ask, askAi, askBasics, askEndpoint, describe, type Ui } from '../src/setup/ask.ts'
import { SETUP_TEXT } from '../src/setup/i18n.ts'

const DOWN = '\x1b[B'
const ENTER = '\r'
const BACK = '\x7f'
const CTRL_C = '\x03'
const wait = () => new Promise(r => setTimeout(r, 15))

function rig(probe: Ui['probe'] = async () => true) {
  const input = new PassThrough()
  let out = ''
  const output = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString()
      cb()
    },
  })
  const u: Ui = {
    text: SETUP_TEXT['pt-BR'],
    io: { input, output },
    exit: code => {
      throw new Error(`exit:${code}`)
    },
    probe,
  }
  const keys = async (...seq: string[]) => {
    for (const k of seq) {
      await wait()
      input.write(k)
    }
  }
  const typed = (s: string) => [...s]
  return { u, keys, typed, out: () => out }
}

test('describe lists language, currency, pairing, AI and group on four lines', () => {
  const t = SETUP_TEXT.en
  const lines = describe(t, {
    lang: 'en',
    currency: 'USD',
    pairing: 'code',
    phone: '5511900000000',
    ai: 'gemini',
    model: 'm',
    hasKey: true,
    group: 'g',
    tz: 'UTC',
  }).split('\n')
  assert.equal(lines.length, 4)
  assert.match(lines[0] ?? '', /en · USD · .*\+5511900000000/)
  assert.match(lines[1] ?? '', /gemini · m · ••••/)
  assert.equal(describe(t, { ai: 'none', hasKey: false }).split('\n')[1], t.aiNone)
  assert.equal(describe(t, { pairing: 'qr', hasKey: false }).split('\n')[0]?.endsWith(t.pairingQr), true)
  assert.equal(describe(t, { hasKey: false }), '— · — · —\n— · — · —\n—\n—')
})

test('askBasics: picking English switches the text and defaults the currency to USD', async () => {
  const r = rig()
  const a: Partial<Answers> = {}
  const done = askBasics(r.u, a)
  await r.keys(DOWN, ENTER, ENTER, ENTER)
  await done
  assert.equal(a.lang, 'en')
  assert.equal(a.currency, 'USD')
  assert.equal(a.pairing, 'qr')
  assert.equal(a.phone, undefined)
  assert.equal(r.u.text, SETUP_TEXT.en)
})

test('askBasics: an invalid currency is refused with a message, then a valid one is upper-cased', async () => {
  const r = rig()
  const a: Partial<Answers> = {}
  const done = askBasics(r.u, a)
  await r.keys(ENTER, ...Array(3).fill(BACK), ...r.typed('xx'), ENTER, BACK, BACK, ...r.typed('brl'), ENTER, ENTER)
  await done
  assert.equal(a.currency, 'BRL')
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].currencyInvalid))
})

test('askBasics: pairing by code asks for a phone, refuses a short one, and normalizes a good one', async () => {
  const r = rig()
  const a: Partial<Answers> = {}
  const done = askBasics(r.u, a)
  await r.keys(
    ENTER,
    ENTER,
    DOWN,
    ENTER,
    ...r.typed('123'),
    ENTER,
    ...Array(3).fill(BACK),
    ...r.typed('+55 11 90000-0000'),
    ENTER,
  )
  await done
  assert.equal(a.pairing, 'code')
  assert.equal(a.phone, '5511900000000')
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].phoneInvalid))
})

test('askEndpoint: a non-URL is refused, a quote is refused, a clean URL and model are kept trimmed', async () => {
  const r = rig()
  const a: Partial<Answers> = {}
  const done = askEndpoint(r.u, a)
  await r.keys(...r.typed('nope'), ENTER, ...Array(4).fill(BACK), ...r.typed("https://x.y/v1'"), ENTER, BACK, ENTER)
  await r.keys(ENTER, ...r.typed('m1'), ENTER)
  await done
  assert.equal(a.llmUrl, 'https://x.y/v1')
  assert.equal(a.visionModel, 'm1')
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].aiUrlInvalid))
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].noQuotes))
})

test('askAi: "no AI" skips the key and the probe', async () => {
  let probed = 0
  const r = rig(async () => {
    probed++
    return true
  })
  const a: Partial<Answers> = {}
  const done = askAi(r.u, a)
  await r.keys(DOWN, DOWN, DOWN, ENTER)
  await done
  assert.equal(a.ai, 'none')
  assert.equal(a.llmKey, undefined)
  assert.equal(probed, 0)
})

test('askAi: Gemini asks for a key, probes it and stops when it answers', async () => {
  const seen: string[] = []
  const r = rig(async cfg => {
    seen.push(cfg.key)
    return true
  })
  const a: Partial<Answers> = {}
  const done = askAi(r.u, a)
  await r.keys(ENTER, ...r.typed('KEY123'), ENTER)
  await done
  assert.equal(a.ai, 'gemini')
  assert.equal(a.llmKey, 'KEY123')
  assert.deepEqual(seen, ['KEY123'])
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].aiOk))
})

test('askAi: a failing probe offers a retry; declining it keeps the answers and moves on', async () => {
  let probed = 0
  const r = rig(async () => {
    probed++
    return false
  })
  const a: Partial<Answers> = {}
  const done = askAi(r.u, a)
  await r.keys(ENTER, ...r.typed('BAD'), ENTER, 'n', ENTER)
  await done
  assert.equal(probed, 1)
  assert.equal(a.llmKey, 'BAD')
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].aiFailed))
})

test('askAi: accepting the retry asks for the key again and probes again', async () => {
  const results = [false, true]
  const r = rig(async () => results.shift() ?? true)
  const a: Partial<Answers> = {}
  const done = askAi(r.u, a)
  await r.keys(ENTER, ...r.typed('BAD'), ENTER, ENTER, ...r.typed('GOOD'), ENTER)
  await done
  assert.equal(a.llmKey, 'GOOD')
  assert.deepEqual(results, [])
})

test('askAi: a saved key is kept when the key prompt is left empty', async () => {
  const r = rig()
  const a: Partial<Answers> = { ai: 'gemini' }
  const done = askAi(r.u, a, { ai: 'gemini', llmKey: 'SAVED' })
  await r.keys(ENTER, ENTER)
  await done
  assert.equal(a.llmKey, 'SAVED')
})

test('ctrl-c at any prompt cancels with exit code 130', async () => {
  const r = rig()
  const done = askBasics(r.u, {})
  const caught = assert.rejects(done, /exit:130/)
  await r.keys(CTRL_C)
  await caught
  assert.ok(r.out().includes(SETUP_TEXT['pt-BR'].cancelled))
})

test('ask: the whole flow returns the answers once the summary is confirmed', async () => {
  const r = rig()
  const done = ask(r.u, {})
  await r.keys(DOWN, ENTER, ENTER, ENTER, DOWN, DOWN, DOWN, ENTER, ...r.typed('120363000000000000@g.us'), ENTER, ENTER)
  const a = await done
  assert.equal(a.lang, 'en')
  assert.equal(a.ai, 'none')
  assert.equal(a.group, '120363000000000000@g.us')
  assert.ok(r.out().includes(SETUP_TEXT.en.summary))
})

test('ask: declining the summary cancels with exit code 130', async () => {
  const r = rig()
  const done = ask(r.u, {})
  const caught = assert.rejects(done, /exit:130/)
  await r.keys(ENTER, ENTER, ENTER, DOWN, DOWN, DOWN, ENTER, ...r.typed('120363000000000000@g.us'), ENTER, 'n', ENTER)
  await caught
})
