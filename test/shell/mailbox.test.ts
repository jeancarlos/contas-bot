import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mailbox } from '../../src/shell/mailbox.ts'

test('the mailbox runs one job at a time per group, never holds up another group and survives a failed job', async () => {
  const box = mailbox()
  const order: string[] = []
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const a1 = box('a', async () => {
    await gate
    order.push('a1')
  })
  const a2 = box('a', async () => {
    order.push('a2')
  })
  await box('b', async () => {
    order.push('b1')
  })
  assert.deepEqual(order, ['b1'])
  release()
  await Promise.all([a1, a2])
  assert.deepEqual(order, ['b1', 'a1', 'a2'])
  await assert.rejects(
    box('a', async () => {
      throw new Error('boom')
    }),
    /boom/,
  )
  await box('a', async () => {
    order.push('a3')
  })
  assert.equal(order.at(-1), 'a3')
})
