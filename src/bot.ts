import {
  normalize, parseDescription, resolveBill, parseCommand, parseAmount, matchPlainText, renderList, monthKey,
  splitDescription, renderSection, composeDescription, billLine, isGreeting,
  type Bill,
} from './bills.ts'
import { DEFAULT_LOCALE, type Locale } from './i18n.ts'
import type { StateStore } from './state.ts'
import type { Llm } from './llm.ts'

export type MsgKey = { id: string; fromMe: boolean; remoteJid: string; participant?: string }
export type Incoming = {
  key: MsgKey
  sender: string
  text: string
  media?: { mime: string; download(): Promise<Buffer> }
  mentionsBot?: boolean
  repliesToBot?: boolean
}
export type Wa = {
  sendText(text: string, quoted?: MsgKey): Promise<MsgKey>
  react(key: MsgKey, emoji: string): Promise<void>
  pin(key: MsgKey): Promise<void>
  unpin(key: MsgKey): Promise<void>
  getDescription(): Promise<string>
  setDescription(text: string): Promise<void>
  leave(): Promise<void>
  memberPhones(): Promise<(string | null)[]>
}
type Log = { info(o: any, m?: string): void; warn(o: any, m?: string): void; error(o: any, m?: string): void }
export type BotDeps = {
  wa: Wa
  llm: Llm
  store: StateStore
  owners?: string[]
  now?: () => Date
  log?: Log
  pdfToPng?: (pdf: Buffer) => Promise<Buffer>
  locale?: Locale
}

const CONFIDENCE = 0.7
// WhatsApp keeps some Brazilian mobiles without the 9th digit (55 + DDD + 8) while owners type it (55 + DDD + 9 + 8).
const br = (p: string) => /^55\d\d9\d{8}$/.test(p) ? p.slice(0, 4) + p.slice(5) : p

export function makeBot(deps: BotDeps) {
  const { wa, llm, store } = deps
  const now = deps.now ?? (() => new Date())
  const log: Log = deps.log ?? { info() {}, warn() {}, error() {} }
  const loc = deps.locale ?? DEFAULT_LOCALE
  const t = loc.t
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
  // A bill named exactly like the whole /pago argument ("Apartamento 101") wins over name + amount.
  const wholeName = (arg: string) => bills.find(b => b.key === normalize(arg)) ?? null

  async function postList() {
    const { key, paid } = month()
    const sentKey = await wa.sendText(renderList(key, bills, paid, loc))
    const prev = state()._meta.pinned
    try {
      // Pin first: a refused pin must not leave the group with no list pinned at all.
      await wa.pin(sentKey)
      state()._meta.pinned = { id: sentKey.id, fromMe: sentKey.fromMe, remoteJid: sentKey.remoteJid }
      if (prev) await wa.unpin(prev).catch(e => log.warn({ err: e }, 'unpinning the previous list failed'))
    } catch (e) {
      log.warn({ err: e }, 'pin failed (group may restrict pinning to admins)')
    }
    await store.save()
  }

  async function markPaid(bill: Bill, amount: number | null, m: Incoming) {
    const { paid } = month()
    const existed = Boolean(paid[bill.key])
    paid[bill.key] = { name: bill.name, paid_at: now().toISOString(), amount, by: m.sender, message_id: m.key.id }
    await store.save()
    await wa.react(m.key, '✅')
    if (existed) await wa.sendText(t.updated, m.key)
    await postList()
  }

  const active = () => Boolean(state()._meta.last_reset)
  // Last text we wrote: if WhatsApp hands back something slightly different, don't fight it forever.
  let lastWritten = ''

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
    if (next.length === 0) next = parseDescription((meta.bills ?? []).join('\n'))
    const changed = renderSection(next, loc) !== renderSection(bills, loc)
    bills = next
    meta.bills = bills.map(b => billLine(b, loc))
    const want = composeDescription(top, bills, loc)
    if (want === desc) meta.section = true
    else if (want !== lastWritten) await writeDescription(want)
    await store.save()
    return changed
  }

  async function handleCommand(m: Incoming): Promise<boolean> {
    const c = parseCommand(m.text, loc)
    if (!c) return false
    switch (c.cmd) {
      case 'pago': {
        const whole = wholeName(c.full)
        const bill = whole ?? resolveBill(bills, c.name)
        if (!bill) { await wa.sendText(t.notFound(c.name, billNames().join(', ')), m.key); return true }
        await markPaid(bill, whole ? null : c.amount, m)
        return true
      }
      case 'despago': {
        const bill = resolveBill(bills, c.name)
        if (!bill) { await wa.sendText(t.notFound(c.name, billNames().join(', ')), m.key); return true }
        delete month().paid[bill.key]
        await store.save()
        await wa.react(m.key, '✅')
        await postList()
        return true
      }
      case 'lista': await postList(); return true
      case 'ajuda': await wa.sendText(t.help, m.key); return true
      case 'unknown': await wa.sendText(t.unknownCmd, m.key); return true
    }
  }

  async function handleMedia(m: Incoming) {
    const c = parseCommand(m.text, loc)
    const pago = c?.cmd === 'pago' ? c : null
    const whole = pago ? wholeName(pago.full) : null
    // "/pago" alone or "/pago 150,00" names no bill: the receipt is read to find it.
    const named = !whole && pago && pago.name && parseAmount(pago.name, loc) === null ? pago.name : null
    const known = whole ?? (named ? resolveBill(bills, named) : pago ? null : resolveBill(bills, m.text) ?? matchPlainText(bills, m.text))
    // A typed bill name is answered like the text command when unknown, not guessed by the LLM.
    if (named && !known) { await wa.sendText(t.notFound(named, billNames().join(', ')), m.key); return }
    const media = m.media!
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
      return
    }
    const typed = pago && !whole ? pago.amount ?? parseAmount(pago.name, loc) : null
    const verdict = await llm.readReceipt(image, mime, m.text, billNames())
    if (known) {
      if (!verdict && typed == null) await wa.sendText(t.noLlmAmount, m.key)
      await markPaid(known, typed ?? verdict?.amount ?? null, m)
      return
    }
    const bill = verdict && verdict.confidence >= CONFIDENCE ? bills.find(b => b.name === verdict.bill) : undefined
    if (!bill) { await wa.sendText(t.ask, m.key); return }
    await markPaid(bill, typed ?? verdict!.amount, m)
  }

  return {
    bills: () => bills,

    join() {
      return serial(async (): Promise<'onboarded' | 'left' | 'active'> => {
        const meta = state()._meta
        if (active()) {
          let desc: string
          try { desc = await wa.getDescription() } catch (e) {
            // Rewriting from an unread description would wipe the group's own text: load and wait.
            log.warn({ err: e }, 'description unreadable, using saved bills')
            bills = parseDescription((meta.bills ?? []).join('\n'))
            return 'active'
          }
          await reconcile(desc)
          log.info({ bills: billNames() }, 'bills loaded')
          return 'active'
        }
        const phones = await wa.memberPhones()
        const owners = deps.owners ?? []
        if (!phones.some(p => p !== null && owners.some(o => br(o) === br(p)))) {
          // One owner is enough to stay; leaving needs every member resolved, never a guess.
          if (phones.includes(null)) throw new Error('could not resolve member phones; not deciding on this group now')
          await wa.sendText(t.private)
          await wa.leave()
          return 'left'
        }
        const desc = await wa.getDescription()
        bills = parseDescription(t.demoBills)
        meta.bills = bills.map(b => billLine(b, loc))
        // A new group is section-style from birth: even if the write below is refused, a later description
        // without our section means "keep their text, restore the list", never "their text is the bill list".
        meta.section = true
        await writeDescription(composeDescription(splitDescription(desc).original, bills, loc))
        await wa.sendText(t.intro)
        await postList()
        // Active only once the list is out: if anything above throws, the next join retries the whole onboarding.
        meta.last_reset = monthKey(now())
        await store.save()
        log.info({ bills: billNames() }, 'group onboarded')
        return 'onboarded'
      })
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

    onMessage(m: Incoming) {
      if (m.key.fromMe) return Promise.resolve()
      return serial(async () => { try {
        if (!active()) return
        if (m.media) return await handleMedia(m)
        if (await handleCommand(m)) return
        const bill = matchPlainText(bills, m.text)
        if (bill) return await markPaid(bill, null, m)
        if (m.mentionsBot || m.repliesToBot || isGreeting(m.text)) await wa.sendText(t.intro, m.key)
      } catch (e) {
        log.error({ err: e, id: m.key.id }, 'message handling failed')
      } })
    },

    tick() {
      return serial(async () => {
        if (!active()) return
        const key = monthKey(now())
        if (state()._meta.last_reset === key) return
        await postList()
        state()._meta.last_reset = key
        await store.save()
      })
    },
  }
}
