import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLlm } from '../src/llm.ts'

const bills = ['Luz', 'Cartão Nu', 'Aluguel']

function fakeFetch(body: unknown, status = 200) {
  const calls: any[] = []
  const fn = (async (_url: any, init: any) => {
    calls.push(JSON.parse(init.body))
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fn, calls }
}

const llmWith = (fetchFn: typeof fetch) => makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn })

function reply(content: string) {
  return { choices: [{ message: { content } }] }
}

test('interpretCaption sends stream:false and validates the bill', async () => {
  const { fn, calls } = fakeFetch(reply('{"bill":"Cartão Nu","amount":6237.6,"confidence":0.95}'))
  const llm = llmWith(fn)
  const v = await llm.interpretCaption('fatura nu set', bills)
  assert.deepEqual(v, { bill: 'Cartão Nu', amount: 6237.6, confidence: 0.95 })
  assert.equal(calls[0].stream, false)
  assert.equal(calls[0].model, 't')
})

test('unknown bill from the model becomes null', async () => {
  const { fn } = fakeFetch(reply('{"bill":"Netflix","amount":10,"confidence":0.99}'))
  const llm = llmWith(fn)
  assert.deepEqual(await llm.interpretCaption('netflix', bills), { bill: null, amount: 10, confidence: 0.99 })
})

test('tolerates code fences and returns null on garbage or http error', async () => {
  const fenced = fakeFetch(reply('```json\n{"bill":"Luz","amount":null,"confidence":0.8}\n```'))
  const llm1 = llmWith(fenced.fn)
  assert.equal((await llm1.interpretCaption('luz', bills))?.bill, 'Luz')

  const garbage = fakeFetch(reply('sorry, I cannot'))
  const llm2 = llmWith(garbage.fn)
  assert.equal(await llm2.interpretCaption('luz', bills), null)

  const down = fakeFetch({}, 502)
  const llm3 = llmWith(down.fn)
  assert.equal(await llm3.interpretCaption('luz', bills), null)
})

test('readReceipt sends the image as a data URI to the vision model', async () => {
  const { fn, calls } = fakeFetch(reply('{"bill":"Luz","amount":231.45,"confidence":0.9}'))
  const llm = llmWith(fn)
  const v = await llm.readReceipt(Buffer.from('png'), 'image/png', '', bills)
  assert.equal(v?.amount, 231.45)
  assert.equal(calls[0].model, 'v')
  const parts = calls[0].messages[1].content
  assert.equal(parts[1].type, 'image_url')
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/)
})

test('non-positive amounts become null', async () => {
  const { fn } = fakeFetch(reply('{"bill":"Luz","amount":-5,"confidence":0.9}'))
  const llm = llmWith(fn)
  const v = await llm.interpretCaption('luz', bills)
  assert.equal(v?.amount, null)
})

test('a network error, a missing choice or a junk field degrades instead of throwing', async () => {
  const offline = (async () => { throw new TypeError('fetch failed') }) as typeof fetch
  assert.equal(await llmWith(offline).interpretCaption('luz', bills), null)
  assert.equal(await llmWith(fakeFetch({ choices: [] }).fn).interpretCaption('luz', bills), null)
  const junk = fakeFetch(reply('{"bill":"Luz","amount":"231,45","confidence":7}'))
  assert.deepEqual(await llmWith(junk.fn).interpretCaption('luz', bills), { bill: 'Luz', amount: null, confidence: 1 })
})
