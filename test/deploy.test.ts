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
