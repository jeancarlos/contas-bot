import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WAMessage } from '@whiskeysockets/baileys'
import { toIncoming } from '../src/wa.ts'

test('a receipt over 16 MB is refused before it is downloaded', async () => {
  const big = 16 * 1024 * 1024 + 1
  for (const message of [
    { imageMessage: { mimetype: 'image/jpeg', fileLength: big } },
    { documentMessage: { mimetype: 'application/pdf', fileLength: big } },
  ]) {
    const m = toIncoming({ key: { id: 'm1', remoteJid: '123@g.us' }, message } as WAMessage, [])
    await assert.rejects(m!.media!.download(), /receipt too large/)
  }
})
