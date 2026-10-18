// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { DisconnectReason } from '@whiskeysockets/baileys'
import pino from 'pino'
import { connectWa } from '../../src/adapters/wa.ts'

const G = 'grupo@g.us'
const tick = () => new Promise(r => setImmediate(r))
const until = async (done: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !(await done())) await tick()
}

class FakeSocket {
  ev = new EventEmitter() as EventEmitter & { on(e: string, h: (...a: never[]) => void): unknown }
  user = { id: 'eu@s.whatsapp.net' }
  ended = 0
  sent: unknown[][] = []
  codes: string[] = []
  codeFails = false
  description: string | undefined = 'desc'
  updated: string[] = []
  end() {
    this.ended++
    return Promise.resolve()
  }
  requestPairingCode(phone: string) {
    this.codes.push(phone)
    return this.codeFails ? Promise.reject(new Error('nope')) : Promise.resolve('ABCD-1234')
  }
  sendMessage(...args: unknown[]) {
    this.sent.push(args)
    return Promise.resolve({ key: { id: 'SENT1' } })
  }
  groupFetchAllParticipating() {
    return Promise.resolve({ [G]: { id: G, subject: 'Casa' } })
  }
  groupGetInviteInfo() {
    return Promise.resolve({ id: G, subject: 'Casa' })
  }
  groupMetadata() {
    return Promise.resolve({ desc: this.description })
  }
  groupUpdateDescription(_jid: string, text: string) {
    this.updated.push(text)
    return Promise.resolve()
  }
  updateMediaMessage(m: unknown) {
    return Promise.resolve(m)
  }
}

async function setup(
  opts: { phone?: string; registered?: boolean; failOpen?: boolean; version?: () => Promise<never> } = {},
) {
  const authDir = await mkdtemp(join(tmpdir(), 'auth-'))
  await writeFile(join(authDir, 'creds.json'), '{}')
  const sockets: FakeSocket[] = []
  const logs = { warn: [] as unknown[][], error: [] as unknown[][], fatal: [] as unknown[][] }
  const log = pino({ level: 'silent' })
  for (const k of ['warn', 'error', 'fatal'] as const) log[k] = ((...a: unknown[]) => logs[k].push(a)) as never
  const saved: number[] = []
  const status: boolean[] = []
  const opened: string[][] = []
  const deps = {
    makeSocket: (() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    }) as never,
    version: opts.version ?? (async () => ({ version: [2, 3000, 1] as [number, number, number], live: true })),
    auth: (async () => ({
      state: { creds: { registered: opts.registered ?? false }, keys: { get: async () => ({}), set: async () => {} } },
      saveCreds: async () => {
        saved.push(1)
      },
    })) as never,
  }
  const wa = await connectWa(
    {
      authDir,
      phone: opts.phone ?? '5511999999999',
      groups: new Set([G]),
      inviteCodes: [],
      log,
      onResolved() {},
      onStatus: c => status.push(c),
      onOpen: j => {
        if (opts.failOpen) throw new Error('boom')
        opened.push(j)
      },
      onJoined() {},
      onInput() {},
      onRemoved() {},
    },
    deps,
  )
  const first = sockets[0] as FakeSocket
  const update = async (u: object) => {
    first.ev.emit('connection.update', u)
    await tick()
  }
  return { wa, sockets, first, logs, saved, status, opened, authDir, update }
}

test('creds.update saves the credentials', async () => {
  const t = await setup()
  t.first.ev.emit('creds.update')
  await tick()
  assert.equal(t.saved.length, 1)
})

test('connection open reports status and hands over the served groups', async () => {
  const t = await setup()
  await t.update({ connection: 'open' })
  assert.deepEqual(t.status, [true])
  assert.deepEqual(t.opened, [[G]])
})

test('a failing connection.update handler is logged, not thrown', async () => {
  const t = await setup({ failOpen: true })
  await t.update({ connection: 'open' })
  assert.equal(t.logs.error.length, 1)
})

test('an unpaired install with no phone ends the socket once and says so', async () => {
  const t = await setup({ phone: '' })
  await t.update({ qr: 'a' })
  await t.update({ qr: 'b' })
  assert.equal(t.first.ended, 1)
  assert.equal(t.logs.warn.length, 1)
})

test('a phone number gets one pairing code per window; a failure resets the window', async () => {
  const t = await setup()
  await t.update({ qr: 'a' })
  await t.update({ qr: 'b' })
  assert.deepEqual(t.first.codes, ['5511999999999'])
  assert.equal(t.logs.warn.length, 1)
  const u = await setup()
  u.first.codeFails = true
  await u.update({ qr: 'a' })
  await u.update({ qr: 'b' })
  assert.equal(u.first.codes.length, 2)
  assert.equal(u.logs.error.length, 2)
})

test('an already registered session never asks for a pairing code', async () => {
  const t = await setup({ registered: true })
  await t.update({ qr: 'a' })
  assert.deepEqual(t.first.codes, [])
})

test('a dropped connection reconnects after a backoff with a fresh socket', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const t = await setup()
    await t.update({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } })
    assert.equal(t.status.at(-1), false)
    mock.timers.tick(3000)
    await tick()
    assert.equal(t.sockets.length, 2)
    await t.update({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.restartRequired } } },
    })
    mock.timers.tick(3000)
    await tick()
    assert.equal(t.sockets.length, 3)
  } finally {
    mock.timers.reset()
  }
})

test('a reconnect that cannot resolve the version exits so the container restarts', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const exit = mock.method(process, 'exit', (() => {}) as never)
  try {
    let fail = false
    const t = await setup({
      version: (() =>
        fail ? Promise.reject(new Error('down')) : Promise.resolve({ version: [2, 3000, 1], live: false })) as never,
    })
    fail = true
    await t.update({ connection: 'close', lastDisconnect: {} })
    mock.timers.tick(3000)
    await tick()
    assert.deepEqual(exit.mock.calls[0]?.arguments, [1])
    assert.equal(t.logs.fatal.length, 1)
  } finally {
    exit.mock.restore()
    mock.timers.reset()
  }
})

test('logged out while unpaired wipes auth and stays idle', async () => {
  const t = await setup()
  await t.update({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
  })
  await until(async () => (await readdir(t.authDir)).length === 0 && t.logs.warn.length > 0)
  assert.deepEqual(await readdir(t.authDir), [])
  assert.equal(t.logs.warn.length, 1)
  await t.update({ connection: 'close', lastDisconnect: {} })
  assert.equal(t.sockets.length, 1)
})

test('logged out while registered wipes auth and exits with 2 after a minute', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const exit = mock.method(process, 'exit', (() => {}) as never)
  try {
    const t = await setup({ registered: true })
    t.first.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    })
    await until(() => {
      mock.timers.tick(60_000)
      return exit.mock.calls.length > 0
    })
    assert.deepEqual(exit.mock.calls[0]?.arguments, [2])
    assert.deepEqual(await readdir(t.authDir), [])
  } finally {
    exit.mock.restore()
    mock.timers.reset()
  }
})

test('forGroup sends, reacts, pins, unpins and edits the description through the socket', async () => {
  const t = await setup()
  const w = t.wa.forGroup(G)
  const key = { id: 'K1', fromMe: false, remoteJid: G, participant: 'p@s.whatsapp.net' }
  assert.equal(await w.sendText('oi'), 'SENT1')
  assert.equal(await w.sendText('re', key), 'SENT1')
  assert.equal(await w.sendVideo(Buffer.from('v'), 'cap'), 'SENT1')
  await w.react(key, '✅')
  await w.pin('M1')
  await w.unpin('M1')
  assert.equal(await w.getDescription(), 'desc')
  t.first.description = undefined
  assert.equal(await w.getDescription(), '')
  await w.setDescription('nova')
  assert.deepEqual(t.first.updated, ['nova'])
  const bodies = t.first.sent.map(a => a[1] as Record<string, unknown>)
  const opts = t.first.sent[1]?.[2] as { quoted: { key: { id: string } } }
  assert.equal(opts.quoted.key.id, 'K1')
  assert.ok('react' in (bodies[3] ?? {}))
  assert.equal((bodies[4] as { type: number }).type, 1)
  assert.equal((bodies[5] as { type: number }).type, 2)
})

test('a send that returns no message id throws', async () => {
  const t = await setup()
  t.first.sendMessage = () => Promise.resolve(undefined as never)
  await assert.rejects(t.wa.forGroup(G).sendText('x'), /no message id/)
})

test('download refuses a receipt the socket never saw', async () => {
  const t = await setup()
  await assert.rejects(t.wa.forGroup(G).download({ handle: { id: `${G}:X`, size: 1 } } as never), /receipt expired/)
})
