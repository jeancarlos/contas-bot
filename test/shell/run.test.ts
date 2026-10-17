// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStore, type Store } from '../../src/adapters/store.ts'
import type { Release } from '../../src/announce.ts'
import type { GroupMeta } from '../../src/adapters/v1.ts'
import { makeLocale } from '../../src/core/i18n.ts'
import { state } from '../core/gen.ts'
import type { GroupState, Input } from '../../src/core/types.ts'
import { cachedGroups, lanes, makeShell, ticker, type Wa } from '../../src/shell/run.ts'

const JID = 'g1@g.us'
const OCT = Date.UTC(2026, 9, 10, 15)
const locale = makeLocale('pt-BR', 'BRL', 'America/Sao_Paulo')
const MIGRATED: GroupMeta = { invite: null, announcedVersion: '2.0.0', descriptionMigrated: true }
const SECTION = [
  '──── 🤖 contas-bot ────',
  'Contas (edite esta lista):',
  'Luz',
  'Internet',
  '──────────────',
  '/pago <conta> [valor] · /lista · /help',
].join('\n')

const RELEASES: Release[] = [{ version: '2.0.0', entries: [{ en: 'bills', 'pt-BR': 'contas por /conta' }] }]

type Call = { op: string; arg?: string }
type WaOpts = {
  desc?: string
  failSetDescription?: boolean
  failDownload?: boolean
  failVideo?: boolean
  fail?: (op: string, arg?: string) => boolean
  download?: (signal: AbortSignal | undefined) => Promise<Buffer>
}

function fakeWa(calls: Call[], o: WaOpts): Wa {
  let n = 0
  return {
    async sendText(text, quoted) {
      if (o.fail?.('send', text)) throw new Error('send refused')
      calls.push({ op: 'send', arg: quoted ? `${quoted.id}: ${text}` : text })
      return `sent${++n}`
    },
    async sendVideo(_video, caption) {
      if (o.failVideo || o.fail?.('video')) throw new Error('video refused')
      calls.push({ op: 'video', arg: caption })
      return `sent${++n}`
    },
    async react(key) {
      if (o.fail?.('react')) throw new Error('react refused')
      calls.push({ op: 'react', arg: key.id })
    },
    async pin(id) {
      if (o.fail?.('pin')) throw new Error('pin refused')
      calls.push({ op: 'pin', arg: id })
    },
    async unpin(id) {
      if (o.fail?.('unpin')) throw new Error('unpin refused')
      calls.push({ op: 'unpin', arg: id })
    },
    async getDescription() {
      return o.desc ?? ''
    },
    async setDescription(text) {
      if (o.failSetDescription) throw new Error('not admin')
      calls.push({ op: 'setDescription', arg: text })
    },
    async download(media, signal) {
      if (o.download) return o.download(signal)
      if (o.failDownload) throw new Error('media gone')
      return Buffer.from(String(media.handle))
    },
  }
}

const bills = (...names: string[]) => state(names)

type Setup = {
  state?: GroupState
  meta?: GroupMeta
  failCommit?: boolean
  failCommitFrom?: number
  wa?: WaOpts
  llm?: (image: Buffer, mime: string, signal?: AbortSignal) => Promise<number | null>
  pdf?: (signal: AbortSignal | undefined) => Promise<Buffer>
  pick?: (names: string[]) => Promise<{ index: number | null; amount: number | null }>
  gif?: boolean
  version?: string
  releases?: Release[] | null
  failSetMeta?: boolean
  readTimeoutMs?: number
  readWaitMs?: number
}

function setup(o: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'contas-shell-'))
  const { store: real } = openStore({
    dbPath: join(dir, 'contas.db'),
    v1Path: join(dir, 'state.json'),
    allowEmpty: true,
  })
  if (o.state) real.commit(JID, o.state)
  if (o.meta) real.setMeta(JID, o.meta)
  const calls: Call[] = []
  const store: Store = {
    ...real,
    commit(jid, state) {
      calls.push({ op: 'commit' })
      if (o.failCommit || (o.failCommitFrom && calls.filter(c => c.op === 'commit').length >= o.failCommitFrom))
        throw new Error('disk full')
      real.commit(jid, state)
    },
    setMeta(jid, meta) {
      if (o.failSetMeta) throw new Error('disk full')
      real.setMeta(jid, meta)
    },
  }
  const wa = fakeWa(calls, o.wa ?? {})
  const pdfs: string[] = []
  const warns: object[] = []
  const shell = makeShell({
    store,
    wa: () => wa,
    locale,
    llm: {
      enabled: true,
      readAmount: o.llm ?? (async () => 80.1),
      pickBill: async (_image, _mime, names) => (o.pick ? o.pick(names) : { index: null, amount: null }),
    },
    pdfToPng: async (pdf, signal) => {
      if (o.pdf) return o.pdf(signal)
      pdfs.push(pdf.toString())
      return Buffer.from('png')
    },
    log: { info() {}, warn: (o: object, m?: string) => warns.push({ ...o, m }), error() {} },
    now: () => OCT,
    version: o.version ?? '2.0.0',
    announce: {
      releases: o.releases === undefined ? RELEASES : o.releases,
      gif: async () => (o.gif ? Buffer.from('gif') : null),
    },
    readTimeoutMs: o.readTimeoutMs ?? 50,
    readGraceMs: 30,
    readWaitMs: o.readWaitMs,
  })
  return { shell, store: real, calls, pdfs, warns }
}

let seq = 0
const msg = (text: string, extra: Partial<Extract<Input, { kind: 'message' }>> = {}) => ({
  kind: 'message' as const,
  key: { id: `m${++seq}`, fromMe: false, remoteJid: JID, participant: 'p@s.whatsapp.net' },
  sender: 'Ana',
  text,
  at: OCT,
  ...extra,
})
const ops = (calls: Call[]) => calls.map(c => c.op)

test('a /pago is committed before anything is sent, and the posted list is pinned after a second commit', async () => {
  const { shell, store, calls } = setup({ state: bills('Luz') })
  await shell.handle(JID, msg('/pago luz 80'))
  await shell.idle()
  assert.deepEqual(ops(calls), ['commit', 'react', 'send', 'commit', 'pin'])
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, 8000)
  assert.equal(store.load(JID)?.pinnedId, 'sent1')
})

test('a failed commit sends saveFailed and nothing else, and the stored state is unchanged', async () => {
  const { shell, store, calls } = setup({ state: bills('Luz'), failCommit: true })
  const m = msg('/pago luz 80')
  await shell.handle(JID, m)
  await shell.idle()
  assert.deepEqual(calls, [{ op: 'commit' }, { op: 'send', arg: `${m.key.id}: não consegui salvar, tenta de novo` }])
  assert.equal(store.load(JID)?.months['2026-10'], undefined)
})

test('chat that changes nothing is neither committed nor answered', async () => {
  const { shell, calls } = setup({ state: bills('Luz') })
  await shell.handle(JID, msg('paguei a luz ontem'))
  await shell.idle()
  assert.deepEqual(calls, [])
})

test('a receipt is paid at once and its amount arrives later through the mailbox, a PDF rendered first', async () => {
  const { shell, store, calls, pdfs } = setup({ state: bills('Luz') })
  await shell.handle(JID, msg('/pago luz', { media: { mime: 'application/pdf', handle: 'pdf-bytes' } }))
  await shell.idle()
  assert.deepEqual(pdfs, ['pdf-bytes'])
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, 8010)
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'read')
  assert.deepEqual(ops(calls), ['commit', 'react', 'commit', 'send', 'commit', 'pin'])
})

test('an undownloadable, unreadable or slow receipt ends as no amount with one question back', async () => {
  const never = () => new Promise<number | null>(() => {})
  for (const o of [{ wa: { failDownload: true } }, { llm: async () => null }, { llm: never }]) {
    const { shell, store, calls } = setup({ state: bills('Luz'), ...o })
    const m = msg('/pago luz', { media: { mime: 'image/jpeg', handle: 'img' } })
    await shell.handle(JID, m)
    await shell.idle()
    assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'none')
    assert.deepEqual(
      calls.filter(c => c.arg?.startsWith(`${m.key.id}: `)),
      [{ op: 'send', arg: `${m.key.id}: não consegui ler o valor de Luz. Qual foi? Responda só o valor, ex: 80,00` }],
    )
  }
})

test('a new group is onboarded once with the intro and a pinned list, and gets no announcement', async () => {
  const { shell, store, calls } = setup()
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(ops(calls), ['commit', 'send', 'send', 'commit', 'pin'])
  assert.match(calls[1]?.arg ?? '', /\/conta adiciona/)
  assert.equal(store.load(JID)?.lastReset, '2026-10')
  assert.deepEqual(store.meta(JID), { invite: null, announcedVersion: '2.0.0', descriptionMigrated: true })
  calls.length = 0
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(calls, [])
})

test('an imported group migrates its description once: bills from the section, group text kept, line added', async () => {
  const meta = { ...MIGRATED, descriptionMigrated: false }
  const { shell, store, calls } = setup({ state: bills('Luz', 'Água'), meta, wa: { desc: `Casa\n\n${SECTION}` } })
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(
    store.load(JID)?.bills.map(b => [b.name, b.removed]),
    [
      ['Luz', false],
      ['Água', true],
      ['Internet', false],
    ],
  )
  assert.deepEqual(
    calls.filter(c => c.op === 'setDescription'),
    [{ op: 'setDescription', arg: 'Casa\n\n📋 contas: /conta · /lista · /ajuda' }],
  )
  assert.equal(store.meta(JID)?.descriptionMigrated, true)
  calls.length = 0
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(calls, [])
})

test('a description the bot cannot edit gets one notice asking the group to delete the old section', async () => {
  const meta = { ...MIGRATED, descriptionMigrated: false }
  const wa = { desc: SECTION, failSetDescription: true }
  const { shell, store, calls } = setup({ state: bills('Luz'), meta, wa })
  await shell.join(JID)
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(
    calls.filter(c => c.op === 'send').map(c => c.arg),
    [
      'não consegui editar a descrição do grupo: alguém apaga de lá a parte antiga do contas-bot? As contas agora ficam em /conta.',
    ],
  )
  assert.equal(store.meta(JID)?.descriptionMigrated, true)
})

test('a new release is announced once to an existing group, as a gif with a text fallback', async () => {
  const older = { ...MIGRATED, announcedVersion: '1.2.0' }
  const body = '🎉🤖 contas-bot v2.0.0\n\n• contas por /conta'
  const gif = setup({ state: bills('Luz'), meta: older, gif: true })
  await gif.shell.join(JID)
  await gif.shell.join(JID)
  await gif.shell.idle()
  assert.deepEqual(gif.calls, [{ op: 'video', arg: body }])
  assert.equal(gif.store.meta(JID)?.announcedVersion, '2.0.0')
  const text = setup({ state: bills('Luz'), meta: older, gif: true, wa: { failVideo: true } })
  await text.shell.join(JID)
  await text.shell.idle()
  assert.deepEqual(text.calls, [{ op: 'send', arg: body }])
})

test('only the first join after a start asks the payer for each pending amount, quoting the receipt', async () => {
  const s = bills('Luz')
  const pending = { amount: null, status: 'pending', by: 'Ana', paidAt: OCT, messageId: 'r1' } as const
  s.months['2026-10'] = { 1: { ...pending, byJid: 'p@s.whatsapp.net' } }
  const { shell, store, calls } = setup({ state: s, meta: MIGRATED })
  await shell.join(JID)
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'none')
  assert.deepEqual(calls, [
    { op: 'commit' },
    { op: 'send', arg: 'r1: não consegui ler o valor de Luz. Qual foi? Responda só o valor, ex: 80,00' },
  ])
  await shell.handle(JID, msg('80'))
  await shell.idle()
  assert.deepEqual(store.load(JID)?.months['2026-10']?.[1], {
    ...s.months['2026-10'][1],
    amount: 8000,
    status: 'typed',
  })
  store.commit(JID, s)
  calls.length = 0
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(calls, [])
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'pending')
})

test('resolved invite codes are cached in the store, and removal forgets the invite but keeps the history', () => {
  const { shell, store } = setup({ state: bills('Luz') })
  shell.resolved('code-a', JID)
  shell.resolved('code-b', 'g2@g.us')
  assert.deepEqual(cachedGroups(store, ['code-a', 'code-c']), { jids: [JID], toResolve: ['code-c'] })
  shell.removed(JID)
  assert.equal(store.meta(JID)?.invite, null)
  assert.deepEqual(cachedGroups(store, ['code-a']), { jids: [], toResolve: ['code-a'] })
  assert.deepEqual(
    store.load(JID)?.bills.map(b => b.name),
    ['Luz'],
  )
})

const TEN_MIN = 10 * 60 * 1000

test('a question asked by one input is answered by the next plain message from the same participant', async () => {
  const { shell, store, calls } = setup({ state: bills('Luz', 'Internet') })
  await shell.handle(JID, msg('/pago lux 80'))
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10'], undefined)
  assert.ok(calls.some(c => c.op === 'send'))
  await shell.handle(JID, msg('sim'))
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, 8000)
})

test('chat that only prunes an expired question does not write the database', async () => {
  const { shell, calls } = setup({ state: bills('Luz', 'Internet') })
  await shell.handle(JID, msg('/pago lux 80'))
  await shell.idle()
  calls.length = 0
  await shell.handle(JID, msg('bom dia', { at: OCT + TEN_MIN + 1000 }))
  await shell.idle()
  assert.deepEqual(calls, [])
  await shell.handle(JID, msg('sim', { at: OCT + TEN_MIN + 2000 }))
  await shell.idle()
  assert.deepEqual(calls, [])
})

test('a receipt with no bill name is matched to a bill by the LLM and paid on it', async () => {
  const seen: string[][] = []
  const pick = async (names: string[]) => {
    seen.push(names)
    return { index: 0, amount: 120.5 }
  }
  const { shell, store, pdfs } = setup({ state: bills('Luz', 'Cartão Nu', 'Cartão Itaú'), pick })
  await shell.handle(JID, msg('/pago cartão', { media: { mime: 'application/pdf', handle: 'pdf-bytes' } }))
  await shell.idle()
  assert.deepEqual(seen, [['Cartão Nu', 'Cartão Itaú']])
  assert.deepEqual(pdfs, ['pdf-bytes'])
  const paid = store.load(JID)?.months['2026-10']
  assert.equal(paid?.[2]?.amount, 12050)
  assert.equal(paid?.[3], undefined)
})

test('a pickBill that finds nothing, throws or hangs leaves the bill unpaid and asks which one', async () => {
  const never = () => new Promise<{ index: number | null; amount: number | null }>(() => {})
  const boom = async () => {
    throw new Error('llm down')
  }
  const outOfRange = async () => ({ index: 7, amount: 10 })
  for (const pick of [never, boom, outOfRange]) {
    const { shell, store, calls } = setup({ state: bills('Luz', 'Cartão Nu', 'Cartão Itaú'), pick })
    await shell.handle(JID, msg('/pago cartão', { media: { mime: 'image/jpeg', handle: 'img' } }))
    await shell.idle()
    assert.equal(store.load(JID)?.months['2026-10'], undefined)
    assert.ok(calls.some(c => c.op === 'send'))
  }
})

test('a failed commit while applying the picked bill sends one saveFailed quoting the receipt and nothing else', async () => {
  const pick = async () => ({ index: 0, amount: 120.5 })
  const { shell, store, calls } = setup({
    state: bills('Luz', 'Cartão Nu', 'Cartão Itaú'),
    pick,
    failCommitFrom: 2,
  })
  const m = msg('/pago cartão', { media: { mime: 'image/jpeg', handle: 'img' } })
  await shell.handle(JID, m)
  await shell.idle()
  assert.deepEqual(calls.slice(1), [
    { op: 'commit' },
    { op: 'send', arg: `${m.key.id}: não consegui salvar, tenta de novo` },
  ])
  assert.equal(store.load(JID)?.months['2026-10'], undefined)
})

function gate<T>(value: T) {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { open, wait: async () => opened.then(() => value) }
}

test('a backlog receipt read that resolves after the startup join keeps its amount and gets no question', async () => {
  const read = gate(80.1)
  const { shell, store, calls } = setup({ state: bills('Luz'), meta: MIGRATED, llm: read.wait })
  await shell.handle(JID, msg('/pago luz', { media: { mime: 'image/jpeg', handle: 'img' } }))
  await shell.join(JID)
  read.open()
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'read')
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, 8010)
  assert.equal(
    calls.some(c => c.arg?.includes('Qual foi?')),
    false,
  )
})

test('a slow pick is dropped after its sender typed a /pago, but survives their chat', async () => {
  const late = gate({ index: 1, amount: 99 })
  const slow = setup({ state: bills('Luz', 'Cartão Nu', 'Cartão Itaú'), pick: late.wait })
  await slow.shell.handle(JID, msg('/pago cartão', { media: { mime: 'image/jpeg', handle: 'img' } }))
  await slow.shell.handle(JID, msg('/pago cartão nu 120'))
  late.open()
  await slow.shell.idle()
  const paid = slow.store.load(JID)?.months['2026-10']
  assert.equal(paid?.[2]?.amount, 12000)
  assert.equal(paid?.[3], undefined)
  const chatty = gate({ index: 1, amount: 99 })
  const kept = setup({ state: bills('Luz', 'Cartão Nu', 'Cartão Itaú'), pick: chatty.wait })
  await kept.shell.handle(JID, msg('/pago cartão', { media: { mime: 'image/jpeg', handle: 'img' } }))
  await kept.shell.handle(JID, msg('já mandei'))
  chatty.open()
  await kept.shell.idle()
  assert.equal(kept.store.load(JID)?.months['2026-10']?.[3]?.amount, 9900)
})

test('at most two receipts are read at once, reads and picks alike, and every one still gets its amount', async () => {
  let live = 0
  let peak = 0
  const busy = async <T>(value: T) => {
    live++
    peak = Math.max(peak, live)
    await new Promise(r => setTimeout(r, 2))
    live--
    return value
  }
  const names = ['Luz', 'Água', 'Gás', 'Internet', 'Aluguel', 'Cartão Nu', 'Cartão Itaú']
  const { shell, store } = setup({
    state: bills(...names),
    llm: () => busy(10),
    pick: () => busy({ index: 0, amount: 20 }),
    readTimeoutMs: 5000,
  })
  const receipt = { media: { mime: 'image/jpeg', handle: 'img' } }
  await Promise.all([
    ...['luz', 'água', 'gás', 'internet', 'aluguel'].map(b => shell.handle(JID, msg(`/pago ${b}`, receipt))),
    shell.handle(JID, msg('/pago cartão', receipt)),
  ])
  await shell.idle()
  assert.ok(peak <= 2, `${peak} receipts read at once`)
  const paid = store.load(JID)?.months['2026-10']
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6].map(id => paid?.[id]?.amount),
    [1000, 1000, 1000, 1000, 1000, 2000],
  )
})

const untilAborted = <T>(signal: AbortSignal) =>
  new Promise<T>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))

test('a hung download, PDF render or LLM call is aborted at its deadline and its lane goes to the next receipt', async () => {
  for (const stage of ['download', 'pdf', 'llm'] as const) {
    const aborted: boolean[] = []
    let calls = 0
    const hang = <T>(signal: AbortSignal | undefined, value: T) => {
      if (++calls > 2) return Promise.resolve(value)
      assert.ok(signal)
      signal.addEventListener('abort', () => aborted.push(true))
      return untilAborted<T>(signal)
    }
    const { shell, store } = setup({
      state: bills('Luz', 'Água', 'Gás'),
      wa: stage === 'download' ? { download: signal => hang(signal, Buffer.from('img')) } : {},
      pdf: stage === 'pdf' ? signal => hang(signal, Buffer.from('png')) : undefined,
      llm: stage === 'llm' ? (_i, _m, signal) => hang(signal, 10) : async () => 10,
    })
    const receipt = { media: { mime: 'application/pdf', handle: 'pdf' } }
    await Promise.all(['luz', 'água', 'gás'].map(b => shell.handle(JID, msg(`/pago ${b}`, receipt))))
    await shell.idle()
    assert.deepEqual(aborted, [true, true], stage)
    assert.deepEqual(
      [1, 2, 3].map(id => store.load(JID)?.months['2026-10']?.[id]?.status),
      ['none', 'none', 'read'],
      stage,
    )
  }
})

test('a lane stays taken until the aborted work has really settled', async () => {
  const lane = lanes(1, { graceMs: 1000, waitMs: 1000 })
  const events: string[] = []
  const slow = lane('g', 10, async signal => {
    await untilAborted(signal).catch(() => events.push('aborted'))
    await new Promise(r => setTimeout(r, 30))
    events.push('settled')
    return 1
  })
  const next = lane('g', 100, async () => {
    events.push('next started')
    return 2
  })
  assert.equal(await slow, null)
  events.push('caller gave up')
  assert.equal(await next, 2)
  assert.deepEqual(events, ['aborted', 'caller gave up', 'settled', 'next started'])
})

test('time spent waiting for a lane does not count against the work deadline', async () => {
  const lane = lanes(1, { graceMs: 1000, waitMs: 1000 })
  const work = (v: number) => async () => {
    await new Promise(r => setTimeout(r, 30))
    return v
  }
  assert.deepEqual(await Promise.all([lane('g', 50, work(1)), lane('g', 50, work(2))]), [1, 2])
})

test('groups take turns for the lanes, so one busy group cannot starve another', async () => {
  const lane = lanes(1, { graceMs: 1000, waitMs: 5000 })
  const started: string[] = []
  let open = () => {}
  const first = lane('a', 1000, async () => {
    started.push('a0')
    await new Promise<void>(r => {
      open = r
    })
  })
  const jobs = ['a1', 'a2', 'a3', 'b1', 'c1', 'b2'].map(id =>
    lane(id.slice(0, 1), 1000, async () => {
      started.push(id)
    }),
  )
  await new Promise(r => setImmediate(r))
  open()
  await Promise.all([first, ...jobs])
  assert.deepEqual(started, ['a0', 'a1', 'b1', 'c1', 'a2', 'b2', 'a3'])
})

test('work that ignores its abort and never settles gives its lane back after the grace, with one warning', async () => {
  const lane = lanes(1, { graceMs: 20, waitMs: 1000 })
  let stuck = 0
  const started = Date.now()
  const hung = lane(
    'g',
    10,
    () => new Promise<number>(() => {}),
    () => stuck++,
  )
  const next = lane('g', 1000, async () => Date.now() - started)
  assert.equal(await hung, null)
  const waited = await next
  assert.ok(waited !== null && waited >= 25, String(waited))
  assert.equal(stuck, 1)
  assert.equal(await lane('g', 1000, async () => 3), 3)
})

const block = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {}
}

test('a late event loop cannot fire the grace before the deadline and leave the caller hanging', async () => {
  const lane = lanes(1, { graceMs: 20, waitMs: 1000 })
  let stuck = 0
  const older = setTimeout(() => {}, 30)
  block(25)
  const hung = lane(
    'g',
    10,
    () => {
      block(40)
      return new Promise<number>(() => {})
    },
    () => stuck++,
  )
  assert.equal(await hung, null)
  assert.equal(await lane('g', 1000, async () => 3), 3)
  assert.equal(stuck, 1)
  clearTimeout(older)
})

test('a job waiting too long for a lane gives up without running, and the queue stays clean', async () => {
  const lane = lanes(1, { graceMs: 1000, waitMs: 20 })
  let open = () => {}
  const first = lane('a', 1000, () => new Promise<void>(r => (open = r)))
  let ran = false
  assert.equal(
    await lane('b', 1000, async () => {
      ran = true
    }),
    null,
  )
  assert.equal(ran, false)
  open()
  await first
  assert.equal(await lane('c', 1000, async () => 'free'), 'free')
})

test('stuck reads are warned about once each with group and message, and the receipt queued behind is read', async () => {
  let calls = 0
  const llm = () => (++calls <= 2 ? new Promise<number | null>(() => {}) : Promise.resolve(10))
  const { shell, store, warns } = setup({ state: bills('Luz', 'Água', 'Gás'), llm })
  const receipt = { media: { mime: 'image/jpeg', handle: 'img' } }
  const sent = [msg('/pago luz', receipt), msg('/pago água', receipt), msg('/pago gás', receipt)]
  await Promise.all(sent.map(m => shell.handle(JID, m)))
  await shell.idle()
  await new Promise(r => setTimeout(r, 150))
  await shell.idle()
  assert.deepEqual(
    [1, 2, 3].map(id => store.load(JID)?.months['2026-10']?.[id]?.status),
    ['none', 'none', 'read'],
  )
  assert.deepEqual(
    warns.filter(w => JSON.stringify(w).includes('abort')),
    sent.slice(0, 2).map(m => ({ jid: JID, id: m.key.id, m: 'receipt read ignored its abort: lane released' })),
  )
})

test('a receipt that waits too long for a lane ends with no amount and one question back', async () => {
  const llm = () => new Promise<number | null>(() => {})
  const { shell, store } = setup({ state: bills('Luz', 'Água', 'Gás'), llm, readTimeoutMs: 1000, readWaitMs: 20 })
  const receipt = { media: { mime: 'image/jpeg', handle: 'img' } }
  const late = msg('/pago gás', receipt)
  await Promise.all([msg('/pago luz', receipt), msg('/pago água', receipt), late].map(m => shell.handle(JID, m)))
  await new Promise(r => setTimeout(r, 100))
  assert.equal(store.load(JID)?.months['2026-10']?.[3]?.status, 'none')
  assert.deepEqual(
    [1, 2].map(id => store.load(JID)?.months['2026-10']?.[id]?.status),
    ['pending', 'pending'],
  )
})

test('minute ticks wait while WhatsApp is disconnected, and one tick runs right after each reconnect', async () => {
  const NOV = Date.UTC(2026, 10, 1, 15)
  const { shell, store, calls } = setup({ state: bills('Luz'), meta: MIGRATED })
  const runs: Promise<void>[] = []
  const ticks = ticker(() => runs.push(shell.handle(JID, { kind: 'tick', at: NOV })))
  ticks.minute()
  assert.equal(runs.length, 0)
  assert.equal(store.load(JID)?.lastReset, '2026-10')
  assert.equal(ticks.connected(), false)
  ticks.status(true)
  ticks.status(true)
  assert.equal(ticks.connected(), true)
  await Promise.all(runs)
  assert.equal(runs.length, 1)
  assert.equal(store.load(JID)?.lastReset, '2026-11')
  assert.ok(calls.some(c => c.op === 'send' && c.arg?.includes('Novembro')))
  ticks.minute()
  ticks.status(false)
  ticks.minute()
  assert.equal(runs.length, 2)
  ticks.status(true)
  assert.equal(runs.length, 3)
  await Promise.all(runs)
})

const OLDER = { ...MIGRATED, announcedVersion: '1.2.0' }
const BODY = '🎉🤖 contas-bot v2.0.0\n\n• contas por /conta'

async function joined(o: Setup) {
  const t = setup({ state: bills('Luz'), meta: OLDER, ...o })
  await t.shell.join(JID)
  await t.shell.idle()
  return t
}

test('without a gif the release is announced as text', async () => {
  const { calls, store } = await joined({})
  assert.deepEqual(calls, [{ op: 'send', arg: BODY }])
  assert.equal(store.meta(JID)?.announcedVersion, '2.0.0')
})

test('an announcement no send gets through is not recorded, the join still succeeds, and the next join retries', async () => {
  let down = true
  const { shell, calls, store } = await joined({ gif: true, wa: { fail: op => down && op !== 'pin' } })
  assert.deepEqual(calls, [])
  assert.equal(store.meta(JID)?.announcedVersion, '1.2.0')
  down = false
  await shell.join(JID)
  await shell.idle()
  assert.deepEqual(calls, [{ op: 'video', arg: BODY }])
  assert.equal(store.meta(JID)?.announcedVersion, '2.0.0')
})

test('a dev build never announces and never records a version', async () => {
  const old = await joined({ version: 'dev' })
  assert.deepEqual(old.calls, [])
  assert.equal(old.store.meta(JID)?.announcedVersion, '1.2.0')
  const fresh = setup({ version: 'dev' })
  await fresh.shell.join(JID)
  await fresh.shell.idle()
  assert.equal(fresh.store.meta(JID)?.announcedVersion, null)
})

test('a release with nothing to say is marked announced without a message', async () => {
  const { calls, store } = await joined({ releases: [{ version: '2.0.0', entries: [] }] })
  assert.deepEqual(calls, [])
  assert.equal(store.meta(JID)?.announcedVersion, '2.0.0')
})

test('the same or an older version is not announced again', async () => {
  for (const announcedVersion of ['2.0.0', '3.0.0']) {
    const { calls, store } = await joined({ meta: { ...MIGRATED, announcedVersion } })
    assert.deepEqual(calls, [])
    assert.equal(store.meta(JID)?.announcedVersion, announcedVersion)
  }
})

test('missing release notes announce nothing and keep the version for later, onboarding still records it', async () => {
  const { calls, store } = await joined({ releases: null })
  assert.deepEqual(calls, [])
  assert.equal(store.meta(JID)?.announcedVersion, '1.2.0')
  const fresh = setup({ releases: null })
  await fresh.shell.join(JID)
  await fresh.shell.idle()
  assert.equal(fresh.store.meta(JID)?.announcedVersion, '2.0.0')
})

test('an announcement whose version cannot be saved is announced again on the next join', async () => {
  const t = setup({ state: bills('Luz'), meta: OLDER, failSetMeta: true })
  await t.shell.join(JID).catch(() => {})
  await t.shell.idle()
  assert.deepEqual(t.calls, [{ op: 'send', arg: BODY }])
  assert.equal(t.store.meta(JID)?.announcedVersion, '1.2.0')
})

test('a failed pin still unpins the old list, and a failed unpin still keeps the new list id', async () => {
  for (const failing of ['pin', 'unpin']) {
    const s = bills('Luz')
    s.pinnedId = 'old'
    const { shell, store, calls } = setup({ state: s, meta: MIGRATED, wa: { fail: op => op === failing } })
    await shell.handle(JID, msg('/lista'))
    await shell.idle()
    const other = failing === 'pin' ? { op: 'unpin', arg: 'old' } : { op: 'pin', arg: 'sent1' }
    assert.ok(
      calls.some(c => c.op === other.op && c.arg === other.arg),
      failing,
    )
    assert.equal(store.load(JID)?.pinnedId, 'sent1', failing)
  }
})

test('a failed reaction or update notice does not stop the list from being posted and pinned', async () => {
  const s = bills('Luz')
  s.months['2026-10'] = { 1: { amount: 8000, status: 'typed', by: 'Ana', paidAt: OCT, messageId: 'a', byJid: null } }
  const fail = (op: string, arg?: string) => op === 'react' || (op === 'send' && arg === 'atualizado')
  const { shell, store, calls } = setup({ state: s, meta: MIGRATED, wa: { fail } })
  await shell.handle(JID, msg('/pago luz 90'))
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, 9000)
  assert.deepEqual(ops(calls), ['commit', 'send', 'commit', 'pin'])
})
