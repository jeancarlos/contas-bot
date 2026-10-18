// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import * as p from '@clack/prompts'
import { access, appendFile, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Lang } from './core/types.ts'
import {
  allowEmpty,
  LANGS,
  answersFromDotenv,
  answersFromEnv,
  buildEnv,
  composeFile,
  detectMode,
  imageTag,
  mergeAnswers,
  savedIds,
  missingAnswers,
  parseEnv,
  probeAi,
  withDefaults,
  type Answers,
  type Mode,
  type Pairing,
} from './setup/core.ts'
import { SETUP_TEXT, type SetupText } from './setup/i18n.ts'
import { ask, check as askCheck, describe, type Ui } from './setup/ask.ts'
import { pair, qrHtml, renderQrSvg } from './setup/pair.ts'

const DIR = process.env.CONTAS_BOT_SETUP_DIR ?? '/setup'
const VERSION = process.env.APP_VERSION ?? 'dev'
const IMAGE = process.env.CONTAS_BOT_IMAGE || `ghcr.io/jeancarlos/contas-bot:${VERSION}`
const CLI = new URL('../bin/contas-bot', import.meta.url)
const interactive = Boolean(process.stdin.isTTY)

let tx: SetupText = SETUP_TEXT['pt-BR']
const read = (f: string) => readFile(join(DIR, f), 'utf8').catch(() => null)

const ui: Ui = { text: tx, io: {}, exit: code => process.exit(code), probe: probeAi }
const check = <T>(v: T) => {
  ui.text = tx
  return askCheck(ui, v)
}

async function writeRuntime() {
  await writeFile(join(DIR, 'docker-compose.yml'), composeFile(IMAGE))
  await copyFile(CLI, join(DIR, 'contas-bot'))
  await chmod(join(DIR, 'contas-bot'), 0o755)
}

const exists = (f: string) =>
  access(join(DIR, f)).then(
    () => true,
    () => false,
  )

async function install(
  pre: Partial<Answers>,
  o: { touchAuth?: boolean; source?: Partial<Answers>; saved?: Record<string, string>; fresh?: boolean } = {},
): Promise<Answers> {
  let a: Answers
  if (interactive) {
    ui.text = tx
    a = await ask(ui, pre, o.source)
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
  if (o.touchAuth !== false) await ensureAuthDir()
  const empty = allowEmpty(await noHistory(), o.fresh === true, o.saved ?? {})
  await ensureDataDir()
  await writeFile(
    join(DIR, '.env'),
    buildEnv(a, ...savedIds(o.saved ?? {}, process.getuid?.() ?? 1000, process.getgid?.() ?? 1000), empty),
    { mode: 0o600 },
  )
  await chmod(join(DIR, '.env'), 0o600)
  await writeRuntime()
  p.log.success(tx.saved)
  return a
}

async function privateDir(name: string) {
  await mkdir(join(DIR, name), { recursive: true, mode: 0o700 })
  await chmod(join(DIR, name), 0o700)
}
const ensureAuthDir = () => privateDir('auth')
const ensureDataDir = () => privateDir('data')
const noHistory = async () => !(await exists('data/state.json')) && !(await exists('data/contas.db'))

async function consentEmpty(mode: Mode, saved: Record<string, string>, rewrites: boolean) {
  if (mode === 'install' || saved.ALLOW_EMPTY_STATE === '1' || !(await noHistory())) return
  if (!interactive) {
    process.stderr.write(`${tx.emptyRefused}\n`)
    process.exit(1)
  }
  if (!check(await p.confirm({ message: tx.emptyAsk, initialValue: false }))) {
    p.cancel(tx.cancelled)
    process.exit(1)
  }
  saved.ALLOW_EMPTY_STATE = '1'
  if (rewrites) return
  const text = (await read('.env')) ?? ''
  await appendFile(join(DIR, '.env'), `${text === '' || text.endsWith('\n') ? '' : '\n'}ALLOW_EMPTY_STATE=1\n`)
}
async function reviewExisting(saved: Record<string, string>, d: Partial<Answers>): Promise<boolean> {
  p.note(
    describe(tx, { ...d, model: saved.LLM_VISION_MODEL ?? '', hasKey: Boolean(saved.LLM_API_KEY) }),
    tx.existingTitle,
  )
  return (
    check(
      await p.select<'keep' | 'review'>({
        message: tx.existingAsk,
        options: [
          { value: 'keep', label: tx.keep },
          { value: 'review', label: tx.review },
        ],
      }),
    ) === 'review'
  )
}

async function update(
  review: { prefill: Partial<Answers>; source: Partial<Answers>; saved: Record<string, string> } | null,
) {
  const from = imageTag((await read('docker-compose.yml')) ?? '') ?? '?'
  if (review) await install(review.prefill, { touchAuth: false, source: review.source, saved: review.saved })
  else {
    await ensureDataDir()
    await writeRuntime()
  }
  p.outro(tx.updated(from, VERSION))
}

async function main() {
  process.on('SIGINT', () => {
    dropQr().then(
      () => process.exit(130),
      () => process.exit(130),
    )
  })
  const envText = await read('.env')
  const mode = detectMode(envText !== null, await read('auth/creds.json'))
  const saved = envText ? parseEnv(envText) : {}
  if ((LANGS as string[]).includes(saved.BOT_LANG ?? '')) tx = SETUP_TEXT[saved.BOT_LANG as Lang]
  p.intro(tx.title(VERSION))
  const fromDotenv = answersFromDotenv(saved)
  const review = interactive && mode !== 'install' && (await reviewExisting(saved, fromDotenv))
  const prefill = interactive
    ? mergeAnswers(answersFromEnv(process.env), { ...fromDotenv, llmKey: undefined })
    : answersFromEnv(process.env)
  await consentEmpty(mode, saved, Boolean(review))
  if (mode === 'update') {
    await update(review ? { prefill, source: fromDotenv, saved } : null)
    return
  }
  if (mode === 'install' || review) await install(prefill, { source: fromDotenv, saved, fresh: mode === 'install' })
  else {
    await ensureAuthDir()
    await ensureDataDir()
  }
  if (process.env.CONTAS_BOT_NO_PAIR === '1') {
    p.outro(tx.saved)
    return
  }
  const env = parseEnv((await read('.env')) ?? '')
  await pairLoop(env.PAIRING_MODE === 'code' ? 'code' : 'qr', env.BOT_PHONE ?? '')
}

let qrChain: Promise<unknown> = Promise.resolve()
let qrOpen = true
const qrFile = () => join(DIR, 'qr.html')
function writeQr(html: string) {
  if (!qrOpen) return
  qrChain = qrChain
    .then(async () => {
      if (!qrOpen) return
      const tmp = `${qrFile()}.tmp`
      await writeFile(tmp, html, { mode: 0o600 })
      await rename(tmp, qrFile())
    })
    .catch(() => {})
}
async function dropQr() {
  qrOpen = false
  await qrChain
  await rm(qrFile(), { force: true })
  await rm(`${qrFile()}.tmp`, { force: true })
}
async function pairLoop(mode: Pairing, phone: string): Promise<void> {
  const frame = '──── 🤖 contas-bot ────'
  for (;;) {
    qrOpen = true
    const ui: { spin: ReturnType<typeof p.spinner> | null } = { spin: null }
    const waiting = () => {
      ui.spin = p.spinner()
      ui.spin.start(tx.waiting)
    }
    const ok = await pair(join(DIR, 'auth'), mode, phone, {
      qr: (ascii, raw) => {
        ui.spin?.stop()
        if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H')
        p.note(
          `${ascii}\n${tx.qrSteps}\n${tx.qrFile(process.env.CONTAS_BOT_HOST_DIR ? join(process.env.CONTAS_BOT_HOST_DIR, 'qr.html') : 'qr.html')}`,
          frame,
        )
        renderQrSvg(raw)
          .then(svg => writeQr(qrHtml(svg)))
          .catch(() => {})
        waiting()
      },
      code: code => {
        ui.spin?.stop()
        p.note(`${code.slice(0, 4)}-${code.slice(4)}\n\n${tx.codeSteps}`, frame)
        waiting()
      },
    })
    ui.spin?.stop(ok ? tx.waiting : tx.pairFailed)
    await dropQr()
    if (ok) {
      p.outro(tx.paired)
      setTimeout(() => process.exit(0), 3000).unref()
      return
    }
    if (!interactive || !check(await p.confirm({ message: tx.pairRetry }))) process.exit(1)
  }
}

await main()
