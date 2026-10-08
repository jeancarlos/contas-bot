import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, pendingReleases, announcementText, type Release } from '../src/announce.ts'
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
