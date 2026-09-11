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
const store = (await openState(env('STATE_FILE', 'data/state.json'), process.env.GROUP_JID || undefined)).forGroup(process.env.GROUP_JID ?? '')
const llm = makeLlm({
  baseUrl: env('LLM_BASE_URL'),
  apiKey: env('LLM_API_KEY'),
  textModel: env('LLM_TEXT_MODEL', 'cx/gpt-5.4-mini'),
  visionModel: env('LLM_VISION_MODEL', 'cx/gpt-5.5'),
})

let bot: ReturnType<typeof makeBot> | undefined
const groupJid = process.env.GROUP_JID ?? ''
const wa = await connectWa({
  authDir: env('AUTH_DIR', 'auth'),
  groupJid,
  phone: env('BOT_PHONE'),
  log,
  onMessage: m => { bot?.onMessage(m) },
  onDescription: d => { bot?.onDescription(d).catch(e => log.error({ err: e }, 'description handling failed')) },
})

if (!groupJid) {
  // First boot: pair, log the groups this number belongs to, and wait for GROUP_JID to be set.
  log.warn('GROUP_JID is empty: pair the number, copy the group JID from the log into .env and restart')
  await new Promise(() => {})
}

// Baileys resolves the socket before the connection is open; wait for the first successful metadata read.
for (let i = 0; ; i++) {
  try { await wa.getDescription(); break } catch {
    if (i > 60) throw new Error('never connected')
    await new Promise(r => setTimeout(r, 5000))
  }
}

bot = makeBot({ wa, llm, store, log, pdfToPng })
await bot.start()
await bot.tick()
setInterval(() => { bot!.tick().catch(e => log.error({ err: e }, 'tick failed')) }, 60_000)
log.info('contas-bot ready')
