import { dirname, resolve } from 'node:path'
import pino from 'pino'
import { connectWa, parseGroupJids } from './wa.ts'
import { makeBot } from './bot.ts'
import { makeLlm } from './llm.ts'
import { openState, cachedGroupsForCodes } from './state.ts'
import { pdfToPng } from './pdf.ts'
import { makeLocale } from './i18n.ts'
import { loadGif, loadReleases } from './announce.ts'

function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback
  if (!v) throw new Error(`missing env ${name}`)
  return v
}

const log = pino({ level: process.env.LOG_LEVEL || 'info' })
const locale = makeLocale(env('BOT_LANG', 'pt-BR'), env('BOT_CURRENCY', 'BRL'))
log.info({ lang: locale.lang, currency: locale.currency }, 'locale')
const stateFile = env('STATE_FILE', 'data/state.json')
const groups = await openState(stateFile, log)
const version = process.env.APP_VERSION || 'dev'
const gifSrc = process.env.ANNOUNCE_GIF || ''
async function gif(): Promise<Buffer | null> {
  try { return await loadGif(gifSrc, dirname(resolve(stateFile))) } catch (e) {
    log.warn({ err: e }, 'announcement gif unavailable')
    return null
  }
}
const announce = process.env.ANNOUNCE_UPDATES === 'false' ? undefined : { releases: await loadReleases(new URL('../CHANGELOG.json', import.meta.url)), gif }
const llm = makeLlm({
  baseUrl: process.env.LLM_BASE_URL || '',
  apiKey: process.env.LLM_API_KEY || '',
  visionModel: env('LLM_VISION_MODEL', 'cx/gpt-5.5'),
  currency: locale.currency,
})
if (!llm.enabled) log.warn('no LLM_BASE_URL: receipts are only paid when their caption names the bill')

const { jids: groupJids, inviteCodes } = parseGroupJids(process.env.GROUP_INVITE_LINKS || '')
if (groupJids.size === 0 && inviteCodes.length === 0) log.warn('serving no groups — add the bot to a WhatsApp group and read its jid from the log, then set GROUP_INVITE_LINKS and restart')
else log.info({ groups: [...groupJids], inviteCodes }, 'serving groups')
const cached = cachedGroupsForCodes(groups, inviteCodes)
for (const jid of cached.jids) groupJids.add(jid)
const bots = new Map<string, ReturnType<typeof makeBot>>()
let wa: Awaited<ReturnType<typeof connectWa>> | undefined

function botFor(jid: string) {
  let bot = bots.get(jid)
  if (!bot) {
    if (!wa) throw new Error('WhatsApp is not connected yet')
    bot = makeBot({ wa: wa.forGroup(jid), llm, store: groups.forGroup(jid), log: log.child({ group: jid }), pdfToPng, locale, version, announce })
    bots.set(jid, bot)
  }
  return bot
}

const join = (jid: string) => botFor(jid).join()
  .then(r => log.info({ jid, result: r }, 'group joined'))
  .catch(e => log.error({ err: e, jid }, 'join failed, retrying on next connection'))

const onRemoved = (jid: string) => {
  groupJids.delete(jid)
  bots.delete(jid)
  delete groups.forGroup(jid).get()._meta.invite
  return groups.forGroup(jid).save()
    .then(() => log.info({ jid }, 'removed from group, no longer served — name it in GROUP_INVITE_LINKS again at next start to restore it'))
    .catch(e => log.error({ err: e, jid }, 'saving state after removal failed'))
}

wa = await connectWa({
  authDir: env('AUTH_DIR', 'auth'),
  phone: process.env.BOT_PHONE || '',
  groups: groupJids,
  inviteCodes: cached.toResolve,
  log,
  onResolved: async (code, jid) => {
    groups.forGroup(jid).get()._meta.invite = code
    await groups.forGroup(jid).save()
  },
  onOpen: jids => { for (const jid of jids) join(jid) },
  onJoined: jid => { join(jid) },
  onMessage: (jid, m) => { botFor(jid).onMessage(m) },
  onDescription: (jid, d) => { botFor(jid).onDescription(d).catch(e => log.error({ err: e, jid }, 'description handling failed')) },
  onRemoved,
})

setInterval(() => {
  for (const [jid, bot] of bots) bot.tick().catch(e => log.error({ err: e, jid }, 'tick failed'))
}, 60_000)
log.info('contas-bot ready')
