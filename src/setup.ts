import * as p from '@clack/prompts'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lang } from './i18n.ts'
import {
  AI_PRESETS, LANGS, answersFromDotenv, answersFromEnv, buildEnv, composeFile, defaultCurrency, detectMode, imageTag, mergeAnswers, missingAnswers,
  normalizePhone, parseEnv, probeAi, resolveAi, validCurrency, validGroup, validUrl, withDefaults,
  type Answers, type Pairing,
} from './setup/core.ts'
import { SETUP_TEXT, type SetupText } from './setup/i18n.ts'
import { pair } from './setup/pair.ts'

const DIR = process.env.CONTAS_BOT_SETUP_DIR ?? '/setup'
const VERSION = process.env.APP_VERSION ?? 'dev'
const IMAGE = process.env.CONTAS_BOT_IMAGE || `ghcr.io/jeancarlos/contas-bot:${VERSION}`
const CLI = new URL('../bin/contas-bot', import.meta.url)
const interactive = Boolean(process.stdin.isTTY)

let tx: SetupText = SETUP_TEXT['pt-BR']
const read = (f: string) => readFile(join(DIR, f), 'utf8').catch(() => null)

function check<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) {
    p.cancel(tx.cancelled)
    process.exit(130)
  }
  return v as Exclude<T, symbol>
}

async function writeRuntime() {
  await writeFile(join(DIR, 'docker-compose.yml'), composeFile(IMAGE))
  await copyFile(CLI, join(DIR, 'contas-bot'))
  await chmod(join(DIR, 'contas-bot'), 0o755)
}

function describe(a: { lang: string; currency: string; pairing: string; phone: string; ai: Answers['ai']; model: string; hasKey: boolean; group: string; tz: string }): string {
  return [
    `${a.lang} · ${a.currency} · ${a.pairing === 'code' ? `${tx.pairingCode}: +${a.phone}` : tx.pairingQr}`,
    a.ai === 'none' ? tx.aiNone : `${a.ai} · ${a.model} · ${a.hasKey ? '••••' : '—'}`,
    a.group || '—',
    a.tz,
  ].join('\n')
}

async function ask(pre: Partial<Answers>): Promise<Answers> {
  const a: Partial<Answers> = { ...pre }
  a.lang = check(await p.select<Lang>({
    message: 'Idioma · Language', initialValue: a.lang,
    options: [{ value: 'pt-BR', label: 'Português (Brasil)' }, { value: 'en', label: 'English' }, { value: 'es', label: 'Español' }],
  }))
  tx = SETUP_TEXT[a.lang]
  a.currency = check(await p.text({
    message: tx.currency, initialValue: a.currency ?? defaultCurrency(a.lang),
    validate: v => (validCurrency(v ?? '') ? undefined : tx.currencyInvalid),
  })).trim().toUpperCase()
  a.pairing = check(await p.select<Pairing>({
    message: tx.pairing, initialValue: a.pairing,
    options: [{ value: 'qr', label: tx.pairingQr }, { value: 'code', label: tx.pairingCode }],
  }))
  if (a.pairing === 'code') {
    a.phone = normalizePhone(check(await p.text({
      message: tx.phone, initialValue: a.phone,
      validate: v => (normalizePhone(v ?? '') ? undefined : tx.phoneInvalid),
    }))) ?? ''
  }
  a.ai = check(await p.select<Answers['ai']>({
    message: tx.ai, initialValue: a.ai,
    options: [
      { value: 'gemini', label: tx.aiGemini, hint: tx.aiGeminiHint },
      { value: 'openai', label: tx.aiOpenai },
      { value: 'custom', label: tx.aiCustom, hint: tx.aiCustomHint },
      { value: 'none', label: tx.aiNone, hint: tx.aiNoneHint },
    ],
  }))
  let current = a.llmKey || undefined
  a.llmKey = undefined
  while (a.ai !== 'none') {
    if (a.ai === 'custom') {
      a.llmUrl = check(await p.text({ message: tx.aiUrl, initialValue: a.llmUrl, validate: v => (validUrl(v ?? '') ? undefined : tx.aiUrlInvalid) })).trim()
      a.visionModel = check(await p.text({ message: tx.aiModel, initialValue: a.visionModel, validate: v => (v?.trim() ? undefined : tx.required) })).trim()
    }
    const preset = a.ai === 'custom' ? '' : AI_PRESETS[a.ai].keyUrl
    const kept = current
    const typed = check(await p.password({
      message: kept ? `${tx.aiKey(preset)} (${tx.keyKept})` : tx.aiKey(preset),
      validate: v => (preset && !kept && !v?.trim() ? tx.required : undefined),
    })).trim()
    a.llmKey = typed || kept || ''
    const s = p.spinner()
    s.start(tx.aiChecking)
    const ok = await probeAi(resolveAi({ ai: a.ai, llmUrl: a.llmUrl ?? '', llmKey: a.llmKey, visionModel: a.visionModel ?? '' }))
    s.stop(ok ? tx.aiOk : tx.aiFailed)
    if (ok || !check(await p.confirm({ message: tx.aiRetry }))) break
    current = undefined
  }
  a.group = check(await p.text({ message: tx.group, initialValue: a.group, validate: v => (validGroup(v ?? '') ? undefined : tx.groupInvalid) })).trim()
  const full = withDefaults(a) as Answers
  const shown = resolveAi(full)
  p.note(describe({ ...full, model: shown.model, hasKey: Boolean(shown.key) }), tx.summary)
  if (!check(await p.confirm({ message: tx.confirm }))) {
    p.cancel(tx.cancelled)
    process.exit(130)
  }
  return full
}

async function install(pre: Partial<Answers>, touchAuth = true): Promise<Answers> {
  let a: Answers
  if (interactive) {
    a = await ask(pre)
  } else {
    const filled = withDefaults(pre)
    const missing = missingAnswers(filled)
    if (missing.length) {
      process.stderr.write(`${(filled.lang ? SETUP_TEXT[filled.lang] : tx).missing(missing.join(', '))}\n`)
      process.exit(2)
    }
    a = filled as Answers
  }
  tx = SETUP_TEXT[a.lang]
  if (touchAuth) await ensureAuthDir()
  await mkdir(join(DIR, 'data'), { recursive: true })
  await writeFile(join(DIR, '.env'), buildEnv(a, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000), { mode: 0o600 })
  await chmod(join(DIR, '.env'), 0o600)
  await writeRuntime()
  p.log.success(tx.saved)
  return a
}

async function ensureAuthDir() {
  await mkdir(join(DIR, 'auth'), { recursive: true, mode: 0o700 })
  await chmod(join(DIR, 'auth'), 0o700)
}
async function reviewExisting(saved: Record<string, string>, d: Partial<Answers>): Promise<boolean> {
  const full = withDefaults({ ...d, llmKey: saved.LLM_API_KEY }) as Answers
  p.note(describe({ ...full, model: saved.LLM_VISION_MODEL ?? '', hasKey: Boolean(saved.LLM_API_KEY) }), tx.existingTitle)
  return (
    check(await p.select<'keep' | 'review'>({
      message: tx.existingAsk,
      options: [{ value: 'keep', label: tx.keep }, { value: 'review', label: tx.review }],
    })) === 'review'
  )
}

async function main() {
  process.on('SIGINT', () => process.exit(130))
  const envText = await read('.env')
  const mode = detectMode(envText !== null, await read('auth/creds.json'))
  const saved = envText ? parseEnv(envText) : {}
  if ((LANGS as string[]).includes(saved.BOT_LANG ?? '')) tx = SETUP_TEXT[saved.BOT_LANG as Lang]
  p.intro(tx.title(VERSION))
  const fromDotenv = answersFromDotenv(saved)
  const review = interactive && mode !== 'install' && (await reviewExisting(saved, fromDotenv))
  const prefill = interactive ? mergeAnswers(answersFromEnv(process.env), fromDotenv) : answersFromEnv(process.env)
  if (mode === 'update') {
    const from = imageTag((await read('docker-compose.yml')) ?? '') ?? '?'
    if (review) await install(prefill, false)
    else await writeRuntime()
    p.outro(tx.updated(from, VERSION))
    return
  }
  if (mode === 'install' || review) await install(prefill)
  else await ensureAuthDir()
  if (process.env.CONTAS_BOT_NO_PAIR === '1') {
    p.outro(tx.saved)
    return
  }
  const env = parseEnv((await read('.env')) ?? '')
  await pairLoop(env.PAIRING_MODE === 'code' ? 'code' : 'qr', env.BOT_PHONE ?? '')
}

async function pairLoop(mode: Pairing, phone: string): Promise<void> {
  const frame = '──── 🤖 contas-bot ────'
  for (;;) {
    const ui: { spin: ReturnType<typeof p.spinner> | null } = { spin: null }
    const waiting = () => {
      ui.spin = p.spinner()
      ui.spin.start(tx.waiting)
    }
    const ok = await pair(join(DIR, 'auth'), mode, phone, {
      qr: ascii => {
        ui.spin?.stop()
        if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
        p.note(`${ascii}\n${tx.qrSteps}`, frame)
        waiting()
      },
      code: code => {
        ui.spin?.stop()
        p.note(`${code.slice(0, 4)}-${code.slice(4)}\n\n${tx.codeSteps}`, frame)
        waiting()
      },
    })
    ui.spin?.stop(ok ? tx.waiting : tx.pairFailed)
    if (ok) {
      p.outro(tx.paired)
      setTimeout(() => process.exit(0), 3000).unref()
      return
    }
    if (!interactive || !check(await p.confirm({ message: tx.pairRetry }))) process.exit(1)
  }
}

await main()
