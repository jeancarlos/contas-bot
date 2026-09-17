import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WAMessage } from '@whiskeysockets/baileys'
import { toIncoming, parseGroupJids, gate, resolveOpenJids, resolveInviteCodes, logJoinedGroup, participantsIncludeSelf, wireGroupEvents, handleOpen } from '../src/wa.ts'
import { openState, cachedGroupsForCodes } from '../src/state.ts'
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

test('GROUP_INVITE_LINKS unset or empty yields an empty allowlist without throwing', () => {
  const original = process.env.GROUP_INVITE_LINKS
  try {
    delete process.env.GROUP_INVITE_LINKS
    const unset = parseGroupJids(process.env.GROUP_INVITE_LINKS ?? '')
    assert.equal(unset.jids.size, 0)
    assert.equal(unset.inviteCodes.length, 0)

    process.env.GROUP_INVITE_LINKS = ''
    const empty = parseGroupJids(process.env.GROUP_INVITE_LINKS ?? '')
    assert.equal(empty.jids.size, 0)
    assert.equal(empty.inviteCodes.length, 0)
  } finally {
    if (original === undefined) delete process.env.GROUP_INVITE_LINKS
    else process.env.GROUP_INVITE_LINKS = original
  }
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

test('parseGroupJids matches an uppercase host and suffix case-insensitively, but keeps the invite code case as-is', () => {
  assert.deepEqual(parseGroupJids('https://Chat.WhatsApp.com/AbCd123').inviteCodes, ['AbCd123'])
  assert.deepEqual([...parseGroupJids('120363@G.US').jids], ['120363@G.US'])
})

test('parseGroupJids strips a #fragment and rejects a link with no path segment after the host', () => {
  assert.deepEqual(parseGroupJids('https://chat.whatsapp.com/AbCd123#frag').inviteCodes, ['AbCd123'])
  for (const entry of ['https://chat.whatsapp.com/', 'chat.whatsapp.com']) {
    assert.throws(() => parseGroupJids(entry), new RegExp(`GROUP_INVITE_LINKS: not a group jid or invite link: ${entry.replace(/[.]/g, '\\.')}`))
  }
})

test('gate passes through jids on the allowlist and swallows the rest', () => {
  const seen: string[] = []
  const spy = {
    onOpen: (jids: string[]) => { seen.push(`open:${jids.join('|')}`) },
    onJoined: (jid: string) => { seen.push(`joined:${jid}`) },
    onMessage: (jid: string, _m: Incoming) => { seen.push(`msg:${jid}`) },
    onDescription: (jid: string, d: string) => { seen.push(`desc:${jid}:${d}`) },
    onRemoved: (jid: string) => { seen.push(`removed:${jid}`) },
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
  g.onRemoved('theirs@g.us')
  g.onRemoved('mine@g.us')

  assert.deepEqual(seen, ['open:mine@g.us', 'joined:mine@g.us', 'msg:mine@g.us', 'desc:mine@g.us:y', 'removed:mine@g.us'])

  seen.length = 0
  const shut = gate(parseGroupJids('').jids, spy)
  shut.onOpen(['mine@g.us', 'theirs@g.us'])
  shut.onJoined('mine@g.us')
  shut.onMessage('mine@g.us', m)
  shut.onDescription('mine@g.us', 'y')
  shut.onRemoved('mine@g.us')
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

test('logJoinedGroup logs without a subject when called with just a jid (group-participants.update path)', () => {
  const infos: unknown[] = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info: (o: unknown) => infos.push(o) } }
  logJoinedGroup(cfg, 'mine@g.us')
  assert.deepEqual(infos, [{ jid: 'mine@g.us', subject: undefined, mine: true }])
})

test('resolveInviteCodes adds the resolved jid to the Set, and the gate then lets it through', async () => {
  const { jids } = parseGroupJids('')
  const cfg = { groups: jids, log: { info() {}, warn() {} } }
  const s = { groupGetInviteInfo: async () => ({ id: 'new@g.us', subject: 'New Group' }) }

  const seen: string[] = []
  const g = gate(jids, { onOpen() {}, onJoined: (jid: string) => { seen.push(jid) }, onMessage() {}, onDescription() {}, onRemoved() {} })
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

test('a resolved code persists its jid and is served on the next startup with groupGetInviteInfo never called', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-wa-')), 'state.json')
  const store = await openState(path)
  const { jids } = parseGroupJids('')
  const cfg = {
    groups: jids,
    log: { info() {}, warn() {} },
    onResolved: async (code: string, jid: string) => {
      store.forGroup(jid).get()._meta.invite = code
      await store.forGroup(jid).save()
    },
  }
  const s = { groupGetInviteInfo: async () => ({ id: 'new@g.us', subject: 'New Group' }) }

  await resolveInviteCodes(s, cfg, ['AbCdEf123'])
  assert.deepEqual([...jids], ['new@g.us'])

  const reopened = await openState(path)
  assert.equal(reopened.forGroup('new@g.us').get()._meta.invite, 'AbCdEf123')

  const cached = cachedGroupsForCodes(reopened, ['AbCdEf123'])
  assert.deepEqual(cached, { jids: ['new@g.us'], toResolve: [] })

  const nextJids = new Set(cached.jids)
  let calls = 0
  const s2 = { groupGetInviteInfo: async () => { calls++; throw new Error('must not be called') } }
  await resolveInviteCodes(s2, { groups: nextJids, log: { info() {}, warn() {} } }, cached.toResolve)

  assert.equal(calls, 0)
  assert.deepEqual([...nextJids], ['new@g.us'])
})

test('a cached group survives a rejecting groupGetInviteInfo and stays in the allowlist, with the warning logged', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-wa-')), 'state.json')
  const store = await openState(path)
  store.forGroup('good@g.us').get()._meta.invite = 'good-code'
  await store.forGroup('good@g.us').save()

  const cached = cachedGroupsForCodes(store, ['good-code', 'bad-code'])
  assert.deepEqual(cached, { jids: ['good@g.us'], toResolve: ['bad-code'] })

  const { jids } = parseGroupJids('')
  for (const jid of cached.jids) jids.add(jid)
  const warnings: unknown[] = []
  const cfg = { groups: jids, log: { info() {}, warn: (o: unknown) => warnings.push(o) } }
  const s = { groupGetInviteInfo: async () => { throw new Error('invite revoked') } }

  await resolveInviteCodes(s, cfg, cached.toResolve)

  assert.deepEqual([...jids], ['good@g.us'])
  assert.equal(warnings.length, 1)
})

test('removing the code from the configuration drops the cached group from the allowlist', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-wa-')), 'state.json')
  const store = await openState(path)
  store.forGroup('a@g.us').get()._meta.invite = 'code-a'
  await store.forGroup('a@g.us').save()

  assert.deepEqual(cachedGroupsForCodes(store, ['code-a']), { jids: ['a@g.us'], toResolve: [] })
  assert.deepEqual(cachedGroupsForCodes(store, []), { jids: [], toResolve: [] })
})

test('a configured code with no cache entry still resolves over the network and gets persisted', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-wa-')), 'state.json')
  const store = await openState(path)

  const cached = cachedGroupsForCodes(store, ['fresh-code'])
  assert.deepEqual(cached, { jids: [], toResolve: ['fresh-code'] })

  const { jids } = parseGroupJids('')
  let calls = 0
  const s = { groupGetInviteInfo: async () => { calls++; return { id: 'fresh@g.us', subject: 'Fresh Group' } } }
  const cfg = {
    groups: jids,
    log: { info() {}, warn() {} },
    onResolved: async (code: string, jid: string) => {
      store.forGroup(jid).get()._meta.invite = code
      await store.forGroup(jid).save()
    },
  }

  await resolveInviteCodes(s, cfg, cached.toResolve)

  assert.equal(calls, 1)
  assert.deepEqual([...jids], ['fresh@g.us'])
  const reopened = await openState(path)
  assert.equal(reopened.forGroup('fresh@g.us').get()._meta.invite, 'fresh-code')
})

test('participantsIncludeSelf is true when the bot is among the participants, by id, phoneNumber or lid', () => {
  const me = ['bot@s.whatsapp.net', 'bot@lid']
  assert.equal(participantsIncludeSelf(me, [{ id: 'bot@s.whatsapp.net' }]), true)
  assert.equal(participantsIncludeSelf(me, [{ phoneNumber: 'bot@s.whatsapp.net' }]), true)
  assert.equal(participantsIncludeSelf(me, [{ lid: 'bot@lid' }]), true)
})

test('participantsIncludeSelf is false when the participants are somebody else', () => {
  const me = ['bot@s.whatsapp.net', 'bot@lid']
  assert.equal(participantsIncludeSelf(me, [{ id: 'gabi@s.whatsapp.net' }]), false)
  assert.equal(participantsIncludeSelf(me, []), false)
})

test('a remove event naming the bot fires onRemoved through gate only for an allowlisted group', () => {
  const seen: string[] = []
  const g = gate(parseGroupJids('mine@g.us').jids, {
    onOpen() {}, onJoined() {}, onMessage() {}, onDescription() {},
    onRemoved: (jid: string) => { seen.push(jid) },
  })
  const me = ['bot@s.whatsapp.net']
  const removedByBot = [{ id: 'bot@s.whatsapp.net' }]

  if (participantsIncludeSelf(me, removedByBot)) g.onRemoved('mine@g.us')
  if (participantsIncludeSelf(me, removedByBot)) g.onRemoved('theirs@g.us')

  assert.deepEqual(seen, ['mine@g.us'])
})

test('a remove event naming somebody else never reaches onRemoved', () => {
  const seen: string[] = []
  const g = gate(parseGroupJids('mine@g.us').jids, {
    onOpen() {}, onJoined() {}, onMessage() {}, onDescription() {},
    onRemoved: (jid: string) => { seen.push(jid) },
  })
  const me = ['bot@s.whatsapp.net']
  const removedByGabi = [{ id: 'gabi@s.whatsapp.net' }]

  if (participantsIncludeSelf(me, removedByGabi)) g.onRemoved('mine@g.us')

  assert.deepEqual(seen, [])
})

test('removal drops the jid from the allowlist, clears _meta.invite on disk, and leaves months and bills untouched', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'contas-wa-')), 'state.json')
  const store = await openState(path)
  store.forGroup('mine@g.us').get()._meta.invite = 'AbCdEf123'
  store.forGroup('mine@g.us').get()._meta.bills = ['luz']
  store.forGroup('mine@g.us').get().months['2026-09'] = { luz: { name: 'Luz' } } as any
  await store.forGroup('mine@g.us').save()

  const { jids: groupJids } = parseGroupJids('mine@g.us')
  const onRemoved = async (jid: string) => {
    groupJids.delete(jid)
    delete store.forGroup(jid).get()._meta.invite
    await store.forGroup(jid).save()
  }

  await onRemoved('mine@g.us')

  assert.equal(groupJids.has('mine@g.us'), false)

  const seen: string[] = []
  const gated = gate(groupJids, { onOpen() {}, onJoined() {}, onMessage: (jid: string) => { seen.push(jid) }, onDescription() {}, onRemoved() {} })
  gated.onMessage('mine@g.us', {} as Incoming)
  assert.deepEqual(seen, [])

  const reopened = await openState(path)
  const g2 = reopened.forGroup('mine@g.us').get()
  assert.equal(g2._meta.invite, undefined)
  assert.deepEqual(g2._meta.bills, ['luz'])
  assert.deepEqual(g2.months, { '2026-09': { luz: { name: 'Luz' } } })
})

function fakeEmitter() {
  const handlers = new Map<string, (arg: any) => void>()
  return {
    on: (event: string, handler: (arg: any) => void) => { handlers.set(event, handler) },
    fire: (event: string, arg: any) => handlers.get(event)!(arg),
  }
}

test('wireGroupEvents: messages.upsert reaches onMessage for a notify message in a served group; not for another type, an unserved group, or a non-group jid; still delivers a fromMe message unchanged', () => {
  const ev = fakeEmitter()
  const seen: Array<{ jid: string; fromMe: boolean }> = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info() {} } }
  const on = { onJoined() {}, onMessage: (jid: string, m: Incoming) => { seen.push({ jid, fromMe: m.key.fromMe }) }, onDescription() {}, onRemoved() {} }
  wireGroupEvents(ev, on, () => [], cfg)

  const wam = (remoteJid: string, fromMe = false): WAMessage => ({ key: { id: 'm1', remoteJid, fromMe }, message: { conversation: 'oi' } } as WAMessage)

  ev.fire('messages.upsert', { messages: [wam('mine@g.us')], type: 'append' })
  ev.fire('messages.upsert', { messages: [wam('theirs@g.us')], type: 'notify' })
  ev.fire('messages.upsert', { messages: [wam('mine@s.whatsapp.net')], type: 'notify' })
  assert.deepEqual(seen, [])

  ev.fire('messages.upsert', { messages: [wam('mine@g.us', true)], type: 'notify' })
  assert.deepEqual(seen, [{ jid: 'mine@g.us', fromMe: true }])
})

test('wireGroupEvents: groups.update reaches onDescription when desc is present, including cleared to empty, and not when the key is absent', () => {
  const ev = fakeEmitter()
  const seen: Array<{ jid: string; desc: string }> = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info() {} } }
  const on = { onJoined() {}, onMessage() {}, onDescription: (jid: string, desc: string) => { seen.push({ jid, desc }) }, onRemoved() {} }
  wireGroupEvents(ev, on, () => [], cfg)

  ev.fire('groups.update', [{ id: 'mine@g.us' }])
  assert.deepEqual(seen, [])

  ev.fire('groups.update', [{ id: 'mine@g.us', desc: 'new description' }])
  ev.fire('groups.update', [{ id: 'mine@g.us', desc: '' }])
  assert.deepEqual(seen, [{ jid: 'mine@g.us', desc: 'new description' }, { jid: 'mine@g.us', desc: '' }])
})

test('wireGroupEvents: group-participants.update reaches onJoined on add-self and onRemoved on remove-self, but not for somebody else or for promote/demote/modify', () => {
  const ev = fakeEmitter()
  const joined: string[] = []
  const removed: string[] = []
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info() {} } }
  const on = { onJoined: (jid: string) => { joined.push(jid) }, onMessage() {}, onDescription() {}, onRemoved: (jid: string) => { removed.push(jid) } }
  const me = ['bot@s.whatsapp.net']
  wireGroupEvents(ev, on, () => me, cfg)

  ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'gabi@s.whatsapp.net' }], action: 'add' })
  ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'gabi@s.whatsapp.net' }], action: 'remove' })
  for (const action of ['promote', 'demote', 'modify']) {
    ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'bot@s.whatsapp.net' }], action })
  }
  assert.deepEqual(joined, [])
  assert.deepEqual(removed, [])

  ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'bot@s.whatsapp.net' }], action: 'add' })
  assert.deepEqual(joined, ['mine@g.us'])

  ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'bot@s.whatsapp.net' }], action: 'remove' })
  assert.deepEqual(removed, ['mine@g.us'])
})

test('wireGroupEvents: groups.upsert reaches onJoined for each group and logs the jid', () => {
  const ev = fakeEmitter()
  const joined: string[] = []
  const infos: unknown[] = []
  const cfg = { groups: parseGroupJids('b@g.us').jids, log: { info: (o: unknown) => infos.push(o) } }
  const on = { onJoined: (jid: string) => { joined.push(jid) }, onMessage() {}, onDescription() {}, onRemoved() {} }
  wireGroupEvents(ev, on, () => [], cfg)

  ev.fire('groups.upsert', [{ id: 'a@g.us', subject: 'A' }, { id: 'b@g.us', subject: 'B' }])

  assert.deepEqual(joined, ['a@g.us', 'b@g.us'])
  assert.deepEqual(infos, [
    { jid: 'a@g.us', subject: 'A', mine: false },
    { jid: 'b@g.us', subject: 'B', mine: true },
  ])
})

test('handleOpen logs every fetched group, resolves invite codes, and calls onOpen', async () => {
  const infos: unknown[] = []
  const resolved: string[] = []
  const opened: string[][] = []
  const cfg = {
    groups: parseGroupJids('mine@g.us').jids,
    inviteCodes: ['AbCdEf123'],
    log: { info: (o: unknown) => infos.push(o), warn() {} },
  }
  const s = {
    groupFetchAllParticipating: async () => ({
      'mine@g.us': { id: 'mine@g.us', subject: 'Mine' },
      'new@g.us': { id: 'new@g.us', subject: 'New' },
    }),
    groupGetInviteInfo: async (code: string) => { resolved.push(code); return { id: 'new@g.us', subject: 'New Group' } },
  }

  await handleOpen(s, cfg, jids => { opened.push(jids) })

  assert.equal(infos[0], 'whatsapp connected')
  assert.deepEqual(resolved, ['AbCdEf123'])
  assert.deepEqual([...cfg.groups], ['mine@g.us', 'new@g.us'])
  assert.deepEqual(opened, [['mine@g.us', 'new@g.us']])
  const groupLogs = infos.filter((o: any) => o && typeof o === 'object' && 'mine' in o)
  assert.deepEqual(groupLogs, [
    { jid: 'mine@g.us', subject: 'Mine', mine: true },
    { jid: 'new@g.us', subject: 'New', mine: true },
  ])
})

test('handleOpen still calls onOpen when groupFetchAllParticipating rejects', async () => {
  const warnings: unknown[] = []
  const cfg = {
    groups: parseGroupJids('mine@g.us').jids,
    inviteCodes: [] as string[],
    log: { info() {}, warn: (o: unknown) => warnings.push(o) },
  }
  const s = {
    groupFetchAllParticipating: async () => { throw new Error('socket dropped') },
    groupGetInviteInfo: async () => { throw new Error('must not be called') },
  }
  const opened: string[][] = []

  await handleOpen(s, cfg, jids => { opened.push(jids) })

  assert.deepEqual(opened, [['mine@g.us']])
  assert.equal(warnings.length, 1)
})
