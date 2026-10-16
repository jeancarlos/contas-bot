import { clean, levenshtein, normalize } from './text.ts'

export const COMMANDS = {
  pago: ['pago', 'paguei', 'pagar', 'paid', 'pagado'],
  despago: ['despago', 'despagado', 'unpaid', 'reverter', 'revert', 'revertir'],
  lista: ['lista', 'list'],
  ajuda: ['ajuda', 'help', 'ayuda'],
  conta: ['conta', 'contas', 'bill', 'bills', 'cuenta', 'cuentas'],
} as const
export type CommandName = keyof typeof COMMANDS

export const ONE_OFF = new Set(['avulsa', 'avulso', 'extra'])

export const SUBCOMMANDS = {
  add: ['adiciona', 'adicionar', 'add', 'agrega', 'agregar'],
  remove: ['remove', 'remover', 'elimina', 'eliminar'],
  pause: ['pausa', 'pausar', 'pause'],
  resume: ['continua', 'continuar', 'resume', 'reanuda', 'reanudar'],
  rename: ['renomeia', 'renomear', 'rename', 'renombra', 'renombrar'],
} as const
export type SubName = keyof typeof SUBCOMMANDS

export type Command = { cmd: CommandName; arg: string } | { cmd: 'unknown'; typed: string; suggestion: string | null }
export type Conta =
  | { sub: 'list' }
  | { sub: 'help' }
  | { sub: 'add' | 'remove' | 'pause' | 'resume'; name: string }
  | { sub: 'rename'; from: string; to: string }
  | { sub: 'unknown'; typed: string; suggestion: string | null }

function lookup<K extends string>(table: Record<K, readonly string[]>, word: string): K | undefined {
  return (Object.keys(table) as K[]).find(k => table[k].includes(word))
}

function suggest<K extends string>(table: Record<K, readonly string[]>, word: string): string | null {
  const scored = (Object.keys(table) as K[]).flatMap(k =>
    table[k].map(alias => ({ k, alias, d: levenshtein(word, alias) })),
  )
  const near = scored.filter(x => x.d <= Math.max(1, Math.floor(x.alias.length / 3)))
  const best = Math.min(...near.map(x => x.d))
  const top = near.filter(x => x.d === best)
  return new Set(top.map(x => x.k)).size === 1 ? (top[0]?.alias ?? null) : null
}

export function parseCommand(text: string): Command | null {
  const t = clean(text)
  if (!t.startsWith('/')) return null
  const [head = '', ...rest] = t.slice(1).split(' ')
  const word = normalize(head)
  if (!word) return null
  const cmd = lookup(COMMANDS, word)
  if (cmd) return { cmd, arg: rest.join(' ') }
  return { cmd: 'unknown', typed: head, suggestion: suggest(COMMANDS, word) }
}

export function parseConta(arg: string): Conta {
  const [head = '', ...rest] = arg.split(' ').filter(Boolean)
  if (!head) return { sub: 'list' }
  const word = normalize(head)
  const sub = lookup(SUBCOMMANDS, word)
  if (!sub) return { sub: 'unknown', typed: head, suggestion: suggest(SUBCOMMANDS, word) }
  const tail = rest.join(' ').trim()
  if (!tail) return { sub: 'help' }
  if (sub !== 'rename') return { sub, name: tail }
  const parts = tail.split('=').map(x => x.trim())
  const [from = '', to = ''] = parts
  return parts.length === 2 && from && to ? { sub: 'rename', from, to } : { sub: 'help' }
}
