import { normalize } from './text.ts'

const CODES = new Set(Intl.supportedValuesOf('currency'))
const WORDS = new Set(['reais', 'real', 'dolar', 'dolares', 'euro', 'euros', 'peso', 'pesos'])
const SYMBOL_RE = /^[a-z]{0,3}\p{Sc}$/iu
const ATTACHED_RE = /^(?:[a-z]{0,3}\p{Sc})(\d[\d.,]*)$|^(\d[\d.,]*)\p{Sc}$/iu

export const isCurrency = (tok: string): boolean =>
  SYMBOL_RE.test(tok) || CODES.has(tok.toUpperCase()) || WORDS.has(normalize(tok))

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
  if (!new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})*$`).test(int) || !/^\d{1,2}$/.test(frac)) return null
  return `${int.split(group).join('')}.${frac}`
}

function single(t: string, last: number, decimal: ',' | '.'): string | null {
  const sep = t.charAt(last)
  const count = t.split(sep).length - 1
  const tail = t.length - last - 1
  if (count > 1 && !/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) return null
  return count === 1 && (tail !== 3 || sep === decimal) ? t.replace(sep, '.') : t.split(sep).join('')
}

export type MoneyHit = { start: number; end: number; cents: number }

function hitAt(tokens: readonly string[], i: number, decimal: ',' | '.'): { hit: MoneyHit; marked: boolean } | null {
  const tok = tokens[i] ?? ''
  const next = tokens[i + 1] ?? ''
  const attached = ATTACHED_RE.exec(tok)
  if (attached) {
    const cents = parseNumber(attached[1] ?? attached[2] ?? '', decimal)
    return cents === null ? null : { hit: { start: i, end: i + 1, cents }, marked: true }
  }
  const own = parseNumber(tok, decimal)
  const following = parseNumber(next, decimal)
  if (isCurrency(tok) && following !== null) return { hit: { start: i, end: i + 2, cents: following }, marked: true }
  if (own === null) return null
  if (next && isCurrency(next) && parseNumber(tokens[i + 2] ?? '', decimal) === null)
    return { hit: { start: i, end: i + 2, cents: own }, marked: true }
  return { hit: { start: i, end: i + 1, cents: own }, marked: false }
}

export function findMoney(tokens: readonly string[], decimal: ',' | '.'): { marked: MoneyHit[]; bare: MoneyHit[] } {
  const marked: MoneyHit[] = []
  const bare: MoneyHit[] = []
  let i = 0
  while (i < tokens.length) {
    const found = hitAt(tokens, i, decimal)
    if (found) (found.marked ? marked : bare).push(found.hit)
    i = found ? found.hit.end : i + 1
  }
  return { marked, bare }
}
