import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildChangelog, releaseNotes } from '../scripts/changelog.ts'

const scratch = mkdtempSync(join(tmpdir(), 'cl-'))
const empty = join(scratch, 'gitconfig')
writeFileSync(empty, '')
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
Object.assign(env, { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' })

function repo() {
  const dir = mkdtempSync(join(scratch, 'r-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, env, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 't')
  git('config', 'user.email', 't@t')
  return git
}
const tr = (s: string) => `${s}\n\nChangelog-pt-BR: ${s} pt\nChangelog-es: ${s} es\n`

test('builds releases newest first from feat/fix commits', () => {
  const git = repo()
  git('commit', '--allow-empty', '-m', tr('feat: a'))
  git('tag', 'v1.0.0')
  git('commit', '--allow-empty', '-m', 'chore: c')
  git('commit', '--allow-empty', '-m', tr('fix: b'))
  git('checkout', '-q', '-b', 'side')
  git('commit', '--allow-empty', '-m', tr('feat: side'))
  git('checkout', '-q', 'main')
  git('merge', '--no-ff', '-m', 'merge side', 'side')
  git('tag', 'v1.1.0')
  git('commit', '--allow-empty', '-m', 'feat: old style')
  git('tag', 'v1.10.0')
  const dir = git('rev-parse', '--show-toplevel').trim()
  const got = buildChangelog(dir)
  assert.deepEqual(got, [
    { version: '1.10.0', entries: [{ en: 'old style' }] },
    { version: '1.1.0', entries: [{ en: 'b', 'pt-BR': 'fix: b pt', es: 'fix: b es' }, { en: 'side', 'pt-BR': 'feat: side pt', es: 'feat: side es' }] },
    { version: '1.0.0', entries: [{ en: 'a', 'pt-BR': 'feat: a pt', es: 'feat: a es' }] },
  ])
  assert.equal(releaseNotes(got[1]), '- b\n  fix: b pt\n- side\n  feat: side pt')
  assert.equal(releaseNotes(got[0]), '- old style')
  assert.equal(releaseNotes({ version: '9', entries: [] }), 'Maintenance release.')
})

test('no tags gives an empty list', () => {
  const git = repo()
  git('commit', '--allow-empty', '-m', 'feat: a')
  assert.deepEqual(buildChangelog(git('rev-parse', '--show-toplevel').trim()), [])
})

test('CRLF messages and scoped breaking subjects count', () => {
  const git = repo()
  git('commit', '--allow-empty', '--cleanup=verbatim', '-m', 'feat: crlf\r\n\r\nChangelog-pt-BR: cr pt\r\nChangelog-es: cr es\r\n')
  git('commit', '--allow-empty', '-m', 'feat(bot)!: scoped')
  git('tag', 'v1.0.0')
  assert.deepEqual(buildChangelog(git('rev-parse', '--show-toplevel').trim()), [
    { version: '1.0.0', entries: [{ en: 'scoped' }, { en: 'crlf', 'pt-BR': 'cr pt', es: 'cr es' }] },
  ])
})

test('CLI ignores a polluted GIT_DIR and writes only versions up to the requested one', () => {
  const git = repo()
  const dir = git('rev-parse', '--show-toplevel').trim()
  git('commit', '--allow-empty', '-m', 'feat: one')
  git('tag', 'v1.0.0')
  git('commit', '--allow-empty', '-m', 'feat: two')
  git('tag', 'v1.1.0')
  git('commit', '--allow-empty', '-m', 'chore: only')
  git('tag', 'v1.2.0')
  const decoy = repo()('rev-parse', '--git-dir')
  const out = join(scratch, 'o', 'c.json')
  const notes = join(scratch, 'o', 'n.md')
  const script = join(process.cwd(), 'scripts', 'changelog.ts')
  const run = (v: string) =>
    spawnSync('node', [script, out, notes, v], { cwd: dir, env: { ...env, GIT_DIR: join(scratch, decoy) }, encoding: 'utf8' })
  assert.equal(run('1.1.0').status, 0)
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).map((r: { version: string }) => r.version), ['1.1.0', '1.0.0'])
  assert.equal(readFileSync(notes, 'utf8'), '- two')
  assert.equal(run('1.2.0').status, 0)
  assert.equal(readFileSync(notes, 'utf8'), 'Maintenance release.')
})
