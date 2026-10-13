import {
  normalize, parseDescription, resolveBill, parseCommand, parseAmount, closestBills, renderList, monthKey,
  splitDescription, renderSection, composeDescription, billLine, suggestCommand,
  type Bill, type Command,
} from './bills.ts'
import { DEFAULT_LOCALE, type Locale } from './i18n.ts'
import { announcementText, compareVersions, isSemver, pendingReleases, type Release } from './announce.ts'
import type { StateStore } from './state.ts'
import type { Llm } from './llm.ts'

export type MsgKey = { id: string; fromMe: boolean; remoteJid: string; participant?: string }
export type Incoming = {
  key: MsgKey
  sender: string
  text: string
  media?: { mime: string; download(): Promise<Buffer> }
}
export type Wa = {
  sendText(text: string, quoted?: MsgKey): Promise<MsgKey>
  sendVideo(video: Buffer, caption: string): Promise<MsgKey>
  react(key: MsgKey, emoji: string): Promise<void>
  pin(key: MsgKey): Promise<void>
  unpin(key: MsgKey): Promise<void>
  getDescription(): Promise<string>
  setDescription(text: string): Promise<void>
}
type Log = { info(o: unknown, m?: string): void; warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void }
export type BotDeps = {
  wa: Wa
  llm: Llm
  store: StateStore
  now?: () => Date
  log?: Log
  pdfToPng?: (pdf: Buffer) => Promise<Buffer>
  locale?: Locale
  version: string
  announce?: { releases: Release[] | null; gif(): Promise<Buffer | null> }
}

type Pago = Extract<Command, { cmd: 'pago' }>

export function makeBot(deps: BotDeps) {
  const { wa, llm, store } = deps
  const now = deps.now ?? (() => new Date())
  const log: Log = deps.log ?? { info() {}, warn() {}, error() {} }
  const loc = deps.locale ?? DEFAULT_LOCALE
  const t = loc.t
  const warn = (msg: string) => (err: unknown) => log.warn({ err }, msg)
  let bills: Bill[] = parseDescription((store.get()._meta.bills ?? []).join('\n'))

  const state = () => store.get()
  // One handler at a time: state.json saves and pin/unpin must not interleave.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>) => { const p = queue.then(fn); queue = p.catch(() => {}); return p }
  const month = () => {
    const key = monthKey(now())
    state().months[key] ??= {}
    return { key, paid: state().months[key] }
  }
  const billNames = () => bills.map(b => b.name)
  const notFoundText = (q: string, suggestions = closestBills(bills, q)) => {
    const near = suggestions.map(b => b.name)
    return t.notFound(q, billNames().join(', '), near.length ? near : undefined)
  }
  // A bill named exactly like the whole /pago argument ("Apartamento 101") wins over name + amount.
  const wholeName = (arg: string) => bills.find(b => b.key === normalize(arg)) ?? null

  let onboardingListSent = false
  async function postList() {
    const { key, paid } = month()
    const sentKey = await wa.sendText(renderList(key, bills, paid, loc))
    onboardingListSent = true
    state()._meta.listed = true
    const prev = state()._meta.pinned
    try {
      // Pin first: a refused pin must not leave the group with no list pinned at all.
      await wa.pin(sentKey)
      state()._meta.pinned = { id: sentKey.id, fromMe: sentKey.fromMe, remoteJid: sentKey.remoteJid }
      if (prev) await wa.unpin(prev).catch(warn('unpinning the previous list failed'))
    } catch (e) {
      log.warn({ err: e }, 'pin failed (group may restrict pinning to admins)')
    }
    await store.save()
  }

  async function markPaid(bill: Bill, amount: number | null, m: Incoming) {
    const { paid } = month()
    const existing = Object.hasOwn(paid, bill.key) ? paid[bill.key] : undefined
    paid[bill.key] = { name: bill.name, paid_at: now().toISOString(), amount: amount ?? existing?.amount ?? null, by: m.sender, message_id: m.key.id }
    const handled = state()._meta.handled
    markHandled(m.key.id)
    try {
      await store.save()
    } catch (e) {
      state()._meta.handled = handled
      if (existing) paid[bill.key] = existing
      else delete paid[bill.key]
      await wa.sendText(t.saveFailed, m.key)
      throw e
    }
    await wa.react(m.key, '✅').catch(warn('reaction failed'))
    if (existing) await wa.sendText(t.updated, m.key).catch(warn('update notice failed'))
    await postList()
  }

  const active = () => Boolean(state()._meta.last_reset)
  const markHandled = (id: string) => {
    const meta = state()._meta
    if (!meta.handled?.includes(id)) meta.handled = [...(meta.handled ?? []), id].slice(-50)
  }
  // Last text we wrote: if WhatsApp hands back something slightly different, don't fight it forever.
  let lastWritten = ''
  let introduced = false

  // null: the description would not fit without cutting the group's text or the list, so it is left alone.
  async function writeDescription(text: string | null) {
    const meta = state()._meta
    if (text === null) {
      log.warn({}, 'description over the WhatsApp limit, not written')
      if (!meta.long_warned) {
        meta.long_warned = true
        await wa.sendText(t.descTooLong)
      }
      return
    }
    try {
      await wa.setDescription(text)
      lastWritten = text
      meta.section = true
    } catch (e) {
      // Stays a failure: `meta.section` is only set on success here; onboarding sets it itself (see join).
      log.warn({ err: e }, 'description write refused (bot may need admin)')
      if (!meta.desc_warned) {
        meta.desc_warned = true
        await wa.sendText(t.descDenied)
      }
    }
  }

  // Reads the bills from the description and makes the description canonical. Returns true when the bills changed.
  async function reconcile(desc: string): Promise<boolean> {
    const meta = state()._meta
    const { original, section } = splitDescription(desc)
    let top = original
    let next: Bill[]
    if (section !== null) next = parseDescription(section)
    else if (meta.section) next = [] // someone deleted our section: keep their text, restore the list below it
    else { next = parseDescription(desc); top = '' } // legacy group: the whole description was the list
    if (section === null && next.length === 0) next = parseDescription((meta.bills ?? []).join('\n'))
    const changed = renderSection(next, loc) !== renderSection(bills, loc)
    bills = next
    meta.bills = bills.map(b => billLine(b, loc))
    const want = composeDescription(top, bills, loc)
    if (want === desc) meta.section = true
    else if (want !== lastWritten || (section === null && meta.section)) await writeDescription(want)
    await store.save()
    return changed
  }

  // A bill named exactly like the whole argument ("Apartamento 101") wins over name + amount.
  function pagoTarget(c: Pago): { bill: Bill; amount: number | null } | string {
    const whole = wholeName(c.full)
    if (whole) return { bill: whole, amount: null }
    const bill = resolveBill(bills, c.name)
    if (bill) return { bill, amount: c.amount }
    return !c.name.trim() || parseAmount(c.name, loc) !== null ? t.missingBillPago : notFoundText(c.name)
  }

  // The receipt is only read for its amount, never to guess the bill. undefined: it could not be downloaded.
  async function receiptAmount(media: NonNullable<Incoming['media']>, m: Incoming): Promise<number | null | undefined> {
    let image: Buffer
    let mime = media.mime
    try {
      image = await media.download()
      if (mime === 'application/pdf') {
        if (!deps.pdfToPng) throw new Error('no pdf renderer')
        image = await deps.pdfToPng(image)
        mime = 'image/png'
      }
    } catch (e) {
      log.warn({ err: e }, 'media download failed')
      await wa.sendText(t.downloadFailed, m.key)
      return undefined
    }
    const amount = await llm.readAmount(image, mime)
    if (amount == null) await wa.sendText(t.noLlmAmount, m.key)
    return amount
  }

  async function pago(c: Pago, m: Incoming) {
    const target = pagoTarget(c)
    if (typeof target === 'string') { await wa.sendText(target, m.key); return }
    let { amount } = target
    if (amount == null && m.media && llm.enabled) {
      const read = await receiptAmount(m.media, m)
      if (read === undefined) return
      amount = read
    }
    await markPaid(target.bill, amount, m)
  }

  async function despago(name: string, m: Incoming) {
    if (!name.trim()) { await wa.sendText(t.missingBillDespago, m.key); return }
    const bill = resolveBill(bills, name)
    if (!bill) { await wa.sendText(notFoundText(name), m.key); return }
    const { paid } = month()
    const removed = Object.hasOwn(paid, bill.key) ? paid[bill.key] : undefined
    delete paid[bill.key]
    try {
      await store.save()
    } catch (e) {
      if (removed) paid[bill.key] = removed
      await wa.sendText(t.saveFailed, m.key)
      throw e
    }
    await wa.react(m.key, '✅').catch(warn('reaction failed'))
    await postList()
  }

  async function handleCommand(c: Command, m: Incoming) {
    switch (c.cmd) {
      case 'pago': return pago(c, m)
      case 'despago': return despago(c.name, m)
      case 'lista': return postList()
      case 'ajuda': { await wa.sendText(t.help, m.key); return }
      case 'unknown': {
        const s = suggestCommand(c.name)
        await wa.sendText(s ? t.unknownCmdSuggest(c.name, s) : t.unknownCmd, m.key)
      }
    }
  }

  let missingLogged = false
  async function maybeAnnounce() {
    const a = deps.announce
    const version = deps.version
    if (!a || !isSemver(version)) return
    if (a.releases === null) {
      if (!missingLogged) { missingLogged = true; log.info('no changelog in this build') }
      return
    }
    const meta = state()._meta
    const previous = meta.announced_version
    if (previous !== undefined && compareVersions(version, previous) <= 0) return
    try {
      const text = announcementText(pendingReleases(a.releases, version, previous), loc.lang, version, t.moreChanges)
      if (text !== null) {
        const gif = await a.gif().catch(() => null)
        try {
          if (gif) await wa.sendVideo(gif, text)
          else await wa.sendText(text)
        } catch (e) {
          if (!gif) throw e
          log.warn({ err: e }, 'gif announcement failed, sending text')
          await wa.sendText(text)
        }
      }
    } catch (e) {
      log.warn({ err: e }, 'release announcement failed')
      return
    }
    meta.announced_version = version
    try { await store.save() } catch (e) {
      meta.announced_version = previous
      log.warn({ err: e }, 'could not save the announced version, will retry on the next join')
    }
  }

  async function joinNow(): Promise<'onboarded' | 'active'> {
    const meta = state()._meta
    if (active()) {
      let desc: string
      try { desc = await wa.getDescription() } catch (e) {
        // Rewriting from an unread description would wipe the group's own text: load and wait.
        log.warn({ err: e }, 'description unreadable, using saved bills')
        bills = parseDescription((meta.bills ?? []).join('\n'))
        await maybeAnnounce()
        return 'active'
      }
      const changed = await reconcile(desc)
      if (meta.listed && changed) await postList()
      log.info({ bills: billNames() }, 'bills loaded')
      await maybeAnnounce()
      return 'active'
    }
    const desc = await wa.getDescription()
    const { original, section } = splitDescription(desc)
    const existingBills = section !== null ? parseDescription(section) : []
    bills = existingBills.length > 0 ? existingBills : parseDescription(t.demoBills)
    meta.bills = bills.map(b => billLine(b, loc))
    // A new group is section-style from birth: even if the write below is refused, a later description
    // without our section means "keep their text, restore the list", never "their text is the bill list".
    meta.section = true
    await writeDescription(composeDescription(original, bills, loc))
    if (!introduced) {
      await wa.sendText(t.intro)
      introduced = true
    }
    if (!onboardingListSent) await postList()
    // Active only once the list is out: if anything above throws, the next join retries the whole onboarding.
    meta.last_reset = monthKey(now())
    if (isSemver(deps.version)) meta.announced_version = deps.version
    try { await store.save() } catch (e) { delete meta.last_reset; throw e }
    log.info({ bills: billNames() }, 'group onboarded')
    return 'onboarded'
  }

  return {
    bills: () => bills,

    join() {
      return serial(joinNow)
    },

    // The event text is only a trigger: Baileys can deliver the pre-migration description after join() rewrote
    // it, and reading that as "section deleted" would paste the old list above the section. Read the current one.
    onDescription(_desc: string) {
      return serial(async () => {
        if (!active()) return
        let fresh: string
        try { fresh = await wa.getDescription() } catch (e) {
          log.warn({ err: e }, 'description unreadable, ignoring update')
          return
        }
        if (await reconcile(fresh)) {
          log.info({ bills: billNames() }, 'bills updated from description')
          await postList()
        }
      })
    },

    // Only slash commands are answered: anything else, receipts included, is the group talking.
    onMessage(m: Incoming) {
      const c = m.key.fromMe ? null : parseCommand(m.text, loc)
      if (!c) return Promise.resolve()
      return serial(async () => { try {
        if (!active() || state()._meta.handled?.includes(m.key.id)) return
        await handleCommand(c, m)
        markHandled(m.key.id)
        await store.save()
      } catch (e) {
        log.error({ err: e, id: m.key.id }, 'message handling failed')
      } })
    },

    tick() {
      return serial(async () => {
        if (!active()) { await joinNow(); return }
        const key = monthKey(now())
        if (state()._meta.last_reset === key) return
        await postList()
        state()._meta.last_reset = key
        await store.save()
      })
    },
  }
}
