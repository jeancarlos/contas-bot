import pino from 'pino'
import { connectWa } from './wa.ts'
import { makeBot } from './bot.ts'
import { makeLlm } from './llm.ts'
import { openState } from './state.ts'
import { pdfToPng } from './pdf.ts'

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined || v === '') throw new Error(`missing env ${name}`)
  return v
}

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' })
const groups = await openState(env('STATE_FILE', 'data/state.json'), process.env.GROUP_JID || undefined)
const llm = makeLlm({
  baseUrl: env('LLM_BASE_URL'),
  apiKey: env('LLM_API_KEY'),
  textModel: env('LLM_TEXT_MODEL', 'cx/gpt-5.4-mini'),
  visionModel: env('LLM_VISION_MODEL', 'cx/gpt-5.5'),
})

const owners = env('OWNER_PHONES').split(',').map(s => s.replace(/\D/g, '')).filter(Boolean)
const bots = new Map<string, ReturnType<typeof makeBot>>()
let wa: Awaited<ReturnType<typeof connectWa>> | undefined

function botFor(jid: string) {
  let bot = bots.get(jid)
  if (!bot) {
    bot = makeBot({ wa: wa!.forGroup(jid), llm, store: groups.forGroup(jid), owners, log: log.child({ group: jid }), pdfToPng })
    bots.set(jid, bot)
  }
  return bot
}

const join = (jid: string) => botFor(jid).join()
  .then(r => log.info({ jid, result: r }, 'group joined'))
  .catch(e => log.error({ err: e, jid }, 'join failed, retrying on next start'))

wa = await connectWa({
  authDir: env('AUTH_DIR', 'auth'),
  phone: env('BOT_PHONE'),
  log,
  onOpen: jids => { for (const jid of jids) join(jid) },
  onJoined: jid => { join(jid) },
  onMessage: (jid, m) => { botFor(jid).onMessage(m) },
  onDescription: (jid, d) => { botFor(jid).onDescription(d).catch(e => log.error({ err: e, jid }, 'description handling failed')) },
})

setInterval(() => {
  for (const [jid, bot] of bots) bot.tick().catch(e => log.error({ err: e, jid }, 'tick failed'))
}, 60_000)
log.info('contas-bot ready')
