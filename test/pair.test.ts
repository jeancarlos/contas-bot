import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { closeOutcome, emptyDir, nextStep, renderQr } from '../src/setup/pair.ts'

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
