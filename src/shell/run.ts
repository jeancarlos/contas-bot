import { isDeepStrictEqual } from 'node:util'
import type { Store } from '../adapters/store.ts'
import type { GroupMeta } from '../adapters/v1.ts'
import { announcementText, compareVersions, isSemver, pendingReleases, type Release } from '../announce.ts'
import { type Ctx, decide } from '../core/decide.ts'
import { migrateDescription, reconcileBills } from '../core/description.ts'
import { render } from '../core/i18n.ts'
import {
  type Effect,
  emptyState,
  type GroupState,
  type Input,
  type Locale,
  type MediaRef,
  type Msg,
  type MsgKey,
} from '../core/types.ts'
import type { Llm } from '../llm.ts'
import { mailbox } from './mailbox.ts'

export type Wa = {
  sendText(text: string, quoted?: MsgKey): Promise<string>
  sendVideo(video: Buffer, caption: string): Promise<string>
  react(key: MsgKey, emoji: string): Promise<void>
  pin(messageId: string): Promise<void>
  unpin(messageId: string): Promise<void>
  getDescription(): Promise<string>
  setDescription(text: string): Promise<void>
  download(media: MediaRef): Promise<Buffer>
}
export type Log = {
  info(o: object, m?: string): void
  warn(o: object, m?: string): void
  error(o: object, m?: string): void
}
export type ShellDeps = {
  store: Store
  wa(jid: string): Wa
  locale: Locale
  llm: Llm
  pdfToPng(pdf: Buffer): Promise<Buffer>
  log: Log
  now(): number
  version: string
  announce?: { releases: Release[] | null; gif(): Promise<Buffer | null> }
  readTimeoutMs?: number
}
export type Shell = {
  handle(jid: string, input: Input): Promise<void>
  join(jid: string): Promise<void>
  resolved(code: string, jid: string): void
  removed(jid: string): void
  idle(): Promise<void>
}

const NO_META: GroupMeta = { invite: null, announcedVersion: null, descriptionMigrated: false }
const READ_TIMEOUT_MS = 90_000
const after = (ms: number) => new Promise<null>(resolve => setTimeout(resolve, ms, null))

export function cachedGroups(store: Store, codes: string[]): { jids: string[]; toResolve: string[] } {
  const jids: string[] = []
  const remaining = new Set(codes)
  for (const jid of store.groups()) {
    const invite = store.meta(jid)?.invite
    if (invite && remaining.has(invite)) {
      jids.push(jid)
      remaining.delete(invite)
    }
  }
  return { jids, toResolve: [...remaining] }
}

const quotable = (i: Input): MsgKey | null => (i.kind === 'billPicked' ? i.pick.to : 'key' in i ? i.key : null)

export function makeShell(d: ShellDeps): Shell {
  const box = mailbox()
  const ctx: Ctx = { locale: d.locale, llm: d.llm.enabled }
  const text = (msg: Msg) => render(msg, d.locale)
  const pending = new Set<Promise<void>>()
  const joined = new Set<string>()
  const asks = new Map<string, GroupState['asks']>()
  const unasked = (s: GroupState): GroupState => ({ ...s, asks: [] })

  const handle = (jid: string, input: Input) => box(jid, () => step(jid, input))
  const follow = (p: Promise<void>) => {
    const tracked: Promise<void> = p
      .catch(err => d.log.error({ err }, 'follow-up failed'))
      .finally(() => pending.delete(tracked))
    pending.add(tracked)
  }

  async function receiptImage(jid: string, media: MediaRef) {
    let image = await d.wa(jid).download(media)
    let mime = media.mime
    if (mime === 'application/pdf') {
      image = await d.pdfToPng(image)
      mime = 'image/png'
    }
    return { image, mime }
  }

  const cents = (amount: number | null) => (amount === null ? null : Math.round(amount * 100))

  async function readReceipt(jid: string, media: MediaRef): Promise<number | null> {
    try {
      const { image, mime } = await receiptImage(jid, media)
      return cents(await d.llm.readAmount(image, mime))
    } catch (err) {
      d.log.warn({ err, jid }, 'receipt unreadable')
      return null
    }
  }

  async function pickReceipt(jid: string, fx: Extract<Effect, { kind: 'pickBill' }>) {
    try {
      const { image, mime } = await receiptImage(jid, fx.media)
      const { index, amount } = await d.llm.pickBill(
        image,
        mime,
        fx.bills.map(b => b.name),
      )
      return { billId: (index === null ? undefined : fx.bills[index]?.id) ?? null, amount: cents(amount) }
    } catch (err) {
      d.log.warn({ err, jid }, 'receipt unreadable')
      return { billId: null, amount: null }
    }
  }

  async function pickBill(jid: string, fx: Extract<Effect, { kind: 'pickBill' }>) {
    const { billId, amount } = (await Promise.race([
      pickReceipt(jid, fx),
      after(d.readTimeoutMs ?? READ_TIMEOUT_MS),
    ])) ?? { billId: null, amount: null }
    await handle(jid, { kind: 'billPicked', pick: fx, billId, amount })
  }

  async function readAmount(jid: string, fx: Extract<Effect, { kind: 'readAmount' }>) {
    const amount = await Promise.race([readReceipt(jid, fx.media), after(d.readTimeoutMs ?? READ_TIMEOUT_MS)])
    await handle(jid, { kind: 'amountRead', key: fx.to, month: fx.month, billId: fx.billId, amount, at: d.now() })
  }

  async function perform(jid: string, fx: Effect) {
    const wa = d.wa(jid)
    switch (fx.kind) {
      case 'reply':
        await wa.sendText(text(fx.msg), fx.to)
        return
      case 'send':
        await wa.sendText(text(fx.msg))
        return
      case 'postList': {
        const messageId = await wa.sendText(text(fx.msg))
        follow(handle(jid, { kind: 'listPosted', messageId }))
        return
      }
      case 'react':
        await wa.react(fx.to, '✅')
        return
      case 'pin':
        await wa.pin(fx.messageId)
        return
      case 'unpin':
        await wa.unpin(fx.messageId)
        return
      case 'readAmount':
        follow(readAmount(jid, fx))
        return
      case 'pickBill':
        follow(pickBill(jid, fx))
        return
    }
  }

  async function step(jid: string, input: Input) {
    const before = d.store.load(jid) ?? emptyState()
    before.asks = asks.get(jid) ?? []
    const { state, effects } = decide(before, input, ctx)
    if (effects.length === 0 && isDeepStrictEqual(unasked(before), unasked(state))) {
      asks.set(jid, state.asks)
      return
    }
    try {
      d.store.commit(jid, state)
    } catch (err) {
      d.log.error({ err, jid, input: input.kind }, 'commit failed: nothing saved, nothing sent')
      const key = quotable(input)
      if (key) await d.wa(jid).sendText(text({ k: 'saveFailed' }), key)
      return
    }
    asks.set(jid, state.asks)
    for (const fx of effects) {
      await perform(jid, fx).catch(err => d.log.warn({ err, jid, effect: fx.kind }, 'effect failed, not retried'))
    }
  }

  async function migrate(jid: string) {
    const meta = d.store.meta(jid)
    if (!meta || meta.descriptionMigrated) return
    const wa = d.wa(jid)
    let desc: string
    try {
      desc = await wa.getDescription()
    } catch (err) {
      d.log.warn({ err, jid }, 'description unreadable, migrating it on the next join')
      return
    }
    const m = migrateDescription(desc, text({ k: 'descLine' }))
    const before = d.store.load(jid) ?? emptyState()
    const state = reconcileBills(before, m.bills)
    if (state !== before) d.store.commit(jid, state)
    if (m.text !== desc) {
      try {
        await wa.setDescription(m.text)
      } catch (err) {
        d.log.warn({ err, jid }, 'description not editable, asking the group to clean it')
        await wa.sendText(text({ k: 'descriptionNotice' }))
      }
    }
    d.store.setMeta(jid, { ...meta, descriptionMigrated: true })
    d.log.info({ jid, bills: m.bills.length }, 'description migrated')
  }

  async function sendAnnouncement(jid: string, body: string, gif: () => Promise<Buffer | null>) {
    const wa = d.wa(jid)
    const video = await gif().catch(() => null)
    if (!video) {
      await wa.sendText(body)
      return
    }
    try {
      await wa.sendVideo(video, body)
    } catch (err) {
      d.log.warn({ err, jid }, 'gif announcement failed, sending text')
      await wa.sendText(body)
    }
  }

  async function announce(jid: string, meta: GroupMeta) {
    const a = d.announce
    if (!a?.releases || !isSemver(d.version)) return
    const previous = meta.announcedVersion ?? undefined
    if (previous !== undefined && compareVersions(d.version, previous) <= 0) return
    const more = (n: number) => text({ k: 'moreChanges', n })
    const body = announcementText(pendingReleases(a.releases, d.version, previous), d.locale.lang, d.version, more)
    try {
      if (body !== null) await sendAnnouncement(jid, body, a.gif)
    } catch (err) {
      d.log.warn({ err, jid }, 'release announcement failed, retrying on the next join')
      return
    }
    d.store.setMeta(jid, { ...meta, announcedVersion: d.version })
  }

  async function joinNow(jid: string, startup: boolean) {
    const fresh = (d.store.load(jid)?.lastReset ?? null) === null
    if (!fresh) await migrate(jid)
    await step(jid, { kind: 'join', jid, at: d.now(), startup })
    const meta = d.store.meta(jid) ?? NO_META
    if (!fresh) await announce(jid, meta)
    else
      d.store.setMeta(jid, {
        ...meta,
        descriptionMigrated: true,
        announcedVersion: isSemver(d.version) ? d.version : null,
      })
  }

  return {
    handle,
    join(jid) {
      const startup = !joined.has(jid)
      joined.add(jid)
      return box(jid, () => joinNow(jid, startup))
    },
    resolved(code, jid) {
      d.store.setMeta(jid, { ...(d.store.meta(jid) ?? NO_META), invite: code })
    },
    removed(jid) {
      const meta = d.store.meta(jid)
      if (meta) d.store.setMeta(jid, { ...meta, invite: null })
    },
    async idle() {
      while (pending.size > 0) await Promise.all(pending)
    },
  }
}
