import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import QRCode from 'qrcode'
import type { Pairing } from './core.ts'

export const renderQr = (text: string): Promise<string> => QRCode.toString(text, { type: 'terminal', small: true })

export function closeOutcome(done: boolean, code: number | undefined): 'ignore' | 'restart' | 'failed' {
  if (done) return 'ignore'
  return code === DisconnectReason.restartRequired ? 'restart' : 'failed'
}

export function nextStep(done: boolean, restarted: boolean, code: number | undefined): 'ignore' | 'restart' | 'failed' {
  const out = closeOutcome(done, code)
  return out === 'restart' && restarted ? 'failed' : out
}

export async function emptyDir(dir: string): Promise<void> {
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true })
}

export async function pair(
  authDir: string,
  mode: Pairing,
  phone: string,
  on: { qr(ascii: string): void; code(code: string): void },
): Promise<boolean> {
  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const logger = pino({ level: 'silent' })
  return new Promise(resolve => {
    let done = false
    let asked = false
    let restarted = false
    const start = () => {
      const s = makeWASocket({ auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false })
      const stop = (): void => {
        s.end(undefined).catch(() => {})
      }
      s.ev.on('creds.update', () => {
        saveCreds().catch(() => {})
      })
      s.ev.on('connection.update', u => {
        if (u.qr && mode === 'qr') renderQr(u.qr).then(on.qr, () => {})
        if (u.qr && mode === 'code' && !asked) {
          asked = true
          s.requestPairingCode(phone).then(on.code, stop)
        }
        if (u.connection === 'open') {
          done = true
          saveCreds().then(
            () => {
              stop()
              resolve(true)
            },
            () => {
              stop()
              resolve(false)
            },
          )
        }
        if (u.connection === 'close') {
          const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
          const next = nextStep(done, restarted, code)
          if (next === 'restart') {
            restarted = true
            start()
          }
          if (next === 'failed') emptyDir(authDir).then(() => resolve(false), () => resolve(false))
        }
      })
    }
    start()
  })
}
