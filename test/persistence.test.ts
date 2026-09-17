import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBot, type Incoming, type Wa } from '../src/bot.ts'
import { openState, type StateStore } from '../src/state.ts'
import type { Llm } from '../src/llm.ts'

const G = '123@g.us'
const NOW = new Date('2026-09-10T12:00:00Z')

type Opts = { desc?: string; pinFails?: boolean; descFails?: boolean }

function fakeWa(opts: Opts): Wa {
  let n = 0
  return {
    async sendText() { return { id: `s${++n}`, fromMe: true, remoteJid: G } },
    async react() {},
    async pin() { if (opts.pinFails) throw new Error('pinning is admin-only') },
    async unpin() {},
    async getDescription() { return opts.desc ?? 'Luz\nÁgua' },
    async setDescription() { if (opts.descFails) throw new Error('description write denied') },
  }
}

const fakeLlm: Llm = { async interpretCaption() { return null }, async readReceipt() { return null } }

const msg = (id: string, text: string): Incoming => ({
  key: { id, fromMe: false, remoteJid: G, participant: 'gabi@s.whatsapp.net' },
  sender: 'Gabi', text,
})

async function onDisk(path: string) {
  return JSON.parse(await readFile(path, 'utf8')).groups?.[G] ?? {}
}

async function run(opts: Opts, scenario: (bot: ReturnType<typeof makeBot>, store: StateStore) => Promise<void>) {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-persist-')), 'state.json')
  const store = (await openState(path)).forGroup(G)
  const bot = makeBot({ wa: fakeWa(opts), llm: fakeLlm, store, now: () => NOW })
  await scenario(bot, store)
  return { disk: await onDisk(path), memory: store.get() }
}

const scenarios: [string, Opts, (bot: ReturnType<typeof makeBot>, store: StateStore) => Promise<void>][] = [
  ['onboarding a new group', {}, async bot => { await bot.join() }],
  ['a payment by command', {}, async bot => { await bot.join(); await bot.onMessage(msg('a', '/pago Luz 100')) }],
  ['a reversal', {}, async bot => {
    await bot.join()
    await bot.onMessage(msg('a', '/pago Luz 100'))
    await bot.onMessage(msg('b', '/despago Luz'))
  }],
  ['an unknown command', {}, async bot => { await bot.join(); await bot.onMessage(msg('a', '/xpto')) }],
  ['a greeting', {}, async bot => { await bot.join(); await bot.onMessage(msg('a', 'oi bot')) }],
  ['a refused pin', { pinFails: true }, async bot => { await bot.join(); await bot.onMessage(msg('a', '/pago Luz 100')) }],
  ['a refused description write', { descFails: true }, async bot => { await bot.join() }],
  ['a member editing the description', {}, async bot => { await bot.join(); await bot.onDescription('Luz\nÁgua\nGás') }],
  ['a month rollover', {}, async (bot, store) => {
    await bot.join()
    store.get()._meta.last_reset = '2026-08'
    await bot.tick()
  }],
]

// The dedup list was appended to memory after every save and so never reached disk, which made it
// useless across exactly the restart that causes a redelivery. The suite missed it because no test
// crossed the file boundary. This one does, for every path that changes state.
for (const [label, opts, scenario] of scenarios) {
  test(`state reaches disk after ${label}`, async () => {
    const { disk, memory } = await run(opts, scenario)
    assert.deepEqual(disk._meta ?? {}, memory._meta, `_meta differs after ${label}`)
    assert.deepEqual(disk.months ?? {}, memory.months, `months differ after ${label}`)
  })
}

test('a handled message id survives a reopen', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-persist-')), 'state.json')
  const first = await openState(path)
  const bot = makeBot({ wa: fakeWa({}), llm: fakeLlm, store: first.forGroup(G), now: () => NOW })
  await bot.join()
  await bot.onMessage(msg('REAL1', '/pago Luz 100'))

  const reopened = (await openState(path)).forGroup(G)
  assert.ok(reopened.get()._meta.handled?.includes('REAL1'), 'the handled id was not persisted')
})
