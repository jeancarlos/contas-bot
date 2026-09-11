export type Bill = { name: string; key: string; paused: boolean }
export type Payment = { name: string; paid_at: string; amount: number | null; by: string; message_id: string }
export type Command =
  | { cmd: 'pago'; name: string; amount: number | null }
  | { cmd: 'despago'; name: string }
  | { cmd: 'lista' }
  | { cmd: 'ajuda' }
  | { cmd: 'unknown'; raw: string }

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']
const TZ = 'America/Sao_Paulo'

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
    // Paused: '(pausado)', '- pausado', 'pausada' at the end of the line, needs a separator (not just a suffix).
    const m = /^(.*?)(?:^|[\s\-–—(]+)pausad[oa]\)?\s*$/i.exec(line)
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

export function parseAmount(s: string): number | null {
  let t = s.replace(/r\$/i, '').replace(/\s/g, '')
  if (!/^\d[\d.,]*$/.test(t)) return null
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function formatBRL(n: number): string {
  const [int, dec] = n.toFixed(2).split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `R$ ${grouped},${dec}`
}

export function monthKey(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value
  return `${get('year')}-${get('month')}`
}

export function monthTitle(key: string): string {
  const [y, m] = key.split('-')
  return `${MONTHS[Number(m) - 1]}/${y}`
}

export function renderList(key: string, bills: Bill[], paid: Record<string, Payment>): string {
  const active = bills.filter(b => !b.paused)
  const done = active.filter(b => paid[b.key])
  const pending = active.filter(b => !paid[b.key])
  const paused = bills.filter(b => b.paused)
  const lines = [`📋 *Contas — ${monthTitle(key)}*`, '']
  for (const b of done) {
    const a = paid[b.key].amount
    lines.push(a == null ? `✅ ${b.name}` : `✅ ${b.name} — ${formatBRL(a)}`)
  }
  for (const b of pending) lines.push(`⬜ ${b.name}`)
  for (const b of paused) lines.push(`⏸️ ${b.name}`)
  const amounts = done.map(b => paid[b.key].amount).filter((a): a is number => a != null)
  const total = amounts.reduce((s, a) => s + a, 0)
  const missing = done.length - amounts.length
  let footer = `*Pago:* ${done.length}/${active.length} · *Total:* ${formatBRL(total)}`
  if (missing > 0) footer += ` (${missing} sem valor)`
  lines.push('', footer)
  return lines.join('\n')
}

export function parseCommand(text: string): Command | null {
  const t = text.trim()
  if (!t.startsWith('/')) return null
  const [cmd, ...rest] = t.slice(1).split(/\s+/)
  const arg = rest.join(' ')
  switch (cmd.toLowerCase()) {
    case 'pago': {
      // trailing amount: last token that parses as money, e.g. "cartão nu R$ 6.237,60"
      const m = /^(.*?)\s+(?:r\$\s*)?([\d.,]+)$/i.exec(arg)
      const amount = m ? parseAmount(m[2]) : null
      return { cmd: 'pago', name: m && amount != null ? m[1] : arg, amount }
    }
    case 'despago': return { cmd: 'despago', name: arg }
    case 'lista': return { cmd: 'lista' }
    case 'ajuda':
    case 'help': return { cmd: 'ajuda' }
    default: return { cmd: 'unknown', raw: t }
  }
}

export function matchPlainText(bills: Bill[], text: string): Bill | null {
  const t = normalize(text).replace(/^(pago|paguei|paga)\s+((a|o|as|os)\s+)?/, '')
  return bills.find(b => b.key === t) ?? null
}

export const SECTION_MARK = '🤖 contas-bot'
const SECTION_HEADER = `──── ${SECTION_MARK} ────`
const SECTION_TITLE = 'Contas (edite esta lista):'
const SECTION_DIVIDER = '──────────────'
const SECTION_HELP = '/pago <conta> [valor] · /lista · /help'
const DESC_LIMIT = 2048
export const DEMO_BILLS = 'Luz\nÁgua\nInternet\nAluguel\nAcademia (pausado)'

// The header is a line holding only the marker and decoration; prose that mentions the bot is not it.
const HEADER_RE = /^[\s\-–—─━=_*~]*🤖 contas-bot[\s\-–—─━=_*~]*$/

// The bot owns everything from its header line down; text above it belongs to the group.
export function splitDescription(desc: string): { original: string; section: string | null } {
  const lines = desc.split('\n')
  const i = lines.findIndex(l => HEADER_RE.test(l.trim()))
  if (i < 0) return { original: desc, section: null }
  return { original: lines.slice(0, i).join('\n'), section: lines.slice(i + 1).join('\n') }
}

export function billLine(b: Bill): string {
  return b.paused ? `${b.name} (pausado)` : b.name
}

export function renderSection(bills: Bill[], withHelp = true): string {
  const lines = [SECTION_HEADER, SECTION_TITLE, ...bills.map(billLine), SECTION_DIVIDER]
  if (withHelp) lines.push(SECTION_HELP)
  return lines.join('\n')
}

// Over WhatsApp's limit only the help line may go. The group's text and the bill list are never cut:
// null means it does not fit and the caller must leave the description alone.
export function composeDescription(original: string, bills: Bill[]): string | null {
  const top = original.trimEnd()
  const join = (section: string) => (top ? `${top}\n\n${section}` : section)
  const full = join(renderSection(bills))
  if (full.length <= DESC_LIMIT) return full
  const bare = join(renderSection(bills, false))
  return bare.length <= DESC_LIMIT ? bare : null
}

const GREETINGS = ['oi', 'ola', 'opa', 'eai', 'e ai', 'bom dia', 'boa tarde', 'boa noite', 'hello', 'hi']

// A greeting only counts when it names the bot: a bare "oi" is for the other person.
export function isGreeting(text: string): boolean {
  const t = normalize(text)
  const words = t.split(' ')
  return words.length <= 4 && words.includes('bot') && GREETINGS.some(g => t === g || t.startsWith(`${g} `))
}
