import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, copyFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

async function install(version: string, lang = 'en') {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'))
  await copyFile(join(ROOT, 'bin', 'contas-bot'), join(dir, 'contas-bot'))
  await writeFile(join(dir, '.env'), `BOT_LANG=${lang}\n`)
  await writeFile(join(dir, 'docker-compose.yml'), `services:\n  contas-bot:\n    image: ghcr.io/jeancarlos/contas-bot:${version}\n`)
  return dir
}
const release = async (tag: string) => {
  const f = join(await mkdtemp(join(tmpdir(), 'rel-')), 'latest.json')
  await writeFile(f, JSON.stringify({ tag_name: tag }))
  return `file://${f}`
}
const cli = (dir: string, args: string[], api: string) =>
  spawnSync('sh', [join(dir, 'contas-bot'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTAS_BOT_API: api, CONTAS_BOT_TTY: '/dev/null' } })

test('update on the latest version says so and exits 0', async () => {
  const r = cli(await install('1.2.0'), ['update'], await release('v1.2.0'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /already on v1\.2\.0/)
})

test('update with a newer release shows from → to and stops without a yes', async () => {
  const r = cli(await install('1.2.0'), ['update'], await release('v1.10.0'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /v1\.2\.0 → v1\.10\.0/)
  assert.match(r.stdout, /no terminal to confirm/)
})

test('update without network fails loudly and changes nothing', async () => {
  const dir = await install('1.2.0', 'pt-BR')
  const r = cli(dir, ['update'], 'file:///nonexistent/latest.json')
  assert.equal(r.status, 1)
  assert.match(r.stdout + r.stderr, /não consegui consultar/)
})

test('help lists the subcommands', async () => {
  const r = cli(await install('1.2.0'), [], await release('v1.2.0'))
  assert.equal(r.status, 0)
  for (const c of ['update', 'status', 'logs', 'pair', 'restart']) assert.match(r.stdout, new RegExp(c))
})

test('update with a hostile tag_name exits 1 and prints no arrow', async () => {
  const r = cli(await install('1.2.0'), ['update'], await release('v1.3.0/../x?a=$(id)'))
  assert.equal(r.status, 1)
  assert.doesNotMatch(r.stdout, /→/)
})

test('running through a symlink in another directory works', async () => {
  const dir = await install('1.2.0')
  const linkdir = await mkdtemp(join(tmpdir(), 'sym-'))
  const linkpath = join(linkdir, 'contas-bot')
  await symlink(join(dir, 'contas-bot'), linkpath)
  await copyFile(join(dir, '.env'), join(linkdir, '.env'))
  await copyFile(join(dir, 'docker-compose.yml'), join(linkdir, 'docker-compose.yml'))
  const r = spawnSync('sh', [linkpath, 'update'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTAS_BOT_API: await release('v1.2.0'), CONTAS_BOT_TTY: '/dev/null' } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /already on v1\.2\.0/)
})

test('unknown subcommand exits 2 and prints usage to stderr', async () => {
  const r = cli(await install('1.2.0'), ['invalid'], await release('v1.2.0'))
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage/)
})

test('nonexistent CONTAS_BOT_TTY path shows hint without error leak', async () => {
  const dir = await install('1.2.0')
  const r = spawnSync('sh', [join(dir, 'contas-bot'), 'update'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONTAS_BOT_API: await release('v1.10.0'), CONTAS_BOT_TTY: '/nonexistent/tty' } })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /no terminal to confirm/)
  assert.doesNotMatch(r.stderr, /tty/)
  assert.doesNotMatch(r.stderr, /inexistente/)
  assert.doesNotMatch(r.stderr, /No such file/)
})
