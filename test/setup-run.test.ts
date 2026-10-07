import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const run = (dir: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [join(ROOT, 'src', 'setup.ts')], {
    cwd: ROOT, encoding: 'utf8', input: '',
    env: { PATH: process.env.PATH, CONTAS_BOT_SETUP_DIR: dir, APP_VERSION: '9.9.9', CONTAS_BOT_NO_PAIR: '1', ...env },
  })

const answers = { CONTAS_BOT_LANG: 'pt-BR', CONTAS_BOT_PAIRING: 'code', CONTAS_BOT_PHONE: '+55 11 90000-0000', CONTAS_BOT_AI: 'none' }

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

test('an already paired folder is updated: compose rewritten, .env untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  await writeFile(join(dir, '.env'), 'BOT_LANG=en\nKEEP=me\n')
  await mkdir(join(dir, 'auth'))
  await writeFile(join(dir, 'auth', 'creds.json'), JSON.stringify({ me: { id: 'x' } }))
  await writeFile(join(dir, 'docker-compose.yml'), 'services:\n  contas-bot:\n    image: ghcr.io/jeancarlos/contas-bot:1.0.0\n')
  const r = run(dir, {})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'BOT_LANG=en\nKEEP=me\n')
  assert.match(await readFile(join(dir, 'docker-compose.yml'), 'utf8'), /contas-bot:9\.9\.9/)
  assert.match(r.stdout, /1\.0\.0 → v?9\.9\.9/)
})

test('a configured but unpaired folder skips the questions (repair) and keeps .env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'setup-'))
  await writeFile(join(dir, '.env'), 'BOT_LANG=es\nPAIRING_MODE=qr\n')
  const r = run(dir, {})
  assert.equal(r.status, 0, r.stderr)
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'BOT_LANG=es\nPAIRING_MODE=qr\n')
})
