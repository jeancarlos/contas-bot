import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeLlm } from '../src/llm.ts'

type Call = {
  url: string
  headers: Record<string, string>
  body: { stream: boolean; model: string; messages: { content: unknown }[] }
}
function fakeFetch(body: unknown, status = 200) {
  const calls: Call[] = []
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    })
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fn, calls }
}

const llmWith = (fetchFn: typeof fetch, apiKey = 'k') =>
  makeLlm({ baseUrl: 'http://x/v1', apiKey, visionModel: 'v', currency: 'EUR', fetchFn })
const reply = (content: string) => ({ choices: [{ message: { content } }] })
const amountOf = async (content: string) =>
  llmWith(fakeFetch(reply(content)).fn).readAmount(Buffer.from('x'), 'image/png')

test('readAmount sends the image alone, as a data URI, with stream:false', async () => {
  const { fn, calls } = fakeFetch(reply('{"amount":6237.6}'))
  assert.equal(await llmWith(fn).readAmount(Buffer.from('img'), 'image/jpeg'), 6237.6)
  const { url, headers, body } = calls[0] ?? assert.fail('no request made')
  assert.equal(url, 'http://x/v1/chat/completions')
  assert.equal(headers.authorization, 'Bearer k')
  assert.equal(body.stream, false)
  assert.equal(body.model, 'v')
  assert.match(String(body.messages[0]?.content), /EUR/)
  assert.deepEqual(body.messages[1]?.content, [
    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from('img').toString('base64')}` } },
  ])
})

test('the reply is parsed through code fences and quantized to cents', async () => {
  assert.equal(await amountOf('```json\n{"amount":80.1}\n```'), 80.1)
  assert.equal(await amountOf('{"amount":10.005}'), 10.01)
})

test('anything that is not a sane positive amount becomes null', async () => {
  for (const content of [
    'sorry, I cannot',
    '{"amount":null}',
    '{"amount":"80"}',
    '{"amount":0}',
    '{"amount":-5}',
    '{"amount":1e12}',
    '{"amount":0.001}',
    '{bad json}',
  ]) {
    assert.equal(await amountOf(content), null, content)
  }
})

test('http errors, network errors and empty replies degrade to null', async () => {
  assert.equal(await llmWith(fakeFetch(reply('{"amount":10}'), 500).fn).readAmount(Buffer.from('x'), 'image/png'), null)
  assert.equal(await llmWith(fakeFetch({ choices: [] }).fn).readAmount(Buffer.from('x'), 'image/png'), null)
  const down = (async () => {
    throw new Error('ECONNREFUSED')
  }) as typeof fetch
  assert.equal(await llmWith(down).readAmount(Buffer.from('x'), 'image/png'), null)
})

test('makeLlm without a base URL is disabled and never calls fetch', async () => {
  const { fn, calls } = fakeFetch(reply('{"amount":10}'))
  const llm = makeLlm({ baseUrl: '', apiKey: '', visionModel: 'v', fetchFn: fn })
  assert.equal(llm.enabled, false)
  assert.equal(await llm.readAmount(Buffer.from('x'), 'image/png'), null)
  assert.equal(calls.length, 0)
})

test('makeLlm omits the authorization header when the API key is empty', async () => {
  const { fn, calls } = fakeFetch(reply('{"amount":10}'))
  await llmWith(fn, '').readAmount(Buffer.from('x'), 'image/png')
  assert.equal(calls[0]?.headers.authorization, undefined)
})

const pickOf = async (content: string, names = ['Luz', 'Agua']) =>
  llmWith(fakeFetch(reply(content)).fn).pickBill(Buffer.from('x'), 'image/png', names)

test('pickBill sends the numbered names with the image and parses index and amount', async () => {
  const { fn, calls } = fakeFetch(reply('```json\n{"index":1,"amount":80.1}\n```'))
  assert.deepEqual(await llmWith(fn).pickBill(Buffer.from('img'), 'image/png', ['Luz', 'Agua']), {
    index: 1,
    amount: 80.1,
  })
  const content = calls[0]?.body.messages[1]?.content as { type: string; text?: string }[]
  assert.match(String(content[0]?.text), /0: Luz\n1: Agua/)
  assert.equal(content[1]?.type, 'image_url')
})

test('pickBill nulls what is unparseable, out of range or insane, and a disabled or failing LLM', async () => {
  const none = { index: null, amount: null }
  assert.deepEqual(await pickOf('sorry'), none)
  assert.deepEqual(await pickOf('{bad json}'), none)
  assert.deepEqual(await pickOf('{"index":2,"amount":-1}'), none)
  assert.deepEqual(await pickOf('{"index":"0","amount":"5"}'), none)
  assert.deepEqual(await pickOf('{"index":0}'), { index: 0, amount: null })
  assert.deepEqual(
    await llmWith(fakeFetch(reply('{"index":0}'), 500).fn).pickBill(Buffer.from('x'), 'image/png', ['a']),
    none,
  )
  const off = makeLlm({ baseUrl: '', apiKey: '', visionModel: 'v' })
  assert.deepEqual(await off.pickBill(Buffer.from('x'), 'image/png', ['a']), none)
})

test('the caller abort signal cuts the request short, for reads and picks', async () => {
  const fn = (async (_url: unknown, init?: RequestInit) =>
    new Promise((_, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error('no signal'))
      signal.addEventListener('abort', () => reject(signal.reason))
    })) as typeof fetch
  const cut = async <T>(call: (s: AbortSignal) => Promise<T>) => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(new Error('receipt read timed out')), 5)
    const started = Date.now()
    const out = await call(abort.signal)
    assert.ok(Date.now() - started < 1000)
    return out
  }
  assert.equal(await cut(s => llmWith(fn).readAmount(Buffer.from('x'), 'image/png', s)), null)
  assert.deepEqual(await cut(s => llmWith(fn).pickBill(Buffer.from('x'), 'image/png', ['Luz'], s)), {
    index: null,
    amount: null,
  })
})
