import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type Ctx, decide, listMsg } from '../../src/core/decide.ts'
import { render } from '../../src/core/i18n.ts'
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
  sender: 'Ana',
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
    ['/pago lux 80', 'askConfirm'],
    ['/pago netflix', 'notFound'],
    ['/pago', 'missingBill'],
    ['/pago luz e agua', 'askBill'],
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
    k: 'askConfirm',
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
  assert.deepEqual(kinds(r.effects), ['react', 'postList', 'reply'])
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
  assert.deepEqual(replies(r.effects), ['askAmount'])
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
  const fixed = decide(after, { kind: 'edit', key: k, sender: 'Ana', text: '/pago luz 80', at: OCT }, ctx)
  assert.equal(fixed.state.months['2026-10']?.[1]?.amount, 8000)
  const edit2 = { kind: 'edit', key: k, sender: 'Ana', text: '/pago luz 90', at: OCT } as const
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
  const r = decide(paid, { kind: 'edit', key: k, sender: 'Ana', text: '/pago luz 90', at: OCT }, ctx)
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

test('join onboards a new group once: lastReset, the intro and the list, no demo bills', () => {
  const r = decide(emptyState(), { kind: 'join', jid: 'g@g.us', at: OCT, startup: true, reading: [] }, ctx)
  assert.equal(r.state.lastReset, '2026-10')
  assert.deepEqual(r.state.bills, [])
  assert.deepEqual(r.effects, [
    { kind: 'send', msg: { k: 'intro' } },
    { kind: 'postList', msg: { k: 'list', month: '2026-10', items: [] } },
  ])
  assert.deepEqual(
    decide(r.state, { kind: 'join', jid: 'g@g.us', at: OCT, startup: false, reading: [] }, ctx).effects,
    [],
  )
})

test('a startup join turns pending amounts into none once, quoting each receipt', () => {
  const m = msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } })
  const k = m.kind === 'message' ? m.key : key()
  const pending = decide(state('Luz'), m, ctx).state
  const r = decide(pending, { kind: 'join', jid: 'g@g.us', at: OCT, startup: true, reading: [] }, ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'none')
  assert.deepEqual(r.effects, [
    { kind: 'reply', to: { id: k.id, fromMe: false, remoteJid: 'g@g.us' }, msg: { k: 'noAmount' } },
  ])
  assert.deepEqual(
    decide(pending, { kind: 'join', jid: 'g@g.us', at: OCT, startup: false, reading: [] }, ctx).effects,
    [],
  )
  const live = decide(pending, { kind: 'join', jid: 'g@g.us', at: OCT, startup: true, reading: [k.id] }, ctx)
  assert.deepEqual(live.effects, [])
  assert.equal(live.state.months['2026-10']?.[1]?.status, 'pending')
})

test('an edit of a /conta change gets the neutral wording, an edit of a payment the /despago hint', () => {
  const add = msg('/conta adiciona Gás')
  const addKey = add.kind === 'message' ? add.key : key()
  const added = decide(state('Luz'), add, ctx).state
  const editAdd = decide(added, { kind: 'edit', key: addKey, sender: 'Ana', text: '/conta adiciona Gas', at: OCT }, ctx)
  assert.deepEqual(
    editAdd.effects.flatMap(e => (e.kind === 'reply' ? [e.msg] : [])),
    [{ k: 'editIgnored', payment: false }],
  )
  const pay = msg('/pago luz 80')
  const payKey = pay.kind === 'message' ? pay.key : key()
  const paid = decide(state('Luz'), pay, ctx).state
  const editPay = decide(paid, { kind: 'edit', key: payKey, sender: 'Ana', text: '/pago luz 90', at: OCT }, ctx)
  assert.deepEqual(
    editPay.effects.flatMap(e => (e.kind === 'reply' ? [e.msg] : [])),
    [{ k: 'editIgnored', payment: true }],
  )
})

test('an edited receipt caption is read like the original receipt', () => {
  const media = { mime: 'image/png', handle: 'h' }
  const typo = msg('/pago lux', { media })
  const k = typo.kind === 'message' ? typo.key : key()
  const after = decide(state('Luz'), typo, ctx).state
  const r = decide(after, { kind: 'edit', key: k, sender: 'Ana', text: '/pago luz', at: OCT, media }, ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'pending')
  assert.deepEqual(kinds(r.effects), ['react', 'readAmount'])
})

test('/conta remove and renomeia need the exact name, pausa and continua take a unique prefix', () => {
  let s = state('Luz', 'Internet')
  const step = (text: string) => {
    const r = decide(s, msg(text), ctx)
    s = r.state
    return replies(r.effects)
  }
  assert.deepEqual(step('/conta remove inter'), ['notFound'])
  assert.deepEqual(step('/conta renomeia inter = Net'), ['notFound'])
  assert.deepEqual(
    s.bills.map(b => [b.name, b.removed]),
    [
      ['Luz', false],
      ['Internet', false],
    ],
  )
  assert.deepEqual(step('/conta pausa inter'), ['bills'])
  assert.equal(s.bills[1]?.paused, true)
  assert.deepEqual(step('/conta remove INTERNET'), ['bills'])
  assert.equal(s.bills[1]?.removed, true)
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
  assert.equal(again.state.months['2026-10']?.[ids[0] ?? 0]?.amount, 7000)
  assert.deepEqual(replies(again.effects), [])
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
    ['/pago avulsa luz 50', 'askConfirm'],
    ['/pago avulsa lux 50', 'askConfirm'],
    ['/pago avulsa cartão 50', 'askBill'],
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
    k: 'askConfirm',
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

const other = (text: string) => msg(text, { key: { ...key(), participant: 'other@s.whatsapp.net' } })
const amountRead = (m: Input, amount: number | null): Input => ({
  kind: 'amountRead',
  key: m.kind === 'message' ? m.key : key(),
  month: '2026-10',
  billId: 1,
  amount,
  at: OCT,
})

test('an unreadable receipt asks the sender for the amount and takes only their plain amount', () => {
  const receipt = msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } })
  const asked = decide(decide(state('Luz'), receipt, ctx).state, amountRead(receipt, null), ctx).state
  assert.equal(asked.asks.length, 1)
  const fromOther = decide(asked, other('90'), ctx)
  assert.deepEqual(fromOther.effects, [])
  const r = decide(fromOther.state, msg('R$ 80,50'), ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.amount, 8050)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'typed')
  assert.deepEqual(kinds(r.effects), ['react', 'postList'])
  assert.deepEqual(r.state.asks, [])
})

test('chat that is not a clean answer closes the question and changes nothing', () => {
  const receipt = msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } })
  const asked = decide(decide(state('Luz'), receipt, ctx).state, amountRead(receipt, null), ctx).state
  const chat = decide(asked, msg('comprei 2 pizzas'), ctx)
  assert.deepEqual(chat.effects, [])
  assert.deepEqual(chat.state.asks, [])
  assert.equal(decide(chat.state, msg('80'), ctx).state.months['2026-10']?.[1]?.amount, null)
})

test('a question expires after ten minutes', () => {
  const receipt = msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } })
  const asked = decide(decide(state('Luz'), receipt, ctx).state, amountRead(receipt, null), ctx).state
  const late = decide(asked, msg('80', { at: OCT + 11 * 60_000 }), ctx)
  assert.deepEqual(late.effects, [])
  assert.equal(late.state.months['2026-10']?.[1]?.amount, null)
})

test('without AI a receipt asks for the amount right away', () => {
  const noLlm = { ...ctx, llm: false }
  const r = decide(state('Luz'), msg('/pago luz', { media: { mime: 'image/png', handle: 'h' } }), noLlm)
  assert.deepEqual(replies(r.effects), ['askAmount'])
  assert.equal(decide(r.state, msg('80'), noLlm).state.months['2026-10']?.[1]?.amount, 8000)
  const known = decide(state('Luz'), msg('/pago luz 80', { media: { mime: 'image/png', handle: 'h' } }), noLlm)
  assert.deepEqual(known.state.asks, [])
})

test('a typo asks to confirm the closest bill, and sim pays it', () => {
  const asked = decide(state('Luz'), msg('/pago lux 80'), ctx)
  assert.deepEqual(replies(asked.effects), ['askConfirm'])
  const no = decide(asked.state, msg('não'), ctx)
  assert.deepEqual(no.effects, [])
  assert.deepEqual(no.state.months, {})
  const yes = decide(asked.state, msg('Sim'), ctx)
  assert.equal(yes.state.months['2026-10']?.[1]?.amount, 8000)
  assert.deepEqual(kinds(yes.effects), ['react', 'postList'])
  assert.equal(yes.state.handled.at(-1)?.changed, true)
})

test('a /despago typo confirmed with sim unpays', () => {
  const paid = decide(state('Luz'), msg('/pago luz 80'), ctx).state
  const asked = decide(paid, msg('/despago lux'), ctx).state
  assert.equal(decide(asked, msg('sim'), ctx).state.months['2026-10']?.[1], undefined)
})

test('a new command from the sender drops their open question', () => {
  const asked = decide(state('Luz', 'Água'), msg('/pago lux 80'), ctx).state
  const next = decide(asked, msg('/pago agua 50'), ctx).state
  assert.deepEqual(next.asks, [])
  assert.equal(decide(next, msg('sim'), ctx).state.months['2026-10']?.[1], undefined)
})

test('a receipt with a bare /pago asks which bill, and the answer pays it with the receipt', () => {
  const asked = decide(state('Luz', 'Água'), msg('/pago', { media: { mime: 'image/png', handle: 'h' } }), ctx)
  assert.deepEqual(replies(asked.effects), ['askBill'])
  assert.deepEqual(decide(asked.state, msg('netflix'), ctx).effects, [])
  const r = decide(asked.state, msg('a luz'), ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.status, 'pending')
  assert.deepEqual(kinds(r.effects), ['react', 'readAmount'])
  assert.deepEqual(replies(decide(state('Luz'), msg('/pago'), ctx).effects), ['missingBill'])
})

test('a one-off receipt without AI is saved and asks for the amount', () => {
  const noLlm = { ...ctx, llm: false }
  const r = decide(state('Luz'), msg('/pago avulsa farmácia', { media: { mime: 'image/png', handle: 'h' } }), noLlm)
  const bill = r.state.bills.find(b => b.key === 'farmacia')
  assert.equal(bill?.removed, true)
  assert.deepEqual(replies(r.effects), ['askAmount'])
  assert.equal(decide(r.state, msg('45,90'), noLlm).state.months['2026-10']?.[bill?.id ?? 0]?.amount, 4590)
})

test('an ambiguous bill asks which one and the answer pays it with the typed amount', () => {
  const s = state('Luz', 'Cartão Nu', 'Cartão Itaú')
  const asked = decide(s, msg('/pago cartão 50'), ctx)
  const q = asked.effects.find(e => e.kind === 'reply')
  assert.deepEqual(q?.kind === 'reply' && q.msg, { k: 'askBill', names: ['Cartão Nu', 'Cartão Itaú'] })
  const r = decide(asked.state, msg('nu'), ctx)
  assert.equal(r.state.months['2026-10']?.[2]?.amount, 5000)
  assert.deepEqual(kinds(r.effects), ['react', 'postList'])
})

test('an ambiguous bill with a receipt lets the AI pick among the matches only', () => {
  const s = state('Luz', 'Cartão Nu', 'Cartão Itaú')
  const media = { mime: 'image/png', handle: 'h' }
  const asked = decide(s, msg('/pago cartão', { media }), ctx)
  const pick = asked.effects.find(e => e.kind === 'pickBill')
  assert.ok(pick?.kind === 'pickBill')
  if (pick?.kind !== 'pickBill') return
  const { kind: _, ...p } = pick
  assert.deepEqual(
    p.bills.map(b => b.name),
    ['Cartão Nu', 'Cartão Itaú'],
  )
  assert.deepEqual(asked.state.months, {})
  const picked = decide(asked.state, { kind: 'billPicked', pick: p, billId: 3, amount: 12000 }, ctx)
  assert.equal(picked.state.months['2026-10']?.[3]?.amount, 12000)
  assert.equal(picked.state.months['2026-10']?.[3]?.status, 'read')
  const outside = decide(asked.state, { kind: 'billPicked', pick: p, billId: 1, amount: 12000 }, ctx)
  assert.deepEqual(outside.state.months, {})
  assert.deepEqual(replies(outside.effects), ['askBill'])
  const unsure = decide(asked.state, { kind: 'billPicked', pick: p, billId: null, amount: null }, ctx)
  assert.deepEqual(replies(unsure.effects), ['askBill'])
  const answered = decide(unsure.state, msg('itaú'), ctx)
  assert.deepEqual(kinds(answered.effects), ['react', 'readAmount'])
  const noAmount = decide(asked.state, { kind: 'billPicked', pick: p, billId: 2, amount: null }, ctx)
  assert.deepEqual(replies(noAmount.effects), ['askAmount'])
  assert.equal(decide(noAmount.state, msg('99'), ctx).state.months['2026-10']?.[2]?.amount, 9900)
})

test('an unknown bill with an amount offers a one-off, and sim records it', () => {
  const s = state('Luz')
  const asked = decide(s, msg('/pago Farmácia 45,90'), ctx)
  const q = asked.effects.find(e => e.kind === 'reply')
  assert.deepEqual(q?.kind === 'reply' && q.msg, { k: 'askOneOff', name: 'Farmácia' })
  assert.deepEqual(asked.state.bills, s.bills)
  const r = decide(asked.state, msg('sim'), ctx)
  const bill = r.state.bills.find(b => b.key === 'farmacia')
  assert.equal(bill?.removed, true)
  assert.equal(r.state.months['2026-10']?.[bill?.id ?? 0]?.amount, 4590)
  assert.deepEqual(replies(decide(s, msg('/pago netflix'), ctx).effects), ['notFound'])
  assert.deepEqual(replies(decide(s, msg('/pago netflix 2 50'), ctx).effects), ['notFound'])
})

test('answering a one-off offer with a bill name pays that bill instead', () => {
  const asked = decide(state('Luz', 'Água'), msg('/pago energia 80'), ctx).state
  const r = decide(asked, msg('luz'), ctx)
  assert.equal(r.state.months['2026-10']?.[1]?.amount, 8000)
  assert.equal(r.state.bills.length, 2)
})

test('a typed thumbs up confirms', () => {
  const asked = decide(state('Luz'), msg('/pago lux 80'), ctx).state
  assert.equal(decide(asked, msg('👍🏽'), ctx).state.months['2026-10']?.[1]?.amount, 8000)
  assert.equal(decide(asked, msg('👍'), ctx).state.months['2026-10']?.[1]?.amount, 8000)
})

function picking(s: GroupState) {
  const receipt = msg('/pago cartão', { media: { mime: 'image/png', handle: 'h' } })
  const asked = decide(s, receipt, ctx)
  const fx = asked.effects.find(e => e.kind === 'pickBill')
  if (fx?.kind !== 'pickBill') throw new Error('no pickBill')
  const { kind: _, ...pick } = fx
  const picked = (st: GroupState, billId: number, amount: number | null) =>
    decide(st, { kind: 'billPicked', pick, billId, amount }, ctx)
  return { state: asked.state, receipt, picked }
}

const cards = () => state('Luz', 'Cartão Nu', 'Cartão Itaú')

test('a late pick is dropped once its sender retyped a /pago without a receipt, even for another bill', () => {
  const p = picking(cards())
  const typed = decide(p.state, msg('/pago cartão nu 120'), ctx).state
  const r = p.picked(typed, 3, 9900)
  assert.deepEqual(r.effects, [])
  assert.equal(r.state.months['2026-10']?.[3], undefined)
  assert.equal(r.state.months['2026-10']?.[2]?.amount, 12000)
  const undone = p.picked(decide(p.state, msg('/despago luz'), ctx).state, 3, 9900)
  assert.equal(undone.state.months['2026-10']?.[3], undefined)
})

test('other commands from the sender keep their pending pick', () => {
  for (const text of ['/lista', '/ajuda', '/conta', '/pago luz 80']) {
    const p = picking(cards())
    const media = text.startsWith('/pago') ? { media: { mime: 'image/png', handle: 'h2' } } : {}
    const r = p.picked(decide(p.state, msg(text, media), ctx).state, 3, 9900)
    assert.equal(r.state.months['2026-10']?.[3]?.amount, 9900, text)
  }
})

test('two ambiguous receipts from one sender are both paid when their picks resolve', () => {
  const first = picking(cards())
  const second = msg('/pago cartão', { media: { mime: 'image/png', handle: 'h2' } })
  const asked = decide(first.state, second, ctx)
  const fx = asked.effects.find(e => e.kind === 'pickBill')
  if (fx?.kind !== 'pickBill') throw new Error('no pickBill')
  const { kind: _, ...pick } = fx
  assert.equal(asked.state.asks.filter(a => a.q === 'pick').length, 2)
  const one = first.picked(asked.state, 2, 12000).state
  const both = decide(one, { kind: 'billPicked', pick, billId: 3, amount: 9900 }, ctx).state
  assert.equal(both.months['2026-10']?.[2]?.amount, 12000)
  assert.equal(both.months['2026-10']?.[3]?.amount, 9900)
  assert.deepEqual(both.asks, [])
})

test('an open question and a pending pick from the same sender coexist', () => {
  const p = picking(cards())
  const asked = decide(p.state, msg('/pago', { media: { mime: 'image/png', handle: 'h2' } }), ctx)
  assert.deepEqual(replies(asked.effects), ['askBill'])
  assert.deepEqual(
    asked.state.asks.map(a => a.q),
    ['pick', 'bill'],
  )
  const answered = decide(asked.state, msg('luz'), ctx).state
  assert.equal(answered.months['2026-10']?.[1]?.status, 'pending')
  const r = p.picked(answered, 3, 9900)
  assert.equal(r.state.months['2026-10']?.[3]?.amount, 9900)
})

test('a late pick never overwrites a payment of the chosen bill typed after the receipt', () => {
  for (const by of [msg, other]) {
    const p = picking(cards())
    const typed = decide(p.state, by('/pago cartão nu 120'), ctx).state
    const r = p.picked(typed, 2, 9900)
    assert.deepEqual(r.effects, [])
    assert.equal(r.state.months['2026-10']?.[2]?.amount, 12000)
    assert.equal(r.state.months['2026-10']?.[2]?.status, 'typed')
  }
})

test('a late pick never undoes a /despago of the chosen bill sent after the receipt', () => {
  for (const by of [msg, other]) {
    const s = cards()
    s.months['2026-10'] = { 2: { amount: 5000, status: 'typed', by: 'Ana', paidAt: OCT - 1000, messageId: 'old' } }
    const p = picking(s)
    const undone = decide(p.state, by('/despago cartão nu'), ctx).state
    const r = p.picked(undone, 2, 9900)
    assert.deepEqual(r.effects, [])
    assert.equal(r.state.months['2026-10']?.[2], undefined)
  }
})

test('chat in between keeps the pick, another member paying a different bill too', () => {
  const p = picking(cards())
  const chat = decide(p.state, msg('mandei o comprovante'), ctx).state
  const busy = decide(chat, other('/pago luz 80'), ctx).state
  const r = p.picked(busy, 3, 9900)
  assert.equal(r.state.months['2026-10']?.[3]?.amount, 9900)
  assert.equal(r.state.months['2026-10']?.[3]?.status, 'read')
  assert.deepEqual(r.state.asks, [])
})

test('a picked receipt cannot be edited into a second payment, and an edit before the pick cancels it', () => {
  const p = picking(cards())
  const edit = (text: string): Input => ({
    kind: 'edit',
    key: p.receipt.kind === 'message' ? p.receipt.key : key(),
    sender: 'Ana',
    text,
    at: OCT,
  })
  const paid = p.picked(p.state, 3, 9900).state
  const again = decide(paid, edit('/pago cartão nu'), ctx)
  assert.deepEqual(replies(again.effects), ['editIgnored'])
  assert.equal(again.state.months['2026-10']?.[2], undefined)
  const edited = decide(p.state, edit('/pago cartão nu 120'), ctx).state
  const late = p.picked(edited, 3, 9900)
  assert.deepEqual(late.effects, [])
  assert.equal(late.state.months['2026-10']?.[3], undefined)
})

const paidList = (s: GroupState) =>
  Object.entries(s.months).flatMap(([m, ps]) =>
    Object.keys(ps).map(id => `${m}:${s.bills.find(b => b.id === Number(id))?.name}`),
  )
const run = (s: GroupState, ...inputs: Input[]) => inputs.reduce((st, i) => decide(st, i, ctx).state, s)
const receipt = { media: { mime: 'image/png', handle: 'h' } }

test('a receipt captioned with only a month asks which bill and pays that month', () => {
  const s = run(state('Luz', 'Água'), msg('/pago setembro', receipt), msg('luz'))
  assert.deepEqual(paidList(s), ['2026-09:Luz'])
})

test('an answer after midnight pays the month the question was asked in', () => {
  const lastMinute = Date.UTC(2026, 10, 1, 2, 58)
  const later = lastMinute + 3 * 60_000
  const confirm = run(state('Luz'), msg('/pago lux 80', { at: lastMinute }), msg('sim', { at: later }))
  assert.deepEqual(paidList(confirm), ['2026-10:Luz'])
  const which = run(state('Luz', 'Água'), msg('/pago', { ...receipt, at: lastMinute }), msg('luz', { at: later }))
  assert.deepEqual(paidList(which), ['2026-10:Luz'])
  const oneOff = run(state('Luz'), msg('/pago pizza 50', { at: lastMinute }), msg('sim', { at: later }))
  assert.deepEqual(paidList(oneOff), ['2026-10:pizza'])
})

test('a no closes the question and pays nothing, even when it prefixes a bill name', () => {
  for (const no of ['n', 'no', 'não', 'nao', 'NOPE']) {
    const oneOff = run(state('Luz', 'Netflix'), msg('/pago pizza 50'), msg(no))
    assert.deepEqual(paidList(oneOff), [], no)
    assert.deepEqual(oneOff.asks, [], no)
    const which = run(state('Cartão Nu', 'Cartão C6', 'Notebook'), msg('/pago cartao 80'), msg(no))
    assert.deepEqual(paidList(which), [], no)
    assert.deepEqual(which.asks, [], no)
  }
})

test('a rename may not take the name of a removed bill, so /despago always reaches the bill on the list', () => {
  const s = run(state('Luz'), msg('/pago avulsa gás 120 09/2026'), msg('/conta adiciona botijão'))
  const r = decide(s, msg('/conta renomeia botijão = Gás'), ctx)
  assert.deepEqual(
    r.effects.flatMap(e => (e.kind === 'reply' ? [e.msg] : [])),
    [{ k: 'nameTaken', name: 'gás' }],
  )
  assert.deepEqual(
    r.state.bills.map(b => b.key),
    ['luz', 'gas', 'botijao'],
  )
  assert.deepEqual(paidList(run(r.state, msg('/despago gás 09/2026'))), [])
})

const footer = (s: GroupState, month: string) => render(listMsg(s, month), ctx.locale).split('\n').at(-1)

test('a paid bill shows as paid and counts even while paused, and pausing never rewrites a past month', () => {
  const now = run(
    state('Luz', 'Internet'),
    msg('/conta pausa internet'),
    msg('/pago internet 100'),
    msg('/pago luz 80'),
  )
  assert.equal(footer(now, '2026-10'), '*Pago:* 2/2 · *Total:* R$ 180,00')
  const sept = run(state('Luz', 'Internet', 'Água'), msg('/pago internet 100 09/2026'), msg('/pago luz 80 09/2026'))
  const before = footer(sept, '2026-09')
  assert.equal(before, '*Pago:* 2/3 · *Total:* R$ 180,00')
  assert.equal(footer(run(sept, msg('/conta pausa internet')), '2026-09'), before)
  assert.equal(footer(run(sept, msg('/conta pausa água')), '2026-09'), '*Pago:* 2/2 · *Total:* R$ 180,00')
})

test('a late amount question and an open confirm from one sender coexist, each taking its own answer', () => {
  const r1 = msg('/pago luz', receipt)
  const k1 = r1.kind === 'message' ? r1.key : key()
  const asked = run(state('Luz', 'Internet'), r1, msg('/pago internt 50', { at: OCT + 10_000 }), {
    kind: 'amountRead',
    key: k1,
    month: '2026-10',
    billId: 1,
    amount: null,
    at: OCT + 90_000,
  })
  assert.deepEqual(
    asked.asks.map(a => a.q),
    ['confirm', 'amount'],
  )
  const yes = decide(asked, msg('sim', { at: OCT + 100_000 }), ctx).state
  assert.deepEqual(paidList(yes).sort(), ['2026-10:Internet', '2026-10:Luz'])
  assert.equal(yes.months['2026-10']?.[2]?.amount, 5000)
  assert.deepEqual(yes.asks, [])
  const amount = decide(asked, msg('80', { at: OCT + 100_000 }), ctx).state
  assert.equal(amount.months['2026-10']?.[1]?.amount, 8000)
  assert.equal(amount.months['2026-10']?.[2], undefined)
  assert.deepEqual(decide(asked, msg('bom dia', { at: OCT + 100_000 }), ctx).state.asks, [])
})

test('a new amount question replaces the older amount question but keeps the other open question', () => {
  const [r1, r2] = [msg('/pago luz', receipt), msg('/pago água', receipt)]
  const read = (m: Input, billId: number, at: number): Input => ({
    kind: 'amountRead',
    key: m.kind === 'message' ? m.key : key(),
    month: '2026-10',
    billId,
    amount: null,
    at,
  })
  const asked = run(
    state('Luz', 'Água', 'Internet'),
    r1,
    r2,
    msg('/pago internt 50', { at: OCT + 1000 }),
    read(r1, 1, OCT + 2000),
    read(r2, 2, OCT + 3000),
  )
  assert.deepEqual(
    asked.asks.map(a => (a.q === 'amount' ? `amount ${a.billId}` : a.q)),
    ['confirm', 'amount 2'],
  )
  const r = decide(asked, msg('80', { at: OCT + 4000 }), ctx).state
  assert.equal(r.months['2026-10']?.[1]?.amount, null)
  assert.equal(r.months['2026-10']?.[2]?.amount, 8000)
})

test('a second one-off with the same name in the same month adds its amount, without asking anything new', () => {
  const s = run(state('Luz'), msg('/pago avulsa farmácia 50'))
  const id = s.bills.find(b => b.key === 'farmacia')?.id ?? 0
  const twice = decide(s, msg('/pago avulsa Farmácia 60'), ctx)
  assert.equal(twice.state.months['2026-10']?.[id]?.amount, 11000)
  assert.equal(twice.state.months['2026-10']?.[id]?.status, 'typed')
  assert.deepEqual(kinds(twice.effects), ['react', 'postList'])
  assert.equal(footer(twice.state, '2026-10'), '*Pago:* 1/2 · *Total:* R$ 110,00')
  const offered = run(s, msg('/pago farmácia 60'), msg('sim'))
  assert.equal(offered.months['2026-10']?.[id]?.amount, 11000)
  const otherMonth = run(s, msg('/pago avulsa farmácia 60 09/2026'))
  assert.equal(otherMonth.months['2026-10']?.[id]?.amount, 5000)
  assert.equal(otherMonth.months['2026-09']?.[id]?.amount, 6000)
  for (const c of [ctx, { ...ctx, llm: false }]) {
    const unread = decide(s, msg('/pago avulsa farmácia', receipt), c)
    assert.equal(unread.state.months['2026-10']?.[id]?.amount, 5000)
    assert.deepEqual(kinds(unread.effects), ['react', 'postList'])
    assert.deepEqual(unread.state.asks, [])
  }
  const reading = run(state('Luz'), msg('/pago avulsa farmácia', receipt), msg('/pago avulsa farmácia 60'))
  assert.equal(reading.months['2026-10']?.[2]?.amount, 6000)
  assert.equal(reading.months['2026-10']?.[2]?.status, 'typed')
})

test('an input whose time is outside any calendar is dropped without effects instead of throwing', () => {
  const s = run(state('Luz', 'Cartão Nu', 'Cartão C6'), msg('/pago luz', receipt))
  const pick = {
    to: key(),
    sender: 'Ana',
    media: receipt.media,
    month: null,
    amount: null,
    bills: [{ id: 2, name: 'Cartão Nu' }],
  }
  for (const at of [1e19, -1e19, Number.NaN, Number.POSITIVE_INFINITY, 32_503_680_000_000]) {
    const inputs: Input[] = [
      msg('/pago luz 80', { at }),
      { kind: 'edit', key: key(), sender: 'Ana', text: '/lista', at },
      { kind: 'amountRead', key: key(), month: '2026-10', billId: 1, amount: null, at },
      { kind: 'billPicked', pick: { ...pick, at }, billId: 2, amount: 100 },
      { kind: 'tick', at },
      { kind: 'join', jid: 'g@g.us', at, startup: true, reading: [] },
    ]
    for (const i of inputs) {
      const r = decide(s, i, ctx)
      assert.deepEqual(r, { state: s, effects: [] }, `${i.kind} ${at}`)
    }
  }
})

test('a bill named like a currency is paid with an amount, and its suggestion round-trips', () => {
  for (const name of ['Real', 'Top', 'All', 'Cup', 'Pen']) {
    const s = run(state('Luz', name), msg(`/pago ${name.toLowerCase()} 80`))
    assert.equal(s.months['2026-10']?.[2]?.amount, 8000, name)
    const r = decide(state('Luz', name), msg(`/pago ${name.toLowerCase()}x 80`), ctx)
    assert.deepEqual(replies(r.effects), ['askConfirm'], name)
    assert.equal(decide(r.state, msg('sim'), ctx).state.months['2026-10']?.[2]?.amount, 8000, name)
  }
  assert.equal(run(state('Luz'), msg('/pago luz 80USD')).months['2026-10']?.[1]?.amount, 8000)
})
