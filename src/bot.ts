import {
  parseDescription, resolveBill, parseCommand, matchPlainText, renderList, monthKey,
  type Bill,
} from './bills.ts'
import type { StateStore, PinKey } from './state.ts'
import type { Llm, Verdict } from './llm.ts'

export type MsgKey = { id: string; fromMe: boolean; remoteJid: string; participant?: string }
export type Incoming = {
  key: MsgKey
  sender: string
  text: string
  media?: { mime: string; download(): Promise<Buffer> }
}
export type Wa = {
  sendText(text: string, quoted?: MsgKey): Promise<MsgKey>
  react(key: MsgKey, emoji: string): Promise<void>
  pin(key: MsgKey): Promise<void>
  unpin(key: MsgKey): Promise<void>
  getDescription(): Promise<string>
}
type Log = { info(o: any, m?: string): void; warn(o: any, m?: string): void; error(o: any, m?: string): void }
export type BotDeps = {
  wa: Wa
  llm: Llm
  store: StateStore
  now?: () => Date
  log?: Log
  pdfToPng?: (pdf: Buffer) => Promise<Buffer>
}

const CONFIDENCE = 0.7
const HELP = '/pago <conta> [valor] · /despago <conta> · /lista · edite a descrição do grupo para mudar as contas'
const ASK = 'esse comprovante é de qual conta? responde /pago <nome>'
const NO_AMOUNT = 'sem valor (LLM indisponível)'
const EMPTY_DESC = 'descrição do grupo vazia, usando lista anterior'

export function makeBot(deps: BotDeps) {
  const { wa, llm, store } = deps
  const now = deps.now ?? (() => new Date())
  const log: Log = deps.log ?? { info() {}, warn() {}, error() {} }
  let bills: Bill[] = []

  const state = () => store.get()
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
    const prev: PinKey | undefined = state()._meta.pinned
    try {
      if (prev) await wa.unpin(prev)
      await wa.pin(sentKey)
    } catch (e) {
      log.warn({ err: e }, 'pin failed (group may restrict pinning to admins)')
    }
    state()._meta.pinned = { id: sentKey.id, fromMe: sentKey.fromMe, remoteJid: sentKey.remoteJid }
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

  async function setBills(desc: string): Promise<boolean> {
    const parsed = parseDescription(desc)
    if (parsed.length === 0) return false
    bills = parsed
    state()._meta.bills = desc.split('\n').map(l => l.trim()).filter(Boolean)
    await store.save()
    return true
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
      case 'unknown': await wa.sendText(HELP, m.key); return true
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
      return
    }
    const known = resolveBill(bills, m.text)
    const verdict: Verdict | null = await llm.readReceipt(image, mime, m.text, billNames())
    if (known) {
      if (!verdict) await wa.sendText(NO_AMOUNT, m.key)
      await markPaid(known, verdict?.amount ?? null, m)
      return
    }
    const bill = verdict && verdict.bill && verdict.confidence >= CONFIDENCE
      ? bills.find(b => b.name === verdict.bill) ?? null
      : null
    if (!bill) { await wa.sendText(ASK, m.key); return }
    await markPaid(bill, verdict!.amount, m)
  }

  return {
    bills: () => bills,

    async start() {
      let desc = ''
      try { desc = await wa.getDescription() } catch (e) { log.warn({ err: e }, 'description unreadable') }
      if (!(await setBills(desc))) {
        bills = parseDescription((state()._meta.bills ?? []).join('\n'))
        await wa.sendText(EMPTY_DESC)
      }
      log.info({ bills: billNames() }, 'bills loaded')
    },

    async onDescription(desc: string) {
      if (await setBills(desc)) log.info({ bills: billNames() }, 'bills updated from description')
    },

    async onMessage(m: Incoming) {
      if (m.key.fromMe) return
      try {
        if (m.media) return await handleMedia(m)
        if (await handleCommand(m)) return
        const bill = matchPlainText(bills, m.text)
        if (bill) await markPaid(bill, null, m)
      } catch (e) {
        log.error({ err: e, id: m.key.id }, 'message handling failed')
      }
    },

    async tick() {
      const key = monthKey(now())
      if (state()._meta.last_reset === key) return
      state().months[key] ??= {}
      state()._meta.last_reset = key
      await store.save()
      await postList()
    },
  }
}
