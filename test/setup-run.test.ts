// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const run = (dir: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [join(ROOT, 'src', 'setup.ts')], {
    cwd: ROOT,
    encoding: 'utf8',
    input: '',
    env: { PATH: process.env.PATH, CONTAS_BOT_SETUP_DIR: dir, APP_VERSION: '9.9.9', CONTAS_BOT_NO_PAIR: '1', ...env },
  })

const answers = {
  CONTAS_BOT_LANG: 'pt-BR',
  CONTAS_BOT_PAIRING: 'code',
  CONTAS_BOT_PHONE: '+55 11 90000-0000',
  CONTAS_BOT_AI: 'none',
}

test('a full non-interactive install writes .env (600), compose, folders and the CLI', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  const r = run(dir, answers)
  assert.equal(r.status, 0, r.stderr)
  const env = await readFile(join(dir, '.env'), 'utf8')
  assert.match(env, /^BOT_PHONE=5511900000000$/m)
  assert.match(env, /^LLM_BASE_URL=$/m)
  assert.equal((await stat(join(dir, '.env'))).mode & 0o777, 0o600)
  assert.match(await readFile(join(dir, 'docker-compose.yml'), 'utf8'), /contas-bot:9\.9\.9/)
  assert.ok((await stat(join(dir, 'auth'))).isDirectory())
  assert.ok((await stat(join(dir, 'data'))).isDirectory())
  assert.equal((await stat(join(dir, 'contas-bot'))).mode & 0o111, 0o111)
})

test('without a terminal and with answers missing it exits 2 and writes nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  const r = run(dir, { CONTAS_BOT_LANG: 'pt-BR' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /pairing/)
  await assert.rejects(stat(join(dir, '.env')))
})

const history = async (dir: string) => {
  await mkdir(join(dir, 'data'), { recursive: true })
  await writeFile(join(dir, 'data', 'state.json'), '{"groups":{}}')
}
const paired1x = async (dir: string, env: string) => {
  await writeFile(join(dir, '.env'), env)
  await mkdir(join(dir, 'auth'))
  await writeFile(join(dir, 'auth', 'creds.json'), JSON.stringify({ me: { id: '5511900000000:1@s.whatsapp.net' } }))
  await writeFile(
    join(dir, 'docker-compose.yml'),
    'services:\n  contas-bot:\n    image: ghcr.io/jeancarlos/contas-bot:1.3.0\n',
  )
}

test('an already paired folder is updated: compose rewritten, .env untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  await history(dir)
  await writeFile(join(dir, '.env'), 'BOT_LANG=en\nKEEP=me\n')
  await mkdir(join(dir, 'auth'))
  await writeFile(join(dir, 'auth', 'creds.json'), JSON.stringify({ me: { id: 'x' } }))
  await writeFile(
    join(dir, 'docker-compose.yml'),
    'services:\n  contas-bot:\n    image: ghcr.io/jeancarlos/contas-bot:1.0.0\n',
  )
  const r = run(dir, {})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'BOT_LANG=en\nKEEP=me\n')
  assert.match(await readFile(join(dir, 'docker-compose.yml'), 'utf8'), /contas-bot:9\.9\.9/)
  assert.match(r.stdout, /1\.0\.0 → v?9\.9\.9/)
})

test('a configured but unpaired folder skips the questions (repair) and keeps .env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  await history(dir)
  await writeFile(join(dir, '.env'), 'BOT_LANG=es\nPAIRING_MODE=qr\n')
  const r = run(dir, {})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'BOT_LANG=es\nPAIRING_MODE=qr\n')
})

test('a fresh install allows the empty history once; an install over existing data does not', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'setup-'))
  assert.equal(run(fresh, answers).status, 0)
  assert.match(await readFile(join(fresh, '.env'), 'utf8'), /^ALLOW_EMPTY_STATE=1$/m)
  const moved = await mkdtemp(join(tmpdir(), 'setup-'))
  await mkdir(join(moved, 'data'))
  await writeFile(join(moved, 'data', 'state.json'), '{"groups":{}}')
  assert.equal(run(moved, answers).status, 0)
  assert.doesNotMatch(await readFile(join(moved, '.env'), 'utf8'), /ALLOW_EMPTY_STATE/)
})

test('an update or repair with no history and no saved consent stops before writing anything', async () => {
  for (const creds of [true, false]) {
    const dir = await mkdtemp(join(tmpdir(), 'setup-'))
    const env = 'BOT_LANG=en\nPAIRING_MODE=qr\nLLM_BASE_URL=\n'
    await paired1x(dir, env)
    if (!creds) await rm(join(dir, 'auth', 'creds.json'))
    const r = run(dir, { APP_VERSION: '2.0.0' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /ALLOW_EMPTY_STATE=1/)
    assert.equal(await readFile(join(dir, '.env'), 'utf8'), env)
    assert.match(await readFile(join(dir, 'docker-compose.yml'), 'utf8'), /contas-bot:1\.3\.0/)
    await assert.rejects(stat(join(dir, 'contas-bot')))
  }
})

test('an update with no history but a saved consent goes ahead and keeps the consent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  await paired1x(dir, 'BOT_LANG=en\nALLOW_EMPTY_STATE=1\n')
  const r = run(dir, { APP_VERSION: '2.0.0' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(await readFile(join(dir, '.env'), 'utf8'), /^ALLOW_EMPTY_STATE=1$/m)
  assert.match(await readFile(join(dir, 'docker-compose.yml'), 'utf8'), /contas-bot:2\.0\.0/)
})

test('data/ is private to the owner, on install and on update of an older folder', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'setup-'))
  assert.equal(run(fresh, answers).status, 0)
  assert.equal((await stat(join(fresh, 'data'))).mode & 0o777, 0o700)
  const old = await mkdtemp(join(tmpdir(), 'setup-'))
  await paired1x(old, 'BOT_LANG=en\n')
  await history(old)
  await chmod(join(old, 'data'), 0o755)
  assert.equal(run(old, {}).status, 0)
  assert.equal((await stat(join(old, 'data'))).mode & 0o777, 0o700)
})
