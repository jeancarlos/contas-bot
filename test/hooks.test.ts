import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const made: string[] = []
after(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true })
})

const scrub = (parent: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(parent).filter(([k]) => !k.startsWith('GIT_')))

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

async function tmp(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

async function repo(parent: NodeJS.ProcessEnv = process.env) {
  const dir = await tmp('hooks-')
  const globalCfg = join(dir, 'gitconfig')
  await writeFile(globalCfg, '')
  const env = { ...scrub(parent), GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' }
  git(dir, env, 'init', '-q', '-b', 'main')
  await mkdir(join(dir, 'scripts'))
  await writeFile(join(dir, 'scripts', 'install-hooks.sh'), await readFile(join(ROOT, 'scripts', 'install-hooks.sh'), 'utf8'))
  return { dir, env, globalCfg }
}

const install = (dir: string, env: NodeJS.ProcessEnv) => execFileSync('sh', ['scripts/install-hooks.sh'], { cwd: dir, env })
const local = (dir: string, env: NodeJS.ProcessEnv, key: string) =>
  spawnSync('git', ['config', '--local', '--get', key], { cwd: dir, env, encoding: 'utf8' })

test('without a global hooksPath the installer points core.hooksPath at .githooks', async () => {
  const { dir, env } = await repo()
  install(dir, env)
  assert.equal(git(dir, env, 'config', '--local', 'core.hooksPath'), '.githooks')
})

test('with a global hooksPath the installer chains instead and leaves core.hooksPath alone', async () => {
  const { dir, env, globalCfg } = await repo()
  await writeFile(globalCfg, '[core]\n\thooksPath = /somewhere/hooks\n')
  install(dir, env)
  assert.equal(git(dir, env, 'config', '--local', 'hooks.chain'), '.githooks')
  assert.notEqual(local(dir, env, 'core.hooksPath').status, 0)
})

test('a hooksPath coming from an included file is detected', async () => {
  const { dir, env, globalCfg } = await repo()
  const inc = join(dir, 'included')
  await writeFile(inc, '[core]\n\thooksPath = /somewhere/hooks\n')
  await writeFile(globalCfg, `[include]\n\tpath = ${inc}\n`)
  install(dir, env)
  assert.equal(git(dir, env, 'config', '--local', 'hooks.chain'), '.githooks')
  assert.notEqual(local(dir, env, 'core.hooksPath').status, 0)
})

test('a stale local core.hooksPath is unset when a global one exists', async () => {
  const { dir, env, globalCfg } = await repo()
  await writeFile(globalCfg, '[core]\n\thooksPath = /somewhere/hooks\n')
  git(dir, env, 'config', '--local', 'core.hooksPath', '.githooks')
  install(dir, env)
  assert.equal(git(dir, env, 'config', '--local', 'hooks.chain'), '.githooks')
  assert.notEqual(local(dir, env, 'core.hooksPath').status, 0)
})

test('outside a git repository the installer does nothing and succeeds', async () => {
  const dir = await tmp('nogit-')
  const env = scrub(process.env)
  const r = spawnSync('sh', [join(ROOT, 'scripts', 'install-hooks.sh')], { cwd: dir, env: { ...env, GIT_CEILING_DIRECTORIES: tmpdir() } })
  assert.equal(r.status, 0)
})

test('inherited GIT_DIR and GIT_INDEX_FILE never reach a real repository', async () => {
  const sentinel = await tmp('sentinel-')
  const clean = { ...scrub(process.env), GIT_CONFIG_NOSYSTEM: '1' }
  git(sentinel, clean, 'init', '-q', '-b', 'trunk')
  git(sentinel, clean, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
  const before = git(sentinel, clean, 'rev-parse', 'HEAD')
  const polluted = { ...process.env, GIT_DIR: join(sentinel, '.git'), GIT_INDEX_FILE: join(sentinel, '.git', 'index') }
  const { dir, env } = await repo(polluted)
  install(dir, env)
  git(dir, env, 'symbolic-ref', 'HEAD', 'refs/heads/develop')
  const cfg = await readFile(join(sentinel, '.git', 'config'), 'utf8')
  assert.doesNotMatch(cfg, /bare\s*=\s*true/)
  assert.doesNotMatch(cfg, /hooksPath/i)
  assert.doesNotMatch(cfg, /chain/i)
  assert.equal(git(sentinel, clean, 'rev-parse', 'HEAD'), before)
  assert.equal(git(sentinel, clean, 'symbolic-ref', 'HEAD'), 'refs/heads/trunk')
})

for (const branch of ['main', 'develop']) {
  test(`pre-commit refuses a commit on ${branch}, even from a subdirectory`, async () => {
    const { dir, env } = await repo()
    git(dir, env, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`)
    await mkdir(join(dir, 'test'))
    const r = spawnSync('sh', [join(ROOT, '.githooks', 'pre-commit')], { cwd: join(dir, 'test'), env, encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /feature\/, fix\/ ou chore\//)
  })
}
