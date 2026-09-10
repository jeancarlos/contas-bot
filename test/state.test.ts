import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openState } from '../src/state.ts'

test('openState creates an empty state and persists atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contas-'))
  const file = join(dir, 'state.json')
  const store = await openState(file)
  assert.deepEqual(store.get(), { _meta: {}, months: {} })
  store.get().months['2026-09'] = { luz: { name: 'Luz', paid_at: 'x', amount: 1, by: 'J', message_id: '1' } }
  store.get()._meta.last_reset = '2026-09'
  await store.save()
  const raw = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(raw._meta.last_reset, '2026-09')
  const again = await openState(file)
  assert.equal(again.get().months['2026-09'].luz.amount, 1)
})
