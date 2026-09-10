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

function reply(content: string) {
  return { choices: [{ message: { content } }] }
}

test('interpretCaption sends stream:false and validates the bill', async () => {
  const { fn, calls } = fakeFetch(reply('{"bill":"Cartão Nu","amount":6237.6,"confidence":0.95}'))
  const llm = makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn: fn })
  const v = await llm.interpretCaption('fatura nu set', bills)
  assert.deepEqual(v, { bill: 'Cartão Nu', amount: 6237.6, confidence: 0.95 })
  assert.equal(calls[0].stream, false)
  assert.equal(calls[0].model, 't')
})

test('unknown bill from the model becomes null', async () => {
  const { fn } = fakeFetch(reply('{"bill":"Netflix","amount":10,"confidence":0.99}'))
  const llm = makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn: fn })
  assert.deepEqual(await llm.interpretCaption('netflix', bills), { bill: null, amount: 10, confidence: 0.99 })
})

test('tolerates code fences and returns null on garbage or http error', async () => {
  const fenced = fakeFetch(reply('```json\n{"bill":"Luz","amount":null,"confidence":0.8}\n```'))
  const llm1 = makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn: fenced.fn })
  assert.equal((await llm1.interpretCaption('luz', bills))?.bill, 'Luz')

  const garbage = fakeFetch(reply('sorry, I cannot'))
  const llm2 = makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn: garbage.fn })
  assert.equal(await llm2.interpretCaption('luz', bills), null)

  const down = fakeFetch({}, 502)
  const llm3 = makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn: down.fn })
  assert.equal(await llm3.interpretCaption('luz', bills), null)
})

test('readReceipt sends the image as a data URI to the vision model', async () => {
  const { fn, calls } = fakeFetch(reply('{"bill":"Luz","amount":231.45,"confidence":0.9}'))
  const llm = makeLlm({ baseUrl: 'http://x/v1', apiKey: 'k', textModel: 't', visionModel: 'v', fetchFn: fn })
  const v = await llm.readReceipt(Buffer.from('png'), 'image/png', '', bills)
  assert.equal(v?.amount, 231.45)
  assert.equal(calls[0].model, 'v')
  const parts = calls[0].messages[1].content
  assert.equal(parts[1].type, 'image_url')
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/)
})
