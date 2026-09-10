import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBot, type Incoming, type MsgKey, type Wa } from '../src/bot.ts'
import { openState } from '../src/state.ts'
import type { Llm, Verdict } from '../src/llm.ts'

const G = '123@g.us'
const DESC = 'Luz\nÁgua\nAluguel\nCartão Nu\nMãe Carme (pausado)'

function fakeWa(desc = DESC) {
  let n = 0
  const sent: { text: string; quoted?: MsgKey }[] = []
  const reactions: { key: MsgKey; emoji: string }[] = []
  const pins: string[] = []
  const wa: Wa = {
    async sendText(text, quoted) { sent.push({ text, quoted }); return { id: `s${++n}`, fromMe: true, remoteJid: G } },
    async react(key, emoji) { reactions.push({ key, emoji }) },
    async pin(key) { pins.push(`pin:${key.id}`) },
    async unpin(key) { pins.push(`unpin:${key.id}`) },
    async getDescription() { return desc },
  }
  return { wa, sent, reactions, pins }
}

function fakeLlm(verdict: Verdict | null) {
  const calls: string[] = []
  const llm: Llm = {
    async interpretCaption(text) { calls.push(`caption:${text}`); return verdict },
    async readReceipt(_img, _mime, caption) { calls.push(`receipt:${caption}`); return verdict },
  }
  return { llm, calls }
}

async function setup(opts: { verdict?: Verdict | null; desc?: string; now?: Date } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = await openState(join(dir, 'state.json'))
  const w = fakeWa(opts.desc)
  const l = fakeLlm(opts.verdict ?? null)
  const bot = makeBot({ wa: w.wa, llm: l.llm, store, now: () => opts.now ?? new Date('2026-09-10T15:00:00Z') })
  await bot.start()
  return { bot, store, ...w, llmCalls: l.calls }
}

const msg = (text: string, extra: Partial<Incoming> = {}): Incoming => ({
  key: { id: 'm1', fromMe: false, remoteJid: G, participant: 'gabi@s.whatsapp.net' },
  sender: 'Gabi', text, ...extra,
})

test('start loads bills from the description', async () => {
  const { bot, store } = await setup()
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Água', 'Aluguel', 'Cartão Nu', 'Mãe Carme'])
  assert.deepEqual(store.get()._meta.bills, DESC.split('\n'))
})

test('/pago marks paid, reacts, posts and pins the list', async () => {
  const { bot, store, sent, reactions, pins } = await setup()
  await bot.onMessage(msg('/pago luz 231,45'))
  const p = store.get().months['2026-09'].luz
  assert.equal(p.amount, 231.45)
  assert.equal(p.by, 'Gabi')
  assert.equal(p.message_id, 'm1')
  assert.deepEqual(reactions[0], { key: msg('').key, emoji: '✅' })
  assert.match(sent[0].text, /✅ Luz — R\$ 231,45/)
  assert.deepEqual(pins, ['pin:s1'])
  assert.equal(store.get()._meta.pinned?.id, 's1')
})

test('second post unpins the previous list first', async () => {
  const { bot, pins } = await setup()
  await bot.onMessage(msg('/pago luz'))
  await bot.onMessage(msg('/pago agua'))
  assert.deepEqual(pins, ['pin:s1', 'unpin:s1', 'pin:s2'])
})

test('unknown bill replies with the list and changes nothing', async () => {
  const { bot, store, sent, pins } = await setup()
  await bot.onMessage(msg('/pago netflix'))
  assert.equal(sent[0].text, 'não achei "netflix". Contas: Luz, Água, Aluguel, Cartão Nu, Mãe Carme')
  assert.deepEqual(store.get().months['2026-09'] ?? {}, {})
  assert.deepEqual(pins, [])
})

test('/despago removes the payment, /lista reposts, /ajuda helps', async () => {
  const { bot, store, sent } = await setup()
  await bot.onMessage(msg('/pago luz'))
  await bot.onMessage(msg('/despago luz'))
  assert.equal(store.get().months['2026-09'].luz, undefined)
  assert.match(sent.at(-1)!.text, /⬜ Luz/)
  await bot.onMessage(msg('/lista'))
  assert.match(sent.at(-1)!.text, /📋 \*Contas — Setembro\/2026\*/)
  await bot.onMessage(msg('/ajuda'))
  assert.equal(sent.at(-1)!.text, '/pago <conta> [valor] · /despago <conta> · /lista · edite a descrição do grupo para mudar as contas')
})

test('plain chat is ignored, plain bill name is a payment', async () => {
  const { bot, sent, llmCalls } = await setup()
  await bot.onMessage(msg('bom dia amor'))
  assert.equal(sent.length, 0)
  assert.equal(llmCalls.length, 0)
  await bot.onMessage(msg('paguei o aluguel'))
  assert.match(sent[0].text, /✅ Aluguel/)
})

test('receipt with mechanical caption: paid immediately, LLM only for amount', async () => {
  const { bot, store, llmCalls } = await setup({ verdict: { bill: null, amount: 6237.6, confidence: 0.4 } })
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('jpg') }
  await bot.onMessage(msg('cartão nu', { media }))
  assert.equal(store.get().months['2026-09']['cartao nu'].amount, 6237.6)
  assert.deepEqual(llmCalls, ['receipt:cartão nu'])
})

test('receipt without caption: LLM picks the bill when confident', async () => {
  const { bot, store, reactions } = await setup({ verdict: { bill: 'Luz', amount: 231.45, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
  assert.equal(reactions[0].emoji, '✅')
})

test('receipt with low confidence asks for /pago and stores nothing', async () => {
  const { bot, store, sent } = await setup({ verdict: { bill: 'Luz', amount: 231.45, confidence: 0.5 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  assert.equal(sent[0].text, 'esse comprovante é de qual conta? responde /pago <nome>')
  assert.deepEqual(store.get().months['2026-09'] ?? {}, {})
})

test('LLM down with a known caption: paid without amount', async () => {
  const { bot, store, sent } = await setup({ verdict: null })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('luz', { media }))
  assert.equal(store.get().months['2026-09'].luz.amount, null)
  assert.equal(sent[0].text, 'sem valor (LLM indisponível)')
})

test('duplicate receipt overwrites and says atualizado', async () => {
  const { bot, store, sent } = await setup({ verdict: { bill: 'Luz', amount: 250, confidence: 0.9 } })
  await bot.onMessage(msg('/pago luz 231,45'))
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('luz', { media, key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].luz.amount, 250)
  assert.equal(store.get().months['2026-09'].luz.message_id, 'm2')
  assert.ok(sent.some(s => s.text === 'atualizado'))
})

test('messages from the bot itself are ignored', async () => {
  const { bot, sent } = await setup()
  await bot.onMessage(msg('/lista', { key: { id: 'x', fromMe: true, remoteJid: G } }))
  assert.equal(sent.length, 0)
})

test('onDescription replaces the bill list and keeps payments', async () => {
  const { bot, store } = await setup()
  await bot.onMessage(msg('/pago luz'))
  await bot.onDescription('Luz\nNetflix')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Netflix'])
  assert.equal(store.get().months['2026-09'].luz.name, 'Luz')
  await bot.onDescription('')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Netflix'])
})

test('empty description at start falls back to _meta.bills and warns once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = await openState(join(dir, 'state.json'))
  store.get()._meta.bills = ['Luz', 'HBO']
  await store.save()
  const w = fakeWa('')
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store })
  await bot.start()
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'HBO'])
  assert.equal(w.sent[0].text, 'descrição do grupo vazia, usando lista anterior')
})

test('tick posts and pins a fresh list once per month', async () => {
  const { bot, store, sent, pins } = await setup({ now: new Date('2026-10-01T03:06:00Z') })
  await bot.tick()
  await bot.tick()
  assert.equal(store.get()._meta.last_reset, '2026-10')
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /Outubro\/2026/)
  assert.deepEqual(pins, ['pin:s1'])
})

test('concurrent messages are handled one at a time, pins never interleave', async () => {
  const { bot, sent, pins } = await setup()
  await Promise.all([
    bot.onMessage(msg('/pago luz 10')),
    bot.onMessage(msg('/pago agua 20', { key: { id: 'm2', fromMe: false, remoteJid: G } })),
  ])
  const lists = sent.filter(s => s.text.startsWith('📋')).length
  assert.equal(lists, 2)
  assert.deepEqual(pins, ['pin:s1', 'unpin:s1', 'pin:s2'])
})

test('onDescription republishes the list', async () => {
  const { bot, sent } = await setup()
  await bot.onDescription('Luz\nNetflix')
  assert.match(sent.at(-1)!.text, /Netflix/)
})

test('a failed pin keeps the previous pinned key', async () => {
  const { bot, wa, store } = await setup()
  await bot.onMessage(msg('/lista'))
  const first = store.get()._meta.pinned?.id
  wa.pin = async () => { throw new Error('not admin') }
  await bot.onMessage(msg('/lista'))
  assert.equal(store.get()._meta.pinned?.id, first)
})

test('tick retries next minute when the post fails', async () => {
  const { bot, wa, store } = await setup()
  wa.sendText = async () => { throw new Error('offline') }
  await assert.rejects(bot.tick())
  assert.equal(store.get()._meta.last_reset, undefined)
})
