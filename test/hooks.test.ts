import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'hooks-'))
  const globalCfg = join(dir, 'gitconfig')
  await writeFile(globalCfg, '')
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: '1' }
  git(dir, env, 'init', '-q', '-b', 'main')
  await mkdir(join(dir, 'scripts'))
  await writeFile(join(dir, 'scripts', 'install-hooks.sh'), await readFile(join(ROOT, 'scripts', 'install-hooks.sh'), 'utf8'))
  return { dir, env, globalCfg }
}

test('without a global hooksPath the installer points core.hooksPath at .githooks', async () => {
  const { dir, env } = await repo()
  execFileSync('sh', ['scripts/install-hooks.sh'], { cwd: dir, env })
  assert.equal(git(dir, env, 'config', '--local', 'core.hooksPath'), '.githooks')
})

test('with a global hooksPath the installer chains instead and leaves core.hooksPath alone', async () => {
  const { dir, env, globalCfg } = await repo()
  await writeFile(globalCfg, '[core]\n\thooksPath = /somewhere/hooks\n')
  execFileSync('sh', ['scripts/install-hooks.sh'], { cwd: dir, env })
  assert.equal(git(dir, env, 'config', '--local', 'hooks.chain'), '.githooks')
  const local = spawnSync('git', ['config', '--local', 'core.hooksPath'], { cwd: dir, env })
  assert.notEqual(local.status, 0)
})

test('outside a git repository the installer does nothing and succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nogit-'))
  await mkdir(join(dir, 'scripts'))
  await writeFile(join(dir, 'scripts', 'install-hooks.sh'), await readFile(join(ROOT, 'scripts', 'install-hooks.sh'), 'utf8'))
  const r = spawnSync('sh', ['scripts/install-hooks.sh'], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } })
  assert.equal(r.status, 0)
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
