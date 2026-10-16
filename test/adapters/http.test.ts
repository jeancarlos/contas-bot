import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { test } from 'node:test'
import { handle, type HttpDeps, renderMetrics, startHttp } from '../../src/adapters/http.ts'
import { makeLocale } from '../../src/core/i18n.ts'
import type { GroupState } from '../../src/core/types.ts'

const AT = Date.UTC(2026, 9, 5, 12)
const state = (name: string): GroupState => ({
  bills: [
    { id: 1, name, key: 'luz', paused: false, removed: false },
    { id: 2, name: 'Agua', key: 'agua', paused: false, removed: false },
    { id: 3, name: 'Gas', key: 'gas', paused: false, removed: false },
    { id: 4, name: 'Net, Fibra', key: 'net', paused: true, removed: false },
  ],
  nextBillId: 5,
  months: {
    '2026-10': { 1: { amount: 8010, status: 'typed', by: 'Gabi', paidAt: AT, messageId: 'M1' } },
    '2026-09': { 4: { amount: null, status: 'none', by: 'Gabi', paidAt: AT, messageId: 'M2' } },
  },
  handled: [],
  pinnedId: null,
  lastReset: null,
  asks: [],
})

function deps(over: Partial<HttpDeps> = {}, luz = 'Luz'): HttpDeps {
  const data: Record<string, GroupState> = { 'grupo@g.us': state(luz), 'outro@g.us': state('Luz') }
  return {
    store: { groups: () => Object.keys(data), load: jid => data[jid] ?? null },
    locale: makeLocale('pt-BR', 'BRL', 'America/Sao_Paulo'),
    currentMonth: () => '2026-10',
    connected: () => true,
    log: { warn: () => {} },
    ...over,
  }
}
const get = (d: HttpDeps, path: string) => handle(d, new URL(path, 'http://x'))

test('renderMetrics exposes the four gauges', () => {
  const m = renderMetrics(deps({ connected: () => false }))
  for (const t of ['whatsapp_connected', 'bills_unpaid', 'paid_amount', 'month_total'])
    assert.ok(m.includes(`# TYPE contas_${t} gauge`))
  assert.ok(m.includes('contas_whatsapp_connected 0\n'))
  assert.ok(m.includes('contas_bills_unpaid{group="grupo"} 2\n'))
  assert.ok(m.includes('contas_paid_amount{group="grupo",bill="Luz"} 80.1\n'))
  assert.equal(m.split('\n').filter(l => l.startsWith('contas_month_total{group="grupo"')).length, 24)
})

test('escapes label values and html', () => {
  const d = deps({}, 'Luz "A"\\ <b>&')
  assert.ok(renderMetrics(d).includes('bill="Luz \\"A\\"\\\\ <b>&"'))
  const page = get(d, '/').body
  assert.ok(page.includes('Luz &quot;A&quot;\\ &lt;b&gt;&amp;'))
  assert.ok(!page.includes('<b>'))
  assert.ok(renderMetrics(deps({}, 'a\nb')).includes('bill="a\\nb"'))
})

test('dashboard shows the list and has no scripts or forms', () => {
  const page = get(deps(), '/').body
  assert.ok(page.includes('<html lang="pt-BR">') && page.includes('<title>contas-bot</title>'))
  assert.ok(page.includes('✅ Luz — R$ 80,10') && page.includes('⬜ Agua') && page.includes('\u23F8\uFE0F Net, Fibra'))
  assert.ok(!/<script|<form/.test(page))
})

test('bad ranges answer 400, unknown paths 404', () => {
  const d = deps()
  for (const q of ['from=2026-13', 'from=2026-10&to=2026-09', 'from=2000-01&to=2026-10', 'to=abc'])
    for (const p of ['/export.csv', '/export.json']) assert.equal(get(d, `${p}?${q}`).status, 400)
  assert.equal(get(d, '/x').status, 404)
})

test('csv header, quoting and json rows', () => {
  const d = deps()
  const csv = get(d, '/export.csv?from=2026-09&to=2026-10')
  assert.equal(csv.status, 200)
  const lines = csv.body.trimEnd().split('\r\n')
  assert.equal(lines[0], 'group,month,bill,amount,status,paid_by,paid_at')
  assert.ok(lines.includes('grupo,2026-10,Luz,80.1,typed,Gabi,2026-10-05T12:00:00.000Z'))
  assert.ok(lines.includes('grupo,2026-09,"Net, Fibra",,none,Gabi,2026-10-05T12:00:00.000Z'))
  const rows = JSON.parse(get(d, '/export.json').body)
  assert.deepEqual(rows[1], {
    group: 'grupo',
    month: '2026-10',
    bill: 'Luz',
    amountCents: 8010,
    status: 'typed',
    by: 'Gabi',
    paidAt: AT,
    amount: 80.1,
  })
})

test('csv neutralises spreadsheet formulas', () => {
  const d = deps()
  const s = state('=HYPERLINK("x")')
  s.months['2026-10'] = { 1: { amount: 100, status: 'typed', by: '+1', paidAt: AT, messageId: 'M' } }
  const csv = get(
    { ...d, store: { groups: () => ['grupo@g.us'], load: () => s } },
    '/export.csv?from=2026-10&to=2026-10',
  ).body
  assert.ok(csv.includes('grupo,2026-10,"\'=HYPERLINK(""x"")",1,typed,\'+1,'))
})

test('a request never writes the store', () => {
  const inner = deps().store
  const guard = new Proxy(inner, {
    get(t, k) {
      if (k === 'groups' || k === 'load') return t[k]
      throw new Error(`store.${String(k)} touched`)
    },
  })
  const d = deps({ store: guard })
  for (const p of ['/', '/metrics', '/export.csv', '/export.json']) assert.equal(get(d, p).status, 200)
})

function rawGet(server: Server, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect((server.address() as AddressInfo).port, '127.0.0.1', () =>
      sock.write(`GET ${target} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`),
    )
    let out = ''
    sock.on('data', c => {
      out += c
    })
    sock.on('end', () => resolve(out))
    sock.on('error', reject)
  })
}

test('startHttp serves, survives a throw and refuses non-GET', async () => {
  const warns: object[] = []
  let boom = false
  const base = deps()
  const server = await startHttp(
    {
      ...base,
      log: { warn: o => warns.push(o) },
      store: {
        groups: base.store.groups,
        load: jid => {
          if (boom) throw new Error('db')
          return base.store.load(jid)
        },
      },
    },
    0,
  )
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    assert.equal((await fetch(`${url}/metrics`)).status, 200)
    boom = true
    assert.equal((await fetch(`${url}/metrics`)).status, 500)
    assert.equal(warns.length, 1)
    boom = false
    assert.equal((await fetch(`${url}/metrics`)).status, 200)
    assert.equal((await fetch(`${url}/metrics`, { method: 'POST' })).status, 405)
    const ok = await fetch(`${url}/metrics`)
    assert.equal(ok.headers.get('cache-control'), 'no-store')
    assert.equal(ok.headers.get('x-content-type-options'), 'nosniff')
    const bad = await rawGet(server, 'http://[')
    assert.match(bad, /^HTTP\/1\.1 400/)
    assert.equal(warns.length, 1)
  } finally {
    server.close()
  }
})
