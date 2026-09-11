import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBot, type Incoming, type MsgKey, type Wa } from '../src/bot.ts'
import { openState } from '../src/state.ts'
import { parseDescription, composeDescription, billLine } from '../src/bills.ts'
import type { Llm, Verdict } from '../src/llm.ts'

const G = '123@g.us'
const DESC = 'Luz\nÁgua\nAluguel\nCartão Nu\nMãe Carme (pausado)'

function fakeWa(desc = DESC, phones: (string | null)[] = ['5549111111111']) {
  let n = 0
  const sent: { text: string; quoted?: MsgKey }[] = []
  const reactions: { key: MsgKey; emoji: string }[] = []
  const pins: string[] = []
  const descs: string[] = []
  let left = false
  const wa: Wa = {
    async sendText(text, quoted) { sent.push({ text, quoted }); return { id: `s${++n}`, fromMe: true, remoteJid: G } },
    async react(key, emoji) { reactions.push({ key, emoji }) },
    async pin(key) { pins.push(`pin:${key.id}`) },
    async unpin(key) { pins.push(`unpin:${key.id}`) },
    async getDescription() { return desc },
    async setDescription(text) { descs.push(text); desc = text },
    async leave() { left = true },
    async memberPhones() { return phones },
  }
  // A member edit: the current description changes, then the event arrives.
  const edit = (text: string) => { desc = text }
  return { wa, sent, reactions, pins, descs, edit, isLeft: () => left }
}

function fakeLlm(verdict: Verdict | null) {
  const calls: string[] = []
  const llm: Llm = {
    async interpretCaption(text) { calls.push(`caption:${text}`); return verdict },
    async readReceipt(_img, _mime, caption) { calls.push(`receipt:${caption}`); return verdict },
  }
  return { llm, calls }
}

async function setup(opts: { verdict?: Verdict | null; desc?: string; now?: Date; phones?: (string | null)[]; owners?: string[]; fresh?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  if (!opts.fresh) store.get()._meta.last_reset = '2026-08'
  const w = fakeWa(opts.desc, opts.phones)
  const l = fakeLlm(opts.verdict ?? null)
  const bot = makeBot({ wa: w.wa, llm: l.llm, store, owners: opts.owners ?? ['5549111111111'], now: () => opts.now ?? new Date('2026-09-10T15:00:00Z') })
  await bot.join()
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
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, owners: [] })
  await bot.join()
  assert.deepEqual(bot.bills().map(b => b.name), ['Luz', 'Água'])
  assert.ok(w.descs[0].includes('Luz\nÁgua'))
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
  const { bot, sent, edit } = await setup()
  edit('──── 🤖 contas-bot ────\nLuz\nNetflix')
  await bot.onDescription('──── 🤖 contas-bot ────\nLuz\nNetflix')
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
  assert.equal(store.get()._meta.last_reset, '2026-08')
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

test('join leaves a group without an owner and stores nothing', async () => {
  const { store, sent, descs, isLeft } = await setup({ fresh: true, phones: ['5511000000000'] })
  assert.equal(sent[0].text, 'sou um bot privado 🤖')
  assert.equal(isLeft(), true)
  assert.equal(descs.length, 0)
  assert.equal(store.get()._meta.last_reset, undefined)
})

test('join does not leave when member phones cannot be resolved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const w = fakeWa(DESC, [null])
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, owners: ['5549111111111'] })
  await assert.rejects(bot.join())
  assert.equal(w.isLeft(), false)
})

test('join onboards when an owner is resolvable even if another member is not', async () => {
  const { store, isLeft } = await setup({ fresh: true, phones: ['5549111111111', null] })
  assert.equal(store.get()._meta.last_reset, '2026-09')
  assert.equal(isLeft(), false)
})

test('owners match member phones across the Brazilian ninth digit, both ways', async () => {
  for (const [owner, phone] of [['5534999998888', '553499998888'], ['553499998888', '5534999998888']]) {
    const { store, isLeft } = await setup({ fresh: true, owners: [owner], phones: [phone] })
    assert.equal(store.get()._meta.last_reset, '2026-09', `${owner} vs ${phone}`)
    assert.equal(isLeft(), false)
  }
})

test('join migrates a legacy group: description becomes the section, no intro', async () => {
  const { bot, sent, descs } = await setup()
  assert.equal(sent.length, 0)
  assert.ok(descs[0].startsWith('──── 🤖 contas-bot ────\nContas (edite esta lista):\nLuz\nÁgua'))
  assert.ok(descs[0].includes('Mãe Carme (pausado)'))
  assert.equal(bot.bills().length, 5)
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
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, owners: ['5549111111111'], now: () => new Date('2026-09-10T15:00:00Z') })
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
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, owners: ['5549111111111'] })
  await assert.rejects(bot.join())
  assert.equal(store.get()._meta.last_reset, undefined)
  assert.equal(await bot.join(), 'onboarded')
})

test('a message queued behind an onboarding join is handled after it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const w = fakeWa('Grupo')
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, owners: ['5549111111111'], now: () => new Date('2026-09-10T15:00:00Z') })
  await Promise.all([bot.join(), bot.onMessage(msg('/pago luz 10'))])
  assert.equal(store.get().months['2026-09'].luz.amount, 10)
})

test('restart before join does not repost the list and still handles a queued payment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const store = (await openState(join(dir, 'state.json'))).forGroup(G)
  const bills = parseDescription(DESC)
  store.get()._meta.last_reset = '2026-08'
  store.get()._meta.bills = bills.map(billLine)
  store.get()._meta.section = true
  const w = fakeWa(composeDescription('', bills)!, ['5549111111111'])
  const bot = makeBot({ wa: w.wa, llm: fakeLlm(null).llm, store, owners: ['5549111111111'], now: () => new Date('2026-09-10T15:00:00Z') })
  // No bot.join(): this simulates onOpen's groups.update/messages.upsert reaching a freshly
  // built bot before its join() call has run.
  await bot.onDescription(composeDescription('', bills))
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
  const { bot, sent } = await setup({ fresh: true, phones: ['5511000000000'] })
  const before = sent.length
  await bot.onMessage(msg('/lista'))
  await bot.tick()
  assert.equal(sent.length, before)
})
