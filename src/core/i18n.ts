import type { CommandName } from './commands.ts'
import { monthTitle } from './month.ts'
import type { Lang, ListMsg, Locale, Msg } from './types.ts'

type Catalog = { [K in Msg['k']]: (m: Extract<Msg, { k: K }>, loc: Locale) => string }
type Words = { cmd: Record<CommandName, string>; title: string; paid: string; total: string; noAmount: string }

export const WORDS: Record<Lang, Words> = {
  'pt-BR': {
    cmd: { pago: 'pago', despago: 'despago', lista: 'lista', ajuda: 'ajuda', conta: 'conta' },
    title: 'Contas',
    paid: 'Pago',
    total: 'Total',
    noAmount: 'sem valor',
  },
  en: {
    cmd: { pago: 'paid', despago: 'unpaid', lista: 'list', ajuda: 'help', conta: 'bill' },
    title: 'Bills',
    paid: 'Paid',
    total: 'Total',
    noAmount: 'without amount',
  },
  es: {
    cmd: { pago: 'pagado', despago: 'despagado', lista: 'lista', ajuda: 'ayuda', conta: 'cuenta' },
    title: 'Cuentas',
    paid: 'Pagado',
    total: 'Total',
    noAmount: 'sin monto',
  },
}

export function formatMoney(cents: number, loc: Locale): string {
  return new Intl.NumberFormat(loc.lang, { style: 'currency', currency: loc.currency })
    .format(cents / 100)
    .replace(/[\u00a0\u202f]/g, ' ')
}

function plainAmount(cents: number, loc: Locale): string {
  const n = (cents / 100).toFixed(2)
  return loc.decimal === ',' ? n.replace('.', ',') : n
}

function renderList(m: ListMsg, loc: Locale): string {
  const w = WORDS[loc.lang]
  const active = m.items.filter(i => !i.paused)
  const done = active.filter(i => i.paid)
  const lines = [`📋 *${w.title} — ${monthTitle(m.month, loc.lang)}*`, '']
  for (const i of done) lines.push(i.amount === null ? `✅ ${i.name}` : `✅ ${i.name} — ${formatMoney(i.amount, loc)}`)
  for (const i of active.filter(x => !x.paid)) lines.push(`⬜ ${i.name}`)
  for (const i of m.items.filter(x => x.paused)) lines.push(`⏸️ ${i.name}`)
  const total = done.reduce((sum, i) => sum + (i.amount ?? 0), 0)
  const missing = done.filter(i => i.amount === null).length
  const tail = missing > 0 ? ` (${missing} ${w.noAmount})` : ''
  lines.push('', `*${w.paid}:* ${done.length}/${active.length} · *${w.total}:* ${formatMoney(total, loc)}${tail}`)
  return lines.join('\n')
}

function suggestion(m: Extract<Msg, { k: 'suggest' }>, loc: Locale): string {
  const [y, mm] = (m.month ?? '').split('-')
  const parts = [`/${WORDS[loc.lang].cmd[m.cmd]}`, m.bill.toLowerCase()]
  if (m.amount !== null) parts.push(plainAmount(m.amount, loc))
  if (m.month) parts.push(`${mm}/${y}`)
  return parts.join(' ')
}

const billLines = (m: Extract<Msg, { k: 'bills' }>, paused: string) =>
  m.bills.map(b => (b.paused ? `⏸️ ${b.name} (${paused})` : `• ${b.name}`)).join('\n')

const CONTA_HELP: Record<Lang, string> = {
  'pt-BR': [
    '/conta adiciona <nome>',
    '/conta remove <nome>',
    '/conta pausa <nome> · /conta continua <nome>',
    '/conta renomeia <nome> = <novo nome>',
  ].join('\n'),
  en: [
    '/bill add <name>',
    '/bill remove <name>',
    '/bill pause <name> · /bill resume <name>',
    '/bill rename <name> = <new name>',
  ].join('\n'),
  es: [
    '/cuenta agrega <nombre>',
    '/cuenta elimina <nombre>',
    '/cuenta pausa <nombre> · /cuenta reanuda <nombre>',
    '/cuenta renombra <nombre> = <nuevo nombre>',
  ].join('\n'),
}

const ptBR: Catalog = {
  list: renderList,
  bills: m => `🧾 *Contas*\n${billLines(m, 'pausada')}\n\n${CONTA_HELP['pt-BR']}`,
  help: () =>
    [
      '🤖 *Comandos do contas-bot*',
      '',
      '/pago <conta> [valor] [mês/ano] — marca como paga',
      '   ex: /pago luz · /pago cartão nu 6.237,60 · /pago luz 80 09/2026',
      '/despago <conta> [mês/ano] — desmarca',
      '/lista — reposta e fixa a lista do mês',
      '/conta — gerencia as contas',
      '/ajuda — esta mensagem',
      '',
      '📎 Comprovante com a legenda /pago <conta> = paga, com o valor lido do comprovante.',
    ].join('\n'),
  contaHelp: () => CONTA_HELP['pt-BR'],
  suggest: (m, loc) => `você quis dizer \`${suggestion(m, loc)}\`?`,
  notFound: m => `não achei "${m.q}". Contas: ${m.names.join(', ')}`,
  missingBill: m => (m.cmd === 'pago' ? 'faltou a conta: /pago luz 80,00' : 'faltou a conta: /despago luz'),
  onePerCommand: m => `um /pago por conta: ${m.bills.map(b => `/pago ${b.toLowerCase()}`).join(' · ')}`,
  pagoSyntax: () => 'um valor e um mês por comando: /pago <conta> [valor] [mês/ano]',
  futureMonth: () => 'esse mês ainda não chegou',
  unknownCmd: m =>
    m.suggestion
      ? `não conheço /${m.typed}, você quis dizer /${m.suggestion}? /ajuda mostra todos.`
      : 'não conheço esse comando. /ajuda mostra todos.',
  unknownSub: m =>
    m.suggestion ? `não conheço "${m.typed}", você quis dizer /conta ${m.suggestion}?` : CONTA_HELP['pt-BR'],
  updated: () => 'atualizado',
  noAmount: () => 'não li o valor do comprovante, marquei sem valor',
  editIgnored: () => 'edição não altera pagamento: use /despago',
  nameTaken: m => `já existe uma conta "${m.name}"`,
  nameInvalid: () => 'nome de conta vazio ou com mais de 40 caracteres',
}

const en: Catalog = {
  list: renderList,
  bills: m => `🧾 *Bills*\n${billLines(m, 'paused')}\n\n${CONTA_HELP.en}`,
  help: () =>
    [
      '🤖 *contas-bot commands*',
      '',
      '/paid <bill> [amount] [month/year] — mark as paid',
      '   e.g. /paid power · /paid credit card 6,237.60 · /paid power 80 09/2026',
      '/unpaid <bill> [month/year] — unmark',
      "/list — repost and pin this month's list",
      '/bill — manage the bills',
      '/help — this message',
      '',
      '📎 Receipt captioned /paid <bill> = paid, with the amount read from the receipt.',
    ].join('\n'),
  contaHelp: () => CONTA_HELP.en,
  suggest: (m, loc) => `did you mean \`${suggestion(m, loc)}\`?`,
  notFound: m => `couldn't find "${m.q}". Bills: ${m.names.join(', ')}`,
  missingBill: m => (m.cmd === 'pago' ? 'missing the bill: /paid power 80.00' : 'missing the bill: /unpaid power'),
  onePerCommand: m => `one /paid per bill: ${m.bills.map(b => `/paid ${b.toLowerCase()}`).join(' · ')}`,
  pagoSyntax: () => 'one amount and one month per command: /paid <bill> [amount] [month/year]',
  futureMonth: () => "that month hasn't come yet",
  unknownCmd: m =>
    m.suggestion
      ? `I don't know /${m.typed}, did you mean /${m.suggestion}? /help lists them all.`
      : "I don't know that command. /help lists them all.",
  unknownSub: m => (m.suggestion ? `I don't know "${m.typed}", did you mean /bill ${m.suggestion}?` : CONTA_HELP.en),
  updated: () => 'updated',
  noAmount: () => "couldn't read the amount on the receipt, marked without one",
  editIgnored: () => "an edit doesn't change a payment: use /unpaid",
  nameTaken: m => `there is already a bill "${m.name}"`,
  nameInvalid: () => 'bill name is empty or longer than 40 characters',
}

const es: Catalog = {
  list: renderList,
  bills: m => `🧾 *Cuentas*\n${billLines(m, 'pausada')}\n\n${CONTA_HELP.es}`,
  help: () =>
    [
      '🤖 *Comandos de contas-bot*',
      '',
      '/pagado <cuenta> [monto] [mes/año] — marca como pagada',
      '   ej: /pagado luz · /pagado tarjeta 6.237,60 · /pagado luz 80 09/2026',
      '/despagado <cuenta> [mes/año] — desmarca',
      '/lista — vuelve a publicar y fijar la lista del mes',
      '/cuenta — gestiona las cuentas',
      '/ayuda — este mensaje',
      '',
      '📎 Comprobante con el texto /pagado <cuenta> = pagada, con el monto leído del comprobante.',
    ].join('\n'),
  contaHelp: () => CONTA_HELP.es,
  suggest: (m, loc) => `¿quisiste decir \`${suggestion(m, loc)}\`?`,
  notFound: m => `no encontré "${m.q}". Cuentas: ${m.names.join(', ')}`,
  missingBill: m => (m.cmd === 'pago' ? 'falta la cuenta: /pagado luz 80,00' : 'falta la cuenta: /despagado luz'),
  onePerCommand: m => `un /pagado por cuenta: ${m.bills.map(b => `/pagado ${b.toLowerCase()}`).join(' · ')}`,
  pagoSyntax: () => 'un monto y un mes por comando: /pagado <cuenta> [monto] [mes/año]',
  futureMonth: () => 'ese mes todavía no llegó',
  unknownCmd: m =>
    m.suggestion
      ? `no conozco /${m.typed}, ¿quisiste decir /${m.suggestion}? /ayuda los muestra todos.`
      : 'no conozco ese comando. /ayuda los muestra todos.',
  unknownSub: m => (m.suggestion ? `no conozco "${m.typed}", ¿quisiste decir /cuenta ${m.suggestion}?` : CONTA_HELP.es),
  updated: () => 'actualizado',
  noAmount: () => 'no leí el monto del comprobante, la marqué sin monto',
  editIgnored: () => 'una edición no cambia el pago: usa /despagado',
  nameTaken: m => `ya existe una cuenta "${m.name}"`,
  nameInvalid: () => 'nombre de cuenta vacío o con más de 40 caracteres',
}

const CATALOGS: Record<Lang, Catalog> = { 'pt-BR': ptBR, en, es }

export function render(msg: Msg, loc: Locale): string {
  const fn = CATALOGS[loc.lang][msg.k] as (m: Msg, l: Locale) => string
  return fn(msg, loc)
}
