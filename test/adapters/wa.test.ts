import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import type { downloadMediaMessage, proto, WAMessage, WAMessageUpdate } from '@whiskeysockets/baileys'
import { getUrlFromDirectPath } from '@whiskeysockets/baileys'
import pino from 'pino'
import {
  download,
  gate,
  handleOpen,
  logJoinedGroup,
  pairingAction,
  parseGroupJids,
  participantsIncludeSelf,
  type Messages,
  type Recent,
  resolveInviteCodes,
  reportStatus,
  resolveOpenJids,
  toEdit,
  toMessage,
  wireGroupEvents,
} from '../../src/adapters/wa.ts'
import { type Ctx, decide } from '../../src/core/decide.ts'
import { normalize } from '../../src/core/text.ts'
import { type EditInput, emptyState, type GroupState, type MessageInput } from '../../src/core/types.ts'

const G = 'grupo@g.us'
const P = 'membro@s.whatsapp.net'
const TS = 1791000000
const must = <T>(v: T | null | undefined): T => {
  assert.ok(v != null)
  return v
}
const wam = (id: string, message: proto.IMessage, extra: Partial<WAMessage> = {}): WAMessage => ({
  key: { id, remoteJid: G, fromMe: false, participant: P },
  message,
  pushName: 'Ana',
  messageTimestamp: TS,
  ...extra,
})
const silent = pino({ level: 'silent' })
const ctx = { reuploadRequest: async (x: WAMessage) => x, logger: silent }
const noop = {
  onJoined() {},
  onInput() {},
  onRemoved() {},
}

function fakeEmitter() {
  const handlers = new Map<string, (arg: unknown) => void>()
  return {
    on: (event: string, handler: (arg: unknown) => void) => {
      handlers.set(event, handler)
    },
    fire: (event: string, arg: unknown) => must(handlers.get(event))(arg),
  }
}

function wired(groups = 'grupo@g.us') {
  const ev = fakeEmitter()
  const seen: (MessageInput | EditInput)[] = []
  const recent: Recent = new Map()
  const msgs: Messages = new Map()
  const on = { ...noop, onInput: (_jid: string, input: MessageInput | EditInput) => seen.push(input) }
  wireGroupEvents(ev, on, () => [], { groups: parseGroupJids(groups).jids, log: { info() {} }, recent, msgs })
  return { ev, seen, msgs }
}

test('a receipt over 16 MB is refused before it is downloaded', async () => {
  const big = 16 * 1024 * 1024 + 1
  for (const message of [
    { imageMessage: { mimetype: 'image/jpeg', fileLength: big } },
    { documentMessage: { mimetype: 'application/pdf', fileLength: big } },
  ]) {
    const msgs: Messages = new Map()
    const m = must(toMessage(wam('m1', message), msgs))
    const dl = (async () => Buffer.from('never')) as unknown as typeof downloadMediaMessage
    await assert.rejects(
      download(must(m.media), msgs, { reuploadRequest: async x => x, logger: silent }, dl),
      /too large/,
    )
  }
})

test('an offline append batch becomes message inputs with the WhatsApp timestamp in milliseconds', () => {
  const { ev, seen } = wired()
  ev.fire('messages.upsert', {
    type: 'append',
    messages: [
      wam('a1', { conversation: '/pago luz' }),
      wam('a2', { extendedTextMessage: { text: '/pago   água  80' } }, { messageTimestamp: TS + 60 }),
    ],
  })
  assert.deepEqual(
    seen.map(i => [i.kind, i.key.id, i.text, i.at, i.sender]),
    [
      ['message', 'a1', '/pago luz', TS * 1000, 'Ana'],
      ['message', 'a2', '/pago água 80', (TS + 60) * 1000, 'Ana'],
    ],
  )
})

test('an edit arrives from messages.update with the original id and media; its own upsert is not a message', () => {
  const { ev, seen } = wired()
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: [wam('r1', { imageMessage: { mimetype: 'image/jpeg', caption: '/pago lux', fileLength: 1000 } })],
  })
  const protocol = {
    editedMessage: {
      message: {
        protocolMessage: { type: 14, key: { id: 'r1' }, editedMessage: { imageMessage: { caption: '/pago luz' } } },
      },
    },
  }
  ev.fire('messages.upsert', { type: 'notify', messages: [wam('e1', protocol, { pushName: 'Ana' })] })
  ev.fire('messages.update', [
    { key: { remoteJid: G, id: 'r1', fromMe: false, participant: P }, update: { status: 4 } },
    {
      key: { remoteJid: G, id: 'r1', fromMe: false, participant: P },
      update: {
        message: { editedMessage: { message: { imageMessage: { caption: '/pago luz' } } } },
        messageTimestamp: TS + 100,
      },
    },
  ])
  assert.deepEqual(
    seen.map(i => [i.kind, i.key.id, i.text]),
    [
      ['message', 'r1', '/pago lux'],
      ['edit', 'r1', '/pago luz'],
    ],
  )
  const edit = must(seen[1])
  assert.equal(edit.at, (TS + 100) * 1000)
  assert.equal(edit.sender, 'Ana')
  assert.equal(edit.media?.mime, 'image/jpeg')
})

test('a reply quoting an image carries the quoted receipt, downloaded with a re-upload request', async () => {
  const quoted = { imageMessage: { mimetype: 'image/jpeg', fileLength: 1000, url: 'https://mmg.whatsapp.net/x' } }
  const reply = wam('q1', {
    extendedTextMessage: {
      text: '/pago luz',
      contextInfo: { stanzaId: 'r9', participant: 'outro@s.whatsapp.net', quotedMessage: quoted },
    },
  })
  const msgs: Messages = new Map()
  const m = must(toMessage(reply, msgs))
  assert.equal(m.media, undefined)
  assert.equal(m.quoted?.mime, 'image/jpeg')
  const reuploadRequest = async (x: WAMessage) => x
  const got: { key: unknown; reupload: unknown }[] = []
  const dl = (async (msg: WAMessage, _type: string, _o: unknown, ctx?: { reuploadRequest: unknown }) => {
    got.push({ key: msg.key, reupload: typeof ctx?.reuploadRequest })
    return Readable.from([Buffer.from('img')])
  }) as unknown as typeof downloadMediaMessage
  assert.equal((await download(must(m.quoted), msgs, { reuploadRequest, logger: silent }, dl)).toString(), 'img')
  assert.deepEqual(got, [
    {
      key: { remoteJid: G, id: 'r9', participant: 'outro@s.whatsapp.net', fromMe: false },
      reupload: 'function',
    },
  ])
})

test('a captioned PDF is a receipt, any other document is not', () => {
  const pdf = must(
    toMessage(
      wam('d1', {
        documentWithCaptionMessage: {
          message: { documentMessage: { mimetype: 'application/pdf', caption: '/pago luz', fileLength: 2000 } },
        },
      }),
      new Map(),
    ),
  )
  assert.equal(pdf.text, '/pago luz')
  assert.equal(pdf.media?.mime, 'application/pdf')
  const zip = must(
    toMessage(wam('d2', { documentMessage: { mimetype: 'application/zip', caption: '/pago luz' } }), new Map()),
  )
  assert.equal(zip.text, '/pago luz')
  assert.equal(zip.media, undefined)
})

test('a forwarded image with a /pago caption is a receipt like any other', () => {
  const fwd = must(
    toMessage(
      wam('f1', {
        imageMessage: {
          mimetype: 'image/jpeg',
          caption: '/pago luz',
          fileLength: 3000,
          contextInfo: { isForwarded: true, forwardingScore: 1 },
        },
      }),
      new Map(),
    ),
  )
  assert.equal(fwd.text, '/pago luz')
  assert.equal(fwd.media?.mime, 'image/jpeg')
  assert.equal(fwd.quoted, undefined)
})

test('edits only remember the media of the newest 500 messages', () => {
  const { ev, seen } = wired()
  const image = { imageMessage: { mimetype: 'image/jpeg', caption: 'foto', fileLength: 10 } }
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: Array.from({ length: 501 }, (_, i) => wam(`m${i}`, image)),
  })
  const edit = (id: string) => ({
    key: { remoteJid: G, id, fromMe: false, participant: P },
    update: { message: { editedMessage: { message: { conversation: '/pago luz' } } } },
  })
  ev.fire('messages.update', [edit('m0'), edit('m500')])
  const edits = seen.filter(i => i.kind === 'edit')
  assert.deepEqual(
    edits.map(e => [e.key.id, e.media?.mime, e.sender]),
    [
      ['m0', undefined, P],
      ['m500', 'image/jpeg', 'Ana'],
    ],
  )
})

test('parseGroupJids trims, drops empties and adds the @g.us suffix', () => {
  assert.deepEqual([...parseGroupJids(' 123-456@g.us , 789 ,, ').jids], ['123-456@g.us', '789@g.us'])
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
  assert.throws(
    () => parseGroupJids('123@s.whatsapp.net'),
    /GROUP_INVITE_LINKS: not a group jid or invite link: 123@s\.whatsapp\.net/,
  )
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
    assert.throws(
      () => parseGroupJids(entry),
      new RegExp(`GROUP_INVITE_LINKS: not a group jid or invite link: ${entry.replace(/[.]/g, '\\.')}`),
    )
  }
})

test('gate passes through jids on the allowlist and swallows the rest', async () => {
  const seen: string[] = []
  const spy = {
    onOpen: (jids: string[]) => {
      seen.push(`open:${jids.join('|')}`)
    },
    onJoined: (jid: string) => {
      seen.push(`joined:${jid}`)
    },
    onInput: (jid: string) => {
      seen.push(`input:${jid}`)
    },
    onRemoved: (jid: string) => {
      seen.push(`removed:${jid}`)
    },
  }
  const g = gate(parseGroupJids('mine@g.us').jids, spy)
  const m = must(toMessage(wam('m1', { conversation: 'oi' }), new Map()))
  g.onOpen(['mine@g.us', 'theirs@g.us'])
  g.onJoined('theirs@g.us')
  g.onJoined('mine@g.us')
  g.onInput('theirs@g.us', m)
  g.onInput('mine@g.us', m)
  await g.onRemoved('theirs@g.us')
  await g.onRemoved('mine@g.us')
  assert.deepEqual(seen, ['open:mine@g.us', 'joined:mine@g.us', 'input:mine@g.us', 'removed:mine@g.us'])
  seen.length = 0
  const shut = gate(parseGroupJids('').jids, spy)
  shut.onOpen(['mine@g.us', 'theirs@g.us'])
  shut.onJoined('mine@g.us')
  shut.onInput('mine@g.us', m)
  await shut.onRemoved('mine@g.us')
  assert.deepEqual(seen, ['open:'])
})

test('resolveOpenJids resolves to the configured jids even when group discovery fails', async () => {
  const warnings: unknown[] = []
  const cfg = {
    groups: parseGroupJids('mine@g.us,other@g.us').jids,
    log: { info() {}, warn: (o: unknown) => warnings.push(o) },
  }
  const s = {
    groupFetchAllParticipating: async () => {
      throw new Error('socket dropped')
    },
  }
  const jids = await resolveOpenJids(s, cfg)
  assert.deepEqual(jids.sort(), ['mine@g.us', 'other@g.us'])
  assert.equal(warnings.length, 1)
})

test('resolveOpenJids narrows to groups the bot is actually a member of when discovery succeeds', async () => {
  const cfg = { groups: parseGroupJids('mine@g.us,notjoined@g.us').jids, log: { info() {}, warn() {} } }
  const s = { groupFetchAllParticipating: async () => ({ 'mine@g.us': { id: 'mine@g.us', subject: 'Mine' } }) }
  assert.deepEqual(await resolveOpenJids(s, cfg), ['mine@g.us'])
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
  const g = gate(jids, {
    onOpen() {},
    onJoined: (jid: string) => {
      seen.push(jid)
    },
    onInput() {},
    onRemoved() {},
  })
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

test('resolveInviteCodes drops a resolved code, so a reconnect cannot re-add a group the bot left', async () => {
  const { jids } = parseGroupJids('')
  const cfg = { groups: jids, log: { info() {}, warn() {} } }
  const s = { groupGetInviteInfo: async () => ({ id: 'new@g.us', subject: 'New Group' }) }
  const codes = ['AbCdEf123']
  await resolveInviteCodes(s, cfg, codes)
  assert.deepEqual(codes, [])
  jids.delete('new@g.us')
  await resolveInviteCodes(s, cfg, codes)
  assert.deepEqual([...jids], [])
})

test('participantsIncludeSelf is true when the bot is among the participants, by id, phoneNumber or lid', () => {
  const me = ['bot@s.whatsapp.net', 'bot@lid']
  assert.equal(participantsIncludeSelf(me, [{ id: 'bot@s.whatsapp.net' }]), true)
  assert.equal(participantsIncludeSelf(me, [{ phoneNumber: 'bot@s.whatsapp.net' }]), true)
  assert.equal(participantsIncludeSelf(me, [{ lid: 'bot@lid' }]), true)
})

test('participantsIncludeSelf is false when the participants are somebody else', () => {
  const me = ['bot@s.whatsapp.net', 'bot@lid']
  assert.equal(participantsIncludeSelf(me, [{ id: 'ana@s.whatsapp.net' }]), false)
  assert.equal(participantsIncludeSelf(me, []), false)
})

test('a remove event naming the bot fires onRemoved through gate only for an allowlisted group', async () => {
  const seen: string[] = []
  const g = gate(parseGroupJids('mine@g.us').jids, {
    onOpen() {},
    ...noop,
    onRemoved: (jid: string) => {
      seen.push(jid)
    },
  })
  const me = ['bot@s.whatsapp.net']
  const removedByBot = [{ id: 'bot@s.whatsapp.net' }]
  if (participantsIncludeSelf(me, removedByBot)) await g.onRemoved('mine@g.us')
  if (participantsIncludeSelf(me, removedByBot)) await g.onRemoved('theirs@g.us')
  assert.deepEqual(seen, ['mine@g.us'])
})

test('a remove event naming somebody else never reaches onRemoved', async () => {
  const seen: string[] = []
  const g = gate(parseGroupJids('mine@g.us').jids, {
    onOpen() {},
    ...noop,
    onRemoved: (jid: string) => {
      seen.push(jid)
    },
  })
  const me = ['bot@s.whatsapp.net']
  if (participantsIncludeSelf(me, [{ id: 'ana@s.whatsapp.net' }])) await g.onRemoved('mine@g.us')
  assert.deepEqual(seen, [])
})

test('wireGroupEvents: messages.upsert reaches onInput for a notify or offline (append) message in a served group; not for another type, an unserved group, or a non-group jid; still delivers a fromMe message unchanged', () => {
  const { ev, seen } = wired('mine@g.us')
  const at = (remoteJid: string, fromMe = false): WAMessage => ({
    key: { id: 'm1', remoteJid, fromMe },
    message: { conversation: 'oi' },
  })
  ev.fire('messages.upsert', { messages: [at('mine@g.us')], type: 'history' })
  ev.fire('messages.upsert', { messages: [at('theirs@g.us')], type: 'notify' })
  ev.fire('messages.upsert', { messages: [at('mine@s.whatsapp.net')], type: 'notify' })
  assert.equal(seen.length, 0)
  ev.fire('messages.upsert', { messages: [at('mine@g.us', true)], type: 'notify' })
  ev.fire('messages.upsert', { messages: [at('mine@g.us')], type: 'append' })
  assert.deepEqual(
    seen.map(i => [i.key.remoteJid, i.key.fromMe]),
    [
      ['mine@g.us', true],
      ['mine@g.us', false],
    ],
  )
})

test('wireGroupEvents: group-participants.update reaches onJoined on add-self and onRemoved on remove-self, but not for somebody else or for promote/demote/modify', () => {
  const ev = fakeEmitter()
  const joined: string[] = []
  const removed: string[] = []
  const on = {
    ...noop,
    onJoined: (jid: string) => {
      joined.push(jid)
    },
    onRemoved: (jid: string) => {
      removed.push(jid)
    },
  }
  const cfg = { groups: parseGroupJids('mine@g.us').jids, log: { info() {} }, recent: new Map(), msgs: new Map() }
  wireGroupEvents(ev, on, () => ['bot@s.whatsapp.net'], cfg)
  ev.fire('group-participants.update', {
    id: 'mine@g.us',
    participants: [{ id: 'ana@s.whatsapp.net' }],
    action: 'add',
  })
  ev.fire('group-participants.update', {
    id: 'mine@g.us',
    participants: [{ id: 'ana@s.whatsapp.net' }],
    action: 'remove',
  })
  for (const action of ['promote', 'demote', 'modify']) {
    ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'bot@s.whatsapp.net' }], action })
  }
  assert.deepEqual(joined, [])
  assert.deepEqual(removed, [])
  ev.fire('group-participants.update', { id: 'mine@g.us', participants: [{ id: 'bot@s.whatsapp.net' }], action: 'add' })
  assert.deepEqual(joined, ['mine@g.us'])
  ev.fire('group-participants.update', {
    id: 'mine@g.us',
    participants: [{ id: 'bot@s.whatsapp.net' }],
    action: 'remove',
  })
  assert.deepEqual(removed, ['mine@g.us'])
})

test('wireGroupEvents: groups.upsert reaches onJoined for each group and logs the jid', () => {
  const ev = fakeEmitter()
  const joined: string[] = []
  const infos: unknown[] = []
  const on = {
    ...noop,
    onJoined: (jid: string) => {
      joined.push(jid)
    },
  }
  const cfg = {
    groups: parseGroupJids('b@g.us').jids,
    log: { info: (o: unknown) => infos.push(o) },
    recent: new Map(),
    msgs: new Map(),
  }
  wireGroupEvents(ev, on, () => [], cfg)
  ev.fire('groups.upsert', [
    { id: 'a@g.us', subject: 'A' },
    { id: 'b@g.us', subject: 'B' },
  ])
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
    groupGetInviteInfo: async (code: string) => {
      resolved.push(code)
      return { id: 'new@g.us', subject: 'New Group' }
    },
  }
  await handleOpen(s, cfg, jids => {
    opened.push(jids)
  })
  assert.equal(infos[0], 'whatsapp connected')
  assert.deepEqual(resolved, ['AbCdEf123'])
  assert.deepEqual([...cfg.groups], ['mine@g.us', 'new@g.us'])
  assert.deepEqual(opened, [['mine@g.us', 'new@g.us']])
  const groupLogs = infos.filter((o: unknown) => o && typeof o === 'object' && 'mine' in o)
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
    groupFetchAllParticipating: async () => {
      throw new Error('socket dropped')
    },
    groupGetInviteInfo: async () => {
      throw new Error('must not be called')
    },
  }
  const opened: string[][] = []
  await handleOpen(s, cfg, jids => {
    opened.push(jids)
  })
  assert.deepEqual(opened, [['mine@g.us']])
  assert.equal(warnings.length, 1)
})

test('an unpaired bot without BOT_PHONE never asks for a pairing code', () => {
  assert.equal(pairingAction(''), 'unpaired')
  assert.equal(pairingAction('5511900000000'), 'code')
})

test('a handle survives structuredClone and still downloads; an evicted message cannot be downloaded', async () => {
  const msgs: Messages = new Map()
  const m = must(
    toMessage(
      wam('c1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 10, url: 'https://mmg.whatsapp.net/x' } }),
      msgs,
    ),
  )
  const dl = (async (msg: WAMessage) =>
    Readable.from([Buffer.from(msg.key.id ?? '')])) as unknown as typeof downloadMediaMessage
  const copy = structuredClone(must(m.media))
  assert.equal((await download(copy, msgs, { reuploadRequest: async x => x, logger: silent }, dl)).toString(), 'c1')
  msgs.clear()
  await assert.rejects(download(copy, msgs, { reuploadRequest: async x => x, logger: silent }, dl), /receipt expired/)
})

test('quoted receipts get their own synthetic id and the message map keeps only the newest 500', () => {
  const { ev, msgs } = wired()
  const quoted = { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } }
  const reply = wam('q1', {
    extendedTextMessage: { text: 'oi', contextInfo: { stanzaId: 'r9', quotedMessage: quoted } },
  })
  ev.fire('messages.upsert', { type: 'notify', messages: [reply] })
  assert.ok(msgs.has('grupo@g.us:q1:quoted'))
  const image = { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } }
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: Array.from({ length: 500 }, (_, i) => wam(`n${i}`, image)),
  })
  assert.equal(msgs.size, 500)
  assert.equal(msgs.has('grupo@g.us:q1:quoted'), false)
  assert.equal(msgs.has('grupo@g.us:n499'), true)
})

test('the 16 MB cap holds on the bytes read, whatever size the sender declared', async () => {
  const msgs: Messages = new Map()
  const m = must(
    toMessage(
      wam('s1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 0, url: 'https://mmg.whatsapp.net/x' } }),
      msgs,
    ),
  )
  let reads = 0
  const stream = Readable.from(
    (function* () {
      while (true) {
        reads++
        yield Buffer.alloc(1024 * 1024)
      }
    })(),
  )
  const dl = (async () => stream) as unknown as typeof downloadMediaMessage
  await assert.rejects(download(must(m.media), msgs, ctx, dl), /too large/)
  assert.equal(stream.destroyed, true)
  assert.ok(reads < 40)
})

test('a small stream is concatenated into one buffer', async () => {
  const msgs: Messages = new Map()
  const m = must(
    toMessage(
      wam('s2', { imageMessage: { mimetype: 'image/jpeg', fileLength: 4, url: 'https://mmg.whatsapp.net/x' } }),
      msgs,
    ),
  )
  const dl = (async () =>
    Readable.from([Buffer.from('ab'), Buffer.from('cd')])) as unknown as typeof downloadMediaMessage
  assert.equal((await download(must(m.media), msgs, ctx, dl)).toString(), 'abcd')
})

test('media from a host outside whatsapp.net is refused before any download', async () => {
  for (const [url, ok] of [
    ['https://evil.example/x', false],
    ['https://whatsapp.net.evil.example/x', false],
    ['not a url', false],
    ['https://mmg.whatsapp.net/x', true],
    ['https://media-gru1-1.cdn.whatsapp.net/x', true],
    [undefined, false],
    ['https://user:pw@mmg.whatsapp.net/x', false],
  ] as const) {
    const msgs: Messages = new Map()
    const m = must(toMessage(wam('h1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 4, url } }), msgs))
    let called = false
    const dl = (async () => {
      called = true
      return Readable.from([Buffer.from('ok')])
    }) as unknown as typeof downloadMediaMessage
    const run = download(must(m.media), msgs, ctx, dl)
    if (ok) assert.equal((await run).toString(), 'ok')
    else await assert.rejects(run, /host refused/)
    assert.equal(called, ok)
  }
})

test('only the checked media object reaches the downloader, own or quoted', async () => {
  const evil = 'https://evil.example/x'
  const trusted = { mimetype: 'image/jpeg', fileLength: 4, url: 'https://mmg.whatsapp.net/x' }
  const mixes: proto.IMessage[] = [
    { imageMessage: trusted, videoMessage: { url: evil }, audioMessage: { url: evil } },
    {
      imageMessage: trusted,
      documentMessage: { mimetype: 'application/pdf', url: evil },
      stickerMessage: { url: evil },
    },
  ]
  for (const mix of mixes) {
    for (const quoted of [false, true]) {
      const msgs: Messages = new Map()
      const m = must(
        toMessage(
          wam(
            'x1',
            quoted ? { extendedTextMessage: { text: 'oi', contextInfo: { stanzaId: 'r1', quotedMessage: mix } } } : mix,
          ),
          msgs,
        ),
      )
      const seen: string[][] = []
      const dl = (async (msg: WAMessage) => {
        seen.push(Object.keys(msg.message ?? {}))
        return Readable.from([Buffer.from('ok')])
      }) as unknown as typeof downloadMediaMessage
      await download(must(quoted ? m.quoted : m.media), msgs, ctx, dl)
      assert.deepEqual(seen, [['imageMessage']])
    }
  }
})

test('the URL that will actually be fetched is checked, directPath included', async () => {
  const cases: [string | undefined, string | undefined, boolean][] = [
    [undefined, '@evil.example/x', false],
    ['https://mmg.whatsapp.net/x', '@evil.example/x', false],
    ['https://mmg.whatsapp.net/x', '/v/t62.7118-24/abc', true],
    [undefined, '/v/t62.7118-24/abc', true],
    [undefined, 'v/abc', false],
    ['https://evil.example/x', '/v/abc', false],
  ]
  for (const [url, directPath, ok] of cases) {
    const msgs: Messages = new Map()
    const m = must(
      toMessage(wam('p1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 4, url, directPath } }), msgs),
    )
    const dl = (async () => Readable.from([Buffer.from('ok')])) as unknown as typeof downloadMediaMessage
    const run = download(must(m.media), msgs, ctx, dl)
    if (ok) assert.equal((await run).toString(), 'ok')
    else await assert.rejects(run, /host refused/)
  }
})

const B = 'outro@g.us'
const inB = (id: string, message: proto.IMessage, pushName = 'Bia'): WAMessage =>
  wam(id, message, { key: { id, remoteJid: B, fromMe: false, participant: 'bia@s.whatsapp.net' }, pushName })
const img = (url: string) => ({ imageMessage: { mimetype: 'image/jpeg', fileLength: 4, url } })

test('the same message id in two groups keeps two separate stored messages', () => {
  const { ev, msgs } = wired('grupo@g.us,outro@g.us')
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: [wam('same', img('https://mmg.whatsapp.net/a')), inB('same', img('https://mmg.whatsapp.net/b'))],
  })
  assert.deepEqual([...msgs.keys()].sort(), ['grupo@g.us:same', 'outro@g.us:same'])
})

test('an edit in one group never takes the sender or media of the same id in another group', () => {
  const { ev, seen } = wired('grupo@g.us,outro@g.us')
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: [
      inB('same', { imageMessage: { mimetype: 'image/jpeg', caption: 'foto', url: 'https://mmg.whatsapp.net/b' } }),
    ],
  })
  ev.fire('messages.update', [
    {
      key: { remoteJid: G, id: 'same', fromMe: false, participant: P },
      update: { message: { editedMessage: { message: { conversation: '/pago luz' } } } },
    },
  ])
  const edit = must(seen.find(i => i.kind === 'edit'))
  assert.equal(edit.media, undefined)
  assert.equal(edit.sender, P)
})

test('a handle from one group is not served by another group entry', async () => {
  const msgs: Messages = new Map()
  const m = must(toMessage(inB('same', img('https://mmg.whatsapp.net/b')), msgs))
  const media = must(m.media)
  const forged = must(msgs.get('outro@g.us:same'))
  msgs.set('outro@g.us:same', { ...forged, key: { ...forged.key, remoteJid: G } })
  const dl = (async () => Readable.from([Buffer.from('ok')])) as unknown as typeof downloadMediaMessage
  await assert.rejects(download(media, msgs, ctx, dl), /group mismatch/)
})

test('reportStatus tells onStatus true on open, false on close, and ignores other updates', () => {
  const seen: boolean[] = []
  const onStatus = (c: boolean) => seen.push(c)
  reportStatus(onStatus, { connection: 'connecting' })
  reportStatus(onStatus, { qr: 'x' })
  reportStatus(onStatus, { connection: 'open' })
  reportStatus(onStatus, { connection: 'close' })
  reportStatus(undefined, { connection: 'open' })
  assert.deepEqual(seen, [true, false])
})

const ctxPt: Ctx = {
  locale: { lang: 'pt-BR', currency: 'BRL', decimal: ',', timeZone: 'America/Sao_Paulo' },
  llm: true,
}
const OCT = Date.UTC(2026, 9, 10, 15)
const atOct = (id: string, message: proto.IMessage, participant = P) =>
  wam(id, message, { key: { id, remoteJid: G, fromMe: false, participant }, messageTimestamp: OCT / 1000 })
function billsState(...names: string[]): GroupState {
  const s = emptyState()
  s.bills = names.map((name, i) => ({ id: i + 1, name, key: normalize(name), paused: false, removed: false }))
  s.nextBillId = names.length + 1
  s.lastReset = '2026-10'
  return s
}
const step = (s: GroupState, m: WAMessage, msgs: Messages) => {
  const input = toMessage(m, msgs)
  return input ? decide(s, input, ctxPt).state : s
}

test('a reaction, pin, poll vote or keep-in-chat from the asker does not cancel their open question', () => {
  for (const content of [
    { reactionMessage: { key: { remoteJid: G, fromMe: false, id: 'OTHER' }, text: '👍', senderTimestampMs: OCT } },
    { pinInChatMessage: { key: { remoteJid: G, fromMe: true, id: 'LIST' }, type: 1 } },
    { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: G, id: 'POLL' } } },
    { keepInChatMessage: { key: { remoteJid: G, fromMe: true, id: 'LIST' }, keepType: 1 } },
  ] as proto.IMessage[]) {
    const msgs: Messages = new Map()
    assert.equal(toMessage(atOct('N1', content), msgs), null, Object.keys(content)[0])
    let s = step(billsState('Luz'), atOct('Q1', { conversation: '/pago lux 80' }), msgs)
    s = step(s, atOct('N1', content), msgs)
    s = step(s, atOct('Y1', { conversation: 'sim' }), msgs)
    assert.equal(s.months['2026-10']?.[1]?.amount, 8000, `lost after ${Object.keys(content)[0]}`)
  }
})

test('only a 👍 reaction to a bot message reaches decide; any other reaction neither answers nor cancels', () => {
  const react = (text: string, fromMe: boolean) =>
    atOct('R2', { reactionMessage: { key: { remoteJid: G, fromMe, id: 'BOT-ASK' }, text, senderTimestampMs: OCT } })
  for (const t of ['👍', '👍🏽', '👍🏿']) assert.equal(must(toMessage(react(t, true), new Map())).text, t)
  for (const [t, fromMe] of [
    ['❤️', true],
    ['👎', true],
    ['😂', true],
    ['👍👍', true],
    ['', true],
    ['👍', false],
  ] as const) {
    assert.equal(toMessage(react(t, fromMe), new Map()), null, `${t} ${fromMe}`)
    const msgs: Messages = new Map()
    let s = step(billsState('Luz'), atOct('Q1', { conversation: '/pago lux 80' }), msgs)
    s = step(s, react(t, fromMe), msgs)
    s = step(s, atOct('Y1', { conversation: 'sim' }), msgs)
    assert.equal(s.months['2026-10']?.[1]?.amount, 8000, `${t} ${fromMe}`)
  }
})

test('a 👍 reaction to the bot question answers it', () => {
  const msgs: Messages = new Map()
  let s = step(billsState('Luz'), atOct('Q1', { conversation: '/pago lux 80' }), msgs)
  const reaction = atOct('R1', {
    reactionMessage: { key: { remoteJid: G, fromMe: true, id: 'BOT-ASK' }, text: '👍', senderTimestampMs: OCT },
  })
  assert.equal(must(toMessage(reaction, msgs)).text, '👍')
  s = step(s, reaction, msgs)
  assert.equal(s.months['2026-10']?.[1]?.amount, 8000)
})

test('an edit timestamp in the future is clamped to now', () => {
  const recent: Recent = new Map()
  const future = Math.floor(Date.UTC(2031, 0, 15) / 1000)
  const u: WAMessageUpdate = {
    key: { remoteJid: G, id: 'E1', fromMe: false, participant: P },
    update: { message: { editedMessage: { message: { conversation: '/pago luz 80' } } }, messageTimestamp: future },
  }
  assert.equal(must(toEdit(u, recent, () => OCT)).at, OCT)
  const s = decide(billsState('Luz'), must(toEdit(u, recent, () => OCT)), ctxPt).state
  assert.deepEqual(Object.keys(s.months), ['2026-10'])
  const past = { ...u, update: { ...u.update, messageTimestamp: OCT / 1000 - 60 } }
  assert.equal(must(toEdit(past, recent, () => OCT)).at, OCT - 60_000)
})

test('a reused message id keeps the first stored receipt; replies quoting the same message each keep their own', async () => {
  const { ev, seen, msgs } = wired()
  const img = (url: string) => ({ url, directPath: '/v/t62/x', mediaKey: new Uint8Array(32), mimetype: 'image/jpeg' })
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: [wam('X', { imageMessage: { ...img('https://mmg.whatsapp.net/victim'), caption: '/pago luz' } })],
  })
  const other = { key: { id: 'X', remoteJid: G, fromMe: false, participant: 'outro@s.whatsapp.net' } }
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: [wam('X', { imageMessage: img('https://mmg.whatsapp.net/attacker') }, other)],
  })
  let got = ''
  const dl = (async (m: WAMessage) => {
    got = `${m.key.participant} ${m.message?.imageMessage?.url}`
    return Readable.from([Buffer.from('jpg')])
  }) as unknown as typeof downloadMediaMessage
  await download(must((seen[0] as MessageInput).media), msgs, ctx, dl)
  assert.equal(got, `${P} https://mmg.whatsapp.net/victim`)
  const quote = (id: string, url: string) =>
    wam(id, {
      extendedTextMessage: {
        text: '/pago luz',
        contextInfo: { stanzaId: 'r9', quotedMessage: { imageMessage: img(url) } },
      },
    })
  ev.fire('messages.upsert', {
    type: 'notify',
    messages: [quote('q1', 'https://mmg.whatsapp.net/first'), quote('q2', 'https://mmg.whatsapp.net/second')],
  })
  await download(must((seen[2] as MessageInput).quoted), msgs, ctx, dl)
  assert.match(got, /\/first$/)
  await download(must((seen[3] as MessageInput).quoted), msgs, ctx, dl)
  assert.match(got, /\/second$/)
})

test('a media-retry reupload pointing outside whatsapp.net is refused', async () => {
  const msgs: Messages = new Map()
  const m = must(
    toMessage(
      wam('M1', {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/gone',
          directPath: '/gone',
          mediaKey: new Uint8Array(32),
          mimetype: 'image/jpeg',
        },
      }),
      msgs,
    ),
  )
  const fetched: string[] = []
  const dl = (async (
    msg: WAMessage,
    _t: string,
    _o: unknown,
    c: { reuploadRequest(x: WAMessage): Promise<WAMessage> },
  ) => {
    const fresh = await c.reuploadRequest(msg)
    fetched.push(new URL(getUrlFromDirectPath(must(fresh.message?.imageMessage?.directPath))).host)
    return Readable.from([Buffer.from('x')])
  }) as unknown as typeof downloadMediaMessage
  const reuploadRequest = async (x: WAMessage) => {
    const im = must(x.message?.imageMessage)
    im.directPath = '@192.168.1.10:8123/api/states'
    im.url = getUrlFromDirectPath(im.directPath)
    return x
  }
  await assert.rejects(download(must(m.media), msgs, { reuploadRequest, logger: silent }, dl), /host refused/)
  assert.deepEqual(fetched, [])
})

test('invite codes never reach the logs, resolved or failed', async () => {
  const lines: string[] = []
  const log = { info: (o: object) => lines.push(JSON.stringify(o)), warn: (o: object) => lines.push(JSON.stringify(o)) }
  const s = {
    groupGetInviteInfo: async (code: string) => {
      if (code === 'SECRETbadCODE456') throw new Error('revoked')
      return { id: G, subject: 'Casa' }
    },
  }
  await resolveInviteCodes(s, { groups: new Set(), log }, ['SECRETinviteCODE123', 'SECRETbadCODE456'])
  assert.equal(lines.length, 2)
  assert.ok(!lines.some(l => l.includes('SECRET')), lines.join('\n'))
})

test('message text is capped at 2000 characters', () => {
  const m = must(toMessage(wam('L1', { conversation: `/pago luz ${'x'.repeat(10_000)}` }), new Map()))
  assert.equal(m.text.length, 2000)
})

test('a download takes an abort signal: refused up front, handed to Baileys, and cuts a running stream', async () => {
  const msgs: Messages = new Map()
  const m = must(
    toMessage(
      wam('A1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 4, url: 'https://mmg.whatsapp.net/x' } }),
      msgs,
    ),
  )
  let calls = 0
  const done = new AbortController()
  done.abort(new Error('late'))
  const never = (async () => {
    calls++
    return Readable.from([])
  }) as unknown as typeof downloadMediaMessage
  await assert.rejects(download(must(m.media), msgs, ctx, never, done.signal), /late/)
  assert.equal(calls, 0)
  const abort = new AbortController()
  let given: unknown
  const stream = new Readable({ read() {} })
  const dl = (async (_m: WAMessage, _t: string, o: { options?: { signal?: AbortSignal } }) => {
    given = o.options?.signal
    stream.push(Buffer.from('ab'))
    return stream
  }) as unknown as typeof downloadMediaMessage
  const run = download(must(m.media), msgs, ctx, dl, abort.signal)
  await new Promise(r => setImmediate(r))
  abort.abort(new Error('receipt read timed out'))
  await assert.rejects(run, /timed out/)
  assert.equal(given, abort.signal)
  assert.equal(stream.destroyed, true)
})

test('an abort also cuts the steps before the stream: the download call and a media re-upload', async () => {
  const msgs: Messages = new Map()
  const m = must(
    toMessage(
      wam('A2', { imageMessage: { mimetype: 'image/jpeg', fileLength: 4, url: 'https://mmg.whatsapp.net/x' } }),
      msgs,
    ),
  )
  const stuckDl = (async () => new Promise(() => {})) as unknown as typeof downloadMediaMessage
  const viaReupload = (async (
    msg: WAMessage,
    _t: string,
    _o: unknown,
    c: { reuploadRequest(x: WAMessage): Promise<WAMessage> },
  ) => {
    await c.reuploadRequest(msg)
    return Readable.from([Buffer.from('x')])
  }) as unknown as typeof downloadMediaMessage
  const stuckReupload = { reuploadRequest: () => new Promise<WAMessage>(() => {}), logger: silent }
  for (const [dl, c] of [
    [stuckDl, ctx],
    [viaReupload, stuckReupload],
  ] as const) {
    const abort = new AbortController()
    setTimeout(() => abort.abort(new Error('receipt read timed out')), 5)
    await assert.rejects(download(must(m.media), msgs, c, dl, abort.signal), /timed out/)
  }
})
