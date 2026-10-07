import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONNECTION_CONFIG } from '@whiskeysockets/baileys'
import { resolveWaVersion } from '../src/waVersion.ts'

test('uses the live version when the fetch succeeds', async () => {
  const r = await resolveWaVersion(async () => ({ version: [2, 3000, 42], isLatest: true }))
  assert.deepEqual(r, { version: [2, 3000, 42], live: true })
})
test('falls back to the bundled version when the fetch throws', async () => {
  const r = await resolveWaVersion(async () => { throw new Error('offline') })
  assert.deepEqual(r, { version: DEFAULT_CONNECTION_CONFIG.version, live: false })
})
test('falls back when baileys reports isLatest false', async () => {
  const r = await resolveWaVersion(async () => ({ version: [2, 3000, 1], isLatest: false }))
  assert.equal(r.live, false)
})
test('falls back on timeout', async () => {
  const r = await resolveWaVersion(() => new Promise(() => {}), 20)
  assert.deepEqual(r, { version: DEFAULT_CONNECTION_CONFIG.version, live: false })
})
