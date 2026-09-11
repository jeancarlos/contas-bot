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
  ask: string
  noLlmAmount: string
  downloadFailed: string
  unknownCmd: string
  private: string
  descDenied: string
  descTooLong: string
  updated: string
  notFound: (q: string, names: string) => string
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
  descPlaceholder: '✏️ Escreva aqui a descrição do grupo (apague estas linhas).\n⚠️ Abaixo é do bot: mude só a lista de contas.',
  demoBills: 'Luz\nÁgua\nInternet\nAluguel\nAcademia (pausado)',
  intro: [
    '👋 Oi! Eu sou o *contas-bot*, cuido da lista de contas do mês deste grupo.',
    '',
    '📎 Pagou? Manda o comprovante (foto ou PDF) aqui. Se a legenda tiver o nome da conta, eu marco na hora; se não, eu leio o comprovante e descubro.',
    '✍️ Sem comprovante: /pago luz 231,45',
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
    '📎 Comprovante com o nome da conta na legenda = paga na hora.',
    '📝 Mudar as contas: edite a lista na descrição do grupo. "(pausado)" no fim tira a conta do mês sem apagar.',
  ].join('\n'),
  ask: 'esse comprovante é de qual conta? responde /pago <nome>',
  noLlmAmount: 'sem valor (LLM indisponível)',
  downloadFailed: 'não consegui ler o comprovante, manda de novo ou usa /pago <nome> [valor]',
  unknownCmd: 'não conheço esse comando. /help mostra todos.',
  private: 'sou um bot privado 🤖',
  descDenied: 'não consigo editar a descrição: me torna admin ou libera "editar dados do grupo" pra todos',
  descTooLong: 'a descrição do grupo passou do limite do WhatsApp: encurte o texto acima da lista do bot',
  updated: 'atualizado',
  notFound: (q, names) => `não achei "${q}". Contas: ${names}`,
}

const en: Catalog = {
  listTitle: 'Bills',
  paidLabel: 'Paid',
  totalLabel: 'Total',
  noAmount: n => `${n} without amount`,
  pauseWord: 'paused',
  sectionTitle: 'Bills (edit this list):',
  sectionHelp: '/paid <bill> [amount] · /list · /help',
  descPlaceholder: '✏️ Write the group description here (delete these lines).\n⚠️ Below is the bot\'s part: change only the bill list.',
  demoBills: 'Electricity\nWater\nInternet\nRent\nGym (paused)',
  intro: [
    "👋 Hi! I'm *contas-bot*, I keep this group's monthly bill list.",
    '',
    '📎 Paid something? Send the receipt (photo or PDF) here. If the caption names the bill I tick it right away; if not, I read the receipt and figure it out.',
    '✍️ No receipt: /paid electricity 231.45',
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
    '📎 Receipt with the bill name in the caption = paid right away.',
    '📝 To change the bills, edit the list in the group description. "(paused)" at the end skips a bill this month without deleting it.',
  ].join('\n'),
  ask: 'which bill is this receipt for? reply /paid <name>',
  noLlmAmount: 'no amount (LLM unavailable)',
  downloadFailed: "couldn't read the receipt, send it again or use /paid <name> [amount]",
  unknownCmd: "I don't know that command. /help lists them all.",
  private: "I'm a private bot 🤖",
  descDenied: "I can't edit the description: make me an admin or let everyone edit group info",
  descTooLong: "the group description is over WhatsApp's limit: shorten the text above the bot's list",
  updated: 'updated',
  notFound: (q, names) => `couldn't find "${q}". Bills: ${names}`,
}

const es: Catalog = {
  listTitle: 'Cuentas',
  paidLabel: 'Pagado',
  totalLabel: 'Total',
  noAmount: n => `${n} sin monto`,
  pauseWord: 'pausado',
  sectionTitle: 'Cuentas (edita esta lista):',
  sectionHelp: '/pagado <cuenta> [monto] · /lista · /ayuda',
  descPlaceholder: '✏️ Escribe aquí la descripción del grupo (borra estas líneas).\n⚠️ Abajo es la parte del bot: cambia solo la lista de cuentas.',
  demoBills: 'Luz\nAgua\nInternet\nAlquiler\nGimnasio (pausado)',
  intro: [
    '👋 ¡Hola! Soy *contas-bot*, llevo la lista de cuentas del mes de este grupo.',
    '',
    '📎 ¿Pagaste algo? Manda el comprobante (foto o PDF) aquí. Si el texto tiene el nombre de la cuenta, la marco al instante; si no, leo el comprobante y lo descubro.',
    '✍️ Sin comprobante: /pagado luz 231,45',
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
    '📎 Comprobante con el nombre de la cuenta en el texto = pagada al instante.',
    '📝 Para cambiar las cuentas, edita la lista en la descripción del grupo. "(pausado)" al final salta la cuenta este mes sin borrarla.',
  ].join('\n'),
  ask: '¿de qué cuenta es este comprobante? responde /pagado <nombre>',
  noLlmAmount: 'sin monto (LLM no disponible)',
  downloadFailed: 'no pude leer el comprobante, mándalo de nuevo o usa /pagado <nombre> [monto]',
  unknownCmd: 'no conozco ese comando. /ayuda los muestra todos.',
  private: 'soy un bot privado 🤖',
  descDenied: 'no puedo editar la descripción: hazme admin o permite que todos editen la info del grupo',
  descTooLong: 'la descripción del grupo pasó el límite de WhatsApp: acorta el texto sobre la lista del bot',
  updated: 'actualizado',
  notFound: (q, names) => `no encontré "${q}". Cuentas: ${names}`,
}

export const CATALOGS: Record<Lang, Catalog> = { 'pt-BR': ptBR, en, es }

export function makeLocale(lang: string, currency: string): Locale {
  if (!Object.hasOwn(CATALOGS, lang)) throw new Error(`unsupported BOT_LANG "${lang}": use pt-BR, en or es`)
  if (!/^[A-Za-z]{3}$/.test(currency)) throw new Error(`invalid BOT_CURRENCY "${currency}": use an ISO 4217 code like BRL, USD, EUR`)
  const l = lang as Lang
  const decimal = new Intl.NumberFormat(l).formatToParts(1.5).find(p => p.type === 'decimal')?.value === '.' ? '.' : ','
  return { lang: l, currency: currency.toUpperCase(), decimal, t: CATALOGS[l] }
}

export const DEFAULT_LOCALE = makeLocale('pt-BR', 'BRL')
