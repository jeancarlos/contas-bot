// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('both compose files cap memory and processes and mount a read-only root with a tmpfs', () => {
  for (const compose of [read('docker-compose.yml'), composeFile('ghcr.io/jeancarlos/contas-bot:2.0.0')]) {
    assert.match(compose, /^ {4}read_only: true$/m)
    assert.match(compose, /^ {4}tmpfs:\n {6}- \/tmp$/m)
    assert.match(compose, /^ {4}mem_limit: 1g$/m)
    assert.match(compose, /^ {4}pids_limit: 64$/m)
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
    for (const u of uses)
      assert.match(u, /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(?:\.\d+\.\d+)?$/, `${file}: ${u}`)
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

test('the bot sets a private umask before it creates any file', () => {
  const src = read('src/shell/index.ts')
  const umask = src.indexOf('process.umask(0o077)')
  assert.ok(umask > 0)
  for (const later of ['pino(', 'openStore(', 'connectWa(', 'startHttp(']) assert.ok(umask < src.indexOf(later), later)
})

test('the image upgrades its OS packages and ships without npm', () => {
  const dockerfile = read('Dockerfile')
  assert.match(dockerfile, /^RUN apt-get update && apt-get upgrade -y && apt-get install /m)
  assert.match(
    dockerfile,
    /^RUN npm ci --omit=dev --ignore-scripts && rm -rf \/usr\/local\/lib\/node_modules\/npm \/usr\/local\/bin\/npm \/usr\/local\/bin\/npx$/m,
  )
  assert.match(dockerfile, /^USER node$/m)
})

test('the branch-name check accepts feature, fix, chore and dependabot branches only', () => {
  const ci = read('.github/workflows/ci.yml')
  const pattern = /\[ "\$HEAD" = develop \] \|\| echo "\$HEAD" \| grep -Eq '([^']+)'/.exec(ci)?.[1]
  assert.ok(pattern)
  const ok = new RegExp(pattern)
  for (const b of [
    'feature/x',
    'fix/audit',
    'chore/a.b-c_d',
    'dependabot/npm_and_yarn/sharp-0.35.5',
    'dependabot/github_actions/actions/checkout-4.2.2',
  ])
    assert.ok(ok.test(b), b)
  for (const b of ['main', 'hotfix/x', 'feature/X Y', 'dependabot', 'dependabot/', 'my-dependabot/x', 'fix/a;b'])
    assert.ok(!ok.test(b), b)
})

test('the publish step passes each gh argument as one word, for a release and a prerelease', () => {
  const release = read('.github/workflows/release.yml')
  const block = /- name: Publish the release\n(?:.*\n)*? {8}run: \|\n((?: {10}.*\n?)+)/.exec(release)?.[1]
  assert.ok(block)
  const script = block.replace(/^ {10}/gm, '')
  assert.doesNotMatch(script, /(^|[^"])\$(notes|pre)\b/)
  const bin = mkdtempSync(join(tmpdir(), 'gh-'))
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nfor a in "$@"; do printf "[%s]" "$a"; done\necho\n', { mode: 0o755 })
  const run = (tag: string) =>
    execFileSync('sh', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_REF_NAME: tag, PATH: `${bin}:${process.env.PATH}` },
    })
  assert.equal(
    run('v2.0.0'),
    '[release][create][v2.0.0][dist/install.sh][dist/install.sh.intoto.jsonl][--notes-file][dist/notes.md][--verify-tag]\n',
  )
  assert.equal(
    run('v2.0.0-rc1'),
    '[release][create][v2.0.0-rc1][dist/install.sh][dist/install.sh.intoto.jsonl][--prerelease][--generate-notes][--verify-tag]\n',
  )
})

test('dependabot auto-merge runs on pull_request, pins its action and never merges a major', () => {
  const wf = read('.github/workflows/dependabot-automerge.yml')
  assert.match(wf, /^on:\n {2}pull_request:\n {4}branches: \[develop\]$/m)
  assert.doesNotMatch(wf, /pull_request_target/)
  assert.match(wf, /if: github\.actor == 'dependabot\[bot\]'/)
  for (const u of wf.match(/uses: .*/g) ?? [])
    assert.match(u, /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(?:\.\d+\.\d+)?$/, u)
  assert.match(wf, /semver-patch.*semver-minor.*update-type/)
  assert.doesNotMatch(wf, /update-type !=/)
  assert.match(wf, /gh pr merge --auto --merge/)
  assert.match(wf, /^permissions:\n {2}contents: read$/m)
})

test('security runs gitleaks over full history and a dynamic workflow fuzzes on every tag', () => {
  const sec = read('.github/workflows/security.yml')
  assert.match(sec, /gitleaks\/gitleaks-action@[0-9a-f]{40}/)
  assert.match(sec, /fetch-depth: 0/)
  const dyn = read('.github/workflows/dynamic.yml')
  assert.match(dyn, /tags: \['v\*'\]/)
  assert.match(dyn, /test\/core\/fuzz\.test\.ts/)
})

test('every pull request is checked for a test on each feat and fix, in CI and in the commit hook', () => {
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /fixes-have-tests:/)
  assert.match(ci, /node scripts\/test-policy\.ts "\$BASE\.\.\$HEAD"/)
  assert.match(read('.githooks/commit-msg'), /test-policy\.ts --staged/)
})

test('a weekly policy run re-verifies the latest release attestations and the 14-day issue reply promise', () => {
  const wf = read('.github/workflows/policy.yml')
  assert.match(wf, /cron:/)
  assert.match(wf, /gh attestation verify install\.sh --repo "\$REPO"/)
  assert.match(wf, /gh attestation verify "oci:\/\/ghcr\.io\/\$REPO:/)
  assert.match(wf, /14 days ago/)
})
