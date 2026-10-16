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

test('a backlog payment from last month never re-pins last month after the new list went up', () => {
  const s = state('Luz')
  const nov = decide(s, { kind: 'tick', at: Date.UTC(2026, 10, 1, 12) }, ctx).state
  const pinned = decide(nov, { kind: 'listPosted', messageId: 'L-nov' }, ctx).state
  const late = decide(pinned, msg('/pago luz 80', { at: NOV_1_LOCAL_LATE_OCT }), ctx)
  assert.equal(late.state.months['2026-10']?.[1]?.amount, 8000)
  assert.deepEqual(kinds(late.effects), ['react', 'reply'])
  assert.deepEqual(replies(late.effects), ['list'])
  assert.equal(late.state.pinnedId, 'L-nov')
  const lista = decide(pinned, msg('/lista', { at: NOV_1_LOCAL_LATE_OCT }), ctx)
  const posted = lista.effects.find(e => e.kind === 'postList')
  assert.equal(posted?.kind === 'postList' && posted.msg.month, '2026-11')
})
test('/despago ambiguity suggests /despago', () => {
  const s = state('Luz', 'Água')
  const r = decide(s, msg('/despago luz e agua'), ctx)
  const reply = r.effects.find(e => e.kind === 'reply')
  assert.deepEqual(reply?.kind === 'reply' && reply.msg, { k: 'onePerCommand', cmd: 'despago', bills: ['Luz', 'Água'] })
})
test('a revived bill is no longer paused', () => {
  let s = state('Luz')
  for (const t of ['/conta adiciona Gas', '/conta pausa Gas', '/conta remove Gas', '/conta adiciona Gas'])
    s = decide(s, msg(t), ctx).state
  assert.equal(s.bills.find(b => b.name === 'Gas')?.paused, false)
})
test('a bill name with an old-looking fraction is not a payment, a recent one is', () => {
  const r = decide(state('Luz'), msg('/conta adiciona Parcela 3/10'), ctx)
  assert.ok(r.state.bills.some(b => b.name === 'Parcela 3/10'))
  const r2 = decide(state('Luz'), msg('/conta adiciona IPVA 1/26'), ctx)
  assert.ok(!r2.state.bills.some(b => b.name === 'IPVA 1/26'))
})
test('a tick in an earlier month than lastReset does nothing', () => {
  const s = state('Luz')
  s.lastReset = '2026-11'
  const r = decide(s, { kind: 'tick', at: OCT }, ctx)
  assert.deepEqual(r.effects, [])
  assert.equal(r.state.lastReset, '2026-11')
})

test('/pago avulsa pays a one-off: on that month list, never a permanent bill', () => {
  const r = decide(state('Luz'), msg('/pago avulsa Farmácia R$ 45,90'), ctx)
  const bill = r.state.bills.find(b => b.name === 'Farmácia')
  assert.equal(bill?.removed, true)
  assert.equal(r.state.months['2026-10']?.[bill?.id ?? 0]?.amount, 4590)
  assert.deepEqual(kinds(r.effects), ['react', 'postList'])
  const posted = r.effects.find(e => e.kind === 'postList')
  assert.ok(posted?.kind === 'postList' && posted.msg.items.some(i => i.name === 'Farmácia' && i.paid))
  const conta = decide(r.state, msg('/conta'), ctx).effects.find(e => e.kind === 'reply')
  assert.deepEqual(conta?.kind === 'reply' && conta.msg, { k: 'bills', bills: [{ name: 'Luz', paused: false }] })
  const nov = decide(r.state, { kind: 'tick', at: Date.UTC(2026, 10, 1, 12) }, ctx)
  const next = nov.effects.find(e => e.kind === 'postList')
  assert.deepEqual(next?.kind === 'postList' && next.msg.items.map(i => i.name), ['Luz'])
})

test('/pago avulsa takes the amount at either end, a past month, and reuses the one-off by name', () => {
  let s = state('Luz')
  s = decide(s, msg('/pago extra 30 uber'), ctx).state
  s = decide(s, msg('/pago avulso Uber 25 09/2026'), ctx).state
  const ids = s.bills.filter(b => b.key === 'uber').map(b => b.id)
  assert.equal(ids.length, 1)
  assert.equal(s.months['2026-10']?.[ids[0] ?? 0]?.amount, 3000)
  assert.equal(s.months['2026-09']?.[ids[0] ?? 0]?.amount, 2500)
  const again = decide(s, msg('/pago avulsa uber 40'), ctx)
  assert.equal(again.state.months['2026-10']?.[ids[0] ?? 0]?.amount, 4000)
  assert.deepEqual(replies(again.effects), ['updated'])
})

test('/pago avulsa refuses a misparsed name and creates nothing', () => {
  const s = state('Luz', 'Cartão Nu', 'Cartão Itaú')
  const cases: [string, string][] = [
    ['/pago avulsa farmácia', 'oneOffSyntax'],
    ['/pago avulsa 50', 'oneOffSyntax'],
    ['/pago avulsa farmácia 2 50', 'oneOffSyntax'],
    ['/pago avulsa farmácia R$ 50 R$ 10', 'oneOffSyntax'],
    ['/pago avulsa farmácia R$', 'oneOffSyntax'],
    ['/pago avulsa farmácia 50 09/2026 08/2026', 'oneOffSyntax'],
    [`/pago avulsa ${'x'.repeat(41)} 50`, 'nameInvalid'],
    ['/pago avulsa luz 50', 'suggest'],
    ['/pago avulsa lux 50', 'suggest'],
    ['/pago avulsa cartão 50', 'onePerCommand'],
    ['/pago avulsa farmácia 50 12/2026', 'futureMonth'],
  ]
  for (const [text, k] of cases) {
    const r = decide(s, msg(text), ctx)
    assert.deepEqual(replies(r.effects), [k], text)
    assert.deepEqual(r.state.bills, s.bills, text)
    assert.deepEqual(r.state.months, {}, text)
    assert.equal(r.state.handled.at(-1)?.changed, false, text)
  }
  const reply = decide(s, msg('/pago avulsa lux 50'), ctx).effects.find(e => e.kind === 'reply')
  assert.deepEqual(reply?.kind === 'reply' && reply.msg, {
    k: 'suggest',
    cmd: 'pago',
    bill: 'Luz',
    amount: 5000,
    month: null,
  })
})

test('a bill whose name holds the one-off word is still paid as itself', () => {
  const r = decide(state('Hora Extra'), msg('/pago hora extra 80'), ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.amount, 8000)
  assert.equal(r.state.bills.length, 1)
})

test('/pago avulsa with a receipt and no typed amount reads it', () => {
  const r = decide(state('Luz'), msg('/pago avulsa farmácia', { media: { mime: 'image/png', handle: 'h' } }), ctx)
  const bill = r.state.bills.find(b => b.key === 'farmacia')
  assert.equal(r.state.months['2026-10']?.[bill?.id ?? 0]?.status, 'pending')
  assert.deepEqual(kinds(r.effects), ['react', 'readAmount'])
})

test('/despago undoes a one-off, which then leaves the list', () => {
  const paid = decide(state('Luz'), msg('/pago avulsa farmácia 50'), ctx).state
  const r = decide(paid, msg('/despago farmacia'), ctx)
  assert.deepEqual(r.state.months['2026-10'], {})
  const posted = r.effects.find(e => e.kind === 'postList')
  assert.deepEqual(posted?.kind === 'postList' && posted.msg.items.map(i => i.name), ['Luz'])
  assert.equal(r.state.handled.at(-1)?.changed, true)
})

test('a one-off later added with /conta becomes permanent and keeps its payment', () => {
  const paid = decide(state('Luz'), msg('/pago avulsa farmácia 50'), ctx).state
  const r = decide(paid, msg('/conta adiciona Farmácia'), ctx).state
  const bill = r.bills.find(b => b.key === 'farmacia')
  assert.equal(bill?.removed, false)
  assert.equal(r.months['2026-10']?.[bill?.id ?? 0]?.amount, 5000)
})
