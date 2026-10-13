import { type Command, type Conta, parseCommand, parseConta } from './commands.ts'
import { findMoney } from './money.ts'
import { monthOf, parseMonthToken } from './month.ts'
import { type Resolution, resolve } from './resolve.ts'
import { normalize } from './text.ts'
import type {
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

const reply = (d: Draft, to: MsgKey, msg: Msg) => d.fx.push({ kind: 'reply', to, msg })
const active = (s: GroupState) => s.bills.filter(b => !b.removed)
const current = (d: Draft, at: number) => monthOf(at, d.ctx.locale.timeZone)
const pinnedMonth = (d: Draft, at: number) => {
  const now = current(d, at)
  return d.s.lastReset && d.s.lastReset > now ? d.s.lastReset : now
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
      return { k: 'onePerCommand', bills: r.bills.map(b => b.name) }
  }
}

function payment(prev: Payment | undefined, amount: number | null, reading: boolean, m: Cmd): Payment {
  const base = { by: m.sender, paidAt: m.at, messageId: m.key.id }
  if (amount !== null) return { ...base, amount, status: 'typed' }
  if (reading) return { ...base, amount: null, status: 'pending' }
  if (prev && prev.status !== 'pending') return { ...base, amount: prev.amount, status: prev.status }
  return { ...base, amount: null, status: 'none' }
}

function pago(d: Draft, arg: string, m: Cmd): boolean {
  const now = current(d, m.at)
  const r = resolve(arg, d.s.bills, now, d.ctx.locale.decimal)
  if (!r.ok) {
    reply(d, m.key, failure(d, r, 'pago'))
    return false
  }
  const month = r.month ?? now
  const paid = d.s.months[month] ?? {}
  d.s.months[month] = paid
  const prev = paid[r.bill.id]
  const media = m.media ?? m.quoted
  const reading = r.amount === null && media !== undefined && d.ctx.llm
  paid[r.bill.id] = payment(prev, r.amount, reading, m)
  d.fx.push({ kind: 'react', to: m.key })
  if (prev) reply(d, m.key, { k: 'updated' })
  if (reading && media) d.fx.push({ kind: 'readAmount', to: m.key, media, month, billId: r.bill.id })
  else showList(d, month, pinnedMonth(d, m.at), m.key)
  return true
}

function despago(d: Draft, arg: string, m: Cmd): boolean {
  const now = current(d, m.at)
  const r = resolve(arg, d.s.bills, now, d.ctx.locale.decimal)
  if (!r.ok) {
    reply(d, m.key, failure(d, r, 'despago'))
    return false
  }
  const month = r.month ?? now
  const paid = d.s.months[month]
  const had = Boolean(paid?.[r.bill.id])
  if (paid) delete paid[r.bill.id]
  d.fx.push({ kind: 'react', to: m.key })
  showList(d, month, pinnedMonth(d, m.at), m.key)
  return had
}

function findBill(d: Draft, name: string, to: MsgKey): Bill | null {
  const q = normalize(name)
  const bills = active(d.s)
  const prefixed = bills.filter(b => b.key.startsWith(q))
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
  const dated = tokens.some(t => t.includes('/') && parseMonthToken(t, current(d, m.at)) !== null)
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
    removed.name = name
  } else {
    d.s.bills.push({ id: d.s.nextBillId, name, key, paused: false, removed: false })
    d.s.nextBillId++
  }
  return true
}

function renameBill(d: Draft, from: string, to: string, key: MsgKey): boolean {
  const bill = findBill(d, from, key)
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
      const bill = findBill(d, c.name, m.key)
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

function onMessage(d: Draft, m: MessageInput) {
  if (m.key.fromMe || d.s.handled.some(h => h.id === m.key.id)) return
  const c = parseCommand(m.text)
  if (c) remember(d.s, m.key.id, run(d, c, m))
}

const paidBy = (s: GroupState, id: string) =>
  Object.values(s.months).some(month => Object.values(month).some(p => p.messageId === id))

function onEdit(d: Draft, e: EditInput) {
  if (e.key.fromMe) return
  const h = d.s.handled.find(x => x.id === e.key.id)
  if (h ? h.changed : paidBy(d.s, e.key.id)) {
    if (h?.warned) return
    reply(d, e.key, { k: 'editIgnored' })
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
  if (a.amount === null) {
    p.status = 'none'
    reply(d, a.key, { k: 'noAmount' })
  } else {
    p.amount = a.amount
    p.status = 'read'
  }
  showList(d, a.month, pinnedMonth(d, a.at), a.key)
}

function onListPosted(d: Draft, messageId: string) {
  const prev = d.s.pinnedId
  d.s.pinnedId = messageId
  d.fx.push({ kind: 'pin', messageId })
  if (prev && prev !== messageId) d.fx.push({ kind: 'unpin', messageId: prev })
}

function onTick(d: Draft, at: number) {
  const month = current(d, at)
  if (d.s.lastReset === null || d.s.lastReset === month) return
  d.s.lastReset = month
  d.fx.push({ kind: 'postList', msg: listMsg(d.s, month) })
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
    case 'listPosted':
      onListPosted(d, input.messageId)
      break
    case 'tick':
      onTick(d, input.at)
      break
  }
  return { state: d.s, effects: d.fx }
}
