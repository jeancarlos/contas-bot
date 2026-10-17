import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePhone,
  validGroup,
  defaultCurrency,
  resolveAi,
  buildEnv,
  parseEnv,
  composeFile,
  imageTag,
  paired,
  detectMode,
  answersFromEnv,
  answersFromDotenv,
  mergeAnswers,
  keyFor,
  savedIds,
  AI_PRESETS,
  withDefaults,
  missingAnswers,
  probeAi,
  allowEmpty,
  envSafe,
  type Answers,
} from '../src/setup/core.ts'
import { SETUP_TEXT } from '../src/setup/i18n.ts'

const base: Answers = {
  lang: 'pt-BR',
  currency: 'BRL',
  pairing: 'qr',
  phone: '',
  ai: 'gemini',
  llmUrl: '',
  llmKey: 'k1',
  visionModel: '',
  group: '',
  tz: 'America/Sao_Paulo',
}

test('normalizePhone accepts the ways people type a number', () => {
  assert.equal(normalizePhone('+55 (11) 90000-0000'), '5511900000000')
  assert.equal(normalizePhone('55.11.9000.00000'), '5511900000000')
  assert.equal(normalizePhone('123'), null)
  assert.equal(normalizePhone('55 11 abc'), null)
})

test('validGroup accepts jids, lists and links like the bot', () => {
  assert.ok(validGroup('120363-111@g.us'))
  assert.ok(validGroup('120363111'))
  assert.ok(validGroup('1203631@g.us, 5551-22@g.us'))
  assert.ok(validGroup('https://chat.whatsapp.com/AbC123, 1203631@g.us'))
  assert.ok(!validGroup('1203631@g.us, junk'))
  assert.ok(!validGroup('hello'))
  assert.ok(!validGroup('120@s.whatsapp.net'))
})
test('validGroup accepts empty or an invite link only', () => {
  assert.ok(validGroup(''))
  assert.ok(validGroup('https://chat.whatsapp.com/AbC123'))
  assert.ok(!validGroup('https://example.com/x'))
})

test('defaultCurrency follows the language', () => {
  assert.deepEqual(
    ['pt-BR', 'en', 'es'].map(l => defaultCurrency(l as Answers['lang'])),
    ['BRL', 'USD', 'EUR'],
  )
})

test('resolveAi fills presets, keeps custom values and empties everything without AI', () => {
  assert.deepEqual(resolveAi(base), {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: 'k1',
    model: 'gemini-2.5-flash',
  })
  assert.deepEqual(resolveAi({ ...base, ai: 'openai' }), {
    url: 'https://api.openai.com/v1',
    key: 'k1',
    model: 'gpt-4o-mini',
  })
  assert.deepEqual(resolveAi({ ...base, ai: 'custom', llmUrl: 'http://h:1/v1/', visionModel: 'm' }), {
    url: 'http://h:1/v1',
    key: 'k1',
    model: 'm',
  })
  assert.deepEqual(resolveAi({ ...base, ai: 'none' }), { url: '', key: '', model: '' })
})

test('buildEnv writes every key, trims pasted values and only keeps the phone for code pairing', () => {
  const env = parseEnv(
    buildEnv(
      { ...base, llmKey: '  k1\n', group: ' https://chat.whatsapp.com/X \n', phone: '5511900000000' },
      1000,
      1001,
    ),
  )
  assert.equal(env.LLM_API_KEY, 'k1')
  assert.equal(env.GROUP_INVITE_LINKS, 'https://chat.whatsapp.com/X')
  assert.equal(env.BOT_PHONE, '')
  assert.equal(env.PAIRING_MODE, 'qr')
  assert.equal(env.PUID, '1000')
  assert.equal(env.PGID, '1001')
  assert.equal(env.LLM_VISION_MODEL, 'gemini-2.5-flash')
  const code = parseEnv(buildEnv({ ...base, pairing: 'code', phone: '5511900000000' }, 1, 1))
  assert.equal(code.BOT_PHONE, '5511900000000')
})

test('composeFile pins the image and imageTag reads the version back', () => {
  const c = composeFile('ghcr.io/jeancarlos/contas-bot:1.2.3')
  assert.match(c, /image: ghcr\.io\/jeancarlos\/contas-bot:1\.2\.3/)
  assert.match(c, /user: "\$\{PUID\}:\$\{PGID\}"/)
  assert.equal(imageTag(c), '1.2.3')
  assert.equal(imageTag('services: {}'), null)
  const digest = `sha256:${'a'.repeat(64)}`
  assert.equal(imageTag(composeFile(`ghcr.io/jeancarlos/contas-bot:1.2.3@${digest}`)), '1.2.3')
  assert.equal(imageTag(composeFile(`localhost:5000/contas-bot:1.2.3@${digest}`)), '1.2.3')
})

test('a QR-paired session counts as paired even though registered is false', () => {
  assert.ok(paired(JSON.stringify({ registered: false, me: { id: '55119@s.whatsapp.net' } })))
  assert.ok(!paired(JSON.stringify({ registered: false })))
  assert.ok(!paired(null))
  assert.ok(!paired('{broken'))
})

test('detectMode picks install, update or repair from the folder', () => {
  assert.equal(detectMode(false, null), 'install')
  assert.equal(detectMode(true, JSON.stringify({ me: { id: 'x' } })), 'update')
  assert.equal(detectMode(true, null), 'repair')
})

test('answersFromEnv reads and normalizes CONTAS_BOT_* and ignores invalid values', () => {
  const a = answersFromEnv({
    CONTAS_BOT_LANG: 'en',
    CONTAS_BOT_PAIRING: 'code',
    CONTAS_BOT_PHONE: '+55 11 90000-0000',
    CONTAS_BOT_AI: 'bogus',
  })
  assert.equal(a.lang, 'en')
  assert.equal(a.pairing, 'code')
  assert.equal(a.phone, '5511900000000')
  assert.equal(a.ai, undefined)
})

test('missingAnswers names only what the chosen path needs', () => {
  assert.deepEqual(missingAnswers(withDefaults({ lang: 'pt-BR', pairing: 'qr', ai: 'none' })), [])
  assert.deepEqual(missingAnswers(withDefaults({ lang: 'pt-BR', pairing: 'code', ai: 'gemini' })), ['phone', 'llmKey'])
  assert.deepEqual(missingAnswers(withDefaults({ lang: 'pt-BR', pairing: 'qr', ai: 'custom' })), [
    'llmUrl',
    'visionModel',
  ])
  assert.deepEqual(missingAnswers({}), ['lang', 'pairing', 'ai'])
})

test('probeAi is true only for a 2xx /models answer and sends the key', async () => {
  const seen: string[] = []
  const ok = (async (url: string, init?: RequestInit) => {
    const h = init?.headers as Record<string, string> | undefined
    if (h) seen.push(`${url} ${h.authorization}`)
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  assert.equal(await probeAi({ url: 'http://h/v1', key: 'k' }, ok), true)
  assert.deepEqual(seen, ['http://h/v1/models Bearer k'])
  const no = (async () => new Response('', { status: 401 })) as typeof fetch
  assert.equal(await probeAi({ url: 'http://h/v1', key: 'k' }, no), false)
  const down = (async () => {
    throw new Error('ECONNREFUSED')
  }) as typeof fetch
  assert.equal(await probeAi({ url: 'http://h/v1', key: '' }, down), false)
})

test('answersFromDotenv maps the plain fields and ignores invalid ones', () => {
  const a = answersFromDotenv({
    BOT_LANG: 'es',
    BOT_CURRENCY: 'eur',
    PAIRING_MODE: 'code',
    BOT_PHONE: '5511900000000',
    GROUP_INVITE_LINKS: 'https://chat.whatsapp.com/x',
    TZ: 'Europe/Madrid',
    LLM_BASE_URL: '',
  })
  assert.deepEqual(a, {
    lang: 'es',
    currency: 'EUR',
    pairing: 'code',
    phone: '5511900000000',
    group: 'https://chat.whatsapp.com/x',
    tz: 'Europe/Madrid',
    ai: 'none',
  })
  const bad = answersFromDotenv({
    BOT_LANG: 'fr',
    BOT_CURRENCY: 'XX',
    PAIRING_MODE: 'x',
    BOT_PHONE: '',
    LLM_BASE_URL: '',
  })
  assert.deepEqual(bad, { ai: 'none' })
})
test('answersFromDotenv recognises the AI provider from the base URL', () => {
  assert.equal(answersFromDotenv({ LLM_BASE_URL: AI_PRESETS.gemini.url, LLM_API_KEY: 'k' }).ai, 'gemini')
  assert.equal(answersFromDotenv({ LLM_BASE_URL: AI_PRESETS.openai.url, LLM_API_KEY: 'k' }).ai, 'openai')
  assert.equal(answersFromDotenv({ LLM_BASE_URL: AI_PRESETS.openai.url, LLM_API_KEY: 'k' }).llmKey, 'k')
  const c = answersFromDotenv({ LLM_BASE_URL: 'http://h:1/v1', LLM_VISION_MODEL: 'm', LLM_API_KEY: '' })
  assert.deepEqual(c, { ai: 'custom', llmUrl: 'http://h:1/v1', visionModel: 'm' })
})
test('mergeAnswers: first defined layer wins per key', () => {
  const m = mergeAnswers(
    { lang: 'en' },
    { lang: 'es', currency: 'EUR', llmKey: '' },
    { currency: 'BRL', llmKey: 'k', tz: 'UTC' },
  )
  assert.deepEqual(m, { lang: 'en', currency: 'EUR', llmKey: '', tz: 'UTC' })
  assert.deepEqual(mergeAnswers({ lang: undefined }, { lang: 'es' }), { lang: 'es' })
})
test('buildEnv -> parseEnv -> answersFromDotenv round-trips every field', () => {
  const cases: Answers[] = [
    { ...base, ai: 'gemini', llmKey: 'g' },
    {
      ...base,
      ai: 'openai',
      llmKey: 'o',
      pairing: 'code',
      phone: '5511900000000',
      group: 'https://chat.whatsapp.com/z',
    },
    {
      ...base,
      ai: 'custom',
      llmUrl: 'http://h:1/v1',
      llmKey: 'c',
      visionModel: 'vm',
      lang: 'en',
      currency: 'USD',
      tz: 'UTC',
    },
    { ...base, ai: 'none', llmKey: '' },
  ]
  for (const a of cases) {
    const back = answersFromDotenv(parseEnv(buildEnv(a, 1000, 1000)))
    const want: Partial<Answers> = {
      lang: a.lang,
      currency: a.currency,
      pairing: a.pairing,
      group: a.group,
      tz: a.tz,
      ai: a.ai,
    }
    if (a.phone) want.phone = a.phone
    if (a.llmKey) want.llmKey = a.llmKey
    if (a.ai === 'custom') {
      want.llmUrl = a.llmUrl
      want.visionModel = a.visionModel
    }
    assert.deepEqual(back, want)
  }
})

test('keyFor keeps a key only for the provider it came from', () => {
  const src = { ai: 'gemini' as const, llmKey: 'k' }
  assert.equal(keyFor({ ai: 'gemini' }, src), 'k')
  assert.equal(keyFor({ ai: 'openai' }, src), undefined)
  assert.equal(keyFor({ ai: 'gemini' }, undefined), undefined)
  assert.equal(keyFor({ ai: 'gemini' }, { ai: 'gemini' }), undefined)
  const c = { ai: 'custom' as const, llmUrl: 'http://h:1/v1', llmKey: 'c' }
  assert.equal(keyFor({ ai: 'custom', llmUrl: 'http://h:1/v1/' }, c), 'c')
  assert.equal(keyFor({ ai: 'custom', llmUrl: 'http://other/v1' }, c), undefined)
  assert.equal(keyFor({ ai: 'gemini' }, c), undefined)
})
test('savedIds reuses numeric PUID/PGID and falls back otherwise', () => {
  assert.deepEqual(savedIds({ PUID: '1234', PGID: '99' }, 1000, 1001), [1234, 99])
  assert.deepEqual(savedIds({ PUID: 'x' }, 1000, 1001), [1000, 1001])
  assert.deepEqual(savedIds({}, 1000, 1001), [1000, 1001])
})

test('values that compose would expand or cut are single-quoted and read back unchanged', () => {
  const tricky = 'sk-ab$HOME-x #tail'
  const a: Answers = { ...base, ai: 'custom', llmUrl: 'http://h:1/v1?a=$X', llmKey: tricky, visionModel: 'm #1' }
  const text = buildEnv(a, 1000, 1000)
  assert.match(text, /^LLM_API_KEY='sk-ab\$HOME-x #tail'$/m)
  assert.match(text, /^LLM_VISION_MODEL='m #1'$/m)
  assert.match(text, /^LLM_BASE_URL='http:\/\/h:1\/v1\?a=\$X'$/m)
  assert.match(text, /^BOT_LANG=pt-BR$/m)
  assert.match(text, /^TZ=America\/Sao_Paulo$/m)
  const env = parseEnv(text)
  assert.equal(env.LLM_API_KEY, tricky)
  const back = answersFromDotenv(env)
  assert.equal(back.llmKey, tricky)
  assert.equal(back.llmUrl, 'http://h:1/v1?a=$X')
  assert.equal(back.visionModel, 'm #1')
  assert.equal(parseEnv("A='x'\nB=''\nC='\nD=it's").A, 'x')
  assert.deepEqual(parseEnv("B=''\nC='\nD=it's"), { B: '', C: "'", D: "it's" })
})

test('a value with a single quote or a line break is refused at the prompt and never written', () => {
  assert.equal(envSafe('sk-ab$HOME #x'), true)
  assert.equal(envSafe("it's"), false)
  assert.equal(envSafe('a\nb'), false)
  assert.equal(envSafe('a\rb'), false)
  assert.throws(() => buildEnv({ ...base, llmKey: "it's" }, 1, 1), /LLM_API_KEY/)
  assert.throws(
    () => buildEnv({ ...base, ai: 'custom', llmUrl: 'http://h', visionModel: 'a\nb' }, 1, 1),
    /LLM_VISION_MODEL/,
  )
  assert.equal(answersFromEnv({ CONTAS_BOT_LLM_KEY: "it's" }).llmKey, undefined)
  assert.equal(answersFromEnv({ CONTAS_BOT_VISION_MODEL: "it's" }).visionModel, undefined)
})

test('allowEmpty: only without history, and only on a fresh install or with the saved consent', () => {
  assert.equal(allowEmpty(true, true, {}), true)
  assert.equal(allowEmpty(true, false, { ALLOW_EMPTY_STATE: '1' }), true)
  assert.equal(allowEmpty(true, false, {}), false)
  assert.equal(allowEmpty(true, false, { ALLOW_EMPTY_STATE: '0' }), false)
  assert.equal(allowEmpty(false, true, { ALLOW_EMPTY_STATE: '1' }), false)
})

test('the phone examples are placeholders that normalize like a real number', () => {
  for (const tx of Object.values(SETUP_TEXT)) {
    const example = /\+[\d ().-]+$/.exec(tx.phoneInvalid)?.[0] ?? ''
    assert.ok(normalizePhone(example), example)
  }
  assert.match(SETUP_TEXT['pt-BR'].phoneInvalid, /\+55 11 90000-0000$/)
})
