export type Lang = 'pt-BR' | 'en' | 'es'
export type Locale = { lang: Lang; currency: string; decimal: ',' | '.'; timeZone: string }

export type Bill = { id: number; name: string; key: string; paused: boolean; removed: boolean }
export type AmountStatus = 'typed' | 'read' | 'pending' | 'none'
export type Payment = { amount: number | null; status: AmountStatus; by: string; paidAt: number; messageId: string }
export type Handled = { id: string; changed: boolean; warned: boolean }
// A question the bot is waiting on: only the asker's next plain message can answer it.
export type Ask = { who: string; at: number } & (
  | { q: 'amount'; month: string; billId: number; messageId: string }
  | {
      q: 'confirm'
      cmd: 'pago' | 'despago'
      billId: number
      amount: number | null
      month: string | null
      media?: MediaRef
    }
  | { q: 'bill'; media: MediaRef }
)
export type GroupState = {
  bills: Bill[]
  nextBillId: number
  months: Record<string, Record<number, Payment>>
  handled: Handled[]
  pinnedId: string | null
  lastReset: string | null
  // ponytail: in memory only (a MediaRef cannot be stored), so a restart drops open questions; persist if that bites.
  asks: Ask[]
}

export const emptyState = (): GroupState => ({
  bills: [],
  nextBillId: 1,
  months: {},
  handled: [],
  pinnedId: null,
  lastReset: null,
  asks: [],
})

export type MsgKey = { id: string; fromMe: boolean; remoteJid: string; participant?: string }
// The handle rides in state while a question is open, so it must survive structuredClone.
export type MediaRef = { mime: string; handle: unknown }

export type MessageInput = {
  kind: 'message'
  key: MsgKey
  sender: string
  text: string
  at: number
  media?: MediaRef
  quoted?: MediaRef
}
export type EditInput = { kind: 'edit'; key: MsgKey; sender: string; text: string; at: number }

export type Input =
  | MessageInput
  | EditInput
  | { kind: 'amountRead'; key: MsgKey; month: string; billId: number; amount: number | null; at: number }
  | { kind: 'listPosted'; messageId: string }
  | { kind: 'tick'; at: number }

export type ListItem = { name: string; paused: boolean; paid: boolean; amount: number | null }
export type ListMsg = { k: 'list'; month: string; items: ListItem[] }
export type Msg =
  | ListMsg
  | { k: 'bills'; bills: { name: string; paused: boolean }[] }
  | { k: 'help' }
  | { k: 'contaHelp' }
  | { k: 'suggest'; cmd: 'pago' | 'despago'; bill: string; amount: number | null; month: string | null }
  | { k: 'notFound'; q: string; names: string[] }
  | { k: 'missingBill'; cmd: 'pago' | 'despago' }
  | { k: 'onePerCommand'; cmd: 'pago' | 'despago'; bills: string[] }
  | { k: 'pagoSyntax' }
  | { k: 'oneOffSyntax' }
  | { k: 'futureMonth' }
  | { k: 'unknownCmd'; typed: string; suggestion: string | null }
  | { k: 'unknownSub'; typed: string; suggestion: string | null }
  | { k: 'updated' }
  | { k: 'askAmount'; bill: string }
  | { k: 'askConfirm'; cmd: 'pago' | 'despago'; bill: string; amount: number | null; month: string | null }
  | { k: 'askBill'; names: string[] }
  | { k: 'editIgnored' }
  | { k: 'nameTaken'; name: string }
  | { k: 'nameInvalid' }

export type Effect =
  | { kind: 'reply'; to: MsgKey; msg: Msg }
  | { kind: 'postList'; msg: ListMsg }
  | { kind: 'react'; to: MsgKey }
  | { kind: 'pin'; messageId: string }
  | { kind: 'unpin'; messageId: string }
  | { kind: 'readAmount'; to: MsgKey; media: MediaRef; month: string; billId: number }
