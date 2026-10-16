import { type Command, type Conta, ONE_OFF, parseCommand, parseConta } from './commands.ts'
import { findMoney, isCurrency } from './money.ts'
import { monthOf, parseMonthToken } from './month.ts'
import { oldest, type Resolution, resolve } from './resolve.ts'
import { clean, normalize } from './text.ts'
import type {
  Ask,
  Bill,
  EditInput,
  Effect,
  GroupState,
  Input,
  ListMsg,
  Locale,
  MessageInput,
  Msg,
  MsgKey,
  Payment,
} from './types.ts'

export type Ctx = { locale: Locale; llm: boolean }
export type Result = { state: GroupState; effects: Effect[] }
type Draft = { s: GroupState; fx: Effect[]; ctx: Ctx }
type Cmd = Pick<MessageInput, 'key' | 'sender' | 'at' | 'media' | 'quoted'>
type Failure = Extract<Resolution, { ok: false }>

const HANDLED_MAX = 500
const NAME_MAX = 40
const ASK_TTL = 10 * 60_000
const YES = new Set(['sim', 's', 'yes', 'y', 'si', 'ok', 'isso'])
const THUMBS = /^👍[\u{1F3FB}-\u{1F3FF}]?$/u

const reply = (d: Draft, to: MsgKey, msg: Msg) => d.fx.push({ kind: 'reply', to, msg })
const active = (s: GroupState) => s.bills.filter(b => !b.removed)
const current = (d: Draft, at: number) => monthOf(at, d.ctx.locale.timeZone)
const pinnedMonth = (d: Draft, at: number) => {
  const now = current(d, at)
  return d.s.lastReset && d.s.lastReset > now ? d.s.lastReset : now
}
const who = (key: MsgKey, sender: string) => key.participant ?? sender

function ask(d: Draft, a: Ask, to: MsgKey, msg: Msg) {
  d.s.asks = [...d.s.asks.filter(x => x.who !== a.who), a]
  reply(d, to, msg)
}

function askAmount(d: Draft, billId: number, month: string, key: MsgKey, by: string, at: number) {
  const bill = d.s.bills.find(b => b.id === billId)?.name ?? ''
  ask(d, { who: who(key, by), at, q: 'amount', month, billId, messageId: key.id }, key, { k: 'askAmount', bill })
}

function confirm(d: Draft, cmd: 'pago' | 'despago', bill: Bill, amount: number | null, month: string | null, m: Cmd) {
  const media = cmd === 'pago' ? (m.media ?? m.quoted) : undefined
  const a: Ask = { who: who(m.key, m.sender), at: m.at, q: 'confirm', cmd, billId: bill.id, amount, month }
  if (media) a.media = media
  ask(d, a, m.key, { k: 'askConfirm', cmd, bill: bill.name, amount, month })
}

type Choice = { id: number; name: string }

function askWhich(d: Draft, bills: readonly Choice[], amount: number | null, month: string | null, m: Cmd) {
  const media = m.media ?? m.quoted
  const choices = bills.map(b => b.id)
  const a: Ask = { who: who(m.key, m.sender), at: m.at, q: 'bill', choices, amount, month }
  if (media) a.media = media
  ask(d, a, m.key, { k: 'askBill', names: bills.map(b => b.name) })
}

function chosen(d: Draft, text: string, choices: readonly number[]): Named | undefined {
  const words = normalize(text).split(' ').filter(Boolean)
  const keyWords = (b: Bill) => b.key.split(' ')
  const hits = d.s.bills.filter(
    b => choices.includes(b.id) && words.length > 0 && words.every(w => keyWords(b).some(k => k.startsWith(w))),
  )
  const [bill, ...more] = hits
  return bill && more.length === 0 ? { bill, amount: null, month: null } : undefined
}

function ambiguous(d: Draft, bills: readonly Bill[], amount: number | null, month: string | null, m: Cmd) {
  const media = m.media ?? m.quoted
  const choices = bills.map(b => ({ id: b.id, name: b.name }))
  if (media && d.ctx.llm)
    d.fx.push({ kind: 'pickBill', to: m.key, sender: m.sender, at: m.at, media, month, amount, bills: choices })
  else askWhich(d, choices, amount, month, m)
}

export function listMsg(s: GroupState, month: string): ListMsg {
  const paid = s.months[month] ?? {}
  const items = s.bills
    .filter(b => !b.removed || paid[b.id])
    .map(b => ({ name: b.name, paused: b.paused, paid: Boolean(paid[b.id]), amount: paid[b.id]?.amount ?? null }))
  return { k: 'list', month, items }
}

function showList(d: Draft, month: string, now: string, to: MsgKey) {
  if (month === now) d.fx.push({ kind: 'postList', msg: listMsg(d.s, month) })
  else reply(d, to, listMsg(d.s, month))
}

function failure(d: Draft, r: Failure, cmd: 'pago' | 'despago'): Msg {
  switch (r.why) {
    case 'missingBill':
      return { k: 'missingBill', cmd }
    case 'pagoSyntax':
      return { k: 'pagoSyntax' }
    case 'futureMonth':
      return { k: 'futureMonth' }
    case 'suggest':
      return { k: 'suggest', cmd, bill: r.bill.name, amount: cmd === 'pago' ? r.amount : null, month: r.month }
    case 'notFound':
      return { k: 'notFound', q: r.q, names: active(d.s).map(b => b.name) }
    case 'onePerCommand':
      return { k: 'onePerCommand', cmd, bills: r.bills.map(b => b.name) }
  }
}

function refuse(d: Draft, r: Failure, cmd: 'pago' | 'despago', m: Cmd, arg: string) {
  const media = m.media ?? m.quoted
  if (r.why === 'suggest') confirm(d, cmd, r.bill, cmd === 'pago' ? r.amount : null, r.month, m)
  else if (cmd === 'despago') reply(d, m.key, failure(d, r, cmd))
  else if (r.why === 'onePerCommand') ambiguous(d, r.bills, r.amount, r.month, m)
  else if (r.why === 'missingBill' && media) askWhich(d, active(d.s), r.amount, null, m)
  else if (r.why !== 'notFound' || !offerOneOff(d, arg, m)) reply(d, m.key, failure(d, r, cmd))
}

function payment(prev: Payment | undefined, amount: number | null, reading: boolean, m: Cmd): Payment {
  const base = { by: m.sender, paidAt: m.at, messageId: m.key.id }
  if (amount !== null) return { ...base, amount, status: 'typed' }
  if (reading) return { ...base, amount: null, status: 'pending' }
  if (prev && prev.status !== 'pending') return { ...base, amount: prev.amount, status: prev.status }
  return { ...base, amount: null, status: 'none' }
}

function pay(d: Draft, bill: Bill, amount: number | null, month: string, m: Cmd) {
  const paid = d.s.months[month] ?? {}
  d.s.months[month] = paid
  const prev = paid[bill.id]
  const media = m.media ?? m.quoted
  const reading = amount === null && media !== undefined && d.ctx.llm
  const p = payment(prev, amount, reading, m)
  paid[bill.id] = p
  d.fx.push({ kind: 'react', to: m.key })
  if (prev) reply(d, m.key, { k: 'updated' })
  if (reading && media) d.fx.push({ kind: 'readAmount', to: m.key, media, month, billId: bill.id })
  else showList(d, month, pinnedMonth(d, m.at), m.key)
  if (media && !reading && p.amount === null) askAmount(d, bill.id, month, m.key, m.sender, m.at)
}

function pago(d: Draft, arg: string, m: Cmd): boolean {
  const now = current(d, m.at)
  const r = resolve(arg, d.s.bills, now, d.ctx.locale.decimal)
  if (r.ok) {
    pay(d, r.bill, r.amount, r.month ?? now, m)
    return true
  }
  const [head = '', ...rest] = arg.split(' ')
  if (ONE_OFF.has(normalize(head))) return oneOff(d, rest, m)
  refuse(d, r, 'pago', m, arg)
  return false
}

type OneOff = { name: string; key: string; amount: number | null; month: string | null }

function parseOneOff(tokens: readonly string[], now: string, decimal: ',' | '.', reading: boolean): OneOff | Msg {
  const months = tokens.map(t => (t.includes('/') ? parseMonthToken(t, now) : null))
  const dated = months.filter((x): x is string => x !== null && x >= oldest(now))
  const month = dated[0] ?? null
  if (dated.length > 1) return { k: 'oneOffSyntax' }
  if (month && month > now) return { k: 'futureMonth' }
  const rest = month ? tokens.filter((_, i) => months[i] !== month) : tokens
  const { marked, bare } = findMoney(rest, decimal)
  const hits = [...marked, ...bare]
  const money = hits.length === 1 ? hits[0] : undefined
  const nameToks = money ? [...rest.slice(0, money.start), ...rest.slice(money.end)] : rest
  const name = nameToks.join(' ')
  const key = normalize(name)
  const atEnd = !money || money.start === 0 || money.end === rest.length
  const plain = key !== '' && nameToks.every(t => !/\d/.test(t) && !isCurrency(t))
  if (hits.length > 1 || !atEnd || !plain || !(money || reading)) return { k: 'oneOffSyntax' }
  if (name.length > NAME_MAX) return { k: 'nameInvalid' }
  return { name, key, amount: money?.cents ?? null, month }
}

function clash(d: Draft, o: OneOff, now: string, m: Cmd): boolean {
  const r = resolve(o.name, d.s.bills, now, d.ctx.locale.decimal)
  if (r.ok || r.why === 'suggest') confirm(d, 'pago', r.bill, o.amount, o.month, m)
  else if (r.why === 'onePerCommand') ambiguous(d, r.bills, o.amount, o.month, m)
  else if (r.why !== 'notFound') reply(d, m.key, { k: 'oneOffSyntax' })
  return r.ok || r.why !== 'notFound'
}

function oneOff(d: Draft, tokens: readonly string[], m: Cmd): boolean {
  const now = current(d, m.at)
  const o = parseOneOff(tokens, now, d.ctx.locale.decimal, Boolean(m.media ?? m.quoted))
  if ('k' in o) {
    reply(d, m.key, o)
    return false
  }
  if (clash(d, o, now, m)) return false
  pay(d, addOneOff(d, o), o.amount, o.month ?? now, m)
  return true
}

function addOneOff(d: Draft, o: OneOff): Bill {
  const found = d.s.bills.filter(b => b.removed && b.key === o.key).at(-1)
  if (found) {
    found.paused = false
    return found
  }
  const bill = { id: d.s.nextBillId, name: o.name, key: o.key, paused: false, removed: true }
  d.s.bills.push(bill)
  d.s.nextBillId++
  return bill
}

function offerOneOff(d: Draft, arg: string, m: Cmd): boolean {
  const media = m.media ?? m.quoted
  const tokens = arg.split(' ').filter(Boolean)
  const o = parseOneOff(tokens, current(d, m.at), d.ctx.locale.decimal, Boolean(media))
  if ('k' in o) return false
  const a: Ask = { who: who(m.key, m.sender), at: m.at, q: 'oneOff', ...o }
  if (media) a.media = media
  ask(d, a, m.key, { k: 'askOneOff', name: o.name })
  return true
}

function unpayable(s: GroupState, now: string): Bill[] {
  const recent = Object.entries(s.months).filter(([k]) => k >= oldest(now))
  return s.bills.map(b => (b.removed && recent.some(([, p]) => p[b.id]) ? { ...b, removed: false } : b))
}

function despago(d: Draft, arg: string, m: Cmd): boolean {
  const now = current(d, m.at)
  const r = resolve(arg, unpayable(d.s, now), now, d.ctx.locale.decimal)
  if (!r.ok) {
    refuse(d, r, 'despago', m, arg)
    return false
  }
  return unpay(d, r.bill.id, r.month ?? now, m)
}

function unpay(d: Draft, billId: number, month: string, m: Cmd): boolean {
  const paid = d.s.months[month]
  const had = Boolean(paid?.[billId])
  if (paid) delete paid[billId]
  d.fx.push({ kind: 'react', to: m.key })
  showList(d, month, pinnedMonth(d, m.at), m.key)
  return had
}

function findBill(d: Draft, name: string, to: MsgKey, exact: boolean): Bill | null {
  const q = normalize(name)
  const bills = active(d.s)
  const prefixed = exact ? [] : bills.filter(b => b.key.startsWith(q))
  const bill = bills.find(b => b.key === q) ?? (prefixed.length === 1 ? prefixed[0] : undefined)
  if (q && bill) return bill
  reply(d, to, { k: 'notFound', q: name, names: bills.map(b => b.name) })
  return null
}

function validName(d: Draft, name: string, to: MsgKey, self?: Bill): string | null {
  const key = normalize(name)
  if (!key || name.length > NAME_MAX) {
    reply(d, to, { k: 'nameInvalid' })
    return null
  }
  const other = d.s.bills.find(b => b.key === key && b !== self && !b.removed)
  if (other) {
    reply(d, to, { k: 'nameTaken', name: other.name })
    return null
  }
  return key
}

function looksLikePayment(d: Draft, name: string, m: Cmd): boolean {
  const tokens = name.split(' ').filter(Boolean)
  const now = current(d, m.at)
  const dated = tokens.some(t => {
    const month = t.includes('/') ? parseMonthToken(t, now) : null
    return month !== null && month >= oldest(now)
  })
  if (!dated && findMoney(tokens, d.ctx.locale.decimal).marked.length === 0) return false
  const r = resolve(name, d.s.bills, current(d, m.at), d.ctx.locale.decimal)
  const target = r.ok || r.why === 'suggest' ? r : null
  reply(
    d,
    m.key,
    target
      ? { k: 'suggest', cmd: 'pago', bill: target.bill.name, amount: target.amount, month: target.month }
      : { k: 'pagoSyntax' },
  )
  return true
}

function addBill(d: Draft, name: string, m: Cmd): boolean {
  if (looksLikePayment(d, name, m)) return false
  const to = m.key
  const key = validName(d, name, to)
  if (!key) return false
  const removed = d.s.bills.filter(b => b.key === key).at(-1)
  if (removed) {
    removed.removed = false
    removed.paused = false
    removed.name = name
  } else {
    d.s.bills.push({ id: d.s.nextBillId, name, key, paused: false, removed: false })
    d.s.nextBillId++
  }
  return true
}

function renameBill(d: Draft, from: string, to: string, key: MsgKey): boolean {
  const bill = findBill(d, from, key, true)
  if (!bill) return false
  const newKey = validName(d, to, key, bill)
  if (!newKey) return false
  bill.name = to
  bill.key = newKey
  return true
}

function changeBill(d: Draft, c: Conta, m: Cmd): boolean {
  switch (c.sub) {
    case 'add':
      return addBill(d, c.name, m)
    case 'rename':
      return renameBill(d, c.from, c.to, m.key)
    case 'remove':
    case 'pause':
    case 'resume': {
      const bill = findBill(d, c.name, m.key, c.sub === 'remove')
      if (!bill) return false
      if (c.sub === 'remove') bill.removed = true
      else bill.paused = c.sub === 'pause'
      return true
    }
    default:
      return false
  }
}

function conta(d: Draft, arg: string, m: Cmd): boolean {
  const c = parseConta(arg)
  if (c.sub === 'help') {
    reply(d, m.key, { k: 'contaHelp' })
    return false
  }
  if (c.sub === 'unknown') {
    reply(d, m.key, { k: 'unknownSub', typed: c.typed, suggestion: c.suggestion })
    return false
  }
  const changed = changeBill(d, c, m)
  if (changed || c.sub === 'list') {
    reply(d, m.key, { k: 'bills', bills: active(d.s).map(b => ({ name: b.name, paused: b.paused })) })
  }
  return changed
}

function run(d: Draft, c: Command, m: Cmd): boolean {
  switch (c.cmd) {
    case 'pago':
      return pago(d, c.arg, m)
    case 'despago':
      return despago(d, c.arg, m)
    case 'lista':
      d.fx.push({ kind: 'postList', msg: listMsg(d.s, pinnedMonth(d, m.at)) })
      return false
    case 'ajuda':
      reply(d, m.key, { k: 'help' })
      return false
    case 'conta':
      return conta(d, c.arg, m)
    case 'unknown':
      reply(d, m.key, { k: 'unknownCmd', typed: c.typed, suggestion: c.suggestion })
      return false
  }
}

function remember(s: GroupState, id: string, changed: boolean, warned = false) {
  s.handled.push({ id, changed, warned })
  if (s.handled.length > HANDLED_MAX) s.handled.splice(0, s.handled.length - HANDLED_MAX)
}

function takeAsk(d: Draft, m: MessageInput): Ask | undefined {
  const by = who(m.key, m.sender)
  const live = (x: Ask) => m.at - x.at <= ASK_TTL
  const open = d.s.asks.find(x => x.who === by && live(x))
  d.s.asks = d.s.asks.filter(x => x.who !== by && live(x))
  return open
}

function answer(d: Draft, a: Ask, m: MessageInput): boolean {
  const text = clean(m.text)
  const yes = YES.has(normalize(text)) || THUMBS.test(m.text.trim())
  if (a.q === 'amount') return fillAmount(d, a, text, m)
  const asker: Cmd = { key: m.key, sender: m.sender, at: m.at, ...(a.media ? { media: a.media } : {}) }
  const month = a.month ?? current(d, m.at)
  if (a.q === 'confirm') return yes && confirmed(d, a, month, asker)
  if (a.q === 'oneOff' && yes) {
    pay(d, addOneOff(d, a), a.amount, month, asker)
    return true
  }
  const bill = (a.q === 'bill' ? chosen(d, text, a.choices) : undefined) ?? named(d, text, m.at)
  if (bill) pay(d, bill.bill, bill.amount ?? a.amount, bill.month ?? month, asker)
  return Boolean(bill)
}

function confirmed(d: Draft, a: Extract<Ask, { q: 'confirm' }>, month: string, m: Cmd): boolean {
  const bill = d.s.bills.find(b => b.id === a.billId)
  if (!bill) return false
  if (a.cmd === 'despago') return unpay(d, bill.id, month, m)
  pay(d, bill, a.amount, month, m)
  return true
}

type Named = { bill: Bill; amount: number | null; month: string | null }

function named(d: Draft, text: string, at: number): Named | undefined {
  const r = resolve(text, d.s.bills, current(d, at), d.ctx.locale.decimal)
  return r.ok ? r : undefined
}

function fillAmount(d: Draft, a: Extract<Ask, { q: 'amount' }>, text: string, m: MessageInput): boolean {
  const toks = text.split(' ').filter(Boolean)
  const { marked, bare } = findMoney(toks, d.ctx.locale.decimal)
  const [hit, ...more] = [...marked, ...bare]
  const p = d.s.months[a.month]?.[a.billId]
  if (!hit || more.length > 0 || hit.start !== 0 || hit.end !== toks.length) return false
  if (!p || p.messageId !== a.messageId) return false
  p.amount = hit.cents
  p.status = 'typed'
  d.fx.push({ kind: 'react', to: m.key })
  showList(d, a.month, pinnedMonth(d, m.at), m.key)
  return true
}

function onMessage(d: Draft, m: MessageInput) {
  if (m.key.fromMe || d.s.handled.some(h => h.id === m.key.id)) return
  const open = takeAsk(d, m)
  const c = parseCommand(m.text)
  if (c) remember(d.s, m.key.id, run(d, c, m))
  else if (open && answer(d, open, m)) remember(d.s, m.key.id, true)
}

const paidBy = (s: GroupState, id: string) =>
  Object.values(s.months).some(month => Object.values(month).some(p => p.messageId === id))

function onEdit(d: Draft, e: EditInput) {
  if (e.key.fromMe) return
  const h = d.s.handled.find(x => x.id === e.key.id)
  if (h ? h.changed : paidBy(d.s, e.key.id)) {
    if (h?.warned) return
    reply(d, e.key, { k: 'editIgnored', payment: paidBy(d.s, e.key.id) })
    if (h) h.warned = true
    else remember(d.s, e.key.id, true, true)
    return
  }
  const c = parseCommand(e.text)
  if (!c) return
  const changed = run(d, c, e)
  if (h) h.changed = changed
  else remember(d.s, e.key.id, changed)
}

function onAmountRead(d: Draft, a: Extract<Input, { kind: 'amountRead' }>) {
  const p = d.s.months[a.month]?.[a.billId]
  if (!p || p.messageId !== a.key.id || p.status !== 'pending') return
  if (a.amount === null) p.status = 'none'
  else {
    p.amount = a.amount
    p.status = 'read'
  }
  showList(d, a.month, pinnedMonth(d, a.at), a.key)
  if (a.amount === null) askAmount(d, a.billId, a.month, a.key, p.by, a.at)
}

function onBillPicked(d: Draft, i: Extract<Input, { kind: 'billPicked' }>) {
  const p = i.pick
  const m: Cmd = { key: p.to, sender: p.sender, at: p.at }
  const bill = p.bills.some(b => b.id === i.billId) ? d.s.bills.find(b => b.id === i.billId) : undefined
  if (!bill) {
    askWhich(d, p.bills, p.amount, p.month, { ...m, media: p.media })
    return
  }
  const month = p.month ?? current(d, p.at)
  pay(d, bill, p.amount ?? i.amount, month, m)
  const paid = d.s.months[month]?.[bill.id]
  if (paid && p.amount === null && i.amount !== null) paid.status = 'read'
  if (paid?.amount === null) askAmount(d, bill.id, month, p.to, p.sender, p.at)
}

function onListPosted(d: Draft, messageId: string) {
  const prev = d.s.pinnedId
  d.s.pinnedId = messageId
  d.fx.push({ kind: 'pin', messageId })
  if (prev && prev !== messageId) d.fx.push({ kind: 'unpin', messageId: prev })
}

function onTick(d: Draft, at: number) {
  const month = current(d, at)
  if (d.s.lastReset === null || month <= d.s.lastReset) return
  d.s.lastReset = month
  d.fx.push({ kind: 'postList', msg: listMsg(d.s, month) })
}

function onJoin(d: Draft, j: Extract<Input, { kind: 'join' }>) {
  if (d.s.lastReset === null) {
    const month = current(d, j.at)
    d.s.lastReset = month
    d.fx.push({ kind: 'send', msg: { k: 'intro' } })
    d.fx.push({ kind: 'postList', msg: listMsg(d.s, month) })
  }
  if (!j.startup) return
  for (const month of Object.values(d.s.months)) {
    for (const p of Object.values(month)) {
      if (p.status !== 'pending') continue
      p.status = 'none'
      reply(d, { id: p.messageId, fromMe: false, remoteJid: j.jid }, { k: 'noAmount' })
    }
  }
}

export function decide(state: GroupState, input: Input, ctx: Ctx): Result {
  const d: Draft = { s: structuredClone(state), fx: [], ctx }
  switch (input.kind) {
    case 'message':
      onMessage(d, input)
      break
    case 'edit':
      onEdit(d, input)
      break
    case 'amountRead':
      onAmountRead(d, input)
      break
    case 'billPicked':
      onBillPicked(d, input)
      break
    case 'listPosted':
      onListPosted(d, input.messageId)
      break
    case 'tick':
      onTick(d, input.at)
      break
    case 'join':
      onJoin(d, input)
      break
  }
  return { state: d.s, effects: d.fx }
}
