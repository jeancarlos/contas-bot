import { createServer, type Server } from 'node:http'
import { listMsg } from '../core/decide.ts'
import { formatMoney, WORDS } from '../core/i18n.ts'
import { monthTitle } from '../core/month.ts'
import { lastMonths, monthTotals, paymentRows, slug } from '../core/report.ts'
import type { Locale } from '../core/types.ts'
import type { Store } from './store.ts'

export type HttpDeps = {
  store: Pick<Store, 'groups' | 'load'>
  locale: Locale
  currentMonth(): string
  connected(): boolean
  log: { warn(o: object, m?: string): void }
}
type Reply = { status: number; type: string; body: string }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const MAX_SPAN = 120
const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const html = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5))

function groups(d: HttpDeps) {
  const out = []
  for (const jid of d.store.groups()) {
    const state = d.store.load(jid)
    if (state) out.push({ id: slug(jid), state })
  }
  return out
}

export function renderMetrics(d: HttpDeps): string {
  const current = d.currentMonth()
  const months = lastMonths(current, 24)
  const gs = groups(d)
  const lines = ['# TYPE contas_whatsapp_connected gauge', `contas_whatsapp_connected ${d.connected() ? 1 : 0}`]
  lines.push('# TYPE contas_bills_unpaid gauge')
  for (const g of gs) {
    const unpaid = monthTotals(g.state, [current])[0]?.unpaid ?? 0
    lines.push(`contas_bills_unpaid{group="${label(g.id)}"} ${unpaid}`)
  }
  lines.push('# TYPE contas_paid_amount gauge')
  for (const g of gs)
    for (const i of listMsg(g.state, current).items)
      if (i.paid && i.amount !== null)
        lines.push(`contas_paid_amount{group="${label(g.id)}",bill="${label(i.name)}"} ${String(i.amount / 100)}`)
  lines.push('# TYPE contas_month_total gauge')
  for (const g of gs)
    for (const t of monthTotals(g.state, months))
      lines.push(`contas_month_total{group="${label(g.id)}",month="${t.month}"} ${String(t.total / 100)}`)
  return `${lines.join('\n')}\n`
}

function renderDashboard(d: HttpDeps): string {
  const current = d.currentMonth()
  const loc = d.locale
  const w = WORDS[loc.lang]
  const sections = groups(d).map(g => {
    const items = listMsg(g.state, current).items
    const li = (cls: string, icon: string, text: string) => `<li class="${cls}">${icon} ${html(text)}</li>`
    const list = [
      ...items
        .filter(i => !i.paused && i.paid)
        .map(i => li('p', '✅', i.amount === null ? i.name : `${i.name} — ${formatMoney(i.amount, loc)}`)),
      ...items.filter(i => !i.paused && !i.paid).map(i => li('u', '⬜', i.name)),
      ...items.filter(i => i.paused).map(i => li('z', '⏸️', i.name)),
    ].join('')
    const rows = monthTotals(g.state, lastMonths(current, 12))
      .reverse()
      .map(t => `<tr><td>${html(monthTitle(t.month, loc.lang))}</td><td>${html(formatMoney(t.total, loc))}</td></tr>`)
      .join('')
    return `<section><h2>${html(g.id)} — ${html(monthTitle(current, loc.lang))}</h2><ul>${list}</ul><table><tr><th>${html(w.title)}</th><th>${html(w.total)}</th></tr>${rows}</table></section>`
  })
  const css =
    ':root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666}@media(prefers-color-scheme:dark){:root{--bg:#121212;--fg:#e8e8e8;--mut:#999}}body{background:var(--bg);color:var(--fg);font:16px system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:1rem}ul{list-style:none;padding:0}li.z{color:var(--mut)}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.25rem .5rem;border-bottom:1px solid var(--mut)}'
  return `<!doctype html><html lang="${html(loc.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>contas-bot</title><style>${css}</style></head><body>${sections.join('')}</body></html>`
}

function range(d: HttpDeps, url: URL): { from: string; to: string } | null {
  const current = d.currentMonth()
  const from = url.searchParams.get('from') ?? lastMonths(current, 24)[0] ?? current
  const to = url.searchParams.get('to') ?? current
  if (!MONTH.test(from) || !MONTH.test(to) || from > to) return null
  return monthIndex(to) - monthIndex(from) > MAX_SPAN ? null : { from, to }
}

function exportRows(d: HttpDeps, from: string, to: string) {
  return groups(d).flatMap(g =>
    paymentRows(g.state, from, to).map(r => ({
      group: g.id,
      ...r,
      amount: r.amountCents === null ? null : r.amountCents / 100,
    })),
  )
}

const text = (status: number, type: string, body: string): Reply => ({ status, type, body })

export function handle(d: HttpDeps, url: URL): Reply {
  switch (url.pathname) {
    case '/':
      return text(200, 'text/html; charset=utf-8', renderDashboard(d))
    case '/metrics':
      return text(200, 'text/plain; version=0.0.4; charset=utf-8', renderMetrics(d))
    case '/export.csv':
    case '/export.json': {
      const r = range(d, url)
      if (!r) return text(400, 'text/plain; charset=utf-8', 'bad from/to\n')
      const rows = exportRows(d, r.from, r.to)
      if (url.pathname === '/export.json') return text(200, 'application/json', JSON.stringify(rows))
      const head = 'group,month,bill,amount,status,paid_by,paid_at'
      const body = rows.map(x =>
        [
          x.group,
          x.month,
          x.bill,
          x.amount === null ? '' : String(x.amount),
          x.status,
          x.by,
          new Date(x.paidAt).toISOString(),
        ]
          .map(csvCell)
          .join(','),
      )
      return text(200, 'text/csv; charset=utf-8', `${[head, ...body].join('\r\n')}\r\n`)
    }
    default:
      return text(404, 'text/plain; charset=utf-8', 'not found\n')
  }
}

export function startHttp(d: HttpDeps, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    let r: Reply
    if (req.method !== 'GET') r = text(405, 'text/plain; charset=utf-8', 'method not allowed\n')
    else
      try {
        r = handle(d, new URL(req.url ?? '/', 'http://localhost'))
      } catch (err) {
        d.log.warn({ err, url: req.url }, 'http handler failed')
        r = text(500, 'text/plain; charset=utf-8', 'internal error\n')
      }
    res.writeHead(r.status, { 'content-type': r.type })
    res.end(r.body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve(server))
  })
}
