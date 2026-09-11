import {
  parseDescription, resolveBill, parseCommand, matchPlainText, renderList, monthKey,
  splitDescription, renderSection, composeDescription, billLine, isGreeting, DEMO_BILLS,
  type Bill,
} from './bills.ts'
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
  memberPhones(): Promise<string[] | null>
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
}

const CONFIDENCE = 0.7
const ASK = 'esse comprovante é de qual conta? responde /pago <nome>'
const NO_AMOUNT = 'sem valor (LLM indisponível)'
const DOWNLOAD_FAILED = 'não consegui ler o comprovante, manda de novo ou usa /pago <nome> [valor]'
const INTRO = [
  '👋 Oi! Eu sou o *contas-bot*, cuido da lista de contas do mês deste grupo.',
  '',
  '📎 Pagou? Manda o comprovante (foto ou PDF) aqui. Se a legenda tiver o nome da conta, eu marco na hora; se não, eu leio o comprovante e descubro.',
  '✍️ Sem comprovante: /pago luz 231,45',
  '📌 A lista fica sempre fixada, com o total do mês.',
  '📝 As contas ficam na descrição do grupo: edite a lista lá que eu atualizo.',
  '🗓️ Todo dia 1º começo uma lista nova.',
  '',
  '/help mostra todos os comandos.',
].join('\n')
const HELP = [
  '🤖 *Comandos do contas-bot*',
  '',
  '/pago <conta> [valor] — marca como paga',
  '   ex: /pago luz · /pago cartão nu 6.237,60',
  '/despago <conta> — desmarca',
  '/lista — reposta e fixa a lista',
  '/help — esta mensagem',
  '',
  '📎 Comprovante com o nome da conta na legenda = paga na hora.',
  '📝 Mudar as contas: edite a lista na descrição do grupo. "(pausado)" no fim tira a conta do mês sem apagar.',
].join('\n')
const UNKNOWN_CMD = 'não conheço esse comando. /help mostra todos.'
const PRIVATE = 'sou um bot privado 🤖'
const DESC_DENIED = 'não consigo editar a descrição: me torna admin ou libera "editar dados do grupo" pra todos'

export function makeBot(deps: BotDeps) {
  const { wa, llm, store } = deps
  const now = deps.now ?? (() => new Date())
  const log: Log = deps.log ?? { info() {}, warn() {}, error() {} }
  let bills: Bill[] = []

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
  const notFound = (q: string) => `não achei "${q}". Contas: ${billNames().join(', ')}`

  async function postList() {
    const { key, paid } = month()
    const sentKey = await wa.sendText(renderList(key, bills, paid))
    const prev = state()._meta.pinned
    try {
      if (prev) await wa.unpin(prev)
      await wa.pin(sentKey)
      state()._meta.pinned = { id: sentKey.id, fromMe: sentKey.fromMe, remoteJid: sentKey.remoteJid }
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
    if (existed) await wa.sendText('atualizado', m.key)
    await postList()
  }

  const active = () => Boolean(state()._meta.last_reset)
  // Last text we wrote: if WhatsApp hands back something slightly different, don't fight it forever.
  let lastWritten = ''

  async function writeDescription(text: string) {
    const meta = state()._meta
    try {
      await wa.setDescription(text)
      lastWritten = text
      meta.section = true
    } catch (e) {
      // Stays a failure: `meta.section` is only set on success here; onboarding sets it itself (see join).
      log.warn({ err: e }, 'description write refused (bot may need admin)')
      if (!meta.desc_warned) {
        meta.desc_warned = true
        await wa.sendText(DESC_DENIED)
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
    const changed = renderSection(next) !== renderSection(bills)
    bills = next
    meta.bills = bills.map(billLine)
    const want = composeDescription(top, bills)
    if (want === desc) meta.section = true
    else if (want !== lastWritten) await writeDescription(want)
    await store.save()
    return changed
  }

  async function handleCommand(m: Incoming): Promise<boolean> {
    const c = parseCommand(m.text)
    if (!c) return false
    switch (c.cmd) {
      case 'pago': {
        const bill = resolveBill(bills, c.name)
        if (!bill) { await wa.sendText(notFound(c.name), m.key); return true }
        await markPaid(bill, c.amount, m)
        return true
      }
      case 'despago': {
        const bill = resolveBill(bills, c.name)
        if (!bill) { await wa.sendText(notFound(c.name), m.key); return true }
        delete month().paid[bill.key]
        await store.save()
        await wa.react(m.key, '✅')
        await postList()
        return true
      }
      case 'lista': await postList(); return true
      case 'ajuda': await wa.sendText(HELP, m.key); return true
      case 'unknown': await wa.sendText(UNKNOWN_CMD, m.key); return true
    }
  }

  async function handleMedia(m: Incoming) {
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
      await wa.sendText(DOWNLOAD_FAILED, m.key)
      return
    }
    const c = parseCommand(m.text)
    const known = c?.cmd === 'pago' ? resolveBill(bills, c.name) : resolveBill(bills, m.text) ?? matchPlainText(bills, m.text)
    const typed = c?.cmd === 'pago' ? c.amount : null
    const verdict = await llm.readReceipt(image, mime, m.text, billNames())
    if (known) {
      if (!verdict && typed == null) await wa.sendText(NO_AMOUNT, m.key)
      await markPaid(known, typed ?? verdict?.amount ?? null, m)
      return
    }
    const bill = verdict && verdict.confidence >= CONFIDENCE ? bills.find(b => b.name === verdict.bill) : undefined
    if (!bill) { await wa.sendText(ASK, m.key); return }
    await markPaid(bill, verdict!.amount, m)
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
        if (phones === null) throw new Error('could not resolve member phones; not deciding on this group now')
        if (!phones.some(p => (deps.owners ?? []).includes(p))) {
          await wa.sendText(PRIVATE)
          await wa.leave()
          return 'left'
        }
        const desc = await wa.getDescription()
        bills = parseDescription(DEMO_BILLS)
        meta.bills = bills.map(billLine)
        // A new group is section-style from birth: even if the write below is refused, a later description
        // without our section means "keep their text, restore the list", never "their text is the bill list".
        meta.section = true
        await writeDescription(composeDescription(splitDescription(desc).original, bills))
        await wa.sendText(INTRO)
        await postList()
        // Active only once the list is out: if anything above throws, the next join retries the whole onboarding.
        meta.last_reset = monthKey(now())
        await store.save()
        log.info({ bills: billNames() }, 'group onboarded')
        return 'onboarded'
      })
    },

    onDescription(desc: string) {
      return serial(async () => {
        if (!active()) return
        if (await reconcile(desc)) {
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
        if (m.mentionsBot || m.repliesToBot || isGreeting(m.text)) await wa.sendText(INTRO, m.key)
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
