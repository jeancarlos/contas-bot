import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { composeFile } from '../src/setup/core.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('both compose files drop every capability and forbid privilege escalation', () => {
  for (const compose of [read('docker-compose.yml'), composeFile('ghcr.io/jeancarlos/contas-bot:2.0.0')]) {
    assert.match(compose, /^ {4}cap_drop:\n {6}- ALL$/m)
    assert.match(compose, /^ {4}security_opt:\n {6}- no-new-privileges:true$/m)
    assert.match(compose, /^ {4}user: "/m)
  }
})

test('the image runs as the unprivileged node user unless compose says otherwise', () => {
  const lines = read('Dockerfile').trim().split('\n')
  const user = lines.indexOf('USER node')
  assert.ok(user > 0, 'USER node missing')
  assert.ok(user < lines.findIndex(l => l.startsWith('CMD ')))
  assert.ok(lines.slice(user).every(l => !l.startsWith('RUN ')))
})

test('the example config and the defaults point at no private endpoint or model', () => {
  const example = read('.env.example')
  assert.match(example, /^LLM_BASE_URL=$/m)
  assert.doesNotMatch(example, /192\.168\.|cx\//)
  assert.doesNotMatch(read('src/shell/index.ts'), /192\.168\.|cx\//)
})

test('the example config documents the dashboard host allowlist', () => {
  assert.match(read('.env.example'), /^# .*\n^HTTP_HOSTS=$/m)
  assert.match(read('src/shell/index.ts'), /env\('HTTP_HOSTS'\)/)
})

test('every workflow action is pinned to a commit and only the release job can write contents', () => {
  for (const file of ['ci.yml', 'release.yml']) {
    const uses = read(`.github/workflows/${file}`).match(/uses: .*/g) ?? []
    assert.ok(uses.length > 0, file)
    for (const u of uses) assert.match(u, /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+$/, `${file}: ${u}`)
  }
  const release = read('.github/workflows/release.yml')
  assert.match(release, /^permissions: \{\}$/m)
  assert.deepEqual(release.match(/^ {6}contents: write$/gm), ['      contents: write'])
  assert.match(release, /^ {2}release:\n(?: {4}.*\n)*? {6}contents: write$/m)
  assert.doesNotMatch(release.slice(0, release.indexOf('\n  release:')), /contents: write/)
})

test('baileys is pinned exactly and the lockfile carries the patched sharp and music-metadata', () => {
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const locked = (name: string): string => lock.packages[`node_modules/${name}`].version
  assert.equal(pkg.dependencies['@whiskeysockets/baileys'], '7.0.0-rc14')
  assert.equal(lock.packages[''].dependencies['@whiskeysockets/baileys'], '7.0.0-rc14')
  assert.equal(locked('@whiskeysockets/baileys'), '7.0.0-rc14')
  const atLeast = (v: string, min: number[]) => {
    const n = v.split('.').map(Number)
    const i = n.findIndex((x, j) => x !== min[j])
    return i === -1 || (n[i] ?? 0) > (min[i] ?? 0)
  }
  assert.ok(atLeast(locked('sharp'), [0, 35, 5]), locked('sharp'))
  assert.ok(atLeast(locked('music-metadata'), [11, 16, 1]), locked('music-metadata'))
})
