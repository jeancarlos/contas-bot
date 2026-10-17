import type { CommandName, SubName } from './commands.ts'
import { monthTitle } from './month.ts'
import type { Lang, ListMsg, Locale, Msg } from './types.ts'

type Catalog = { [K in Msg['k']]: (m: Extract<Msg, { k: K }>, loc: Locale) => string }
type Words = {
  cmd: Record<CommandName, string>
  sub: Record<SubName, string>
  title: string
  paid: string
  total: string
  noAmount: string
}

export const WORDS: Record<Lang, Words> = {
  'pt-BR': {
    cmd: { pago: 'pago', despago: 'despago', lista: 'lista', ajuda: 'ajuda', conta: 'conta' },
    sub: { add: 'adiciona', remove: 'remove', pause: 'pausa', resume: 'continua', rename: 'renomeia' },
    title: 'Contas',
    paid: 'Pago',
    total: 'Total',
    noAmount: 'sem valor',
  },
  en: {
    cmd: { pago: 'paid', despago: 'unpaid', lista: 'list', ajuda: 'help', conta: 'bill' },
    sub: { add: 'add', remove: 'remove', pause: 'pause', resume: 'resume', rename: 'rename' },
    title: 'Bills',
    paid: 'Paid',
    total: 'Total',
    noAmount: 'without amount',
  },
  es: {
    cmd: { pago: 'pagado', despago: 'despagado', lista: 'lista', ajuda: 'ayuda', conta: 'cuenta' },
    sub: { add: 'agrega', remove: 'elimina', pause: 'pausa', resume: 'reanuda', rename: 'renombra' },
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

function suggestion(m: Extract<Msg, { k: 'suggest' | 'askConfirm' }>, loc: Locale): string {
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
      '/pago avulsa <nome> <valor> — gasto extra, só na lista do mês',
      '/despago <conta> [mês/ano] — desmarca (ou /reverter)',
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
  onePerCommand: m =>
    `um /${WORDS['pt-BR'].cmd[m.cmd]} por conta: ${m.bills.map(b => `/${WORDS['pt-BR'].cmd[m.cmd]} ${b.toLowerCase()}`).join(' · ')}`,
  pagoSyntax: () => 'um valor e um mês por comando: /pago <conta> [valor] [mês/ano]',
  oneOffSyntax: () => 'gasto avulso: /pago avulsa <nome> <valor> [mês/ano], sem números no nome',
  futureMonth: () => 'esse mês ainda não chegou',
  unknownCmd: m =>
    m.suggestion
      ? `não conheço /${m.typed}, você quis dizer /${WORDS['pt-BR'].cmd[m.suggestion]}? /ajuda mostra todos.`
      : 'não conheço esse comando. /ajuda mostra todos.',
  unknownSub: m =>
    m.suggestion
      ? `não conheço "${m.typed}", você quis dizer /conta ${WORDS['pt-BR'].sub[m.suggestion]}?`
      : CONTA_HELP['pt-BR'],
  updated: () => 'atualizado',
  askAmount: m =>
    m.read
      ? `não consegui ler o valor de ${m.bill}. Qual foi? Responda só o valor, ex: 80,00`
      : `qual foi o valor de ${m.bill}? Responda só o valor, ex: 80,00`,
  askConfirm: (m, loc) => `você quis dizer \`${suggestion(m, loc)}\`? Responda *sim* pra confirmar.`,
  askBill: m => `qual conta? Responda o nome: ${m.names.join(', ')}`,
  askOneOff: m => `não achei "${m.name}". Responda *sim* pra lançar como avulsa, ou o nome da conta.`,
  noAmount: () => 'não li o valor do comprovante, marquei sem valor',
  editIgnored: m =>
    m.payment ? 'edição não altera pagamento: use /despago' : 'edição não refaz o comando: mande um novo',
  nameTaken: m => `já existe uma conta "${m.name}"`,
  nameInvalid: () => 'nome de conta vazio ou com mais de 40 caracteres',
  intro: () =>
    [
      '👋 Oi! Eu sou o *contas-bot*, cuido da lista de contas do mês deste grupo.',
      '',
      '🧾 Cadastre as contas: /conta adiciona luz',
      '📎 Pagou? Manda o comprovante (foto ou PDF) com a legenda /pago luz: eu marco e leio o valor.',
      '📝 Sem comprovante: /pago luz 231,45',
      '🤫 Só respondo a comandos: o resto da conversa eu ignoro.',
      '📌 A lista fica sempre fixada, com o total do mês.',
      '📅 Todo dia 1º começo uma lista nova.',
      '',
      '/ajuda mostra todos os comandos.',
    ].join('\n'),
  saveFailed: () => 'não consegui salvar, tenta de novo',
  descriptionNotice: () =>
    'não consegui editar a descrição do grupo: alguém apaga de lá a parte antiga do contas-bot? As contas agora ficam em /conta.',
  descLine: () => '📋 contas: /conta · /lista · /ajuda',
  moreChanges: m => `…e mais ${m.n}`,
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
      '/paid extra <name> <amount> — one-off expense, only on that month list',
      '/unpaid <bill> [month/year] — unmark (or /revert)',
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
  onePerCommand: m =>
    `one /${WORDS.en.cmd[m.cmd]} per bill: ${m.bills.map(b => `/${WORDS.en.cmd[m.cmd]} ${b.toLowerCase()}`).join(' · ')}`,
  pagoSyntax: () => 'one amount and one month per command: /paid <bill> [amount] [month/year]',
  oneOffSyntax: () => 'one-off expense: /paid extra <name> <amount> [month/year], no numbers in the name',
  futureMonth: () => "that month hasn't come yet",
  unknownCmd: m =>
    m.suggestion
      ? `I don't know /${m.typed}, did you mean /${WORDS.en.cmd[m.suggestion]}? /help lists them all.`
      : "I don't know that command. /help lists them all.",
  unknownSub: m =>
    m.suggestion ? `I don't know "${m.typed}", did you mean /bill ${WORDS.en.sub[m.suggestion]}?` : CONTA_HELP.en,
  updated: () => 'updated',
  askAmount: m =>
    m.read
      ? `couldn't read the amount for ${m.bill}. How much was it? Reply with just the amount, e.g. 80.00`
      : `how much was ${m.bill}? Reply with just the amount, e.g. 80.00`,
  askConfirm: (m, loc) => `did you mean \`${suggestion(m, loc)}\`? Reply *yes* to confirm.`,
  askBill: m => `which bill? Reply with its name: ${m.names.join(', ')}`,
  askOneOff: m => `couldn't find "${m.name}". Reply *yes* to record it as a one-off, or with the bill name.`,
  noAmount: () => "couldn't read the amount on the receipt, marked without one",
  editIgnored: m =>
    m.payment ? "an edit doesn't change a payment: use /unpaid" : "an edit doesn't redo the command: send a new one",
  nameTaken: m => `there is already a bill "${m.name}"`,
  nameInvalid: () => 'bill name is empty or longer than 40 characters',
  intro: () =>
    [
      "👋 Hi! I'm *contas-bot*, I keep this group's monthly bill list.",
      '',
      '🧾 Add the bills: /bill add power',
      '📎 Paid something? Send the receipt (photo or PDF) captioned /paid power: I tick it and read the amount.',
      '📝 No receipt: /paid power 231.45',
      '🤫 I only answer commands: I ignore the rest of the chat.',
      '📌 The list is always pinned, with the month total.',
      '📅 Every 1st of the month I start a fresh list.',
      '',
      '/help shows every command.',
    ].join('\n'),
  saveFailed: () => "couldn't save, try again",
  descriptionNotice: () =>
    "I couldn't edit the group description: could someone delete the old contas-bot part there? Bills now live in /bill.",
  descLine: () => '📋 bills: /bill · /list · /help',
  moreChanges: m => `…and ${m.n} more`,
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
      '/pagado extra <nombre> <monto> — gasto suelto, solo en la lista del mes',
      '/despagado <cuenta> [mes/año] — desmarca (o /revertir)',
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
  onePerCommand: m =>
    `un /${WORDS.es.cmd[m.cmd]} por cuenta: ${m.bills.map(b => `/${WORDS.es.cmd[m.cmd]} ${b.toLowerCase()}`).join(' · ')}`,
  pagoSyntax: () => 'un monto y un mes por comando: /pagado <cuenta> [monto] [mes/año]',
  oneOffSyntax: () => 'gasto suelto: /pagado extra <nombre> <monto> [mes/año], sin números en el nombre',
  futureMonth: () => 'ese mes todavía no llegó',
  unknownCmd: m =>
    m.suggestion
      ? `no conozco /${m.typed}, ¿quisiste decir /${WORDS.es.cmd[m.suggestion]}? /ayuda los muestra todos.`
      : 'no conozco ese comando. /ayuda los muestra todos.',
  unknownSub: m =>
    m.suggestion ? `no conozco "${m.typed}", ¿quisiste decir /cuenta ${WORDS.es.sub[m.suggestion]}?` : CONTA_HELP.es,
  updated: () => 'actualizado',
  askAmount: m =>
    m.read
      ? `no pude leer el monto de ${m.bill}. ¿Cuánto fue? Responde solo el monto, ej: 80,00`
      : `¿cuánto fue ${m.bill}? Responde solo el monto, ej: 80,00`,
  askConfirm: (m, loc) => `¿quisiste decir \`${suggestion(m, loc)}\`? Responde *sí* para confirmar.`,
  askBill: m => `¿qué cuenta? Responde el nombre: ${m.names.join(', ')}`,
  askOneOff: m =>
    `no encontré "${m.name}". Responde *sí* para registrarlo como gasto suelto, o el nombre de la cuenta.`,
  noAmount: () => 'no leí el monto del comprobante, la marqué sin monto',
  editIgnored: m =>
    m.payment ? 'una edición no cambia el pago: usa /despagado' : 'una edición no rehace el comando: envía uno nuevo',
  nameTaken: m => `ya existe una cuenta "${m.name}"`,
  nameInvalid: () => 'nombre de cuenta vacío o con más de 40 caracteres',
  intro: () =>
    [
      '👋 ¡Hola! Soy *contas-bot*, llevo la lista de cuentas del mes de este grupo.',
      '',
      '🧾 Agrega las cuentas: /cuenta agrega luz',
      '📎 ¿Pagaste algo? Manda el comprobante (foto o PDF) con el texto /pagado luz: la marco y leo el monto.',
      '📝 Sin comprobante: /pagado luz 231,45',
      '🤫 Solo respondo a comandos: el resto de la conversación lo ignoro.',
      '📌 La lista queda siempre fijada, con el total del mes.',
      '📅 Cada día 1 empiezo una lista nueva.',
      '',
      '/ayuda muestra todos los comandos.',
    ].join('\n'),
  saveFailed: () => 'no pude guardar, intenta de nuevo',
  descriptionNotice: () =>
    'no pude editar la descripción del grupo: ¿alguien borra de ahí la parte vieja de contas-bot? Las cuentas ahora están en /cuenta.',
  descLine: () => '📋 cuentas: /cuenta · /lista · /ayuda',
  moreChanges: m => `…y ${m.n} más`,
}

const CATALOGS: Record<Lang, Catalog> = { 'pt-BR': ptBR, en, es }

export function render(msg: Msg, loc: Locale): string {
  const fn = CATALOGS[loc.lang][msg.k] as (m: Msg, l: Locale) => string
  return fn(msg, loc)
}

const isLang = (s: string): s is Lang => Object.hasOwn(CATALOGS, s)

function validZone(tz: string): boolean {
  if (!tz) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export function makeLocale(lang: string, currency: string, timeZone: string): Locale {
  if (!isLang(lang)) throw new Error(`unsupported BOT_LANG "${lang}": use pt-BR, en or es`)
  if (!/^[A-Za-z]{3}$/.test(currency))
    throw new Error(`invalid BOT_CURRENCY "${currency}": use an ISO 4217 code like BRL, USD, EUR`)
  const decimal =
    new Intl.NumberFormat(lang).formatToParts(1.5).find(p => p.type === 'decimal')?.value === '.' ? '.' : ','
  return {
    lang,
    currency: currency.toUpperCase(),
    decimal,
    timeZone: validZone(timeZone) ? timeZone : 'America/Sao_Paulo',
  }
}
