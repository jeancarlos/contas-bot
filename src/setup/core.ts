import type { Lang } from '../i18n.ts'

export type Ai = 'gemini' | 'openai' | 'custom' | 'none'
export type Pairing = 'qr' | 'code'
export type Mode = 'install' | 'update' | 'repair'
export type Answers = {
  lang: Lang; currency: string; pairing: Pairing; phone: string; ai: Ai
  llmUrl: string; llmKey: string; visionModel: string; group: string; tz: string
}

export const LANGS: Lang[] = ['pt-BR', 'en', 'es']
const AIS: Ai[] = ['gemini', 'openai', 'custom', 'none']
export const AI_PRESETS = {
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  openai: { url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys' },
} as const

export const defaultCurrency = (lang: Lang): string => (lang === 'pt-BR' ? 'BRL' : lang === 'en' ? 'USD' : 'EUR')
export const validCurrency = (s: string): boolean => /^[A-Za-z]{3}$/.test(s.trim())
export const validUrl = (s: string): boolean => /^https?:\/\/\S+$/.test(s.trim())
export const validGroup = (link: string): boolean => link.trim() === '' || /chat\.whatsapp\.com\/\S+/.test(link.trim())

export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/[\s+().-]/g, '')
  return /^\d{10,15}$/.test(d) ? d : null
}

export function resolveAi(a: Pick<Answers, 'ai' | 'llmUrl' | 'llmKey' | 'visionModel'>): { url: string; key: string; model: string } {
  if (a.ai === 'none') return { url: '', key: '', model: '' }
  if (a.ai === 'custom') return { url: a.llmUrl.trim().replace(/\/+$/, ''), key: a.llmKey.trim(), model: a.visionModel.trim() }
  const p = AI_PRESETS[a.ai]
  return { url: p.url, key: a.llmKey.trim(), model: p.model }
}

export async function probeAi(ai: { url: string; key: string }, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const headers: Record<string, string> = ai.key ? { authorization: `Bearer ${ai.key}` } : {}
    const res = await fetchFn(`${ai.url}/models`, { headers, signal: AbortSignal.timeout(10_000) })
    return res.ok
  } catch {
    return false
  }
}

export function buildEnv(a: Answers, uid: number, gid: number): string {
  const ai = resolveAi(a)
  const lines: [string, string][] = [
    ['BOT_LANG', a.lang],
    ['BOT_CURRENCY', a.currency.trim().toUpperCase()],
    ['PAIRING_MODE', a.pairing],
    ['BOT_PHONE', a.pairing === 'code' ? a.phone.trim() : ''],
    ['GROUP_INVITE_LINKS', a.group.trim()],
    ['LLM_BASE_URL', ai.url],
    ['LLM_API_KEY', ai.key],
    ['LLM_VISION_MODEL', ai.model],
    ['TZ', a.tz.trim()],
    ['PUID', String(uid)],
    ['PGID', String(gid)],
  ]
  return `${lines.map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

export function composeFile(image: string): string {
  return [
    'services:',
    '  contas-bot:',
    `    image: ${image}`,
    '    container_name: contas-bot',
    '    restart: unless-stopped',
    '    init: true',
    `    user: "\${PUID}:\${PGID}"`,
    '    env_file: .env',
    '    environment:',
    '      - AUTH_DIR=/app/auth',
    '      - STATE_FILE=/app/data/state.json',
    '    volumes:',
    '      - ./auth:/app/auth',
    '      - ./data:/app/data',
    '',
  ].join('\n')
}

export function imageTag(compose: string): string | null {
  return /^\s*image:\s*\S+:(\S+)\s*$/m.exec(compose)?.[1] ?? null
}

export function paired(creds: string | null): boolean {
  if (!creds) return false
  try {
    const c: unknown = JSON.parse(creds)
    const me = typeof c === 'object' && c !== null ? (c as { me?: { id?: unknown } }).me : undefined
    return typeof me?.id === 'string' && me.id.length > 0
  } catch {
    return false
  }
}

export function detectMode(hasEnv: boolean, creds: string | null): Mode {
  if (!hasEnv) return 'install'
  return paired(creds) ? 'update' : 'repair'
}

export function answersFromEnv(env: NodeJS.ProcessEnv): Partial<Answers> {
  const a: Partial<Answers> = {}
  const v = (k: string) => env[`CONTAS_BOT_${k}`]?.trim() || undefined
  const lang = v('LANG')
  if (lang && (LANGS as string[]).includes(lang)) a.lang = lang as Lang
  const cur = v('CURRENCY')
  if (cur && validCurrency(cur)) a.currency = cur.toUpperCase()
  const pairing = v('PAIRING')
  if (pairing === 'qr' || pairing === 'code') a.pairing = pairing
  const phone = v('PHONE')
  if (phone && normalizePhone(phone)) a.phone = normalizePhone(phone) ?? undefined
  const ai = v('AI')
  if (ai && (AIS as string[]).includes(ai)) a.ai = ai as Ai
  const key = v('LLM_KEY'); if (key) a.llmKey = key
  const url = v('LLM_URL'); if (url && validUrl(url)) a.llmUrl = url
  const model = v('VISION_MODEL'); if (model) a.visionModel = model
  const group = v('GROUP'); if (group && validGroup(group)) a.group = group
  const tz = v('TZ'); if (tz) a.tz = tz
  return a
}

export function answersFromDotenv(env: Record<string, string>): Partial<Answers> {
  const a: Partial<Answers> = {}
  if ((LANGS as string[]).includes(env.BOT_LANG ?? '')) a.lang = env.BOT_LANG as Lang
  if (env.BOT_CURRENCY && validCurrency(env.BOT_CURRENCY)) a.currency = env.BOT_CURRENCY.toUpperCase()
  if (env.PAIRING_MODE === 'qr' || env.PAIRING_MODE === 'code') a.pairing = env.PAIRING_MODE
  if (env.BOT_PHONE) a.phone = env.BOT_PHONE
  if (env.GROUP_INVITE_LINKS !== undefined) a.group = env.GROUP_INVITE_LINKS
  if (env.TZ !== undefined) a.tz = env.TZ
  const url = env.LLM_BASE_URL
  if (url !== undefined) {
    if (url === '') a.ai = 'none'
    else if (url === AI_PRESETS.gemini.url) a.ai = 'gemini'
    else if (url === AI_PRESETS.openai.url) a.ai = 'openai'
    else { a.ai = 'custom'; a.llmUrl = url; a.visionModel = env.LLM_VISION_MODEL ?? '' }
  }
  if (env.LLM_API_KEY) a.llmKey = env.LLM_API_KEY
  return a
}
export function mergeAnswers(...layers: Partial<Answers>[]): Partial<Answers> {
  const out: Record<string, unknown> = {}
  for (const layer of [...layers].reverse()) {
    for (const [k, val] of Object.entries(layer)) if (val !== undefined) out[k] = val
  }
  return out as Partial<Answers>
}
const trimUrl = (u: string | undefined): string => (u ?? '').trim().replace(/\/+$/, '')
export function keyFor(chosen: { ai: Ai; llmUrl?: string }, source: { ai?: Ai; llmUrl?: string; llmKey?: string } | undefined): string | undefined {
  if (!source?.llmKey || chosen.ai !== source.ai) return undefined
  if (chosen.ai === 'custom' && trimUrl(chosen.llmUrl) !== trimUrl(source.llmUrl)) return undefined
  return source.llmKey
}
export function savedIds(saved: Record<string, string>, uid: number, gid: number): [number, number] {
  const id = (v: string | undefined, fallback: number) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : fallback)
  return [id(saved.PUID, uid), id(saved.PGID, gid)]
}
export function withDefaults(a: Partial<Answers>): Partial<Answers> {
  const out: Partial<Answers> = { group: '', tz: 'America/Sao_Paulo', ...a }
  if (out.lang && !out.currency) out.currency = defaultCurrency(out.lang)
  if (out.pairing === 'qr') out.phone ??= ''
  if (out.ai === 'none') { out.llmKey ??= ''; out.llmUrl ??= ''; out.visionModel ??= '' }
  if (out.ai === 'gemini' || out.ai === 'openai') { out.llmUrl ??= ''; out.visionModel ??= '' }
  if (out.ai === 'custom') out.llmKey ??= ''
  return out
}

export function missingAnswers(a: Partial<Answers>): (keyof Answers)[] {
  const need: (keyof Answers)[] = ['lang', 'pairing', 'ai']
  if (a.pairing === 'code') need.push('phone')
  if (a.ai === 'gemini' || a.ai === 'openai') need.push('llmKey')
  if (a.ai === 'custom') need.push('llmUrl', 'visionModel')
  return need.filter(k => a[k] === undefined || (k !== 'llmKey' && a[k] === '') || (k === 'llmKey' && (a.ai === 'gemini' || a.ai === 'openai') && !a.llmKey))
}
