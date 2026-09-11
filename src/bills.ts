import { DEFAULT_LOCALE, type Locale } from './i18n.ts'

export type Bill = { name: string; key: string; paused: boolean }
export type Payment = { name: string; paid_at: string; amount: number | null; by: string; message_id: string }
export type Command =
  | { cmd: 'pago'; name: string; amount: number | null }
  | { cmd: 'despago'; name: string }
  | { cmd: 'lista' }
  | { cmd: 'ajuda' }
  | { cmd: 'unknown'; raw: string }

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
const TZ = process.env.TZ && validTimeZone(process.env.TZ) ? process.env.TZ : 'America/Sao_Paulo'

export function normalize(s: string): string {
  return s.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseDescription(desc: string): Bill[] {
  const bills: Bill[] = []
  for (const raw of desc.split('\n')) {
    const trimmed = raw.trim()
    // A divider line ends the bill list: below it the description is free text (help, notes).
    if (/^[-_=—–─━.·*~]{3,}$/.test(trimmed)) break
    // Strip list markers so '- Luz', '1. Luz', '• Luz' all become 'Luz'.
    const line = trimmed.replace(/^(?:[-*•·]|\d+[.)])\s+/, '')
    // '#' comments and 'Contas:'-style headings are not bills.
    if (!line || line.startsWith('#') || line.startsWith('/') || line.endsWith(':')) continue
    // Paused: '(pausado)'/'(paused)', '- pausado', 'pausada' at the end of the line, needs a separator (not just a suffix).
    const m = /^(.*?)(?:^|[\s\-–—(]+)(?:pausad[oa]|paused)\)?\s*$/i.exec(line)
    const name = (m ? m[1] : line).trim()
    const key = normalize(name)
    if (!key || bills.some(b => b.key === key)) continue
    bills.push({ name, key, paused: Boolean(m) })
  }
  return bills
}

export function resolveBill(bills: Bill[], query: string): Bill | null {
  const q = normalize(query)
  if (!q) return null
  const exact = bills.find(b => b.key === q)
  if (exact) return exact
  const prefix = bills.filter(b => b.key.startsWith(q))
  return prefix.length === 1 ? prefix[0] : null
}

export function parseAmount(s: string, loc: Locale = DEFAULT_LOCALE): number | null {
  // Currency symbols and codes sit at the ends ("R$ 10", "10 €", "USD 10"); spaces may group thousands.
  // A leading digit/comma/dot/hyphen is never stripped, so a bare ".5" or "-10" fails the digit-start check below.
  const t = s.replace(/^[^\d.,-]+|\D+$/g, '').replace(/\s/g, '')
  if (!/^\d[\d.,]*$/.test(t)) return null
  let num: string
  const last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'))
  if (t.includes(',') && t.includes('.')) {
    num = t.slice(0, last).replace(/[.,]/g, '') + '.' + t.slice(last + 1)
  } else if (last < 0) {
    num = t
  } else {
    const sep = t[last]
    const count = t.split(sep).length - 1
    const tail = t.length - last - 1
    const isDecimal = count === 1 && (tail !== 3 || sep === loc.decimal)
    num = isDecimal ? t.replace(sep, '.') : t.split(sep).join('')
  }
  const n = Number(num)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function formatMoney(n: number, loc: Locale = DEFAULT_LOCALE): string {
  return new Intl.NumberFormat(loc.lang, { style: 'currency', currency: loc.currency }).format(n).replace(/[\u00a0\u202f]/g, ' ')
}

export function monthKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value
  return `${get('year')}-${get('month')}`
}

export function monthTitle(key: string, loc: Locale = DEFAULT_LOCALE): string {
  const [y, m] = key.split('-').map(Number)
  const name = new Intl.DateTimeFormat(loc.lang, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 15)))
  return `${name[0].toLocaleUpperCase(loc.lang)}${name.slice(1)}/${y}`
}

export function renderList(key: string, bills: Bill[], paid: Record<string, Payment>, loc: Locale = DEFAULT_LOCALE): string {
  const active = bills.filter(b => !b.paused)
  const done = active.filter(b => paid[b.key])
  const pending = active.filter(b => !paid[b.key])
  const paused = bills.filter(b => b.paused)
  const lines = [`📋 *${loc.t.listTitle} — ${monthTitle(key, loc)}*`, '']
  for (const b of done) {
    const a = paid[b.key].amount
    lines.push(a == null ? `✅ ${b.name}` : `✅ ${b.name} — ${formatMoney(a, loc)}`)
  }
  for (const b of pending) lines.push(`⬜ ${b.name}`)
  for (const b of paused) lines.push(`⏸️ ${b.name}`)
  const amounts = done.map(b => paid[b.key].amount).filter((a): a is number => a != null)
  const total = amounts.reduce((s, a) => s + a, 0)
  const missing = done.length - amounts.length
  let footer = `*${loc.t.paidLabel}:* ${done.length}/${active.length} · *${loc.t.totalLabel}:* ${formatMoney(total, loc)}`
  if (missing > 0) footer += ` (${loc.t.noAmount(missing)})`
  lines.push('', footer)
  return lines.join('\n')
}

export function parseCommand(text: string, loc: Locale = DEFAULT_LOCALE): Command | null {
  const t = text.trim()
  if (!t.startsWith('/')) return null
  const [cmd, ...rest] = t.slice(1).split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd.toLowerCase()) {
    case 'pago':
    case 'paid':
    case 'pagado': {
      // trailing amount: e.g. "cartão nu R$ 6.237,60", "water $80.10", "luz 80 €", "luz USD 10".
      // The optional prefix/suffix is restricted to currency tokens (a symbol, optionally led by
      // up to 3 letters as in "R$"/"US$", or an upper-case 3-letter code like "USD") so a
      // multi-word bill name is never swallowed into the amount.
      const m = /^(.*?)\s+((?:(?:[A-Za-z]{0,3}[^\p{L}\d\s]|[A-Z]{3})\s*)?[\d.,]+(?:\s*(?:[^\p{L}\d\s]{1,3}|[A-Z]{3}))?)$/u.exec(arg)
      const amount = m ? parseAmount(m[2], loc) : null
      return { cmd: 'pago', name: m && amount != null ? m[1] : arg, amount }
    }
    case 'despago':
    case 'despagado':
    case 'unpaid':
    case 'reverter':
    case 'revert':
    case 'revertir': return { cmd: 'despago', name: arg }
    case 'lista':
    case 'list': return { cmd: 'lista' }
    case 'ajuda':
    case 'help':
    case 'ayuda': return { cmd: 'ajuda' }
    default: return { cmd: 'unknown', raw: t }
  }
}

export function matchPlainText(bills: Bill[], text: string): Bill | null {
  const t = normalize(text).replace(/^(pago|paguei|paga|paid|pagado|pague)\s+((a|o|as|os|the|el|la|los|las)\s+)?/, '')
  return bills.find(b => b.key === t) ?? null
}

export const SECTION_MARK = '🤖 contas-bot'
const SECTION_HEADER = `──── ${SECTION_MARK} ────`
const SECTION_DIVIDER = '──────────────'
const DESC_LIMIT = 2048
export const DEMO_BILLS = DEFAULT_LOCALE.t.demoBills

// The header is a line holding only the marker and decoration; prose that mentions the bot is not it.
const HEADER_RE = /^[\s\-–—─━=_*~]*🤖 contas-bot[\s\-–—─━=_*~]*$/

// The bot owns everything from its header line down; text above it belongs to the group.
export function splitDescription(desc: string): { original: string; section: string | null } {
  const lines = desc.split('\n')
  const i = lines.findIndex(l => HEADER_RE.test(l.trim()))
  if (i < 0) return { original: desc, section: null }
  return { original: lines.slice(0, i).join('\n'), section: lines.slice(i + 1).join('\n') }
}

export function billLine(b: Bill, loc: Locale = DEFAULT_LOCALE): string {
  return b.paused ? `${b.name} (${loc.t.pauseWord})` : b.name
}

export function renderSection(bills: Bill[], loc: Locale = DEFAULT_LOCALE, withHelp = true): string {
  const lines = [SECTION_HEADER, loc.t.sectionTitle, ...bills.map(b => billLine(b, loc)), SECTION_DIVIDER]
  if (withHelp) lines.push(loc.t.sectionHelp)
  return lines.join('\n')
}

// Over WhatsApp's limit only the help line may go. The group's text and the bill list are never cut:
// null means it does not fit and the caller must leave the description alone.
export function composeDescription(original: string, bills: Bill[], loc: Locale = DEFAULT_LOCALE): string | null {
  const top = original.trimEnd()
  const join = (section: string) => (top ? `${top}\n\n${section}` : section)
  const full = join(renderSection(bills, loc))
  if (full.length <= DESC_LIMIT) return full
  const bare = join(renderSection(bills, loc, false))
  return bare.length <= DESC_LIMIT ? bare : null
}

const GREETINGS = [
  'oi', 'ola', 'opa', 'eai', 'e ai', 'bom dia', 'boa tarde', 'boa noite', 'hello', 'hi',
  'hey', 'good morning', 'good afternoon', 'good evening', 'hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches',
]

// A greeting only counts when it names the bot: a bare "oi" is for the other person.
export function isGreeting(text: string): boolean {
  const t = normalize(text)
  const words = t.split(' ')
  return words.length <= 4 && words.includes('bot') && GREETINGS.some(g => t === g || t.startsWith(`${g} `))
}
