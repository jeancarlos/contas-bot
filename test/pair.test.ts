// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { closeOutcome, emptyDir, nextStep, pair, qrHtml, renderQr, renderQrSvg } from '../src/setup/pair.ts'

test('renderQr draws a multi-line block QR', async () => {
  const s = await renderQr('2@abc,def,ghi')
  assert.ok(s.split('\n').length > 10)
})

test('closing our own socket after pairing is ignored, so auth survives', () => {
  assert.equal(closeOutcome(true, 401), 'ignore')
  assert.equal(closeOutcome(true, undefined), 'ignore')
})

test('restartRequired reopens; anything else before pairing fails', () => {
  assert.equal(closeOutcome(false, 515), 'restart')
  assert.equal(closeOutcome(false, 408), 'failed')
  assert.equal(closeOutcome(false, 401), 'failed')
  assert.equal(closeOutcome(false, undefined), 'failed')
})

test('emptyDir clears a folder but keeps it (it is a bind mount)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'))
  await writeFile(join(dir, 'creds.json'), '{}')
  await mkdir(join(dir, 'keys'))
  await emptyDir(dir)
  assert.deepEqual(await readdir(dir), [])
})

test('restartRequired restarts once; a second one fails', () => {
  assert.equal(nextStep(false, false, 515), 'restart')
  assert.equal(nextStep(false, true, 515), 'failed')
  assert.equal(nextStep(true, true, 515), 'ignore')
  assert.equal(nextStep(false, false, 401), 'failed')
})
test('renderQrSvg returns an svg', async () => {
  assert.ok((await renderQrSvg('2@abc,def,ghi')).includes('<svg'))
})
test('qrHtml refreshes and embeds the svg on white', () => {
  const h = qrHtml('<svg></svg>')
  assert.ok(h.includes('http-equiv="refresh" content="2"') && h.includes('<svg></svg>') && h.includes('#fff'))
})

function fakePairing() {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    ev = new EventEmitter()
    ended = 0
    codeFor: string[] = []
    end() {
      this.ended++
      return Promise.resolve()
    }
    requestPairingCode(phone: string) {
      this.codeFor.push(phone)
      return Promise.resolve('ABCD-1234')
    }
  }
  const deps = {
    makeSocket: (() => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    }) as never,
    version: async () => ({ version: [2, 3000, 1] as [number, number, number], live: true }),
  }
  const tick = () => new Promise(r => setImmediate(r))
  const opened = async () => {
    while (!sockets.length) await tick()
  }
  return { sockets, deps, tick, opened }
}

const sink = () => {
  const got = { qr: [] as string[], code: [] as string[] }
  return { got, on: { qr: (_a: string, raw: string) => got.qr.push(raw), code: (c: string) => got.code.push(c) } }
}

test('pair in qr mode shows the QR and resolves true when the connection opens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'))
  const { sockets, deps, tick, opened } = fakePairing()
  const { got, on } = sink()
  const done = pair(dir, 'qr', '', on, deps)
  await opened()
  sockets[0]?.ev.emit('connection.update', { qr: '2@abc' })
  await tick()
  assert.deepEqual(got.qr, ['2@abc'])
  sockets[0]?.ev.emit('connection.update', { connection: 'open' })
  assert.equal(await done, true)
  assert.equal(sockets[0]?.ended, 1)
})

test('pair in code mode asks for the pairing code once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'))
  const { sockets, deps, tick, opened } = fakePairing()
  const { got, on } = sink()
  const done = pair(dir, 'code', '5511999999999', on, deps)
  await opened()
  sockets[0]?.ev.emit('connection.update', { qr: 'a' })
  sockets[0]?.ev.emit('connection.update', { qr: 'b' })
  await tick()
  assert.deepEqual(sockets[0]?.codeFor, ['5511999999999'])
  assert.deepEqual(got.code, ['ABCD-1234'])
  sockets[0]?.ev.emit('connection.update', { connection: 'open' })
  await done
})

test('pair reopens the socket once on restartRequired, then fails and empties the auth dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'))
  await writeFile(join(dir, 'creds.json'), '{}')
  const { sockets, deps, opened } = fakePairing()
  const done = pair(dir, 'qr', '', sink().on, deps)
  await opened()
  const lost = (statusCode: number) => ({ connection: 'close', lastDisconnect: { error: { output: { statusCode } } } })
  sockets[0]?.ev.emit('connection.update', lost(515))
  assert.equal(sockets.length, 2)
  sockets[1]?.ev.emit('connection.update', lost(515))
  assert.equal(await done, false)
  assert.deepEqual(await readdir(dir), [])
})

test('pair fails on a close with no status code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auth-'))
  const { sockets, deps, opened } = fakePairing()
  const done = pair(dir, 'qr', '', sink().on, deps)
  await opened()
  sockets[0]?.ev.emit('connection.update', { connection: 'close' })
  assert.equal(await done, false)
})
