import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openStore, type Store } from '../../src/adapters/store.ts'
import type { GroupMeta } from '../../src/adapters/v1.ts'
import { makeLocale } from '../../src/core/i18n.ts'
import { normalize } from '../../src/core/text.ts'
import { emptyState, type GroupState, type Input } from '../../src/core/types.ts'
import { cachedGroups, lanes, makeShell, type Wa } from '../../src/shell/run.ts'

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

type Call = { op: string; arg?: string }
type WaOpts = { desc?: string; failSetDescription?: boolean; failDownload?: boolean; failVideo?: boolean }

function fakeWa(calls: Call[], o: WaOpts): Wa {
  let n = 0
  return {
    async sendText(text, quoted) {
      calls.push({ op: 'send', arg: quoted ? `${quoted.id}: ${text}` : text })
      return `sent${++n}`
    },
    async sendVideo(_video, caption) {
      if (o.failVideo) throw new Error('video refused')
      calls.push({ op: 'video', arg: caption })
      return `sent${++n}`
    },
    async react(key) {
      calls.push({ op: 'react', arg: key.id })
    },
    async pin(id) {
      calls.push({ op: 'pin', arg: id })
    },
    async unpin(id) {
      calls.push({ op: 'unpin', arg: id })
    },
    async getDescription() {
      return o.desc ?? ''
    },
    async setDescription(text) {
      if (o.failSetDescription) throw new Error('not admin')
      calls.push({ op: 'setDescription', arg: text })
    },
    async download(media) {
      if (o.failDownload) throw new Error('media gone')
      return Buffer.from(String(media.handle))
    },
  }
}

function bills(...names: string[]): GroupState {
  const s = emptyState()
  s.bills = names.map((name, i) => ({ id: i + 1, name, key: normalize(name), paused: false, removed: false }))
  s.nextBillId = names.length + 1
  s.lastReset = '2026-10'
  return s
}

type Setup = {
  state?: GroupState
  meta?: GroupMeta
  failCommit?: boolean
  failCommitFrom?: number
  wa?: WaOpts
  llm?: (image: Buffer, mime: string) => Promise<number | null>
  pick?: (names: string[]) => Promise<{ index: number | null; amount: number | null }>
  gif?: boolean
  readTimeoutMs?: number
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
  }
  const wa = fakeWa(calls, o.wa ?? {})
  const pdfs: string[] = []
  const shell = makeShell({
    store,
    wa: () => wa,
    locale,
    llm: {
      enabled: true,
      readAmount: o.llm ?? (async () => 80.1),
      pickBill: async (_image, _mime, names) => (o.pick ? o.pick(names) : { index: null, amount: null }),
    },
    pdfToPng: async pdf => {
      pdfs.push(pdf.toString())
      return Buffer.from('png')
    },
    log: { info() {}, warn() {}, error() {} },
    now: () => OCT,
    version: '2.0.0',
    announce: {
      releases: [{ version: '2.0.0', entries: [{ en: 'bills', 'pt-BR': 'contas por /conta' }] }],
      gif: async () => (o.gif ? Buffer.from('gif') : null),
    },
    readTimeoutMs: o.readTimeoutMs ?? 50,
  })
  return { shell, store: real, calls, pdfs }
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

test('only the first join after a start turns pending amounts into none, quoting the receipt', async () => {
  const s = bills('Luz')
  s.months['2026-10'] = { 1: { amount: null, status: 'pending', by: 'Ana', paidAt: OCT, messageId: 'r1' } }
  const { shell, store, calls } = setup({ state: s, meta: MIGRATED })
  await shell.join(JID)
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'none')
  assert.deepEqual(calls, [
    { op: 'commit' },
    { op: 'send', arg: 'r1: não li o valor do comprovante, marquei sem valor' },
  ])
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

test('a backlog receipt read that resolves after the startup join keeps its amount and gets no noAmount', async () => {
  const read = gate(80.1)
  const { shell, store, calls } = setup({ state: bills('Luz'), meta: MIGRATED, llm: read.wait })
  await shell.handle(JID, msg('/pago luz', { media: { mime: 'image/jpeg', handle: 'img' } }))
  await shell.join(JID)
  read.open()
  await shell.idle()
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.status, 'read')
  assert.equal(store.load(JID)?.months['2026-10']?.[1]?.amount, 8010)
  assert.equal(
    calls.some(c => c.arg?.includes('não li o valor')),
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

test('a hung read frees its lane at its deadline, so the receipts queued behind it are still read', async () => {
  let calls = 0
  const hang = () => {
    calls++
    return calls <= 2 ? new Promise<number | null>(() => {}) : Promise.resolve(10)
  }
  const { shell, store } = setup({ state: bills('Luz', 'Água', 'Gás'), llm: hang })
  const receipt = { media: { mime: 'image/jpeg', handle: 'img' } }
  await Promise.all(['luz', 'água', 'gás'].map(b => shell.handle(JID, msg(`/pago ${b}`, receipt))))
  await shell.idle()
  assert.equal(calls, 3)
  assert.deepEqual(
    [1, 2, 3].map(id => store.load(JID)?.months['2026-10']?.[id]?.status),
    ['none', 'none', 'read'],
  )
})

test('work still queued at its own deadline is dropped without ever taking a lane', async () => {
  const lane = lanes(2)
  const hung = () => new Promise<number>(() => {})
  let ran = false
  const first = lane(30, hung)
  const second = lane(30, hung)
  assert.equal(
    await lane(5, async () => {
      ran = true
      return 1
    }),
    null,
  )
  assert.deepEqual(await Promise.all([first, second]), [null, null])
  assert.equal(ran, false)
  assert.equal(await lane(30, async () => 7), 7)
})
