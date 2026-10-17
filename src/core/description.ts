// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { NAME_MAX } from './decide.ts'
import { clean, normalize } from './text.ts'
import type { GroupState } from './types.ts'

export type BillLine = { name: string; paused: boolean }

const DIVIDER = /^[-_=—–─━.·*~]{3,}$/
const HEADER = /^[\s\-–—─━=_*~]*🤖 contas-bot[\s\-–—─━=_*~]*$/
const PAUSED = /^(.*?)[\s\-–—(]+(?:pausad[oa]|paused)\)?\s*$/i
const flat = (s: string) =>
  s
    .replace(/\uFE0F/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const BOT_LINES = new Set(
  [
    '──────────────',
    '/pago <conta> [valor] · /lista · /help',
    '/paid <bill> [amount] · /list · /help',
    '/pagado <cuenta> [monto] · /lista · /ayuda',
  ].map(flat),
)
const PLACEHOLDER = new Set(
  [
    '✏ Escreva aqui a descrição do grupo (apague estas linhas).',
    '⚠ Abaixo é do bot: mude só a lista de contas.',
    '✏ Write the group description here (delete these lines).',
    "⚠ Below is the bot's part: change only the bill list.",
    '✏ Escribe aquí la descripción del grupo (borra estas líneas).',
    '⚠ Abajo es la parte del bot: cambia solo la lista de cuentas.',
  ].map(flat),
)

function billLine(raw: string): BillLine | null {
  const line = clean(raw.trim().replace(/^(?:[-*•·]|\d+[.)])\s+/, ''))
  if (!line || line.startsWith('#') || line.startsWith('/') || line.endsWith(':')) return null
  const m = PAUSED.exec(line)
  const name = (m?.[1] ?? line).trim()
  return name.length > NAME_MAX ? null : { name, paused: Boolean(m) }
}

function parseSection(section: string): BillLine[] {
  const bills: BillLine[] = []
  const keys = new Set<string>()
  for (const raw of section.split('\n')) {
    if (DIVIDER.test(raw.trim())) break
    const bill = billLine(raw)
    const key = bill ? normalize(bill.name) : ''
    if (!bill || !key || keys.has(key)) continue
    keys.add(key)
    bills.push(bill)
  }
  return bills
}

function splitDescription(desc: string): { original: string; section: string | null } {
  const lines = desc.split('\n')
  const i = lines.findIndex(l => HEADER.test(l.trim()))
  if (i < 0) return { original: desc, section: null }
  const above = lines.slice(0, i).join('\n')
  const section = lines.slice(i + 1)
  const d = section.findIndex(l => DIVIDER.test(l.trim()))
  const end = d >= 0 ? d : section.findIndex(l => l.trim().startsWith('/'))
  const below = end < 0 ? [] : section.slice(end + 1)
  const h = below.findIndex(l => HEADER.test(l.trim()))
  const stray = (h < 0 ? below : below.slice(0, h))
    .filter(l => !BOT_LINES.has(flat(l)))
    .join('\n')
    .trim()
  const original = stray ? [above.trimEnd(), stray].filter(Boolean).join('\n\n') : above
  return { original, section: (end < 0 ? section : section.slice(0, end)).join('\n') }
}

export function migrateDescription(desc: string, line: string): { bills: BillLine[]; text: string } {
  const { original, section } = splitDescription(desc)
  const own = original
    .split('\n')
    .filter(l => !PLACEHOLDER.has(flat(l)))
    .join('\n')
    .trim()
  return { bills: section === null ? [] : parseSection(section), text: own ? `${own}\n\n${line}` : line }
}

export function reconcileBills(state: GroupState, lines: BillLine[]): GroupState {
  if (lines.length === 0) return state
  const s = structuredClone(state)
  const keys = new Set<string>()
  for (const l of lines) {
    const key = normalize(l.name)
    keys.add(key)
    const bill = s.bills.find(b => b.key === key)
    if (bill) Object.assign(bill, { name: l.name, paused: l.paused, removed: false })
    else s.bills.push({ id: s.nextBillId++, name: l.name, key, paused: l.paused, removed: false })
  }
  for (const b of s.bills) if (!keys.has(b.key)) b.removed = true
  return s
}
