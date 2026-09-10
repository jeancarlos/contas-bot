import makeWASocket, {
  DisconnectReason, downloadMediaMessage, useMultiFileAuthState, makeCacheableSignalKeyStore,
  type WAMessage, type WAMessageKey, normalizeMessageContent,
} from '@whiskeysockets/baileys'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import type { Incoming, MsgKey, Wa } from './bot.ts'

type Cfg = {
  authDir: string
  groupJid: string
  phone: string
  log: Logger
  onMessage(m: Incoming): void
  onDescription(desc: string): void
}

let pairingCodeRequested = false

function toIncoming(msg: WAMessage): Incoming | null {
  const c = normalizeMessageContent(msg.message)
  if (!c || !msg.key.id || !msg.key.remoteJid) return null
  const key: MsgKey = {
    id: msg.key.id, fromMe: Boolean(msg.key.fromMe), remoteJid: msg.key.remoteJid,
    participant: msg.key.participant ?? undefined,
  }
  const sender = msg.pushName || key.participant || 'alguém'
  const text = c.conversation ?? c.extendedTextMessage?.text ?? c.imageMessage?.caption ?? c.documentMessage?.caption ?? ''
  const mediaMime = c.imageMessage?.mimetype ?? c.documentMessage?.mimetype ?? undefined
  const isReceipt = Boolean(c.imageMessage) || (Boolean(c.documentMessage) && mediaMime === 'application/pdf')
  const media = isReceipt && mediaMime
    ? { mime: mediaMime, download: async () => (await downloadMediaMessage(msg, 'buffer', {})) as Buffer }
    : undefined
  return { key, sender, text, media }
}

export async function connectWa(cfg: Cfg): Promise<Wa> {
  // authDir is a bind-mount point: removing it needs write on /app, which this
  // container does not have, and the EACCES took the process down instead of
  // letting it exit cleanly. Emptying it does the same job.
  async function wipeAuth() {
    try {
      for (const name of await readdir(cfg.authDir)) {
        await rm(join(cfg.authDir, name), { recursive: true, force: true })
      }
    } catch (err) {
      cfg.log.error({ err }, 'could not wipe auth dir; delete its contents by hand')
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
    s.ev.on('creds.update', saveCreds)
    s.ev.on('connection.update', async u => { try {
      // requestPairingCode only works on an open socket. Asking on a 3s timer
      // raced the 428 close WhatsApp sends to unregistered sockets, and the throw
      // out of that floating timer took the process down on every restart. The qr
      // event is the signal that the socket is up and still unregistered.
      if (u.qr && !state.creds.registered && !pairingCodeRequested) {
        pairingCodeRequested = true
        try {
          const code = await s.requestPairingCode(cfg.phone)
          cfg.log.warn({ code }, 'PAIRING CODE: WhatsApp > Aparelhos conectados > Conectar com número de telefone')
        } catch (err) {
          // Latching on a failed request is what left the bot unable to ever pair.
          pairingCodeRequested = false
          cfg.log.error({ err }, 'pairing code request failed, retrying on next connection')
        }
      }
      if (u.connection === 'open') {
        cfg.log.info('whatsapp connected')
        const groups = await s.groupFetchAllParticipating()
        for (const g of Object.values(groups)) cfg.log.info({ jid: g.id, subject: g.subject }, 'member of group')
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode
        if (code === DisconnectReason.loggedOut) {
          // Stale credentials would 401 forever; wipe them so the restart pairs from scratch.
          cfg.log.error('logged out: wiping auth, restart pairs again')
          await wipeAuth()
          // Back off before the restart: rapid re-pairing gets the number rate-limited by WhatsApp.
          if (!state.creds.registered) await new Promise(r => setTimeout(r, 60_000))
          process.exit(2)
        }
        cfg.log.warn({ code }, 'connection closed, reconnecting')
        setTimeout(() => { sock = start() }, 3000)
      }
    } catch (e) { cfg.log.error({ err: e }, 'connection.update handler failed') } })
    s.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return
      for (const raw of messages) {
        if (raw.key.remoteJid !== cfg.groupJid) continue
        const m = toIncoming(raw)
        if (m) cfg.onMessage(m)
      }
    })
    s.ev.on('groups.update', updates => {
      for (const g of updates) if (g.id === cfg.groupJid && typeof g.desc === 'string') cfg.onDescription(g.desc)
    })
    return s
  }

  const toKey = (k: MsgKey): WAMessageKey => ({ id: k.id, fromMe: k.fromMe, remoteJid: k.remoteJid, participant: k.participant })

  return {
    async sendText(text, quoted) {
      const opts = quoted ? { quoted: { key: toKey(quoted), message: {} } } : {}
      const sent = await sock.sendMessage(cfg.groupJid, { text }, opts)
      return { id: sent!.key.id!, fromMe: true, remoteJid: cfg.groupJid }
    },
    async react(key, emoji) {
      await sock.sendMessage(cfg.groupJid, { react: { text: emoji, key: toKey(key) } })
    },
    async pin(key) {
      await sock.sendMessage(cfg.groupJid, { pin: toKey(key), type: 1, time: 2592000 })
    },
    async unpin(key) {
      await sock.sendMessage(cfg.groupJid, { pin: toKey(key), type: 2 })
    },
    async getDescription() {
      const meta = await sock.groupMetadata(cfg.groupJid)
      return meta.desc ?? ''
    },
  }
}
