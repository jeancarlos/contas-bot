import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, copyFile } from 'node:fs/promises'
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
  spawnSync('sh', [join(dir, 'contas-bot'), ...args], { encoding: 'utf8', input: '', env: { ...process.env, CONTAS_BOT_API: api } })

test('update on the latest version says so and exits 0', async () => {
  const r = cli(await install('1.2.0'), ['update'], await release('v1.2.0'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /already on v1\.2\.0/)
})

test('update with a newer release shows from → to and stops without a yes', async () => {
  const r = cli(await install('1.2.0'), ['update'], await release('v1.10.0'))
  assert.equal(r.status, 0)
  assert.match(r.stdout, /v1\.2\.0 → v1\.10\.0/)
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
