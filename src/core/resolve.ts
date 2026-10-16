import { findMoney, type MoneyHit, parseNumber } from './money.ts'
import { parseMonthToken } from './month.ts'
import { closest, normalize } from './text.ts'
import type { Bill } from './types.ts'

export type Resolution =
  | { ok: true; bill: Bill; amount: number | null; month: string | null }
  | { ok: false; why: 'missingBill' | 'pagoSyntax' | 'futureMonth'; amount: number | null }
  | { ok: false; why: 'suggest'; bill: Bill; amount: number | null; month: string | null }
  | { ok: false; why: 'notFound'; q: string }
  | { ok: false; why: 'onePerCommand'; bills: Bill[]; amount: number | null; month: string | null }

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
const core = (b: Bill) =>
  b.key
    .split(' ')
    .filter(w => !FILLER.has(w))
    .join(' ')
const coreWords = (b: Bill) => (core(b) ? core(b).split(' ') : words(b))

function fromCovered(kept: readonly string[], bills: readonly Bill[]): Match | null {
  const covered = bills.filter(b => coreWords(b).every(w => kept.includes(w)))
  const union = new Set(covered.flatMap(coreWords))
  if (covered.length > 1 && kept.every(w => union.has(w))) return { kind: 'many', bills: covered }
  const full = covered.filter(b => words(b).every(w => kept.includes(w)))
  const pick = covered.length === 1 ? covered[0] : full.length === 1 ? full[0] : undefined
  if (!pick) return null
  return kept.every(w => coreWords(pick).includes(w)) ? { kind: 'bill', bill: pick } : { kind: 'typo', bill: pick }
}
function paddedKey(raw: string, bills: readonly Bill[]): Bill | undefined {
  const padded = ` ${raw} `
  return [...bills]
    .sort((a, b) => b.key.length - a.key.length)
    .find(
      b =>
        padded.includes(` ${b.key} `) &&
        padded
          .replace(` ${b.key} `, ' ')
          .split(' ')
          .every(w => !w || FILLER.has(w)),
    )
}
function match(toks: readonly Tok[], bills: readonly Bill[]): Match {
  const raw = normalize(toks.map(t => t.text).join(' '))
  const named = bills.find(b => b.key === raw) ?? paddedKey(raw, bills)
  if (named) return { kind: 'bill', bill: named }
  const kept = raw.split(' ').filter(w => w && !FILLER.has(w))
  if (kept.length === 0) return { kind: 'empty' }
  const q = kept.join(' ')
  const exact = bills.find(b => b.key === q) ?? bills.find(b => core(b) === q)
  if (exact) return { kind: 'bill', bill: exact }
  const byKey = bills.filter(b => b.key.startsWith(q))
  const prefixed = byKey.length > 0 ? byKey : bills.filter(b => core(b).startsWith(q))
  if (prefixed.length === 1 && prefixed[0]) return { kind: 'bill', bill: prefixed[0] }
  if (prefixed.length > 1) return { kind: 'many', bills: prefixed }
  const fromBills = fromCovered(kept, bills)
  if (fromBills) return fromBills
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
      return { ok: false, why: 'onePerCommand', bills: m.bills, amount, month }
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
  const whole = run(rest)
  if (whole.kind === 'bill') return finish(whole, null, month)
  const ends = [rest.at(-1), rest[0]].filter(
    (t, k, all): t is Tok => t !== undefined && all.indexOf(t) === k && parseNumber(t.text, decimal) !== null,
  )
  for (const end of ends) {
    const without = run(rest.filter(t => t !== end))
    if (without.kind === 'bill' || without.kind === 'empty')
      return finish(without, parseNumber(end.text, decimal), month)
  }
  const first = ends[0]
  return first
    ? finish(run(rest.filter(t => t !== first)), parseNumber(first.text, decimal), month)
    : finish(whole, null, month)
}

const YEAR_RE = /^20\d\d$/
const LINKS = new Set(['de', 'of', 'del'])

function joinYears(tokens: readonly string[], billWords: ReadonlySet<string>, current: string): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] ?? ''
    const link = LINKS.has(normalize(tokens[i + 1] ?? '')) ? 1 : 0
    const year = tokens[i + 1 + link] ?? ''
    const named = !tok.includes('/') && !billWords.has(normalize(tok)) && parseMonthToken(tok, current) !== null
    if (named && YEAR_RE.test(year)) {
      out.push(`${tok}/${year}`)
      i += 1 + link
    } else out.push(tok)
  }
  return out
}

export function oldest(current: string): string {
  const [y = 0, m = 1] = current.split('-').map(Number)
  return `${y - 2}-${String(m).padStart(2, '0')}`
}

export function resolve(arg: string, all: readonly Bill[], current: string, decimal: ',' | '.'): Resolution {
  const bills = all.filter(b => !b.removed)
  const whole = bills.find(b => b.key === normalize(arg))
  if (whole) return { ok: true, bill: whole, amount: null, month: null }
  const billWords = new Set(bills.flatMap(words))
  const tokens = joinYears(arg.split(' ').filter(Boolean), billWords, current)
  const { marked } = findMoney(tokens, decimal)
  const money: MoneyHit | undefined = marked[0]
  if (marked.length > 1) return { ok: false, why: 'pagoSyntax', amount: null }
  const months = tokens
    .map((text, i) => ({ i, m: billWords.has(normalize(text)) ? null : parseMonthToken(text, current) }))
    .filter((x): x is { i: number; m: string } => x.m !== null && x.m >= oldest(current))
  if (months.length > 1) return { ok: false, why: 'pagoSyntax', amount: money?.cents ?? null }
  const month = months[0]?.m ?? null
  if (month && month > current) return { ok: false, why: 'futureMonth', amount: null }
  const taken = new Set(months.map(x => x.i))
  if (money) for (let i = money.start; i < money.end; i++) taken.add(i)
  const rest = tokens.map((text, i) => ({ i, text })).filter(t => !taken.has(t.i))
  const run = (toks: readonly Tok[]) => match(toks, bills)
  return money ? finish(run(rest), money.cents, month) : withBare(rest, decimal, run, month)
}
