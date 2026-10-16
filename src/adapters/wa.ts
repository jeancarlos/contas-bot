import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Boom } from '@hapi/boom'
import makeWASocket, {
  type ConnectionState,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type proto,
  toNumber,
  useMultiFileAuthState,
  type WAMessage,
  type WAMessageKey,
  type WAMessageUpdate,
  type WAVersion,
} from '@whiskeysockets/baileys'
import type { Logger } from 'pino'
import type { EditInput, MediaRef, MessageInput, MsgKey } from '../core/types.ts'
import type { Wa } from '../shell/run.ts'
import { waVersionOnce } from '../waVersion.ts'

export type Handlers = {
  onOpen(jids: string[]): void
  onJoined(jid: string): void
  onInput(jid: string, input: MessageInput | EditInput): void
  onRemoved(jid: string): void | Promise<void>
}
type Cfg = Handlers & {
  authDir: string
  phone: string
  groups: Set<string>
  inviteCodes: string[]
  log: Logger
  onResolved(code: string, jid: string): void | Promise<void>
  onStatus?(connected: boolean): void
}
export type Recent = Map<string, { sender: string; media: MediaRef | undefined }>
export type Messages = Map<string, WAMessage>
type Handle = { id: string; size: number }
type DownloadCtx = NonNullable<Parameters<typeof downloadMediaMessage>[3]>
type Content = proto.IMessage
type Num = Parameters<typeof toNumber>[0]

const PAIRING_CODE_TTL_MS = 180_000
const MAX_RECEIPT = 16 * 1024 * 1024
const RECENT_MAX = 500

export function pairingAction(phone: string): 'code' | 'unpaired' {
  return phone ? 'code' : 'unpaired'
}

function inviteCode(link: string): string {
  const path = link.split('?')[0]?.split('#')[0] ?? ''
  const code = path.replace(/\/+$/, '').split('/').pop() ?? ''
  if (code.toLowerCase() === 'chat.whatsapp.com')
    throw new Error(`GROUP_INVITE_LINKS: not a group jid or invite link: ${link}`)
  return code
}

export function parseGroupJids(raw: string): { jids: Set<string>; inviteCodes: string[] } {
  const jids = new Set<string>()
  const inviteCodes: string[] = []
  for (const entry of raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)) {
    if (entry.toLowerCase().includes('chat.whatsapp.com')) {
      inviteCodes.push(inviteCode(entry))
      continue
    }
    const jid = entry.includes('@') ? entry : /^\d+$/.test(entry) ? `${entry}@g.us` : entry
    if (!jid.toLowerCase().endsWith('@g.us'))
      throw new Error(`GROUP_INVITE_LINKS: not a group jid or invite link: ${entry}`)
    jids.add(jid)
  }
  return { jids, inviteCodes }
}

export async function resolveInviteCodes(
  s: { groupGetInviteInfo(code: string): Promise<{ id: string; subject: string }> },
  cfg: {
    groups: Set<string>
    log: Pick<Logger, 'info' | 'warn'>
    onResolved?(code: string, jid: string): void | Promise<void>
  },
  codes: string[],
): Promise<void> {
  await Promise.allSettled(
    codes.map(async code => {
      try {
        const { id, subject } = await s.groupGetInviteInfo(code)
        cfg.groups.add(id)
        codes.splice(codes.indexOf(code), 1)
        cfg.log.info(
          { code, jid: id, subject },
          'resolved invite link; put this jid in GROUP_INVITE_LINKS directly to stop depending on the link',
        )
        await cfg.onResolved?.(code, id)
      } catch (err) {
        cfg.log.warn({ err, code }, 'invite link resolution failed')
      }
    }),
  )
}

export async function resolveOpenJids(
  s: { groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string }>> },
  cfg: { groups: Set<string>; log: Pick<Logger, 'info' | 'warn'> },
): Promise<string[]> {
  try {
    const groups = await s.groupFetchAllParticipating()
    for (const g of Object.values(groups))
      cfg.log.info({ jid: g.id, subject: g.subject, mine: cfg.groups.has(g.id) }, 'member of group')
    return [...cfg.groups].filter(jid => groups[jid])
  } catch (err) {
    cfg.log.warn({ err }, 'group discovery failed')
  }
  return [...cfg.groups]
}

export function logJoinedGroup(
  cfg: { groups: Set<string>; log: Pick<Logger, 'info'> },
  jid: string,
  subject?: string,
): void {
  cfg.log.info(
    { jid, subject, mine: cfg.groups.has(jid) },
    'added to a group; put this jid in GROUP_INVITE_LINKS to serve it',
  )
}

export function participantsIncludeSelf(
  me: string[],
  participants: { id?: string; phoneNumber?: string; lid?: string }[],
): boolean {
  const isMe = (j?: string) => !!j && me.includes(jidNormalizedUser(j))
  return participants.some(p => isMe(p.id) || isMe(p.phoneNumber) || isMe(p.lid))
}

export function reportStatus(onStatus: ((connected: boolean) => void) | undefined, u: Partial<ConnectionState>): void {
  if (u.connection === 'open') onStatus?.(true)
  if (u.connection === 'close') onStatus?.(false)
}

export function gate(groups: Set<string>, cfg: Handlers): Handlers {
  const mine = (jid?: string | null): jid is string => jid != null && groups.has(jid)
  return {
    onOpen: jids => cfg.onOpen(jids.filter(mine)),
    onJoined: jid => {
      if (mine(jid)) cfg.onJoined(jid)
    },
    onInput: (jid, input) => {
      if (mine(jid)) cfg.onInput(jid, input)
    },
    onRemoved: async jid => {
      if (mine(jid)) await cfg.onRemoved(jid)
    },
  }
}

function textOf(c: Content): string {
  const raw =
    c.conversation ??
    c.extendedTextMessage?.text ??
    c.imageMessage?.caption ??
    c.documentMessage?.caption ??
    (c.reactionMessage?.key?.fromMe ? c.reactionMessage.text : null) ??
    ''
  return raw.replace(/@\d+/g, ' ').replace(/\s+/g, ' ').trim()
}

function mediaOf(c: Content, id: string, msg: WAMessage, msgs: Messages): MediaRef | undefined {
  const ref = (mime: string, size: Num, message: Content): MediaRef => {
    msgs.set(id, { key: msg.key, message })
    const handle: Handle = { id, size: toNumber(size) }
    return { mime, handle }
  }
  const { imageMessage, documentMessage } = c
  if (imageMessage) return ref(imageMessage.mimetype || 'image/jpeg', imageMessage.fileLength, { imageMessage })
  if (documentMessage?.mimetype === 'application/pdf')
    return ref('application/pdf', documentMessage.fileLength, { documentMessage })
  return undefined
}

function quotedOf(c: Content, remoteJid: string, msgs: Messages): MediaRef | undefined {
  const ctx = c.extendedTextMessage?.contextInfo ?? c.imageMessage?.contextInfo ?? c.documentMessage?.contextInfo
  const quoted = normalizeMessageContent(ctx?.quotedMessage)
  if (!ctx?.stanzaId || !quoted) return undefined
  const key = { remoteJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }
  return mediaOf(quoted, `${remoteJid}:${ctx.stanzaId}:quoted`, { key, message: ctx.quotedMessage }, msgs)
}

const keyOf = (k: WAMessageKey, id: string, remoteJid: string): MsgKey => ({
  id,
  fromMe: Boolean(k.fromMe),
  remoteJid,
  participant: k.participant ?? undefined,
})
const millis = (t: Num) => toNumber(t) * 1000 || Date.now()

export function toMessage(msg: WAMessage, msgs: Messages): MessageInput | null {
  const c = normalizeMessageContent(msg.message)
  const { id, remoteJid } = msg.key
  if (!c || c.protocolMessage || !id || !remoteJid) return null
  const text = textOf(c)
  const media = mediaOf(c, `${remoteJid}:${id}`, msg, msgs)
  const quoted = quotedOf(c, remoteJid, msgs)
  if (!text && !media && !quoted) return null
  return {
    kind: 'message',
    key: keyOf(msg.key, id, remoteJid),
    sender: msg.pushName || msg.key.participant || '',
    text,
    at: millis(msg.messageTimestamp),
    media,
    quoted,
  }
}

export function toEdit(u: WAMessageUpdate, recent: Recent, now = Date.now): EditInput | null {
  const c = normalizeMessageContent(u.update.message?.editedMessage?.message)
  const { id, remoteJid } = u.key
  if (!c || !id || !remoteJid) return null
  const original = recent.get(`${remoteJid}:${id}`)
  return {
    kind: 'edit',
    key: keyOf(u.key, id, remoteJid),
    sender: original?.sender || u.key.participant || '',
    text: textOf(c),
    at: Math.min(millis(u.update.messageTimestamp), now()),
    media: original?.media,
  }
}

function newest(map: Map<string, unknown>) {
  for (const id of map.keys()) {
    if (map.size <= RECENT_MAX) break
    map.delete(id)
  }
}

function remember(recent: Recent, msgs: Messages, m: MessageInput) {
  recent.set(`${m.key.remoteJid}:${m.key.id}`, { sender: m.sender, media: m.media ?? m.quoted })
  newest(recent)
  newest(msgs)
}

function trustedUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    const ok = u.protocol === 'https:' && !u.username && !u.password
    return ok && (u.hostname === 'whatsapp.net' || u.hostname.endsWith('.whatsapp.net')) ? u : null
  } catch {
    return null
  }
}

function trustedHost(msg: WAMessage): boolean {
  const c = normalizeMessageContent(msg.message)
  const media = c?.imageMessage ?? c?.documentMessage
  const { url, directPath } = media ?? {}
  if (!url && !directPath) return false
  const given = url ? trustedUrl(url) : null
  if (url && !given) return false
  if (!directPath) return true
  if (!directPath.startsWith('/') || directPath.includes('@')) return false
  return trustedUrl(`https://${given?.host ?? 'mmg.whatsapp.net'}${directPath}`) !== null
}

export async function download(
  media: MediaRef,
  msgs: Messages,
  ctx: DownloadCtx,
  dl = downloadMediaMessage,
): Promise<Buffer> {
  const h = media.handle as Handle
  if (h.size > MAX_RECEIPT) throw new Error('receipt too large')
  const msg = msgs.get(h.id)
  if (!msg) throw new Error('receipt expired')
  if (!msg.key.remoteJid || !h.id.startsWith(`${msg.key.remoteJid}:`)) throw new Error('receipt group mismatch')
  if (!trustedHost(msg)) throw new Error('receipt host refused')
  const stream = await dl(msg, 'stream', {}, ctx)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.length
    if (total > MAX_RECEIPT) {
      stream.destroy()
      throw new Error('receipt too large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

type Listener = { bivariant(arg: unknown): void }['bivariant']
type Participants = { id: string; participants: { id?: string; phoneNumber?: string; lid?: string }[]; action: string }

export function wireGroupEvents(
  ev: { on(event: string, handler: Listener): void },
  on: Omit<Handlers, 'onOpen'>,
  self: () => string[],
  cfg: { groups: Set<string>; log: Pick<Logger, 'info'>; recent: Recent; msgs: Messages },
): void {
  const served = (jid?: string | null): jid is string => Boolean(jid?.endsWith('@g.us') && cfg.groups.has(jid))
  ev.on('messages.upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
    if (type !== 'notify' && type !== 'append') return
    for (const raw of messages) {
      const jid = raw.key.remoteJid
      const m = served(jid) ? toMessage(raw, cfg.msgs) : null
      if (!jid || !m) continue
      remember(cfg.recent, cfg.msgs, m)
      on.onInput(jid, m)
    }
  })
  ev.on('messages.update', (updates: WAMessageUpdate[]) => {
    for (const u of updates) {
      const jid = u.key.remoteJid
      const e = served(jid) ? toEdit(u, cfg.recent) : null
      if (jid && e) on.onInput(jid, e)
    }
  })
  ev.on('group-participants.update', async ({ id, participants, action }: Participants) => {
    const isSelf = participantsIncludeSelf(self(), participants)
    if (action === 'add' && isSelf) {
      logJoinedGroup(cfg, id)
      on.onJoined(id)
    }
    if (action === 'remove' && isSelf) await on.onRemoved(id)
  })
  ev.on('groups.upsert', (groups: { id: string; subject?: string }[]) => {
    for (const g of groups) {
      logJoinedGroup(cfg, g.id, g.subject)
      on.onJoined(g.id)
    }
  })
}

export async function handleOpen(
  s: {
    groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string }>>
    groupGetInviteInfo(code: string): Promise<{ id: string; subject: string }>
  },
  cfg: {
    groups: Set<string>
    inviteCodes: string[]
    log: Pick<Logger, 'info' | 'warn'>
    onResolved?(code: string, jid: string): void | Promise<void>
  },
  onOpen: (jids: string[]) => void,
): Promise<void> {
  cfg.log.info('whatsapp connected')
  await resolveInviteCodes(s, cfg, cfg.inviteCodes)
  onOpen(await resolveOpenJids(s, cfg))
}

async function wipeAuth(authDir: string, log: Logger) {
  try {
    for (const name of await readdir(authDir)) await rm(join(authDir, name), { recursive: true, force: true })
    const left = await readdir(authDir)
    if (left.length) throw new Error(`still present after wipe: ${left.join(', ')}`)
  } catch (err) {
    log.fatal({ err, authDir }, 'could not wipe auth dir — the same logout will repeat until it is emptied by hand')
  }
}

const toKey = (k: MsgKey): WAMessageKey => ({
  id: k.id,
  fromMe: k.fromMe,
  remoteJid: k.remoteJid,
  participant: k.participant,
})
const sentId = (sent: WAMessage | undefined) => {
  const id = sent?.key.id
  if (!id) throw new Error('sendMessage returned no message id')
  return id
}

export async function connectWa(cfg: Cfg): Promise<{ forGroup(jid: string): Wa }> {
  let pairingCodeAt = 0
  let idle = false
  let reconnects = 0
  let announced = ''
  const recent: Recent = new Map()
  const msgs: Messages = new Map()
  const { state, saveCreds } = await useMultiFileAuthState(cfg.authDir)
  const on = gate(cfg.groups, cfg)
  const sockLog = cfg.log.child({ mod: 'baileys' }, { level: 'warn' })

  const resolveVersion = async () => {
    const wa = await waVersionOnce()
    const v = wa.version.join('.')
    if (v + wa.live !== announced) {
      announced = v + wa.live
      if (wa.live) cfg.log.info({ version: v }, 'announcing current WhatsApp Web version')
      else cfg.log.warn({ version: v }, 'could not fetch the current WhatsApp Web version; using the bundled one')
    }
    return wa.version
  }

  async function pairing(s: ReturnType<typeof makeWASocket>, u: Partial<ConnectionState>) {
    if (!u.qr || state.creds.registered) return
    if (pairingAction(cfg.phone) === 'unpaired') {
      if (idle) return
      idle = true
      cfg.log.warn('not paired: run the installer again to pair')
      await s.end(undefined)
      return
    }
    if (Date.now() - pairingCodeAt <= PAIRING_CODE_TTL_MS) return
    pairingCodeAt = Date.now()
    try {
      const code = await s.requestPairingCode(cfg.phone)
      cfg.log.warn({ code }, 'PAIRING CODE: WhatsApp > Aparelhos conectados > Conectar com número de telefone')
    } catch (err) {
      pairingCodeAt = 0
      cfg.log.error({ err }, 'pairing code request failed, retrying on next connection')
    }
  }

  async function loggedOut() {
    cfg.log.error('logged out: wiping auth, restart pairs again')
    await wipeAuth(cfg.authDir, cfg.log)
    if (!state.creds.registered) {
      cfg.log.warn(
        'session ended unpaired: run the installer again, or docker restart contas-bot for a new pairing code',
      )
      idle = true
      return
    }
    await new Promise(r => setTimeout(r, 60_000))
    process.exit(2)
  }

  async function closed(u: Partial<ConnectionState>) {
    if (idle) return
    const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode
    if (code === DisconnectReason.loggedOut) return loggedOut()
    const delay = code === DisconnectReason.restartRequired ? 3000 : Math.min(3000 * 2 ** reconnects++, 300_000)
    cfg.log.warn({ code, delay }, 'connection closed, reconnecting')
    setTimeout(() => {
      resolveVersion()
        .then(v => {
          sock = start(v)
        })
        .catch(err => {
          cfg.log.fatal({ err }, 'reconnect failed, exiting so the container restarts')
          process.exit(1)
        })
    }, delay)
  }

  function start(version: WAVersion) {
    const s = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, sockLog) },
      logger: sockLog,
      version,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })
    const self = () => [s.user?.id, s.user?.lid].filter((j): j is string => Boolean(j)).map(jidNormalizedUser)
    s.ev.on('creds.update', () => {
      saveCreds().catch(err => cfg.log.error({ err }, 'saving WhatsApp credentials failed'))
    })
    s.ev.on('connection.update', async u => {
      try {
        reportStatus(cfg.onStatus, u)
        await pairing(s, u)
        if (u.connection === 'open') {
          reconnects = 0
          await handleOpen(s, cfg, on.onOpen)
        }
        if (u.connection === 'close') await closed(u)
      } catch (err) {
        cfg.log.error({ err }, 'connection.update handler failed')
      }
    })
    wireGroupEvents(s.ev, on, self, { groups: cfg.groups, log: cfg.log, recent, msgs })
    return s
  }

  let sock = start(await resolveVersion())
  const own = (jid: string, id: string): WAMessageKey => ({ id, fromMe: true, remoteJid: jid })

  return {
    forGroup(jid: string): Wa {
      return {
        async sendText(text, quoted) {
          const opts = quoted ? { quoted: { key: toKey(quoted), message: {} } } : {}
          return sentId(await sock.sendMessage(jid, { text }, opts))
        },
        async sendVideo(video, caption) {
          return sentId(await sock.sendMessage(jid, { video, gifPlayback: true, caption }))
        },
        async react(key, emoji) {
          await sock.sendMessage(jid, { react: { text: emoji, key: toKey(key) } })
        },
        async pin(id) {
          await sock.sendMessage(jid, { pin: own(jid, id), type: 1, time: 2592000 })
        },
        async unpin(id) {
          await sock.sendMessage(jid, { pin: own(jid, id), type: 2 })
        },
        async getDescription() {
          return (await sock.groupMetadata(jid)).desc ?? ''
        },
        async setDescription(text) {
          await sock.groupUpdateDescription(jid, text)
        },
        download: media => download(media, msgs, { reuploadRequest: m => sock.updateMediaMessage(m), logger: sockLog }),
      }
    },
  }
}
