// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { isIP } from 'node:net'
import { listMsg } from '../core/decide.ts'
import { formatMoney, WORDS } from '../core/i18n.ts'
import { monthTitle } from '../core/month.ts'
import { lastMonths, monthTotals, paymentRows, slug } from '../core/report.ts'
import type { GroupState, Locale } from '../core/types.ts'
import type { Store } from './store.ts'

export type HttpDeps = {
  store: Pick<Store, 'groups' | 'load'>
  locale: Locale
  currentMonth(): string
  served(): string[]
  connected(): boolean
  log: { warn(o: object, m?: string): void }
  hosts?: string[]
  token?: string
}
type Reply = { status: number; type: string; body: string }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const MAX_SPAN = 120
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
}

export function httpPort(raw: string | undefined, log: HttpDeps['log']): number {
  const v = (raw ?? '').trim()
  if (v === '' || v === '0') return 0
  const n = Number(v)
  if (/^\d+$/.test(v) && n >= 1 && n <= 65535) return n
  log.warn({ HTTP_PORT: v }, 'HTTP_PORT is not a port from 1 to 65535: http server off')
  return 0
}
const label = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
const html = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const safe = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5))

function groups(d: HttpDeps) {
  const out = []
  const served = new Set(d.served())
  for (const jid of d.store.groups().filter(j => served.has(j))) {
    const state = d.store.load(jid)
    if (state) out.push({ id: slug(jid), state })
  }
  return out
}

function paidLines(g: { id: string; state: GroupState }, current: string): string[] {
  const paid = new Map<string, number>()
  for (const i of listMsg(g.state, current).items)
    if (i.paid && !i.paused && i.amount !== null) paid.set(i.name, (paid.get(i.name) ?? 0) + i.amount)
  return [...paid].map(
    ([name, cents]) => `contas_paid_amount{group="${label(g.id)}",bill="${label(name)}"} ${String(cents / 100)}`,
  )
}

const family = (name: string, help: string) => [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`]

export function renderMetrics(d: HttpDeps): string {
  const current = d.currentMonth()
  const months = lastMonths(current, 24)
  const gs = groups(d)
  const lines = [
    ...family('contas_whatsapp_connected', '1 while the WhatsApp session is open, 0 otherwise'),
    `contas_whatsapp_connected ${d.connected() ? 1 : 0}`,
  ]
  lines.push(...family('contas_bills_unpaid', 'Active bills not yet paid this month, per group'))
  for (const g of gs) {
    const unpaid = monthTotals(g.state, [current])[0]?.unpaid ?? 0
    lines.push(`contas_bills_unpaid{group="${label(g.id)}"} ${unpaid}`)
  }
  lines.push(...family('contas_paid_amount', 'Amount paid this month per bill, in the bot currency'))
  for (const g of gs) lines.push(...paidLines(g, current))
  lines.push(...family('contas_month_paid', 'Total paid per group and month over the last 24 months'))
  for (const g of gs)
    for (const t of monthTotals(g.state, months))
      lines.push(`contas_month_paid{group="${label(g.id)}",month="${t.month}"} ${String(t.total / 100)}`)
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
      ...items.filter(i => i.paused).map(i => li('z', '\u23F8\uFE0F', i.name)),
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
  const to = url.searchParams.get('to') ?? current
  const from = url.searchParams.get('from') ?? (MONTH.test(to) ? lastMonths(to, 24)[0] : undefined) ?? current
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

function summary(d: HttpDeps) {
  const current = d.currentMonth()
  return {
    month: current,
    currency: d.locale.currency,
    groups: groups(d).map(g => {
      const t = monthTotals(g.state, [current])[0]
      return {
        group: g.id,
        unpaid: t?.unpaid ?? 0,
        total: (t?.total ?? 0) / 100,
        bills: listMsg(g.state, current).items.map(i => ({
          name: i.name,
          paid: i.paid,
          amount: i.amount === null ? null : i.amount / 100,
          paused: i.paused,
        })),
      }
    }),
  }
}

const text = (status: number, type: string, body: string): Reply => ({ status, type, body })

export function handle(d: HttpDeps, url: URL): Reply {
  switch (url.pathname) {
    case '/':
      return text(200, 'text/html; charset=utf-8', renderDashboard(d))
    case '/metrics':
      return text(200, 'text/plain; version=0.0.4; charset=utf-8', renderMetrics(d))
    case '/summary.json':
      return text(200, 'application/json', JSON.stringify(summary(d)))
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
          safe(x.bill),
          x.amount === null ? '' : String(x.amount),
          x.status,
          safe(x.by),
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

const hostName = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[(.*)\]$/, '$1')

function hostOk(d: HttpDeps, host: string | undefined): boolean {
  const name = hostName(host ?? '')
  if (name === '') return false
  return !name.includes('.') || isIP(name) !== 0 || (d.hosts ?? []).some(h => hostName(h) === name)
}

const digest = (v: string) => createHash('sha256').update(v).digest()
const tokenOk = (token: string, auth: string | undefined) =>
  timingSafeEqual(digest(`Bearer ${token}`), digest(auth ?? ''))

function route(
  d: HttpDeps,
  method: string | undefined,
  raw: string | undefined,
  host: string | undefined,
  auth: string | undefined,
): Reply {
  if (!hostOk(d, host)) return text(421, 'text/plain; charset=utf-8', 'misdirected request\n')
  if (method !== 'GET') return text(405, 'text/plain; charset=utf-8', 'method not allowed\n')
  if (d.token && !tokenOk(d.token, auth)) return text(401, 'text/plain; charset=utf-8', 'unauthorized\n')
  let url: URL
  try {
    url = new URL(raw ?? '/', 'http://localhost')
  } catch {
    return text(400, 'text/plain; charset=utf-8', 'bad url\n')
  }
  try {
    return handle(d, url)
  } catch (err) {
    d.log.warn({ err, url: raw }, 'http handler failed')
    return text(500, 'text/plain; charset=utf-8', 'internal error\n')
  }
}

export function startHttp(d: HttpDeps, port: number, bind = '0.0.0.0'): Promise<Server> {
  const server = createServer((req, res) => {
    const r = route(d, req.method, req.url, req.headers.host, req.headers.authorization)
    res.writeHead(r.status, { ...HEADERS, 'content-type': r.type })
    res.end(r.body)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bind, () => {
      server.off('error', reject)
      server.on('error', err => d.log.warn({ err }, 'http server error'))
      resolve(server)
    })
  })
}
