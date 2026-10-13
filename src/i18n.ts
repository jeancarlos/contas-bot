export type Lang = 'pt-BR' | 'en' | 'es'

export type Catalog = {
  listTitle: string
  paidLabel: string
  totalLabel: string
  noAmount: (n: number) => string
  pauseWord: string
  sectionTitle: string
  sectionHelp: string
  descPlaceholder: string
  demoBills: string
  intro: string
  help: string
  noLlmAmount: string
  saveFailed: string
  downloadFailed: string
  unknownCmd: string
  unknownCmdSuggest: (typed: string, cmd: string) => string
  missingBillPago: string
  missingBillDespago: string
  descDenied: string
  descTooLong: string
  updated: string
  moreChanges: (n: number) => string
  notFound: (q: string, names: string, suggest?: string[]) => string
}

export type Locale = { lang: Lang; currency: string; decimal: ',' | '.'; t: Catalog }

const ptBR: Catalog = {
  listTitle: 'Contas',
  paidLabel: 'Pago',
  totalLabel: 'Total',
  noAmount: n => `${n} sem valor`,
  pauseWord: 'pausado',
  sectionTitle: 'Contas (edite esta lista):',
  sectionHelp: '/pago <conta> [valor] · /lista · /help',
  descPlaceholder:
    '✏️ Escreva aqui a descrição do grupo (apague estas linhas).\n⚠️ Abaixo é do bot: mude só a lista de contas.',
  demoBills: 'Luz\nÁgua\nInternet\nAluguel\nAcademia (pausado)',
  intro: [
    '👋 Oi! Eu sou o *contas-bot*, cuido da lista de contas do mês deste grupo.',
    '',
    '📎 Pagou? Manda o comprovante (foto ou PDF) com a legenda /pago luz: eu marco e leio o valor.',
    '✍️ Sem comprovante: /pago luz 231,45',
    '🤫 Só respondo a comandos: o resto da conversa eu ignoro.',
    '📌 A lista fica sempre fixada, com o total do mês.',
    '📝 As contas ficam na descrição do grupo: edite a lista lá que eu atualizo.',
    '🗓️ Todo dia 1º começo uma lista nova.',
    '',
    '/help mostra todos os comandos.',
  ].join('\n'),
  help: [
    '🤖 *Comandos do contas-bot*',
    '',
    '/pago <conta> [valor] — marca como paga',
    '   ex: /pago luz · /pago cartão nu 6.237,60',
    '/despago <conta> — desmarca (ou /reverter)',
    '/lista — reposta e fixa a lista',
    '/help — esta mensagem',
    '',
    '📎 Comprovante com a legenda /pago <conta> = paga, com o valor lido do comprovante.',
    '📝 Mudar as contas: edite a lista na descrição do grupo. "(pausado)" no fim tira a conta do mês sem apagar.',
  ].join('\n'),
  noLlmAmount: 'não li o valor do comprovante, marquei sem valor',
  saveFailed: 'não consegui salvar, tenta de novo',
  downloadFailed: 'não consegui ler o comprovante, manda de novo ou usa /pago <nome> [valor]',
  unknownCmd: 'não conheço esse comando. /help mostra todos.',
  unknownCmdSuggest: (typed, cmd) => `não conheço /${typed}, você quis dizer /${cmd}? /help mostra todos.`,
  missingBillPago: 'faltou a conta: /pago luz 80,00',
  missingBillDespago: 'faltou a conta: /despago luz',
  descDenied: 'não consigo editar a descrição: me torna admin ou libera "editar dados do grupo" pra todos',
  descTooLong: 'a descrição do grupo passou do limite do WhatsApp: encurte o texto acima da lista do bot',
  updated: 'atualizado',
  moreChanges: n => `…e mais ${n}`,
  notFound: (q, names, suggest) =>
    suggest?.length
      ? `não achei "${q}", você quis dizer ${suggest.map(n => `*${n}*`).join(' ou ')}? Contas: ${names}`
      : `não achei "${q}". Contas: ${names}`,
}

const en: Catalog = {
  listTitle: 'Bills',
  paidLabel: 'Paid',
  totalLabel: 'Total',
  noAmount: n => `${n} without amount`,
  pauseWord: 'paused',
  sectionTitle: 'Bills (edit this list):',
  sectionHelp: '/paid <bill> [amount] · /list · /help',
  descPlaceholder:
    "✏️ Write the group description here (delete these lines).\n⚠️ Below is the bot's part: change only the bill list.",
  demoBills: 'Electricity\nWater\nInternet\nRent\nGym (paused)',
  intro: [
    "👋 Hi! I'm *contas-bot*, I keep this group's monthly bill list.",
    '',
    '📎 Paid something? Send the receipt (photo or PDF) captioned /paid electricity: I tick it and read the amount.',
    '✍️ No receipt: /paid electricity 231.45',
    '🤫 I only answer commands: I ignore the rest of the chat.',
    '📌 The list is always pinned, with the month total.',
    '📝 The bills live in the group description: edit the list there and I follow.',
    '🗓️ Every 1st of the month I start a fresh list.',
    '',
    '/help shows every command.',
  ].join('\n'),
  help: [
    '🤖 *contas-bot commands*',
    '',
    '/paid <bill> [amount] — mark as paid',
    '   e.g. /paid electricity · /paid credit card 6,237.60',
    '/unpaid <bill> — unmark (or /revert)',
    '/list — repost and pin the list',
    '/help — this message',
    '',
    '📎 Receipt captioned /paid <bill> = paid, with the amount read from the receipt.',
    '📝 To change the bills, edit the list in the group description. "(paused)" at the end skips a bill this month without deleting it.',
  ].join('\n'),
  noLlmAmount: "couldn't read the amount on the receipt, marked without one",
  saveFailed: "couldn't save, try again",
  downloadFailed: "couldn't read the receipt, send it again or use /paid <name> [amount]",
  unknownCmd: "I don't know that command. /help lists them all.",
  unknownCmdSuggest: (typed, cmd) => `I don't know /${typed}, did you mean /${cmd}? /help lists them all.`,
  missingBillPago: 'missing the bill: /paid power 80.00',
  missingBillDespago: 'missing the bill: /unpaid power',
  descDenied: "I can't edit the description: make me an admin or let everyone edit group info",
  descTooLong: "the group description is over WhatsApp's limit: shorten the text above the bot's list",
  updated: 'updated',
  moreChanges: n => `…and ${n} more`,
  notFound: (q, names, suggest) =>
    suggest?.length
      ? `couldn't find "${q}", did you mean ${suggest.map(n => `*${n}*`).join(' or ')}? Bills: ${names}`
      : `couldn't find "${q}". Bills: ${names}`,
}

const es: Catalog = {
  listTitle: 'Cuentas',
  paidLabel: 'Pagado',
  totalLabel: 'Total',
  noAmount: n => `${n} sin monto`,
  pauseWord: 'pausado',
  sectionTitle: 'Cuentas (edita esta lista):',
  sectionHelp: '/pagado <cuenta> [monto] · /lista · /ayuda',
  descPlaceholder:
    '✏️ Escribe aquí la descripción del grupo (borra estas líneas).\n⚠️ Abajo es la parte del bot: cambia solo la lista de cuentas.',
  demoBills: 'Luz\nAgua\nInternet\nAlquiler\nGimnasio (pausado)',
  intro: [
    '👋 ¡Hola! Soy *contas-bot*, llevo la lista de cuentas del mes de este grupo.',
    '',
    '📎 ¿Pagaste algo? Manda el comprobante (foto o PDF) con el texto /pagado luz: la marco y leo el monto.',
    '✍️ Sin comprobante: /pagado luz 231,45',
    '🤫 Solo respondo a comandos: el resto de la conversación lo ignoro.',
    '📌 La lista queda siempre fijada, con el total del mes.',
    '📝 Las cuentas están en la descripción del grupo: edita la lista ahí y yo la actualizo.',
    '🗓️ Cada día 1 empiezo una lista nueva.',
    '',
    '/ayuda muestra todos los comandos.',
  ].join('\n'),
  help: [
    '🤖 *Comandos de contas-bot*',
    '',
    '/pagado <cuenta> [monto] — marca como pagada',
    '   ej: /pagado luz · /pagado tarjeta 6.237,60',
    '/despagado <cuenta> — desmarca (o /revertir)',
    '/lista — vuelve a publicar y fijar la lista',
    '/ayuda — este mensaje',
    '',
    '📎 Comprobante con el texto /pagado <cuenta> = pagada, con el monto leído del comprobante.',
    '📝 Para cambiar las cuentas, edita la lista en la descripción del grupo. "(pausado)" al final salta la cuenta este mes sin borrarla.',
  ].join('\n'),
  noLlmAmount: 'no leí el monto del comprobante, la marqué sin monto',
  saveFailed: 'no pude guardar, intenta de nuevo',
  downloadFailed: 'no pude leer el comprobante, mándalo de nuevo o usa /pagado <nombre> [monto]',
  unknownCmd: 'no conozco ese comando. /ayuda los muestra todos.',
  unknownCmdSuggest: (typed, cmd) => `no conozco /${typed}, ¿quisiste decir /${cmd}? /ayuda los muestra todos.`,
  missingBillPago: 'falta la cuenta: /pagado luz 80,00',
  missingBillDespago: 'falta la cuenta: /despagado luz',
  descDenied: 'no puedo editar la descripción: hazme admin o permite que todos editen la info del grupo',
  descTooLong: 'la descripción del grupo pasó el límite de WhatsApp: acorta el texto sobre la lista del bot',
  updated: 'actualizado',
  moreChanges: n => `…y ${n} más`,
  notFound: (q, names, suggest) =>
    suggest?.length
      ? `no encontré "${q}", ¿quisiste decir ${suggest.map(n => `*${n}*`).join(' o ')}? Cuentas: ${names}`
      : `no encontré "${q}". Cuentas: ${names}`,
}

export const CATALOGS: Record<Lang, Catalog> = { 'pt-BR': ptBR, en, es }

export function makeLocale(lang: string, currency: string): Locale {
  if (!Object.hasOwn(CATALOGS, lang)) throw new Error(`unsupported BOT_LANG "${lang}": use pt-BR, en or es`)
  if (!/^[A-Za-z]{3}$/.test(currency))
    throw new Error(`invalid BOT_CURRENCY "${currency}": use an ISO 4217 code like BRL, USD, EUR`)
  const l = lang as Lang
  const decimal = new Intl.NumberFormat(l).formatToParts(1.5).find(p => p.type === 'decimal')?.value === '.' ? '.' : ','
  return { lang: l, currency: currency.toUpperCase(), decimal, t: CATALOGS[l] }
}

export const DEFAULT_LOCALE = makeLocale('pt-BR', 'BRL')
