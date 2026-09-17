import makeWASocket, {
  DisconnectReason, downloadMediaMessage, useMultiFileAuthState, makeCacheableSignalKeyStore,
  jidNormalizedUser,
  type WAMessage, type WAMessageKey, normalizeMessageContent,
} from '@whiskeysockets/baileys'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import type { Incoming, MsgKey, Wa } from './bot.ts'

type Cfg = {
  authDir: string
  phone: string
  groups: Set<string>
  inviteCodes: string[]
  log: Logger
  onResolved(code: string, jid: string): void | Promise<void>
  onOpen(jids: string[]): void
  onJoined(jid: string): void
  onMessage(jid: string, m: Incoming): void
  onDescription(jid: string, desc: string): void
  onRemoved(jid: string): void | Promise<void>
}

type Handlers = Pick<Cfg, 'onOpen' | 'onJoined' | 'onMessage' | 'onDescription' | 'onRemoved'>

// WhatsApp expires a pairing code in a couple of minutes and rate-limits
// repeat requests. A boolean latch was never cleared on reconnect, so the
// bot sat on a dead code forever; a timestamp both throttles and expires.
const PAIRING_CODE_TTL_MS = 180_000
let pairingCodeAt = 0
// Receipts are buffered whole in memory; anything bigger is not a receipt.
const MAX_RECEIPT = 16 * 1024 * 1024

function inviteCode(link: string): string {
  const code = link.split('?')[0].split('#')[0].replace(/\/+$/, '').split('/').pop()!
  if (code.toLowerCase() === 'chat.whatsapp.com') throw new Error(`GROUP_INVITE_LINKS: not a group jid or invite link: ${link}`)
  return code
}

export function parseGroupJids(raw: string): { jids: Set<string>; inviteCodes: string[] } {
  const jids = new Set<string>()
  const inviteCodes: string[] = []
  for (const entry of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const lower = entry.toLowerCase()
    if (lower.includes('chat.whatsapp.com')) { inviteCodes.push(inviteCode(entry)); continue }
    const jid = entry.includes('@') ? entry : /^\d+$/.test(entry) ? `${entry}@g.us` : entry
    if (!jid.toLowerCase().endsWith('@g.us')) throw new Error(`GROUP_INVITE_LINKS: not a group jid or invite link: ${entry}`)
    jids.add(jid)
  }
  return { jids, inviteCodes }
}

export async function resolveInviteCodes(
  s: { groupGetInviteInfo(code: string): Promise<{ id: string; subject: string }> },
  cfg: { groups: Set<string>; log: Pick<Logger, 'info' | 'warn'>; onResolved?(code: string, jid: string): void | Promise<void> },
  codes: string[],
): Promise<void> {
  await Promise.allSettled(codes.map(async code => {
    try {
      const { id, subject } = await s.groupGetInviteInfo(code)
      cfg.groups.add(id)
      cfg.log.info({ code, jid: id, subject }, 'resolved invite link; put this jid in GROUP_INVITE_LINKS directly to stop depending on the link')
      await cfg.onResolved?.(code, id)
    } catch (err) {
      cfg.log.warn({ err, code }, 'invite link resolution failed')
    }
  }))
}

export async function resolveOpenJids(
  s: { groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string }>> },
  cfg: { groups: Set<string>; log: Pick<Logger, 'info' | 'warn'> },
): Promise<string[]> {
  try {
    const groups = await s.groupFetchAllParticipating()
    for (const g of Object.values(groups)) cfg.log.info({ jid: g.id, subject: g.subject, mine: cfg.groups.has(g.id) }, 'member of group')
    return [...cfg.groups].filter(jid => groups[jid])
  } catch (err) {
    cfg.log.warn({ err }, 'group discovery failed')
  }
  return [...cfg.groups]
}

export function logJoinedGroup(cfg: { groups: Set<string>; log: Pick<Logger, 'info'> }, jid: string, subject?: string): void {
  cfg.log.info({ jid, subject, mine: cfg.groups.has(jid) }, 'added to a group; put this jid in GROUP_INVITE_LINKS to serve it')
}

export function participantsIncludeSelf(me: string[], participants: { id?: string; phoneNumber?: string; lid?: string }[]): boolean {
  const isMe = (j?: string) => Boolean(j) && me.includes(jidNormalizedUser(j!))
  return participants.some(p => isMe(p.id) || isMe(p.phoneNumber) || isMe(p.lid))
}

export function gate(groups: Set<string>, cfg: Handlers): Handlers {
  const mine = (jid?: string | null): jid is string => jid != null && groups.has(jid)
  return {
    onOpen: jids => cfg.onOpen(jids.filter(mine)),
    onJoined: jid => { if (mine(jid)) cfg.onJoined(jid) },
    onMessage: (jid, m) => { if (mine(jid)) cfg.onMessage(jid, m) },
    onDescription: (jid, desc) => { if (mine(jid)) cfg.onDescription(jid, desc) },
    onRemoved: jid => { if (mine(jid)) cfg.onRemoved(jid) },
  }
}

export function toIncoming(msg: WAMessage, self: string[]): Incoming | null {
  const c = normalizeMessageContent(msg.message)
  if (!c || !msg.key.id || !msg.key.remoteJid) return null
  const key: MsgKey = {
    id: msg.key.id, fromMe: Boolean(msg.key.fromMe), remoteJid: msg.key.remoteJid,
    participant: msg.key.participant ?? undefined,
  }
  const sender = msg.pushName || key.participant || 'alguém'
  const ctx = c.extendedTextMessage?.contextInfo ?? c.imageMessage?.contextInfo ?? c.documentMessage?.contextInfo
  const isSelf = (j?: string | null) => Boolean(j) && self.includes(jidNormalizedUser(j!))
  const mentionsBot = (ctx?.mentionedJid ?? []).some(isSelf)
  const repliesToBot = isSelf(ctx?.participant)
  const raw = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.documentMessage?.caption ?? ''
  const text = raw.replace(/@\d+/g, ' ').replace(/\s+/g, ' ').trim()
  const mediaMime = c.imageMessage ? (c.imageMessage.mimetype || 'image/jpeg') : c.documentMessage?.mimetype ?? undefined
  const isReceipt = Boolean(c.imageMessage) || (Boolean(c.documentMessage) && mediaMime === 'application/pdf')
  const size = Number((c.imageMessage ?? c.documentMessage)?.fileLength ?? 0) // Long or number
  const media = isReceipt && mediaMime
    ? { mime: mediaMime, download: async () => {
        if (size > MAX_RECEIPT) throw new Error('receipt too large')
        return (await downloadMediaMessage(msg, 'buffer', {})) as Buffer
      } }
    : undefined
  return { key, sender, text, media, mentionsBot, repliesToBot }
}

export function wireGroupEvents(
  ev: { on(event: string, handler: (arg: any) => void): void },
  on: Pick<Handlers, 'onJoined' | 'onMessage' | 'onDescription' | 'onRemoved'>,
  self: () => string[],
  cfg: { groups: Set<string>; log: Pick<Logger, 'info'> },
): void {
  ev.on('messages.upsert', ({ messages, type }: { messages: WAMessage[]; type: string }) => {
    if (type !== 'notify') return
    for (const raw of messages) {
      const jid = raw.key.remoteJid
      if (!jid?.endsWith('@g.us')) continue
      if (!cfg.groups.has(jid)) continue
      const m = toIncoming(raw, self())
      if (m) on.onMessage(jid, m)
    }
  })
  ev.on('groups.update', (updates: { id?: string; desc?: string }[]) => {
    // A cleared description arrives with the key present and no text.
    for (const g of updates) if (g.id && 'desc' in g) on.onDescription(g.id, g.desc ?? '')
  })
  ev.on('group-participants.update', async ({ id, participants, action }: { id: string; participants: { id?: string; phoneNumber?: string; lid?: string }[]; action: string }) => {
    const isSelf = participantsIncludeSelf(self(), participants)
    if (action === 'add' && isSelf) {
      logJoinedGroup(cfg, id)
      on.onJoined(id)
    }
    if (action === 'remove' && isSelf) {
      on.onRemoved(id)
    }
  })
  ev.on('groups.upsert', (groups: { id: string; subject?: string }[]) => { for (const g of groups) { logJoinedGroup(cfg, g.id, g.subject); on.onJoined(g.id) } })
}

export async function handleOpen(
  s: {
    groupFetchAllParticipating(): Promise<Record<string, { id: string; subject: string }>>
    groupGetInviteInfo(code: string): Promise<{ id: string; subject: string }>
  },
  cfg: { groups: Set<string>; inviteCodes: string[]; log: Pick<Logger, 'info' | 'warn'>; onResolved?(code: string, jid: string): void | Promise<void> },
  onOpen: (jids: string[]) => void,
): Promise<void> {
  cfg.log.info('whatsapp connected')
  await resolveInviteCodes(s, cfg, cfg.inviteCodes)
  onOpen(await resolveOpenJids(s, cfg))
}

export async function connectWa({ onOpen, onJoined, onMessage, onDescription, onRemoved, ...cfg }: Cfg): Promise<{ forGroup(jid: string): Wa }> {
  // authDir is a bind-mount point: removing it needs write on /app, which this
  // container does not have, and the EACCES took the process down instead of
  // letting it exit cleanly. Emptying it does the same job.
  async function wipeAuth() {
    try {
      for (const name of await readdir(cfg.authDir)) {
        await rm(join(cfg.authDir, name), { recursive: true, force: true })
      }
      const left = await readdir(cfg.authDir)
      if (left.length) throw new Error('still present after wipe: ' + left.join(', '))
    } catch (err) {
      // Exiting on a half-wiped dir reloads the same dead session and loops
      // silently, so say so loudly instead of pretending the wipe worked.
      cfg.log.fatal({ err, authDir: cfg.authDir },
        'could not wipe auth dir — the same logout will repeat until it is emptied by hand')
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(cfg.authDir)
  const on = gate(cfg.groups, { onOpen, onJoined, onMessage, onDescription, onRemoved })
  const sockLog = cfg.log.child({ mod: 'baileys' }, { level: 'warn' })
  let sock = start()

  function start() {
    const s = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, sockLog) },
      logger: sockLog,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })
    const self = () => [s.user?.id, s.user?.lid].filter((j): j is string => Boolean(j)).map(jidNormalizedUser)
    s.ev.on('creds.update', () => { saveCreds().catch(err => cfg.log.error({ err }, 'saving WhatsApp credentials failed')) })
    s.ev.on('connection.update', async u => { try {
      // requestPairingCode only works on an open socket. Asking on a 3s timer
      // raced the 428 close WhatsApp sends to unregistered sockets, and the throw
      // out of that floating timer took the process down on every restart. The qr
      // event is the signal that the socket is up and still unregistered.
      if (u.qr && !state.creds.registered && Date.now() - pairingCodeAt > PAIRING_CODE_TTL_MS) {
        pairingCodeAt = Date.now()
        try {
          const code = await s.requestPairingCode(cfg.phone)
          cfg.log.warn({ code }, 'PAIRING CODE: WhatsApp > Aparelhos conectados > Conectar com número de telefone')
        } catch (err) {
          // Blocking on a failed request is what left the bot unable to ever pair.
          pairingCodeAt = 0
          cfg.log.error({ err }, 'pairing code request failed, retrying on next connection')
        }
      }
      if (u.connection === 'open') {
        await handleOpen(s, cfg, on.onOpen)
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          // Stale credentials would 401 forever; wipe them so the restart pairs from scratch.
          cfg.log.error('logged out: wiping auth, restart pairs again')
          await wipeAuth()
          // Back off before the restart: rapid re-pairing gets the number rate-limited
          // by WhatsApp. This used to read state.creds.registered, which is the copy
          // loaded at startup and still true for a session that was just logged out.
          await new Promise(r => setTimeout(r, 60_000))
          process.exit(2)
        }
        cfg.log.warn({ code }, 'connection closed, reconnecting')
        setTimeout(() => { sock = start() }, 3000)
      }
    } catch (e) { cfg.log.error({ err: e }, 'connection.update handler failed') } })
    wireGroupEvents(s.ev, on, self, cfg)
    return s
  }

  const toKey = (k: MsgKey): WAMessageKey => ({ id: k.id, fromMe: k.fromMe, remoteJid: k.remoteJid, participant: k.participant })

  return {
    forGroup(jid: string): Wa {
      return {
        async sendText(text, quoted) {
          const opts = quoted ? { quoted: { key: toKey(quoted), message: {} } } : {}
          const sent = await sock.sendMessage(jid, { text }, opts)
          return { id: sent!.key.id!, fromMe: true, remoteJid: jid }
        },
        async react(key, emoji) { await sock.sendMessage(jid, { react: { text: emoji, key: toKey(key) } }) },
        async pin(key) { await sock.sendMessage(jid, { pin: toKey(key), type: 1, time: 2592000 }) },
        async unpin(key) { await sock.sendMessage(jid, { pin: toKey(key), type: 2 }) },
        async getDescription() { return (await sock.groupMetadata(jid)).desc ?? '' },
        async setDescription(text) { await sock.groupUpdateDescription(jid, text) },
      }
    },
  }
}
