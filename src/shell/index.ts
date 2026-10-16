import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import pino from 'pino'
import { openStore } from '../adapters/store.ts'
import { connectWa, parseGroupJids } from '../adapters/wa.ts'
import { loadGif, loadReleases } from '../announce.ts'
import { makeLocale } from '../core/i18n.ts'
import { makeLlm } from '../llm.ts'
import { pdfToPng } from '../pdf.ts'
import { cachedGroups, makeShell, type Wa } from './run.ts'

const env = (name: string, fallback = '') => process.env[name] || fallback
const log = pino({ level: env('LOG_LEVEL', 'info') })
const locale = makeLocale(env('BOT_LANG', 'pt-BR'), env('BOT_CURRENCY', 'BRL'), env('TZ'))
log.info(locale, 'locale')

const dbPath = env('DB_FILE', 'data/contas.db')
const v1Path = env('STATE_FILE', 'data/state.json')
if (existsSync(dbPath) && existsSync(v1Path))
  log.warn({ dbPath, v1Path }, 'both contas.db and state.json exist: contas.db wins, state.json is ignored')
const { store, imported } = openStore({ dbPath, v1Path, allowEmpty: env('ALLOW_EMPTY_STATE') === '1' })
if (imported !== null) log.info({ groups: imported }, 'imported state.json into contas.db')

const version = env('APP_VERSION', 'dev')
const gifSrc = env('ANNOUNCE_GIF')
const releases =
  env('ANNOUNCE_UPDATES') === 'false' ? null : await loadReleases(new URL('../../CHANGELOG.json', import.meta.url))
if (releases === null) log.info('no release announcements: changelog missing or ANNOUNCE_UPDATES=false')
const gif = () =>
  loadGif(gifSrc, dirname(resolve(v1Path))).catch(err => {
    log.warn({ err }, 'announcement gif unavailable')
    return null
  })

const llm = makeLlm({
  baseUrl: env('LLM_BASE_URL'),
  apiKey: env('LLM_API_KEY'),
  visionModel: env('LLM_VISION_MODEL', 'cx/gpt-5.5'),
  currency: locale.currency,
})
if (!llm.enabled) log.warn('no LLM_BASE_URL: receipts are only paid when their caption names the bill')

const { jids: groups, inviteCodes } = parseGroupJids(env('GROUP_INVITE_LINKS'))
if (groups.size === 0 && inviteCodes.length === 0)
  log.warn(
    'serving no groups — add the bot to a WhatsApp group and read its jid from the log, then set GROUP_INVITE_LINKS and restart',
  )
else log.info({ groups: [...groups], inviteCodes }, 'serving groups')
const cached = cachedGroups(store, inviteCodes)
for (const jid of cached.jids) groups.add(jid)

let wa: { forGroup(jid: string): Wa } | undefined
const shell = makeShell({
  store,
  wa: jid => {
    if (!wa) throw new Error('WhatsApp is not connected yet')
    return wa.forGroup(jid)
  },
  locale,
  llm,
  pdfToPng,
  log,
  now: Date.now,
  version,
  announce: { releases, gif },
})

const failed = (what: string, jid: string) => (err: unknown) => log.error({ err, jid }, what)
const join = (jid: string) => {
  shell.join(jid).then(() => log.info({ jid }, 'group joined'), failed('join failed, retrying on next connection', jid))
}

wa = await connectWa({
  authDir: env('AUTH_DIR', 'auth'),
  phone: env('BOT_PHONE'),
  groups,
  inviteCodes: cached.toResolve,
  log,
  onResolved: (code, jid) => shell.resolved(code, jid),
  onOpen: jids => {
    for (const jid of jids) join(jid)
  },
  onJoined: join,
  onInput: (jid, input) => {
    shell.handle(jid, input).catch(failed('input handling failed', jid))
  },
  onRemoved: jid => {
    groups.delete(jid)
    shell.removed(jid)
    log.info(
      { jid },
      'removed from group, no longer served — name it in GROUP_INVITE_LINKS again at next start to restore it',
    )
  },
})

setInterval(() => {
  for (const jid of groups) shell.handle(jid, { kind: 'tick', at: Date.now() }).catch(failed('tick failed', jid))
}, 60_000)
log.info('contas-bot ready')
