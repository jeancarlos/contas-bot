import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Ctx, decide } from '../../src/core/decide.ts'
import { normalize } from '../../src/core/text.ts'
import { emptyState, type GroupState, type Input, type MsgKey } from '../../src/core/types.ts'

const ctx: Ctx = { locale: { lang: 'pt-BR', currency: 'BRL', decimal: ',', timeZone: 'America/Sao_Paulo' }, llm: true }
const OCT = Date.UTC(2026, 9, 10, 15)
const NOV_1_LOCAL_LATE_OCT = Date.UTC(2026, 10, 1, 2)

function state(...names: string[]): GroupState {
  const s = emptyState()
  s.bills = names.map((name, i) => ({ id: i + 1, name, key: normalize(name), paused: false, removed: false }))
  s.nextBillId = names.length + 1
  s.lastReset = '2026-10'
  return s
}

let seq = 0
const key = (id = `m${++seq}`): MsgKey => ({ id, fromMe: false, remoteJid: 'g@g.us', participant: 'p@s.whatsapp.net' })
const msg = (text: string, extra: Partial<Extract<Input, { kind: 'message' }>> = {}): Input => ({
  kind: 'message',
  key: key(),
  sender: 'Gabi',
  text,
  at: OCT,
  ...extra,
})
const kinds = (effects: { kind: string }[]) => effects.map(e => e.kind)
const replies = (effects: ReturnType<typeof decide>['effects']) =>
  effects.flatMap(e => (e.kind === 'reply' ? [e.msg.k] : []))

test('chat that is not a slash command changes nothing and says nothing', () => {
  const s = state('Luz')
  for (const text of ['paguei a luz', 'luz', 'oi bot', '']) {
    const r = decide(s, msg(text), ctx)
    assert.deepEqual(r.effects, [])
    assert.deepEqual(r.state, s)
  }
})

test('/pago pays, reacts, posts the list and remembers the message as a change', () => {
  const r = decide(state('Luz'), msg('/pago luz 80'), ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.amount, 8000)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'typed')
  assert.deepEqual(kinds(r.effects), ['react', 'postList'])
  assert.equal(r.state.handled.at(-1)?.changed, true)
})

test('decide never mutates the state it was given', () => {
  const s = state('Luz')
  const before = structuredClone(s)
  decide(s, msg('/pago luz 80'), ctx)
  assert.deepEqual(s, before)
})

test('a redelivered message is ignored', () => {
  const m = msg('/pago luz 80')
  const once = decide(state('Luz'), m, ctx)
  const twice = decide(once.state, m, ctx)
  assert.deepEqual(twice.effects, [])
})

test('the payment month comes from the message timestamp in the group time zone', () => {
  const r = decide(state('Luz'), msg('/pago luz', { at: NOV_1_LOCAL_LATE_OCT }), ctx)
  assert.ok(r.state.months['2026-10']?.[1])
  assert.equal(r.state.months['2026-11'], undefined)
})

test('/pago with an explicit past month answers with that month list and leaves the pinned one alone', () => {
  const r = decide(state('Luz'), msg('/pago luz 80 09/2026'), ctx)
  assert.equal(r.state.months['2026-09']?.[1]?.amount, 8000)
  assert.deepEqual(kinds(r.effects), ['react', 'reply'])
  assert.deepEqual(replies(r.effects), ['list'])
})

test('off-path /pago answers with a suggestion or the syntax and changes nothing', () => {
  const s = state('Luz', 'Água')
  const cases: [string, string][] = [
    ['/pago lux 80', 'suggest'],
    ['/pago netflix', 'notFound'],
    ['/pago', 'missingBill'],
    ['/pago luz e agua', 'onePerCommand'],
    ['/pago luz R$80 R$90', 'pagoSyntax'],
    ['/pago luz 12/2026', 'futureMonth'],
    ['/pagp luz', 'unknownCmd'],
  ]
  for (const [text, k] of cases) {
    const r = decide(s, msg(text), ctx)
    assert.deepEqual(replies(r.effects), [k], text)
    assert.deepEqual(r.state.months, {}, text)
    assert.equal(r.state.handled.at(-1)?.changed, false, text)
  }
})

test('a suggestion carries the typed amount and month, copy-ready', () => {
  const r = decide(state('Luz'), msg('/pago lux 80 09/2026'), ctx)
  const reply = r.effects.find(e => e.kind === 'reply')
  assert.deepEqual(reply?.kind === 'reply' && reply.msg, {
    k: 'suggest',
    cmd: 'pago',
    bill: 'Luz',
    amount: 8000,
    month: '2026-09',
  })
})

test('repaying without an amount keeps the earlier amount and says atualizado', () => {
  const first = decide(state('Luz'), msg('/pago luz 80'), ctx)
  const again = decide(first.state, msg('/pago luz'), ctx)
  assert.equal(again.state.months['2026-10']?.[1]?.amount, 8000)
  assert.deepEqual(replies(again.effects), ['updated'])
})

test('a receipt without a typed amount is paid at once as pending and read once', () => {
  const media = { mime: 'image/png', handle: 'h' }
  const m = msg('/pago luz', { media })
  const r = decide(state('Luz'), m, ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'pending')
  assert.deepEqual(kinds(r.effects), ['react', 'readAmount'])
  const read = decide(
    r.state,
    {
      kind: 'amountRead',
      key: m.kind === 'message' ? m.key : key(),
      month: '2026-10',
      billId: 1,
      amount: 8010,
      at: OCT,
    },
    ctx,
  )
  assert.equal(read.state.months['2026-10']?.[1]?.amount, 8010)
  assert.equal(read.state.months['2026-10']?.[1]?.status, 'read')
  assert.deepEqual(kinds(read.effects), ['postList'])
})

test('a reply quoting a receipt reads the quoted media', () => {
  const r = decide(state('Luz'), msg('/pago luz', { quoted: { mime: 'image/jpeg', handle: 'q' } }), ctx)
  assert.deepEqual(kinds(r.effects), ['react', 'readAmount'])
})

test('without AI a receipt is paid without an amount and never read', () => {
  const r = decide(state('Luz'), msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } }), {
    ...ctx,
    llm: false,
  })
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'none')
  assert.deepEqual(kinds(r.effects), ['react', 'postList'])
})

test('a late amountRead after a newer /pago or a /despago is dropped', () => {
  const media = { mime: 'image/png', handle: 'h' }
  const receipt = msg('/pago luz', { media })
  const receiptKey = receipt.kind === 'message' ? receipt.key : key()
  const pending = decide(state('Luz'), receipt, ctx).state
  const late = { kind: 'amountRead', key: receiptKey, month: '2026-10', billId: 1, amount: 9999, at: OCT } as const
  const overwritten = decide(pending, msg('/pago luz 80'), ctx).state
  assert.equal(decide(overwritten, late, ctx).state.months['2026-10']?.[1]?.amount, 8000)
  const unpaid = decide(pending, msg('/despago luz'), ctx).state
  assert.equal(decide(unpaid, late, ctx).state.months['2026-10']?.[1], undefined)
})

test('an unreadable receipt becomes status none and says so', () => {
  const m = msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } })
  const pending = decide(state('Luz'), m, ctx).state
  const k = m.kind === 'message' ? m.key : key()
  const r = decide(pending, { kind: 'amountRead', key: k, month: '2026-10', billId: 1, amount: null, at: OCT }, ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'none')
  assert.deepEqual(replies(r.effects), ['noAmount'])
})

test('/despago removes the payment for the given month', () => {
  const paid = decide(state('Luz'), msg('/pago luz 80 09/2026'), ctx).state
  const r = decide(paid, msg('/despago luz 09/2026'), ctx)
  assert.equal(r.state.months['2026-09']?.[1], undefined)
})

test('an edit fixes a command that changed nothing, and is refused once after a payment', () => {
  const typo = msg('/pago lux 80')
  const k = typo.kind === 'message' ? typo.key : key()
  const after = decide(state('Luz'), typo, ctx).state
  const fixed = decide(after, { kind: 'edit', key: k, sender: 'Gabi', text: '/pago luz 80', at: OCT }, ctx)
  assert.equal(fixed.state.months['2026-10']?.[1]?.amount, 8000)
  const edit2 = { kind: 'edit', key: k, sender: 'Gabi', text: '/pago luz 90', at: OCT } as const
  const refused = decide(fixed.state, edit2, ctx)
  assert.deepEqual(replies(refused.effects), ['editIgnored'])
  assert.equal(refused.state.months['2026-10']?.[1]?.amount, 8000)
  assert.deepEqual(decide(refused.state, edit2, ctx).effects, [])
})

test('an edit of a payment whose handled entry was pruned is still refused via the payment record', () => {
  const m = msg('/pago luz 80')
  const k = m.kind === 'message' ? m.key : key()
  const paid = decide(state('Luz'), m, ctx).state
  paid.handled = []
  const r = decide(paid, { kind: 'edit', key: k, sender: 'Gabi', text: '/pago luz 90', at: OCT }, ctx)
  assert.deepEqual(replies(r.effects), ['editIgnored'])
})

test('/conta manages bills and answers each change with the bill list', () => {
  let s = state('Luz', 'Cartão Nu')
  const step = (text: string) => {
    const r = decide(s, msg(text), ctx)
    s = r.state
    return replies(r.effects)
  }
  assert.deepEqual(step('/conta adiciona Internet'), ['bills'])
  assert.deepEqual(
    s.bills.map(b => b.name),
    ['Luz', 'Cartão Nu', 'Internet'],
  )
  assert.deepEqual(step('/conta adiciona internet'), ['nameTaken'])
  assert.deepEqual(step(`/conta adiciona ${'x'.repeat(41)}`), ['nameInvalid'])
  assert.deepEqual(step('/bill pause luz'), ['bills'])
  assert.equal(s.bills[0]?.paused, true)
  assert.deepEqual(step('/conta continua luz'), ['bills'])
  assert.equal(s.bills[0]?.paused, false)
  assert.deepEqual(step('/conta renomeia cartão nu = Nubank'), ['bills'])
  assert.equal(s.bills[1]?.name, 'Nubank')
  assert.equal(s.bills[1]?.id, 2)
  assert.deepEqual(step('/conta remove internet'), ['bills'])
  assert.equal(s.bills[2]?.removed, true)
  assert.deepEqual(step('/conta adiciona Internet'), ['bills'])
  assert.equal(s.bills.length, 3)
  assert.deepEqual(step('/conta remove netflix'), ['notFound'])
  assert.deepEqual(step('/conta pausaa luz'), ['unknownSub'])
  assert.deepEqual(step('/conta renomeia luz'), ['contaHelp'])
  assert.deepEqual(step('/conta'), ['bills'])
})

test('a rename keeps the payment, because payments hang on the bill id', () => {
  const paid = decide(state('Cartão Nu'), msg('/pago cartão nu 50'), ctx).state
  const r = decide(paid, msg('/conta renomeia cartão nu = Nubank'), ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.amount, 5000)
})

test('listPosted pins the new list and unpins the previous one', () => {
  const s = state('Luz')
  s.pinnedId = 'old'
  const r = decide(s, { kind: 'listPosted', messageId: 'new' }, ctx)
  assert.equal(r.state.pinnedId, 'new')
  assert.deepEqual(r.effects, [
    { kind: 'pin', messageId: 'new' },
    { kind: 'unpin', messageId: 'old' },
  ])
})

test('tick posts a fresh list once per month and never before onboarding', () => {
  const s = state('Luz')
  s.lastReset = '2026-09'
  const r = decide(s, { kind: 'tick', at: OCT }, ctx)
  assert.equal(r.state.lastReset, '2026-10')
  assert.deepEqual(kinds(r.effects), ['postList'])
  assert.deepEqual(decide(r.state, { kind: 'tick', at: OCT }, ctx).effects, [])
  const fresh = { ...s, lastReset: null }
  assert.deepEqual(decide(fresh, { kind: 'tick', at: OCT }, ctx).effects, [])
})

test('the bot never answers its own messages', () => {
  const r = decide(state('Luz'), msg('/pago luz', { key: { ...key(), fromMe: true } }), ctx)
  assert.deepEqual(r.effects, [])
})

test('/conta adiciona that looks like a payment points to /pago and creates nothing', () => {
  const s = state('Luz')
  const r = decide(s, msg('/conta adicionar luz 80 09/2026'), ctx)
  assert.equal(r.state.bills.length, 1)
  const reply = r.effects.find(e => e.kind === 'reply')
  assert.deepEqual(reply?.kind === 'reply' && reply.msg, {
    k: 'suggest',
    cmd: 'pago',
    bill: 'Luz',
    amount: 8000,
    month: '2026-09',
  })
  assert.deepEqual(replies(decide(s, msg('/conta adiciona netflix R$ 50'), ctx).effects), ['pagoSyntax'])
  assert.deepEqual(replies(decide(s, msg('/conta adiciona Apto 101'), ctx).effects), ['bills'])
  assert.deepEqual(replies(decide(s, msg('/conta adiciona Maio'), ctx).effects), ['bills'])
})
