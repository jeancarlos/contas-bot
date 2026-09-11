import makeWASocket, {
  DisconnectReason, downloadMediaMessage, useMultiFileAuthState, makeCacheableSignalKeyStore,
  jidNormalizedUser, jidDecode, isLidUser,
  type WAMessage, type WAMessageKey, normalizeMessageContent,
} from '@whiskeysockets/baileys'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import type { Incoming, MsgKey, Wa } from './bot.ts'

type Cfg = {
  authDir: string
  phone: string
  log: Logger
  onOpen(jids: string[]): void
  onJoined(jid: string): void
  onMessage(jid: string, m: Incoming): void
  onDescription(jid: string, desc: string): void
}

// WhatsApp expires a pairing code in a couple of minutes and rate-limits
// repeat requests. A boolean latch was never cleared on reconnect, so the
// bot sat on a dead code forever; a timestamp both throttles and expires.
const PAIRING_CODE_TTL_MS = 180_000
let pairingCodeAt = 0
// Receipts are buffered whole in memory; anything bigger is not a receipt.
const MAX_RECEIPT = 16 * 1024 * 1024

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

export async function connectWa(cfg: Cfg): Promise<{ forGroup(jid: string): Wa }> {
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
        cfg.log.info('whatsapp connected')
        const groups = await s.groupFetchAllParticipating()
        for (const g of Object.values(groups)) cfg.log.info({ jid: g.id, subject: g.subject }, 'member of group')
        cfg.onOpen(Object.keys(groups))
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
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const raw of messages) {
        const jid = raw.key.remoteJid
        if (!jid?.endsWith('@g.us')) continue
        const m = toIncoming(raw, self())
        if (m) cfg.onMessage(jid, m)
      }
    })
    s.ev.on('groups.update', updates => {
      // A cleared description arrives with the key present and no text.
      for (const g of updates) if (g.id && 'desc' in g) cfg.onDescription(g.id, g.desc ?? '')
    })
    s.ev.on('group-participants.update', ({ id, participants, action }) => {
      const me = self()
      const isMe = (j?: string) => Boolean(j) && me.includes(jidNormalizedUser(j!))
      if (action === 'add' && participants.some(p => isMe(p.id) || isMe(p.phoneNumber) || isMe(p.lid))) cfg.onJoined(id)
    })
    s.ev.on('groups.upsert', groups => { for (const g of groups) cfg.onJoined(g.id) })
    return s
  }

  const toKey = (k: MsgKey): WAMessageKey => ({ id: k.id, fromMe: k.fromMe, remoteJid: k.remoteJid, participant: k.participant })

  const phoneOf = async (p: { id: string; phoneNumber?: string }): Promise<string | null> => {
    const pn = p.phoneNumber ?? (p.id.endsWith('@s.whatsapp.net') ? p.id : null)
      ?? (isLidUser(p.id) ? await sock.signalRepository.lidMapping.getPNForLID(p.id) : null)
    return pn ? jidDecode(pn)?.user ?? null : null
  }

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
        async leave() { await sock.groupLeave(jid) },
        // null for a member whose phone is unknown: the owner check must never leave a group on a guess.
        async memberPhones() {
          const me = [sock.user?.id, sock.user?.lid].filter((j): j is string => Boolean(j)).map(jidNormalizedUser)
          const others = (await sock.groupMetadata(jid)).participants.filter(p => !me.includes(jidNormalizedUser(p.id)))
          return Promise.all(others.map(phoneOf))
        },
      }
    },
  }
}
