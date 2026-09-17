import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WAMessage } from '@whiskeysockets/baileys'
import { toIncoming, parseGroupJids, gate, resolveOpenJids, logJoinedGroup, fetchAndLogJoinedGroup } from '../src/wa.ts'
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

  seen.length = 0
  const shut = gate(parseGroupJids(''), spy)
  shut.onOpen(['mine@g.us', 'theirs@g.us'])
  shut.onJoined('mine@g.us')
  shut.onMessage('mine@g.us', m)
  shut.onDescription('mine@g.us', 'y')
  assert.deepEqual(seen, ['open:'])
})

test('resolveOpenJids resolves to the configured jids even when group discovery fails', async () => {
  const warnings: unknown[] = []
  const cfg = {
    groups: parseGroupJids('mine@g.us,other@g.us'),
    log: { info() {}, warn: (o: unknown) => warnings.push(o) },
  }
  const s = { groupFetchAllParticipating: async () => { throw new Error('socket dropped') } }
  const jids = await resolveOpenJids(s, cfg)
  assert.deepEqual(jids.sort(), ['mine@g.us', 'other@g.us'])
  assert.equal(warnings.length, 1)
})

test('resolveOpenJids narrows to groups the bot is actually a member of when discovery succeeds', async () => {
  const cfg = {
    groups: parseGroupJids('mine@g.us,notjoined@g.us'),
    log: { info() {}, warn() {} },
  }
  const s = { groupFetchAllParticipating: async () => ({ 'mine@g.us': { id: 'mine@g.us', subject: 'Mine' } }) }
  const jids = await resolveOpenJids(s, cfg)
  assert.deepEqual(jids, ['mine@g.us'])
})

test('logJoinedGroup logs the jid, subject and allowlist membership (groups.upsert path)', () => {
  const infos: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us'), log: { info: (o: unknown) => infos.push(o) } }
  logJoinedGroup(cfg, 'new@g.us', 'New Group')
  assert.deepEqual(infos, [{ jid: 'new@g.us', subject: 'New Group', mine: false }])
})

test('fetchAndLogJoinedGroup fetches the subject before logging (group-participants.update path)', async () => {
  const infos: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us'), log: { info: (o: unknown) => infos.push(o), warn() {} } }
  const s = { groupMetadata: async () => ({ subject: 'Mine' }) }
  await fetchAndLogJoinedGroup(s, cfg, 'mine@g.us')
  assert.deepEqual(infos, [{ jid: 'mine@g.us', subject: 'Mine', mine: true }])
})

test('fetchAndLogJoinedGroup still logs without a subject when the metadata fetch fails', async () => {
  const infos: unknown[] = []
  const warnings: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us'), log: { info: (o: unknown) => infos.push(o), warn: (o: unknown) => warnings.push(o) } }
  const s = { groupMetadata: async () => { throw new Error('socket dropped') } }
  await fetchAndLogJoinedGroup(s, cfg, 'mine@g.us')
  assert.deepEqual(infos, [{ jid: 'mine@g.us', subject: undefined, mine: true }])
  assert.equal(warnings.length, 1)
})
