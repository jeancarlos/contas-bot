import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, pendingReleases, announcementText, loadGif, loadReleases, MAX_GIF, type Release } from '../src/announce.ts'
const more = (n: number) => `…and ${n} more`
const all: Release[] = [
  { version: '1.2.0', entries: [{ en: 'two', 'pt-BR': 'dois' }] },
  { version: '1.10.0', entries: [{ en: 'ten' }] },
  { version: '1.1.0', entries: [{ en: 'one' }] },
].sort((a, b) => compareVersions(b.version, a.version))
test('compareVersions is numeric and never throws', () => {
  assert.ok(compareVersions('1.10.0', '1.9.0') > 0)
  assert.ok(compareVersions('1.0.0', '1.0.1') < 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.equal(typeof compareVersions('dev', '1.0.0'), 'number')
  assert.equal(typeof compareVersions('', 'x'), 'number')
})
test('pendingReleases', () => {
  assert.deepEqual(pendingReleases(all, 'dev', undefined), [])
  assert.deepEqual(pendingReleases(all, '1.2.0', '1.2.0'), [])
  assert.deepEqual(pendingReleases(all, '1.2.0', undefined).map(r => r.version), ['1.2.0'])
  assert.deepEqual(pendingReleases(all, '1.3.0', undefined), [])
  assert.deepEqual(pendingReleases(all, '1.10.0', '1.1.0').map(r => r.version), ['1.10.0', '1.2.0'])
})
test('announcementText', () => {
  assert.equal(announcementText([], 'en', '1.2.0', more), null)
  assert.equal(announcementText([{ version: '1.2.0', entries: [] }], 'en', '1.2.0', more), null)
  assert.equal(announcementText(all.slice(1, 2), 'pt-BR', '1.2.0', more), '🎉🤖 contas-bot v1.2.0\n\n• dois')
  assert.equal(announcementText([{ version: '1.2.0', entries: [{ en: 'a' }, { en: 'b', es: 'be' }] }], 'es', '1.2.0', more), '🎉🤖 contas-bot v1.2.0\n\n• a\n• be')
  const many: Release[] = [{ version: '1.2.0', entries: Array.from({ length: 13 }, (_, i) => ({ en: `e${i}` })) }]
  const lines = announcementText(many, 'en', '1.2.0', more)?.split('\n') ?? []
  assert.equal(lines.length, 2 + 10 + 1)
  assert.equal(lines.at(-1), '…and 3 more')
})

const tmp = () => mkdtemp(join(tmpdir(), 'ann-'))
test('loadReleases returns null for a missing or invalid file, an array otherwise', async () => {
  const d = await tmp()
  assert.equal(await loadReleases(new URL(`file://${d}/none.json`)), null)
  await writeFile(join(d, 'bad.json'), '{nope')
  assert.equal(await loadReleases(new URL(`file://${d}/bad.json`)), null)
  await writeFile(join(d, 'obj.json'), '{}')
  assert.equal(await loadReleases(new URL(`file://${d}/obj.json`)), null)
  await writeFile(join(d, 'ok.json'), '[]')
  assert.deepEqual(await loadReleases(new URL(`file://${d}/ok.json`)), [])
})
test('loadGif reads a file inside the data dir and rejects symlinks out, oversize and missing files', async () => {
  const d = await tmp()
  const out = await tmp()
  await writeFile(join(d, 'a.gif'), 'gif')
  assert.equal((await loadGif('a.gif', d))?.toString(), 'gif')
  await writeFile(join(out, 'secret'), 'secret')
  await symlink(join(out, 'secret'), join(d, 'link.gif'))
  await assert.rejects(loadGif('link.gif', d), /outside/)
  await writeFile(join(d, 'big.gif'), Buffer.alloc(MAX_GIF + 1))
  await assert.rejects(loadGif('big.gif', d), /too large/)
  await assert.rejects(loadGif('missing.gif', d))
  assert.equal(await loadGif('', d), null)
})
test('loadGif aborts a streamed body past the cap even without content-length', async () => {
  let pulled = 0
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024 * 1024)); if (pulled > 50) c.close() } })
  const f = (async () => new Response(body)) as unknown as typeof fetch
  await assert.rejects(loadGif('https://x/a.gif', '/', f), /too large/)
  assert.ok(pulled < 20)
  const ok = (async () => new Response('gif')) as unknown as typeof fetch
  assert.equal((await loadGif('https://x/a.gif', '/', ok))?.toString(), 'gif')
  const big = (async () => new Response('x', { headers: { 'content-length': String(MAX_GIF + 1) } })) as unknown as typeof fetch
  await assert.rejects(loadGif('https://x/a.gif', '/', big), /too large/)
})
