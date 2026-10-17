import { normalize } from './text.ts'

const CODES = new Set(Intl.supportedValuesOf('currency'))
const WORDS = new Set(['reais', 'real', 'dolar', 'dolares', 'euro', 'euros', 'peso', 'pesos'])
const SYMBOL_RE = /^[a-z]{0,3}\p{Sc}$/iu
const ATTACHED_RE = /^(?:[a-z]{0,3}\p{Sc})(\d[\d.,]*)$|^(\d[\d.,]*)\p{Sc}$/iu
const CODE_ATTACHED_RE = /^([a-z]{3})(\d[\d.,]*)$|^(\d[\d.,]*)([a-z]{3})$/i
const NONE: ReadonlySet<string> = new Set()

export const isCurrency = (tok: string, notMoney = NONE): boolean =>
  !notMoney.has(normalize(tok)) && (SYMBOL_RE.test(tok) || CODES.has(tok.toUpperCase()) || WORDS.has(normalize(tok)))

function attachedNumber(tok: string, notMoney: ReadonlySet<string>): string | null {
  const symbol = ATTACHED_RE.exec(tok)
  if (symbol) return symbol[1] ?? symbol[2] ?? ''
  const code = CODE_ATTACHED_RE.exec(tok)
  if (!code || !isCurrency(code[1] ?? code[4] ?? '', notMoney)) return null
  return code[2] ?? code[3] ?? ''
}

export function parseNumber(t: string, decimal: ',' | '.'): number | null {
  if (!/^\d[\d.,]*$/.test(t)) return null
  const last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'))
  const num = t.includes(',') && t.includes('.') ? mixed(t, last) : last < 0 ? t : single(t, last, decimal)
  if (num === null) return null
  const n = Number(num)
  if (!(n > 0 && n < 1e12)) return null
  const cents = Math.round(n * 100)
  return cents > 0 ? cents : null
}

function mixed(t: string, last: number): string | null {
  const dec = t.charAt(last)
  const group = dec === ',' ? '.' : ','
  const int = t.slice(0, last)
  const frac = t.slice(last + 1)
  if (!new RegExp(`^(?:0|[1-9]\\d{0,2}(?:\\${group}\\d{3})*)$`).test(int) || !/^\d{1,2}$/.test(frac)) return null
  return `${int.split(group).join('')}.${frac}`
}

function single(t: string, last: number, decimal: ',' | '.'): string | null {
  const sep = t.charAt(last)
  const count = t.split(sep).length - 1
  const tail = t.length - last - 1
  if (count === 1 && (tail !== 3 || sep === decimal)) return tail <= 2 ? t.replace(sep, '.') : null
  return /^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(t) ? t.split(sep).join('') : null
}

export type MoneyHit = { start: number; end: number; cents: number }

type Found = { hit: MoneyHit; marked: boolean } | null

function hitAt(tokens: readonly string[], i: number, decimal: ',' | '.', notMoney: ReadonlySet<string>): Found {
  const tok = tokens[i] ?? ''
  const next = tokens[i + 1] ?? ''
  const attached = attachedNumber(tok, notMoney)
  if (attached !== null) {
    const cents = parseNumber(attached, decimal)
    return cents === null ? null : { hit: { start: i, end: i + 1, cents }, marked: true }
  }
  const own = parseNumber(tok, decimal)
  const following = parseNumber(next, decimal)
  if (isCurrency(tok, notMoney) && following !== null)
    return { hit: { start: i, end: i + 2, cents: following }, marked: true }
  if (own === null) return null
  if (next && isCurrency(next, notMoney) && parseNumber(tokens[i + 2] ?? '', decimal) === null)
    return { hit: { start: i, end: i + 2, cents: own }, marked: true }
  return { hit: { start: i, end: i + 1, cents: own }, marked: false }
}

export function findMoney(
  tokens: readonly string[],
  decimal: ',' | '.',
  notMoney = NONE,
): { marked: MoneyHit[]; bare: MoneyHit[] } {
  const marked: MoneyHit[] = []
  const bare: MoneyHit[] = []
  let i = 0
  while (i < tokens.length) {
    const found = hitAt(tokens, i, decimal, notMoney)
    if (found) (found.marked ? marked : bare).push(found.hit)
    i = found ? found.hit.end : i + 1
  }
  return { marked, bare }
}
