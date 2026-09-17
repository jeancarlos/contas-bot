import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WAMessage } from '@whiskeysockets/baileys'
import { toIncoming, parseGroupJids, gate } from '../src/wa.ts'
import type { Incoming } from '../src/bot.ts'

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

test('parseGroupJids trims, drops empties and adds the @g.us suffix', () => {
  assert.deepEqual(
    [...parseGroupJids(' 123-456@g.us , 789 ,, ')],
    ['123-456@g.us', '789@g.us'],
  )
  assert.equal(parseGroupJids('').size, 0)
})

test('parseGroupJids rejects a jid that is not a group jid, but still normalizes bare digits', () => {
  assert.throws(() => parseGroupJids('123@s.whatsapp.net'), /GROUP_JIDS: not a group jid: 123@s\.whatsapp\.net/)
  assert.deepEqual([...parseGroupJids('456')], ['456@g.us'])
})

test('gate passes through jids on the allowlist and swallows the rest', () => {
  const seen: string[] = []
  const spy = {
    onOpen: (jids: string[]) => { seen.push(`open:${jids.join('|')}`) },
    onJoined: (jid: string) => { seen.push(`joined:${jid}`) },
    onMessage: (jid: string, _m: Incoming) => { seen.push(`msg:${jid}`) },
    onDescription: (jid: string, d: string) => { seen.push(`desc:${jid}:${d}`) },
  }
  const g = gate(parseGroupJids('mine@g.us'), spy)
  const m = { key: { id: 'm1', fromMe: false, remoteJid: 'mine@g.us' }, sender: 'Gabi', text: 'oi' } as Incoming

  g.onOpen(['mine@g.us', 'theirs@g.us'])
  g.onJoined('theirs@g.us')
  g.onJoined('mine@g.us')
  g.onMessage('theirs@g.us', m)
  g.onMessage('mine@g.us', m)
  g.onDescription('theirs@g.us', 'x')
  g.onDescription('mine@g.us', 'y')

  assert.deepEqual(seen, ['open:mine@g.us', 'joined:mine@g.us', 'msg:mine@g.us', 'desc:mine@g.us:y'])
})
