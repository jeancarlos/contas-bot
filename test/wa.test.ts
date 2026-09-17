import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WAMessage } from '@whiskeysockets/baileys'
import { toIncoming, parseGroupJids, gate, resolveOpenJids, resolveInviteCodes, logJoinedGroup, fetchAndLogJoinedGroup } from '../src/wa.ts'
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
    [...parseGroupJids(' 123-456@g.us , 789 ,, ').jids],
    ['123-456@g.us', '789@g.us'],
  )
  const empty = parseGroupJids('')
  assert.equal(empty.jids.size, 0)
  assert.equal(empty.inviteCodes.length, 0)
})

test('parseGroupJids rejects a jid that is not a group jid, but still normalizes bare digits', () => {
  assert.throws(() => parseGroupJids('123@s.whatsapp.net'), /GROUP_INVITE_LINKS: not a group jid or invite link: 123@s\.whatsapp\.net/)
  assert.deepEqual([...parseGroupJids('456').jids], ['456@g.us'])
})

test('parseGroupJids splits a mixed value into jids and invite codes, and still throws on a junk entry', () => {
  const { jids, inviteCodes } = parseGroupJids('456, mine@g.us, https://chat.whatsapp.com/AbCdEf123')
  assert.deepEqual([...jids], ['456@g.us', 'mine@g.us'])
  assert.deepEqual(inviteCodes, ['AbCdEf123'])
  assert.throws(() => parseGroupJids('not-a-jid'), /GROUP_INVITE_LINKS: not a group jid or invite link: not-a-jid/)
})

test('parseGroupJids extracts the invite code past a trailing slash and a query string', () => {
  assert.deepEqual(parseGroupJids('https://chat.whatsapp.com/AbCdEf123/').inviteCodes, ['AbCdEf123'])
  assert.deepEqual(parseGroupJids('https://chat.whatsapp.com/AbCdEf123?mode=ac_t').inviteCodes, ['AbCdEf123'])
})

test('gate passes through jids on the allowlist and swallows the rest', () => {
  const seen: string[] = []
  const spy = {
    onOpen: (jids: string[]) => { seen.push(`open:${jids.join('|')}`) },
    onJoined: (jid: string) => { seen.push(`joined:${jid}`) },
    onMessage: (jid: string, _m: Incoming) => { seen.push(`msg:${jid}`) },
    onDescription: (jid: string, d: string) => { seen.push(`desc:${jid}:${d}`) },
  }
  const g = gate(parseGroupJids('mine@g.us').jids, spy)
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
  const shut = gate(parseGroupJids('').jids, spy)
  shut.onOpen(['mine@g.us', 'theirs@g.us'])
  shut.onJoined('mine@g.us')
  shut.onMessage('mine@g.us', m)
  shut.onDescription('mine@g.us', 'y')
  assert.deepEqual(seen, ['open:'])
})

test('resolveOpenJids resolves to the configured jids even when group discovery fails', async () => {
  const warnings: unknown[] = []
  const cfg = {
    groups: parseGroupJids('mine@g.us,other@g.us').jids,
    log: { info() {}, warn: (o: unknown) => warnings.push(o) },
  }
  const s = { groupFetchAllParticipating: async () => { throw new Error('socket dropped') } }
  const jids = await resolveOpenJids(s, cfg)
  assert.deepEqual(jids.sort(), ['mine@g.us', 'other@g.us'])
  assert.equal(warnings.length, 1)
})

test('resolveOpenJids narrows to groups the bot is actually a member of when discovery succeeds', async () => {
  const cfg = {
    groups: parseGroupJids('mine@g.us,notjoined@g.us').jids,
    log: { info() {}, warn() {} },
  }
  const s = { groupFetchAllParticipating: async () => ({ 'mine@g.us': { id: 'mine@g.us', subject: 'Mine' } }) }
  const jids = await resolveOpenJids(s, cfg)
  assert.deepEqual(jids, ['mine@g.us'])
})

test('logJoinedGroup logs the jid, subject and allowlist membership (groups.upsert path)', () => {
  const infos: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info: (o: unknown) => infos.push(o) } }
  logJoinedGroup(cfg, 'new@g.us', 'New Group')
  assert.deepEqual(infos, [{ jid: 'new@g.us', subject: 'New Group', mine: false }])
})

test('fetchAndLogJoinedGroup fetches the subject before logging (group-participants.update path)', async () => {
  const infos: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info: (o: unknown) => infos.push(o), warn() {} } }
  const s = { groupMetadata: async () => ({ subject: 'Mine' }) }
  await fetchAndLogJoinedGroup(s, cfg, 'mine@g.us')
  assert.deepEqual(infos, [{ jid: 'mine@g.us', subject: 'Mine', mine: true }])
})

test('fetchAndLogJoinedGroup still logs without a subject when the metadata fetch fails', async () => {
  const infos: unknown[] = []
  const warnings: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info: (o: unknown) => infos.push(o), warn: (o: unknown) => warnings.push(o) } }
  const s = { groupMetadata: async () => { throw new Error('socket dropped') } }
  await fetchAndLogJoinedGroup(s, cfg, 'mine@g.us')
  assert.deepEqual(infos, [{ jid: 'mine@g.us', subject: undefined, mine: true }])
  assert.equal(warnings.length, 1)
})

test('resolveInviteCodes adds the resolved jid to the Set, and the gate then lets it through', async () => {
  const { jids } = parseGroupJids('')
  const cfg = { groups: jids, log: { info() {}, warn() {} } }
  const s = { groupGetInviteInfo: async () => ({ id: 'new@g.us', subject: 'New Group' }) }

  const seen: string[] = []
  const g = gate(jids, { onOpen() {}, onJoined: (jid: string) => { seen.push(jid) }, onMessage() {}, onDescription() {} })
  g.onJoined('new@g.us')
  assert.deepEqual(seen, [])

  await resolveInviteCodes(s, cfg, ['AbCdEf123'])
  assert.deepEqual([...jids], ['new@g.us'])

  g.onJoined('new@g.us')
  assert.deepEqual(seen, ['new@g.us'])
})

test('a rejecting groupGetInviteInfo leaves the Set unchanged, logs a warning, and does not block a second code', async () => {
  const { jids } = parseGroupJids('')
  const infos: unknown[] = []
  const warnings: unknown[] = []
  const cfg = { groups: jids, log: { info: (o: unknown) => infos.push(o), warn: (o: unknown) => warnings.push(o) } }
  const s = {
    groupGetInviteInfo: async (code: string) => {
      if (code === 'bad') throw new Error('invite revoked')
      return { id: 'good@g.us', subject: 'Good Group' }
    },
  }

  await resolveInviteCodes(s, cfg, ['bad', 'good'])

  assert.deepEqual([...jids], ['good@g.us'])
  assert.equal(warnings.length, 1)
  assert.equal(infos.length, 1)
})
