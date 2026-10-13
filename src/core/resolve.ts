import { findMoney, type MoneyHit, parseNumber } from './money.ts'
import { parseMonthToken } from './month.ts'
import { closest, normalize } from './text.ts'
import type { Bill } from './types.ts'

export type Resolution =
  | { ok: true; bill: Bill; amount: number | null; month: string | null }
  | { ok: false; why: 'missingBill' | 'pagoSyntax' | 'futureMonth'; amount: number | null }
  | { ok: false; why: 'suggest'; bill: Bill; amount: number | null; month: string | null }
  | { ok: false; why: 'notFound'; q: string }
  | { ok: false; why: 'onePerCommand'; bills: Bill[] }

type Match =
  | { kind: 'bill'; bill: Bill }
  | { kind: 'empty' }
  | { kind: 'many'; bills: Bill[] }
  | { kind: 'typo'; bill: Bill }
  | { kind: 'none'; q: string }

type Tok = { i: number; text: string }

const FILLER = new Set([
  'a',
  'o',
  'as',
  'os',
  'e',
  'y',
  'da',
  'de',
  'do',
  'das',
  'dos',
  'the',
  'el',
  'la',
  'los',
  'las',
  'conta',
  'mes',
  'ok',
  'paga',
  'paguei',
])

const words = (b: Bill) => b.key.split(' ')

function match(toks: readonly Tok[], bills: readonly Bill[]): Match {
  const raw = normalize(toks.map(t => t.text).join(' '))
  const named = bills.find(b => b.key === raw)
  if (named) return { kind: 'bill', bill: named }
  const kept = raw.split(' ').filter(w => w && !FILLER.has(w))
  if (kept.length === 0) return { kind: 'empty' }
  const q = kept.join(' ')
  const exact = bills.find(b => b.key === q)
  if (exact) return { kind: 'bill', bill: exact }
  const prefixed = bills.filter(b => b.key.startsWith(q))
  if (prefixed.length === 1 && prefixed[0]) return { kind: 'bill', bill: prefixed[0] }
  if (prefixed.length > 1) return { kind: 'many', bills: prefixed }
  const covered = bills.filter(b => words(b).every(w => kept.includes(w)))
  const union = new Set(covered.flatMap(words))
  const onlyBillWords = kept.every(w => union.has(w))
  if (covered.length > 1 && onlyBillWords) return { kind: 'many', bills: covered }
  if (covered.length === 1 && covered[0]) {
    return onlyBillWords ? { kind: 'bill', bill: covered[0] } : { kind: 'typo', bill: covered[0] }
  }
  const near = closest(bills, b => b.key, q)
  return near ? { kind: 'typo', bill: near } : { kind: 'none', q }
}

function finish(m: Match, amount: number | null, month: string | null): Resolution {
  switch (m.kind) {
    case 'bill':
      return { ok: true, bill: m.bill, amount, month }
    case 'empty':
      return { ok: false, why: 'missingBill', amount }
    case 'many':
      return { ok: false, why: 'onePerCommand', bills: m.bills }
    case 'typo':
      return { ok: false, why: 'suggest', bill: m.bill, amount, month }
    case 'none':
      return { ok: false, why: 'notFound', q: m.q }
  }
}

function withBare(
  rest: readonly Tok[],
  decimal: ',' | '.',
  run: (toks: readonly Tok[]) => Match,
  month: string | null,
) {
  const end = [rest.at(-1), rest[0]].find(t => t && parseNumber(t.text, decimal) !== null)
  if (!end) return finish(run(rest), null, month)
  const cents = parseNumber(end.text, decimal)
  const without = run(rest.filter(t => t !== end))
  if (without.kind === 'bill' || without.kind === 'empty') return finish(without, cents, month)
  const asName = run(rest)
  return asName.kind === 'bill' ? finish(asName, null, month) : finish(without, cents, month)
}

export function resolve(arg: string, all: readonly Bill[], current: string, decimal: ',' | '.'): Resolution {
  const bills = all.filter(b => !b.removed)
  const whole = bills.find(b => b.key === normalize(arg))
  if (whole) return { ok: true, bill: whole, amount: null, month: null }
  const tokens = arg.split(' ').filter(Boolean)
  const billWords = new Set(bills.flatMap(words))
  const { marked } = findMoney(tokens, decimal)
  const money: MoneyHit | undefined = marked[0]
  if (marked.length > 1) return { ok: false, why: 'pagoSyntax', amount: null }
  const months = tokens
    .map((text, i) => ({ i, m: billWords.has(normalize(text)) ? null : parseMonthToken(text, current) }))
    .filter((x): x is { i: number; m: string } => x.m !== null)
  if (months.length > 1) return { ok: false, why: 'pagoSyntax', amount: money?.cents ?? null }
  const month = months[0]?.m ?? null
  if (month && month > current) return { ok: false, why: 'futureMonth', amount: null }
  const taken = new Set(months.map(x => x.i))
  if (money) for (let i = money.start; i < money.end; i++) taken.add(i)
  const rest = tokens.map((text, i) => ({ i, text })).filter(t => !taken.has(t.i))
  const run = (toks: readonly Tok[]) => match(toks, bills)
  return money ? finish(run(rest), money.cents, month) : withBare(rest, decimal, run, month)
}
