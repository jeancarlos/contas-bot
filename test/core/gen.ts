import type { Ctx } from '../../src/core/decide.ts'
import { normalize } from '../../src/core/text.ts'
import { emptyState, type GroupState, type Input, type MediaRef, type MsgKey } from '../../src/core/types.ts'

export function rng(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T
  return { next, int, pick }
}
export type R = ReturnType<typeof rng>

export const ctxPt: Ctx = {
  locale: { lang: 'pt-BR', currency: 'BRL', decimal: ',', timeZone: 'America/Sao_Paulo' },
  llm: true,
}
export const ctxEn: Ctx = {
  locale: { lang: 'en', currency: 'USD', decimal: '.', timeZone: 'America/New_York' },
  llm: false,
}

export const NAMES = [
  'Luz',
  'Água',
  'Conta de Luz',
  'Cartão Nu',
  'Cartão C6',
  'Apto 101',
  'Internet',
  'Gás',
  'Maio',
  'Aluguel',
  'Luz Garagem',
  'Real',
  'Top',
  'Parcela 3/10',
]

export function state(names: readonly string[]): GroupState {
  const s = emptyState()
  s.bills = names.map((name, i) => ({ id: i + 1, name, key: normalize(name), paused: false, removed: false }))
  s.nextBillId = names.length + 1
  s.lastReset = '2026-10'
  return s
}

const WORDS = [
  ...['/pago', '/paguei', '/despago', '/lista', '/ajuda', '/conta', '/contas', '/paid', '/unpaid', '/bill', '/pagado'],
  ...['/ pago', '/pagp', '/', '//', 'adiciona', 'remove', 'pausa', 'continua', 'renomeia', '=', 'avulsa', 'extra'],
  ...['luz', 'Luz', 'LUZ', 'lúz', 'agua', 'água', 'conta', 'de', 'cartao', 'cartão', 'nu', 'c6', 'apto', '101'],
  ...['internet', 'gas', 'gás', 'maio', 'aluguel', 'garagem', 'real', 'top', 'parcela', '3/10'],
  ...['80', '80,00', '80.00', '1.000', '1,000', '1.000,50', '6.237,60', '6,237.60', 'R$', 'R$80', 'r$', 'US$', '$'],
  ...['€', '80€', 'reais', 'BRL', 'usd', '80USD', '0', '0,00', '999999999999', '1e3', '-80', '+80', '0,005'],
  ...['09/2026', '9/26', 'set/2026', 'setembro', 'outubro', 'novembro', 'dezembro/2026', '12/2026', '10/2026'],
  ...['13/2026', '01/2000', '2026', 'of', 'sim', 's', 'ok', 'yes', '👍', '👍🏽', 'não', 'nao', 'n', 'a', 'o', 'e'],
  ...['paguei', 'mês', '*', '_', '~', '`', '*luz*', '_80_', '💡', '\n', '\t', '  ', 'İ', 'ß', 'ﬁ', 'Ø', 'x'.repeat(50)],
  ...[0x200b, 0x200d, 0xfe0f, 0x301].map(c => String.fromCodePoint(c)),
]
const CMD = ['/pago', '/pago', '/pago', '/despago', '/pago avulsa', '/conta adiciona', '/conta remove', '/conta pausa']
const CMD_MORE = ['/conta continua', '/conta renomeia', '']
const BILLISH = ['luz', 'agua', 'água', 'conta de luz', 'cartao', 'cartão nu', 'nu', 'c6', 'apto 101', 'apto']
const BILLISH_MORE = ['internet', 'net', 'gas', 'maio', 'aluguel', 'garagem', 'luz garagem', 'parcela 3/10', 'pizza']
const ANSWERS = ['farmacia', 'lux', 'internt', 'n', 'no', 'sim', 'ok', 'top', 'real']
const BILLS = [...BILLISH, ...BILLISH_MORE, ...ANSWERS]
const AMT = ['', '80', 'R$80', '80,00', '1.234,56', '1,234.56', 'R$ 50', '50 reais', '0,5', '80usd']
const MON = ['', '09/2026', 'setembro', 'out/26', '12/2026', 'maio 2026', '10/2024', '09/2024']

function command(r: R): string {
  const cmd = r.pick([...CMD, ...CMD_MORE])
  if (cmd === '/conta renomeia') return `${cmd} ${r.pick(BILLS)} = ${r.pick(BILLS)}`
  const tail = [r.pick(BILLS), r.pick(AMT), r.pick(MON)].sort(() => r.next() - 0.5).join(' ')
  return `${cmd} ${tail}`.trim()
}

export function text(r: R): string {
  if (r.next() < 0.6) return command(r)
  const parts = Array.from({ length: r.int(7) }, () =>
    r.next() < 0.08 ? String.fromCodePoint(r.int(0x2ffff)) : r.pick(WORDS),
  )
  return parts.join(r.next() < 0.9 ? ' ' : '')
}

export const SENDERS = ['a@s.whatsapp.net', 'b@s.whatsapp.net', 'c@s.whatsapp.net']
export const OCT = Date.UTC(2026, 9, 10, 15)
export const media = (id: string): MediaRef => ({ mime: 'image/jpeg', handle: { id, size: 10 } })

type Gen = { r: R; ids: string[]; s: GroupState; at: number; key: (id: string) => MsgKey; who: string }

const someId = (g: Gen, fallback: string) => (g.ids.length ? g.r.pick(g.ids) : fallback)

const maybe = <T extends object>(r: R, p: number, v: T): T | Record<string, never> => (r.next() < p ? v : {})

function freshOrReusedId(g: Gen): string {
  const reuse = g.r.next() < 0.05 && g.ids.length > 0
  const id = reuse ? g.r.pick(g.ids) : `m${g.ids.length}`
  g.ids.push(id)
  return id
}

function message(g: Gen): Input {
  const { r } = g
  const id = freshOrReusedId(g)
  return {
    kind: 'message',
    key: g.key(id),
    sender: g.who.split('@')[0] ?? '',
    text: text(r),
    at: g.at,
    ...maybe(r, 0.2, { media: media(id) }),
    ...maybe(r, 0.1, { quoted: media(`q${id}`) }),
  }
}

function amountRead(g: Gen): Input {
  const { r, s } = g
  const months = Object.keys(s.months)
  const amount = r.next() < 0.5 ? null : r.int(100000) + 1
  const month = months.length ? r.pick(months) : '2026-10'
  return { kind: 'amountRead', key: g.key(someId(g, 'x')), month, billId: r.int(s.nextBillId + 1), amount, at: g.at }
}

const half = <T>(r: R, v: T): T | null => (r.next() < 0.5 ? null : v)

function pickTarget(g: Gen): MsgKey {
  const open = g.s.asks.find(a => a.q === 'pick')
  return open?.q === 'pick'
    ? { id: open.messageId, fromMe: false, remoteJid: 'g@g.us', participant: open.who }
    : g.key('zz')
}

const maybeBillId = (g: Gen): number | null => (g.r.next() < 0.2 ? null : g.r.int(g.s.nextBillId + 1))

function billPicked(g: Gen): Input {
  const { r, s } = g
  const to = pickTarget(g)
  const bills = s.bills.map(b => ({ id: b.id, name: b.name }))
  const month = half(r, '2026-09')
  const amount = half(r, 500)
  return {
    kind: 'billPicked',
    pick: {
      to,
      sender: g.who,
      at: g.at,
      media: media('p'),
      month,
      amount,
      bills: bills.slice(0, r.int(bills.length + 1)),
    },
    billId: maybeBillId(g),
    amount: half(r, 700),
  }
}

export function input(r: R, ids: string[], s: GroupState, at: number): Input {
  const k = r.int(20)
  const who = r.pick(SENDERS)
  const key = (id: string): MsgKey => ({ id, fromMe: r.next() < 0.02, remoteJid: 'g@g.us', participant: who })
  const g: Gen = { r, ids, s, at, key, who }
  if (k < 13) return message(g)
  if (k < 15) {
    const edit: Input = { kind: 'edit', key: key(someId(g, 'none')), sender: who, text: text(r), at }
    return r.next() < 0.3 ? { ...edit, media: media('e') } : edit
  }
  if (k === 15) return amountRead(g)
  if (k === 16) return billPicked(g)
  if (k === 17) return { kind: 'tick', at }
  if (k === 18) return { kind: 'join', jid: 'g@g.us', at, startup: r.next() < 0.5, reading: [] }
  return { kind: 'listPosted', messageId: `L${r.int(5)}` }
}
