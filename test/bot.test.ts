import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBot, type Incoming, type MsgKey, type Wa } from '../src/bot.ts'
import { openState, type StateStore } from '../src/state.ts'
import { parseDescription, composeDescription, billLine } from '../src/bills.ts'
import { makeLocale, DEFAULT_LOCALE, type Locale } from '../src/i18n.ts'
import type { Llm, Verdict } from '../src/llm.ts'

const G = '123@g.us'
const DESC = 'Luz\nÁgua\nAluguel\nCartão Nu\nMãe Carme (pausado)'

function fakeWa(desc = DESC) {
  let n = 0
  const sent: { text: string; quoted?: MsgKey }[] = []
  const reactions: { key: MsgKey; emoji: string }[] = []
  const pins: string[] = []
  const descs: string[] = []
  const wa: Wa = {
    async sendText(text, quoted) { sent.push({ text, quoted }); return { id: `s${++n}`, fromMe: true, remoteJid: G } },
    async react(key, emoji) { reactions.push({ key, emoji }) },
    async pin(key) { pins.push(`pin:${key.id}`) },
    async unpin(key) { pins.push(`unpin:${key.id}`) },
    async getDescription() { return desc },
    async setDescription(text) { descs.push(text); desc = text },
  }
  // A member edit: the current description changes, then the event arrives.
  const edit = (text: string) => { desc = text }
  return { wa, sent, reactions, pins, descs, edit }
}

function fakeLlm(verdict: Verdict | null) {
  const calls: string[] = []
  const llm: Llm = {
    async interpretCaption(text) { calls.push(`caption:${text}`); return verdict },
    async readReceipt(_img, _mime, caption) { calls.push(`receipt:${caption}`); return verdict },
  }
  return { llm, calls }
}

async function setup(opts: { verdict?: Verdict | null; desc?: string; now?: Date; fresh?: boolean; locale?: Locale } = {}) {
  seq = 0
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  if (!opts.fresh) store.get()._meta.last_reset = '2026-08'
  const w = fakeWa(opts.desc)
  const l = fakeLlm(opts.verdict ?? null)
  const bot = makeBot({ wa: w.wa, llm: l.llm, store, now: () => opts.now ?? new Date('2026-09-10T15:00:00Z'), locale: opts.locale })
  await bot.join()
  return { bot, store, ...w, llmCalls: l.calls, llm: l.llm }
}

let seq = 0
const msg = (text: string, extra: Partial<Incoming> = {}): Incoming => {
  const { key: extraKey, ...restExtra } = extra
  return {
    key: { id: `m${++seq}`, fromMe: false, remoteJid: G, participant: 'gabi@s.whatsapp.net', ...extraKey },
    sender: 'Gabi', text, ...restExtra,
  }
}

test('start loads bills from the description', async () => {
  const { bot, store } = await setup()
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Água', 'Aluguel', 'Cartão Nu', 'Mãe Carme'])
  assert.deepEqual(store.get()._meta.bills, DESC.split('\n'))
})

test('/pago marks paid, reacts, posts and pins the list', async () => {
  const { bot, store, sent, reactions, pins } = await setup()
  const m = msg('/pago luz 231,45')
  await bot.onMessage(m)
  const p = store.get().months['2026-09'].luz
  assert.equal(p.amount, 231.45)
  assert.equal(p.by, 'Gabi')
  assert.equal(p.message_id, m.key.id)
  assert.deepEqual(reactions[0], { key: m.key, emoji: '✅' })
  assert.match(sent[0].text, /✅ Luz — R\$ 231,45/)
  assert.deepEqual(pins, ['pin:s1'])
  assert.equal(store.get()._meta.pinned?.id, 's1')
})

test('a plain-text repayment keeps the previously typed amount', async () => {
  const { bot, store } = await setup()
  await bot.onMessage(msg('/pago luz 231,45'))
  await bot.onMessage(msg('luz'))
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
  await bot.onMessage(msg('/pago luz 300'))
  assert.equal(store.get().months['2026-09'].luz.amount, 300)
})

test('a bill named constructor is paid and unpaid like any other bill', async () => {
  const { bot, store, sent } = await setup({ desc: 'constructor\nLuz' })
  await bot.onMessage(msg('/lista'))
  assert.match(sent.at(-1)!.text, /⬜ constructor/)
  await bot.onMessage(msg('/pago constructor 10'))
  assert.equal(store.get().months['2026-09']['constructor'].amount, 10)
  await bot.onMessage(msg('/despago constructor'))
  assert.equal(Object.hasOwn(store.get().months['2026-09'], 'constructor'), false)
  await bot.onMessage(msg('/lista'))
  assert.match(sent.at(-1)!.text, /⬜ constructor/)
})

test('second post pins the new list, then unpins the previous one', async () => {
  const { bot, pins } = await setup()
  await bot.onMessage(msg('/pago luz'))
  await bot.onMessage(msg('/pago agua'))
  assert.deepEqual(pins, ['pin:s1', 'pin:s2', 'unpin:s1'])
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
  assert.ok(sent.at(-1)!.text.startsWith('🤖 *Comandos do contas-bot*'))
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
  const { bot, store, llmCalls } = await setup({ verdict: { bill: null, amount: 6237.6, confidence: 0.9 } })
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('jpg') }
  await bot.onMessage(msg('cartão nu', { media }))
  assert.equal(store.get().months['2026-09']['cartao nu'].amount, 6237.6)
  assert.deepEqual(llmCalls, ['receipt:cartão nu'])
})

test('a receipt captioned with a known bill but low LLM confidence is paid without an amount', async () => {
  const { bot, store, sent, llmCalls } = await setup({ verdict: { bill: null, amount: 6237.6, confidence: 0.4 } })
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('jpg') }
  await bot.onMessage(msg('cartão nu', { media }))
  assert.equal(store.get().months['2026-09']['cartao nu'].amount, null)
  assert.equal(sent[0].text, 'sem valor (LLM indisponível)')
  assert.deepEqual(llmCalls, ['receipt:cartão nu'])
})

test('a receipt captioned with an unrelated command is dispatched as the command, not read', async () => {
  const { bot, store, llmCalls } = await setup()
  await bot.onMessage(msg('/pago luz 10'))
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('jpg') }
  await bot.onMessage(msg('/despago luz', { media, key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].luz, undefined)
  assert.deepEqual(llmCalls, [])
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

test('a receipt that only reads an amount remembers it for the /pago that answers the ask', async () => {
  const { bot, store, sent } = await setup({ verdict: { bill: null, amount: 231.45, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  assert.equal(sent[0].text, 'esse comprovante é de qual conta? responde /pago <nome>')
  await bot.onMessage(msg('/pago luz', { key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
})

test('a /pago with an explicit amount wins over a pending receipt amount', async () => {
  const { bot, store } = await setup({ verdict: { bill: null, amount: 231.45, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  await bot.onMessage(msg('/pago luz 50', { key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].luz.amount, 50)
})

test('a second receipt replaces the pending amount instead of stacking', async () => {
  const { bot, store, llm } = await setup({ verdict: { bill: null, amount: 100, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  llm.readReceipt = async () => ({ bill: null, amount: 200, confidence: 0.9 })
  await bot.onMessage(msg('', { media, key: { id: 'm2', fromMe: false, remoteJid: G } }))
  await bot.onMessage(msg('/pago luz', { key: { id: 'm3', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].luz.amount, 200)
})

test('a pending receipt amount only applies to the sender who sent the receipt', async () => {
  const { bot, store } = await setup({ verdict: { bill: null, amount: 231.45, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  await bot.onMessage(msg('/pago agua', { sender: 'Marido', key: { id: 'm2', fromMe: false, remoteJid: G, participant: 'marido@s.whatsapp.net' } }))
  assert.equal(store.get().months['2026-09'].agua.amount, null)
  await bot.onMessage(msg('/pago luz', { key: { id: 'm3', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
})

test('a receipt that fails to complete still clears a stale pending amount', async () => {
  const { bot, store } = await setup({ verdict: { bill: null, amount: 231.45, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  const broken = { mime: 'image/png', download: async (): Promise<Buffer> => { throw new Error('expired') } }
  await bot.onMessage(msg('luz', { media: broken, key: { id: 'm2', fromMe: false, remoteJid: G } }))
  await bot.onMessage(msg('/pago agua', { key: { id: 'm3', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].agua.amount, null)
})

test('two members with the same display name but different jids do not share pending amounts', async () => {
  const { bot, store } = await setup({ verdict: { bill: null, amount: 100, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media, key: { id: 'm2', fromMe: false, remoteJid: G, participant: 'alice@s.whatsapp.net' }, sender: 'Sam' }))
  await bot.onMessage(msg('/pago agua', { key: { id: 'm3', fromMe: false, remoteJid: G, participant: 'bob@s.whatsapp.net' }, sender: 'Sam' }))
  assert.equal(store.get().months['2026-09'].agua.amount, null)
})

test('a bill name ending in a number falls back to a pending amount held by the same sender', async () => {
  const { bot, store } = await setup({ desc: 'Apartamento\nApartamento 101\nLuz', verdict: { bill: null, amount: 231.45, confidence: 0.9 } })
  const media = { mime: 'image/png', download: async () => Buffer.from('png') }
  await bot.onMessage(msg('', { media }))
  await bot.onMessage(msg('/pago apartamento 101', { key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09']['apartamento 101'].amount, 231.45)
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

test('a redelivered message id is applied once, not re-applied on retry', async () => {
  const { bot, store, reactions } = await setup()
  const first = msg('/pago luz 100')
  await bot.onMessage(first)
  await bot.onMessage(msg('/pago luz 150'))
  await bot.onMessage(first) // WhatsApp redelivery: same id, same content
  assert.equal(store.get().months['2026-09'].luz.amount, 150)
  assert.equal(reactions.length, 2)
})

test('two distinct messages carrying identical text both apply', async () => {
  const { bot, store, reactions } = await setup()
  await bot.onMessage(msg('luz'))
  await bot.onMessage(msg('luz'))
  assert.equal(reactions.length, 2)
  assert.equal(store.get().months['2026-09'].luz.message_id, 'm2')
})

test('the handled id list stays capped at 50, keeping the newest', async () => {
  const { bot, store } = await setup()
  for (let i = 0; i < 55; i++) await bot.onMessage(msg('/lista'))
  const handled = store.get()._meta.handled!
  assert.equal(handled.length, 50)
  assert.deepEqual(handled, Array.from({ length: 50 }, (_, i) => `m${i + 6}`))
})

test('the handled id reaches disk, so a restart after redelivery does not re-apply it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const path = join(dir, 'state.json')
  const store = (await openState(path)).forGroup(G)
  store.get()._meta.last_reset = '2026-08'
  const w = fakeWa()
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  await bot.join()
  const m = msg('/pago luz 231,45')
  await bot.onMessage(m)
  const reopened = (await openState(path)).forGroup(G)
  assert.deepEqual(reopened.get()._meta.handled, [m.key.id])
})

test('a message whose handling threw is not recorded as handled, so redelivery retries it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const real = (await openState(join(dir, 'state.json'))).forGroup(G)
  real.get()._meta.last_reset = '2026-08'
  let fail = false
  const store: StateStore = { get: () => real.get(), save: () => fail ? Promise.reject(new Error('disk full')) : real.save() }
  const w = fakeWa()
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  await bot.join()
  fail = true
  const m = msg('/pago luz 231,45')
  await bot.onMessage(m)
  assert.equal(store.get()._meta.handled, undefined)
  assert.equal(w.reactions.length, 0)
  fail = false
  await bot.onMessage(m)
  assert.deepEqual(store.get()._meta.handled, [m.key.id])
  assert.equal(w.reactions.length, 1)
})

test('onDescription replaces the bill list and keeps payments', async () => {
  const { bot, store, edit } = await setup()
  await bot.onMessage(msg('/pago luz'))
  edit('──── 🤖 contas-bot ────\nLuz\nNetflix')
  await bot.onDescription('──── 🤖 contas-bot ────\nLuz\nNetflix')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Netflix'])
  assert.equal(store.get().months['2026-09'].luz.name, 'Luz')
  edit('')
  await bot.onDescription('')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Netflix'])
})

test('an empty description is rebuilt from _meta.bills', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  store.get()._meta.last_reset = '2026-08'
  store.get()._meta.bills = ['Luz', 'Água']
  const w = fakeWa('')
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store })
  await bot.join()
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Água'])
  assert.ok(w.descs[0].includes('Luz\nÁgua'))
})

test('a section emptied by a member stays empty instead of being restored', async () => {
  const { bot, store, edit } = await setup()
  const emptied = composeDescription('', [])!
  edit(emptied)
  await bot.onDescription(emptied)
  assert.equal(bot.bills().length, 0)
  assert.deepEqual(store.get()._meta.bills, [])
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
  assert.deepEqual(pins, ['pin:s1', 'pin:s2', 'unpin:s1'])
})

test('onDescription republishes the list', async () => {
  const { bot, sent, edit } = await setup()
  edit('──── 🤖 contas-bot ────\nLuz\nNetflix')
  await bot.onDescription('──── 🤖 contas-bot ────\nLuz\nNetflix')
  assert.match(sent.at(-1)!.text, /Netflix/)
})

test('a failed pin keeps the previous pinned key', async () => {
  const { bot, wa, store, pins } = await setup()
  await bot.onMessage(msg('/lista'))
  const first = store.get()._meta.pinned?.id
  wa.pin = async () => { throw new Error('not admin') }
  await bot.onMessage(msg('/lista'))
  assert.equal(store.get()._meta.pinned?.id, first)
  assert.deepEqual(pins, ['pin:s1']) // the old list stays pinned: nothing is unpinned before a pin succeeds
})

test('a failed unpin after a successful pin still stores the new key', async () => {
  const { bot, wa, store } = await setup()
  await bot.onMessage(msg('/lista'))
  wa.unpin = async () => { throw new Error('gone') }
  await bot.onMessage(msg('/lista'))
  assert.equal(store.get()._meta.pinned?.id, 's2')
})

test('tick retries next minute when the post fails', async () => {
  const { bot, wa, store } = await setup()
  wa.sendText = async () => { throw new Error('offline') }
  await assert.rejects(bot.tick())
  assert.equal(store.get()._meta.last_reset, '2026-08')
})

test('a failed reaction still saves the payment and updates the list', async () => {
  const { bot, wa, store, sent, pins } = await setup()
  wa.react = async () => { throw new Error('disconnected') }
  await bot.onMessage(msg('/pago luz 231,45'))
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
  assert.match(sent.at(-1)!.text, /✅ Luz — R\$ 231,45/)
  assert.deepEqual(pins, ['pin:s1'])
})

test('a failed save while marking paid warns the group instead of going silent', async () => {
  const { bot, store, sent } = await setup()
  store.save = async () => { throw new Error('disk full') }
  await bot.onMessage(msg('/pago luz 231,45'))
  assert.equal(sent.at(-1)!.text, 'não consegui salvar, tenta de novo')
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
})

test('a failed save on /despago warns the group instead of going silent', async () => {
  const { bot, store, sent } = await setup()
  await bot.onMessage(msg('/pago luz 231,45'))
  store.save = async () => { throw new Error('disk full') }
  await bot.onMessage(msg('/despago luz', { key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(sent.at(-1)!.text, 'não consegui salvar, tenta de novo')
  assert.equal(store.get().months['2026-09'].luz, undefined)
})

test('a failed "updated" notice still saves the payment and posts the list', async () => {
  const { bot, wa, store, sent } = await setup()
  await bot.onMessage(msg('/pago luz 231,45'))
  const posts = sent.length
  wa.sendText = async (text, quoted) => {
    if (text === DEFAULT_LOCALE.t.updated) throw new Error('disconnected')
    sent.push({ text, quoted })
    return { id: `s${sent.length + 1}`, fromMe: true, remoteJid: G }
  }
  await bot.onMessage(msg('/pago luz 300'))
  assert.equal(store.get().months['2026-09'].luz.amount, 300)
  assert.equal(sent.length, posts + 1)
  assert.match(sent.at(-1)!.text, /✅ Luz — R\$ 300,00/)
})

test('a receipt that cannot be read asks to resend and stores nothing', async () => {
  const { bot, store, sent, llmCalls } = await setup()
  const broken = { mime: 'image/png', download: async (): Promise<Buffer> => { throw new Error('media expired') } }
  await bot.onMessage(msg('luz', { media: broken }))
  const pdf = { mime: 'application/pdf', download: async () => Buffer.from('%PDF') } // setup() passes no pdfToPng
  await bot.onMessage(msg('luz', { media: pdf }))
  const reply = 'não consegui ler o comprovante, manda de novo ou usa /pago <nome> [valor]'
  assert.deepEqual(sent.slice(-2).map(s => s.text), [reply, reply])
  assert.deepEqual(llmCalls, [])
  assert.deepEqual(store.get().months['2026-09'] ?? {}, {})
})

test('join onboards a new group that has an owner: description, intro, list, pin', async () => {
  const { bot, store, sent, descs, pins } = await setup({ fresh: true, desc: 'Grupo da casa' })
  assert.equal(descs.length, 1)
  assert.ok(descs[0].startsWith('Grupo da casa\n\n──── 🤖 contas-bot ────'))
  assert.ok(descs[0].includes('Academia (pausado)'))
  assert.match(sent[0].text, /^👋 Oi! Eu sou o \*contas-bot\*/)
  assert.match(sent[1].text, /^📋/)
  assert.deepEqual(pins, ['pin:s2'])
  assert.equal(store.get()._meta.last_reset, '2026-09')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Água', 'Internet', 'Aluguel', 'Academia'])
})

test('onboarding with a lost state.json keeps an existing bill section instead of the demo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G) // fresh: no last_reset
  const existing = composeDescription('Grupo da casa', parseDescription('Luz\nGás'))!
  const w = fakeWa(existing)
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  assert.equal(await bot.join(), 'onboarded')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Gás'])
})

test('an en bot onboards in English and understands /paid and /revert', async () => {
  const EN = makeLocale('en', 'USD')
  const { bot, store, sent, descs } = await setup({ fresh: true, desc: 'Family', locale: EN })
  assert.ok(descs[0].includes('Bills (edit this list):\nElectricity\nWater\nInternet\nRent\nGym (paused)'))
  assert.match(sent[0].text, /^👋 Hi! I'm \*contas-bot\*/)
  assert.match(sent[1].text, /^📋 \*Bills — September\/2026\*/)
  await bot.onMessage(msg('/paid water $80.10'))
  assert.equal(store.get().months['2026-09'].water.amount, 80.1)
  await bot.onMessage(msg('/revert water'))
  assert.equal(store.get().months['2026-09'].water, undefined)
  await bot.onMessage(msg('/nope'))
  assert.equal(sent.at(-1)!.text, "I don't know that command. /help lists them all.")
})

test('switching BOT_LANG rewrites the section once and keeps payments', async () => {
  const { store, descs, wa } = await setup() // pt-BR legacy group, migrated to a pt section
  store.get().months['2026-09'] = { luz: { name: 'Luz', paid_at: '', amount: 10, by: 'x', message_id: 'm' } }
  const EN = makeLocale('en', 'USD')
  const bot = makeBot({ wa, llm: fakeLlm(null).llm, store, locale: EN, now: () => new Date('2026-09-10T15:00:00Z') })
  await bot.join()
  const last = descs.at(-1)!
  assert.ok(last.includes('Bills (edit this list):'), last)
  assert.ok(last.includes('Mãe Carme (paused)'), last)
  assert.equal(store.get().months['2026-09'].luz.amount, 10)
  const writes = descs.length
  await bot.onDescription(last)
  assert.equal(descs.length, writes)
})

test('a section deleted by a member is restored even though the rebuilt text matches the last write', async () => {
  const { bot, descs, edit } = await setup()
  const placeholderOnly = descs[0].split('\n\n')[0]
  edit(placeholderOnly)
  await bot.onDescription(placeholderOnly)
  assert.equal(descs.length, 2)
  assert.ok(descs.at(-1)!.includes('🤖 contas-bot'))
})

test('join migrates a legacy group: description becomes the section, no intro', async () => {
  const { bot, sent, descs } = await setup()
  assert.equal(sent.length, 0)
  // the old list moves into the section and the empty group text above gets the placeholder
  assert.ok(descs[0].startsWith(`${DEFAULT_LOCALE.t.descPlaceholder}\n\n──── 🤖 contas-bot ────\nContas (edite esta lista):\nLuz\nÁgua`))
  assert.ok(descs[0].includes('Mãe Carme (pausado)'))
  assert.equal(bot.bills().length, 5)
})

test('join republishes the list when the bills changed while the bot was offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  store.get()._meta.last_reset = '2026-08'
  store.get()._meta.bills = ['Luz']
  store.get()._meta.section = true
  store.get()._meta.pinned = { id: 's0', fromMe: true, remoteJid: G }
  store.get()._meta.listed = true
  const desc = composeDescription('', parseDescription('Luz\nÁgua'))!
  const w = fakeWa(desc)
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  await bot.join()
  assert.ok(w.sent.some(s => s.text.includes('Água')))
})

test('join republishes on offline changes even when every pin has failed (admin-restricted group)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  store.get()._meta.last_reset = '2026-08'
  store.get()._meta.bills = ['Luz']
  store.get()._meta.section = true
  store.get()._meta.listed = true
  const desc = composeDescription('', parseDescription('Luz\nÁgua'))!
  const w = fakeWa(desc)
  w.wa.pin = async () => { throw new Error('not admin') }
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  await bot.join()
  assert.ok(w.sent.some(s => s.text.includes('Água')))
  assert.equal(store.get()._meta.pinned, undefined)
})

test('text typed below the section moves up into the group text; bills unchanged, no repost', async () => {
  const { bot, sent, descs, edit } = await setup()
  const edited = `${descs[0]}\nPix: chave 123`
  edit(edited)
  const posts = sent.length
  await bot.onDescription(edited)
  assert.ok(descs.at(-1)!.startsWith('Pix: chave 123\n\n──── 🤖 contas-bot ────'))
  assert.ok(!descs.at(-1)!.includes(DEFAULT_LOCALE.t.descPlaceholder))
  assert.equal(sent.length, posts)
  assert.equal(bot.bills().length, 5)
})

test('a member note below the section survives even if it starts with a slash', async () => {
  const { bot, descs, edit } = await setup()
  const edited = `${descs[0]}\n/assembleia sábado às 10h`
  edit(edited)
  await bot.onDescription(edited)
  assert.ok(descs.at(-1)!.includes('/assembleia sábado às 10h'))
})

test('a description edit inside the section reposts the list; the echo of our own write does nothing', async () => {
  const { bot, sent, descs, edit } = await setup()
  const edited = descs[0].replace('Aluguel', 'Aluguel\nNetflix')
  edit(edited)
  await bot.onDescription(edited)
  assert.match(sent.at(-1)!.text, /Netflix/)
  const posts = sent.length
  await bot.onDescription(edited) // same text again, as WhatsApp echoes our state
  assert.equal(sent.length, posts)
  assert.equal(descs.length, 1) // edited text was already canonical: no rewrite
})

test('a stale pre-migration description event changes nothing: the current description wins', async () => {
  const { bot, store, sent, descs } = await setup() // legacy group: join rewrote the plain list into the section
  const bills = store.get()._meta.bills
  await bot.onDescription(DESC) // Baileys delivers the old plain list after the rewrite
  assert.equal(descs.length, 1)
  assert.deepEqual(store.get()._meta.bills, bills)
  assert.equal(sent.length, 0)
})

test('an unreadable description on an update event changes nothing', async () => {
  const { bot, wa, sent, descs } = await setup()
  wa.getDescription = async () => { throw new Error('offline') }
  await bot.onDescription('──── 🤖 contas-bot ────\nLuz')
  assert.equal(bot.bills().length, 5)
  assert.equal(descs.length, 1)
  assert.equal(sent.length, 0)
})

test('a description over the limit is not written and the group is asked once to shorten its text', async () => {
  const { bot, sent, descs, edit } = await setup()
  const long = 'x'.repeat(2100) + '\n' + descs[0].replace('Aluguel', 'Aluguel\nNetflix')
  edit(long)
  await bot.onDescription(long)
  await bot.onDescription(long)
  assert.equal(descs.length, 1)
  const warning = 'a descrição do grupo passou do limite do WhatsApp: encurte o texto acima da lista do bot'
  assert.equal(sent.filter(s => s.text === warning).length, 1)
  assert.ok(bot.bills().some(b => b.name === 'Netflix'))
})

test('a deleted section is put back below the remaining text', async () => {
  const { bot, descs, edit } = await setup()
  edit('Só a descrição do grupo')
  await bot.onDescription('Só a descrição do grupo')
  assert.ok(descs.at(-1)!.startsWith('Só a descrição do grupo\n\n──── 🤖 contas-bot ────\nContas (edite esta lista):\nLuz'))
})

test('a refused description write warns once and keeps the bills', async () => {
  const { bot, wa, sent, edit } = await setup()
  wa.setDescription = async () => { throw new Error('not-authorized') }
  edit('──── 🤖 contas-bot ────\nLuz\nGás')
  await bot.onDescription('──── 🤖 contas-bot ────\nLuz\nGás')
  edit('──── 🤖 contas-bot ────\nLuz\nGás\nIPTU')
  await bot.onDescription('──── 🤖 contas-bot ────\nLuz\nGás\nIPTU')
  const warnings = sent.filter(s => s.text.startsWith('não consigo editar a descrição'))
  assert.equal(warnings.length, 1)
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Gás', 'IPTU'])
})

test('onboarding with a refused description write still never reads the group text as bills', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const w = fakeWa('Grupo da casa 🏠')
  w.wa.setDescription = async () => { throw new Error('not-authorized') }
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  assert.equal(await bot.join(), 'onboarded')
  await bot.onDescription('Grupo da casa 🏠')
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Água', 'Internet', 'Aluguel', 'Academia'])
  assert.equal(w.sent.filter(s => s.text.startsWith('não consigo editar a descrição')).length, 1)
})

test('a failed first list post leaves the group inactive so the next join retries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const w = fakeWa('Grupo')
  // the intro is send #1, the first list is send #2: fail the list
  let sends = 0
  const send = w.wa.sendText
  w.wa.sendText = async (t, q) => { if (++sends === 2) throw new Error('offline'); return send(t, q) }
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store })
  await assert.rejects(bot.join())
  assert.equal(store.get()._meta.last_reset, undefined)
  assert.equal(await bot.join(), 'onboarded')
})

test('a message queued behind an onboarding join is handled after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const w = fakeWa('Grupo')
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  await Promise.all([bot.join(), bot.onMessage(msg('/pago luz 10'))])
  assert.equal(store.get().months['2026-09'].luz.amount, 10)
})

test('restart before join does not repost the list and still handles a queued payment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const bills = parseDescription(DESC)
  store.get()._meta.last_reset = '2026-08'
  store.get()._meta.bills = bills.map(b => billLine(b))
  store.get()._meta.section = true
  const w = fakeWa(composeDescription('', bills)!)
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, now: () => new Date('2026-09-10T15:00:00Z') })
  // No bot.join(): this simulates onOpen's groups.update/messages.upsert reaching a freshly
  // built bot before its join() call has run.
  await bot.onDescription(composeDescription('', bills)!)
  assert.equal(w.sent.length, 0)
  await bot.onMessage(msg('pago luz'))
  assert.ok(store.get().months['2026-09'].luz)
})

test('a receipt captioned with /pago or "pago" uses the typed bill and amount', async () => {
  const { bot, store } = await setup({ verdict: { bill: 'Água', amount: 99, confidence: 0.99 } })
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('x') }
  await bot.onMessage(msg('/pago luz 231,45', { media }))
  assert.equal(store.get().months['2026-09'].luz.amount, 231.45)
  await bot.onMessage(msg('pago aluguel', { media, key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09'].aluguel.amount, 99)
  assert.equal(store.get().months['2026-09'].agua, undefined)
})

test('a receipt captioned /pago with an unknown bill says not found, like the text command', async () => {
  const { bot, store, sent, llmCalls } = await setup({ verdict: { bill: 'Luz', amount: 10, confidence: 0.99 } })
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('x') }
  await bot.onMessage(msg('/pago netflix', { media }))
  assert.equal(sent[0].text, 'não achei "netflix". Contas: Luz, Água, Aluguel, Cartão Nu, Mãe Carme')
  assert.deepEqual(llmCalls, [])
  assert.deepEqual(store.get().months['2026-09'] ?? {}, {})
})

test('a receipt captioned /pago with no bill name is read to find the bill', async () => {
  for (const [caption, amount] of [['/pago', 99], ['/pago 150,00', 150]] as const) {
    const { bot, store, llmCalls } = await setup({ verdict: { bill: 'Luz', amount: 99, confidence: 0.99 } })
    const media = { mime: 'image/jpeg', download: async () => Buffer.from('x') }
    await bot.onMessage(msg(caption, { media }))
    assert.equal(store.get().months['2026-09'].luz?.amount, amount, caption)
    assert.deepEqual(llmCalls, [`receipt:${caption}`])
  }
})

test('greetings aimed at the bot get the intro, a bare oi does not', async () => {
  const { bot, sent } = await setup()
  await bot.onMessage(msg('oi'))
  assert.equal(sent.length, 0)
  await bot.onMessage(msg('oi bot'))
  await bot.onMessage(msg('tudo certo?', { mentionsBot: true }))
  await bot.onMessage(msg('valeu', { repliesToBot: true }))
  assert.equal(sent.filter(s => s.text.startsWith('👋 Oi!')).length, 3)
})

test('a payment that mentions the bot is a payment, not a greeting', async () => {
  const { bot, store, sent } = await setup()
  await bot.onMessage(msg('pago luz', { mentionsBot: true }))
  assert.ok(store.get().months['2026-09'].luz)
  assert.equal(sent.filter(s => s.text.startsWith('👋')).length, 0)
})

test('/help lists every command; unknown commands point to /help', async () => {
  const { bot, sent } = await setup()
  await bot.onMessage(msg('/help'))
  assert.match(sent[0].text, /^🤖 \*Comandos do contas-bot\*/)
  for (const c of ['/pago', '/despago', '/lista', '/help']) assert.ok(sent[0].text.includes(c), c)
  await bot.onMessage(msg('/xyz'))
  assert.equal(sent[1].text, 'não conheço esse comando. /help mostra todos.')
})

test('an inactive group ignores messages and ticks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const w = fakeWa()
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store })
  await bot.onMessage(msg('/lista'))
  await bot.tick()
  assert.equal(w.sent.length, 0)
})

test('a receipt captioned with a bill name holding a digit marks that bill with the receipt amount', async () => {
  const { bot, store } = await setup({ desc: 'Cartão C6\nInternet 5G\nLuz', verdict: { bill: 'Cartão C6', amount: 1500, confidence: 0.99 } })
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('x') }
  await bot.onMessage(msg('/pago cartão c6', { media }))
  assert.equal(store.get().months['2026-09']['cartao c6']?.amount, 1500)
  await bot.onMessage(msg('/pago Internet 5G', { media, key: { id: 'm2', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09']['internet 5g']?.amount, 1500)
  assert.equal(store.get().months['2026-09']['cartao c6']?.message_id, 'm1')
})

test('a bill whose name ends in a number wins over reading that number as the amount', async () => {
  const { bot, store } = await setup({ desc: 'Apartamento\nApartamento 101\nLuz', verdict: { bill: 'Luz', amount: 80, confidence: 0.99 } })
  await bot.onMessage(msg('/pago apartamento 101'))
  assert.deepEqual(Object.keys(store.get().months['2026-09']), ['apartamento 101'])
  assert.equal(store.get().months['2026-09']['apartamento 101'].amount, null)
  await bot.onMessage(msg('/pago apartamento 250'))
  assert.equal(store.get().months['2026-09'].apartamento?.amount, 250)
  const media = { mime: 'image/jpeg', download: async () => Buffer.from('x') }
  await bot.onMessage(msg('/pago Apartamento 101', { media, key: { id: 'm3', fromMe: false, remoteJid: G } }))
  assert.equal(store.get().months['2026-09']['apartamento 101'].message_id, 'm3')
  assert.equal(store.get().months['2026-09']['apartamento 101'].amount, 80)
  assert.equal(store.get().months['2026-09'].luz, undefined)
})
