import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintCommitMessage, parseTrailers } from '../scripts/changelog-lint.ts'

const ok = 'feat: bot announces new versions in the group\n\nChangelog-pt-BR: o bot anuncia versões novas no grupo\nChangelog-es: el bot anuncia versiones nuevas en el grupo\n'

test('feat without trailers fails and names both', () => {
  const e = lintCommitMessage('feat: something\n')
  assert.equal(e.length, 2)
  assert.match(e.join('\n'), /Changelog-pt-BR/)
  assert.match(e.join('\n'), /Changelog-es/)
})

test('valid feat passes', () => {
  assert.deepEqual(lintCommitMessage(ok), [])
})

test('empty trailer fails', () => {
  const e = lintCommitMessage(ok.replace('o bot anuncia versões novas no grupo', ''))
  assert.equal(e.length, 1)
  assert.match(e[0], /Changelog-pt-BR/)
})

test('too-long trailer fails', () => {
  const e = lintCommitMessage(ok.replace('o bot anuncia versões novas no grupo', 'x'.repeat(73)))
  assert.equal(e.length, 1)
  assert.match(e[0], /Changelog-pt-BR/)
})

test('fix with scope passes, breaking feat with scope too', () => {
  assert.deepEqual(lintCommitMessage(ok.replace('feat:', 'fix(bot):')), [])
  assert.deepEqual(lintCommitMessage(ok.replace('feat:', 'feat(x)!:')), [])
  assert.equal(lintCommitMessage('fix(bot): x\n').length, 2)
})

test('comment lines are ignored', () => {
  assert.deepEqual(lintCommitMessage(`${ok}# Changelog-pt-BR: ignored\n# please enter a message\n`), [])
  assert.equal(lintCommitMessage('feat: x\n\n# Changelog-pt-BR: a\n# Changelog-es: b\n').length, 2)
})

test('subject over 72 chars after the prefix fails', () => {
  assert.ok(lintCommitMessage(ok.replace('bot announces new versions in the group', 'y'.repeat(73))).length > 0)
})

test('free types, merges and fixups pass without trailers', () => {
  for (const m of ['chore: x\n', 'ci: x\n', 'test: x\n', 'docs: x\n', 'refactor: x\n', 'style: x\n', 'build: x\n', 'perf: x\n', 'Merge pull request #1 from a/b\n', 'fixup! feat: x\n', 'squash! fix: y\n']) {
    assert.deepEqual(lintCommitMessage(m), [], m)
  }
})

test('parseTrailers reads the trailer block', () => {
  assert.deepEqual(parseTrailers(ok), { 'Changelog-pt-BR': 'o bot anuncia versões novas no grupo', 'Changelog-es': 'el bot anuncia versiones nuevas en el grupo' })
})
