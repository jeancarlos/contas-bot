// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import { normalize } from './text.ts'
import type { Lang } from './types.ts'

export const MONTH_NAMES: Record<Lang, readonly string[]> = {
  'pt-BR': [
    'janeiro',
    'fevereiro',
    'março',
    'abril',
    'maio',
    'junho',
    'julho',
    'agosto',
    'setembro',
    'outubro',
    'novembro',
    'dezembro',
  ],
  en: [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ],
  es: [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ],
}

const FULL = new Map<string, number>()
const ABBR = new Map<string, number>()
for (const names of Object.values(MONTH_NAMES)) {
  names.forEach((name, i) => {
    FULL.set(normalize(name), i + 1)
    ABBR.set(normalize(name).slice(0, 3), i + 1)
  })
}

const pad = (m: number) => String(m).padStart(2, '0')
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))

const FORMATS = new Map<string, Intl.DateTimeFormat>()

export function monthOf(ms: number, timeZone: string): string {
  const format =
    FORMATS.get(timeZone) ?? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
  FORMATS.set(timeZone, format)
  const parts = format.formatToParts(ms)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}`
}

export function parseMonthToken(tok: string, current: string): string | null {
  const numeric = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(tok)
  if (numeric) {
    const m = Number(numeric[1])
    return m >= 1 && m <= 12 ? `${fullYear(numeric[2] ?? '')}-${pad(m)}` : null
  }
  const named = /^([^\d/]+)\/(\d{2}|\d{4})$/.exec(tok)
  if (named) {
    const word = normalize(named[1] ?? '')
    const m = FULL.get(word) ?? ABBR.get(word)
    return m ? `${fullYear(named[2] ?? '')}-${pad(m)}` : null
  }
  const m = FULL.get(normalize(tok))
  if (!m) return null
  const [cy = 0, cm = 0] = current.split('-').map(Number)
  return `${m <= cm ? cy : cy - 1}-${pad(m)}`
}

export function monthTitle(month: string, lang: Lang): string {
  const [y = '', m = '1'] = month.split('-')
  const name = MONTH_NAMES[lang][Number(m) - 1] ?? m
  return `${name.charAt(0).toLocaleUpperCase(lang)}${name.slice(1)}/${y}`
}
