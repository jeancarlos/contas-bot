// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Jean Souza
import * as p from '@clack/prompts'
import type { Readable, Writable } from 'node:stream'
import type { Lang } from '../core/types.ts'
import {
  AI_PRESETS,
  type Answers,
  defaultCurrency,
  envSafe,
  keyFor,
  type Pairing,
  type probeAi,
  normalizePhone,
  resolveAi,
  validCurrency,
  validGroup,
  validUrl,
  withDefaults,
} from './core.ts'
import { SETUP_TEXT, type SetupText } from './i18n.ts'

export type Ui = {
  text: SetupText
  io: { input?: Readable; output?: Writable }
  exit(code: number): never
  probe: typeof probeAi
}

export function check<T>(u: Ui, v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) {
    p.cancel(u.text.cancelled, u.io)
    u.exit(130)
  }
  return v as Exclude<T, symbol>
}

export function describe(
  t: SetupText,
  a: {
    lang?: string
    currency?: string
    pairing?: string
    phone?: string
    ai?: Answers['ai']
    model?: string
    hasKey: boolean
    group?: string
    tz?: string
  },
): string {
  const pairing =
    a.pairing === 'code' ? `${t.pairingCode}${a.phone ? `: +${a.phone}` : ''}` : a.pairing === 'qr' ? t.pairingQr : '—'
  return [
    `${a.lang ?? '—'} · ${a.currency ?? '—'} · ${pairing}`,
    a.ai === 'none' ? t.aiNone : `${a.ai ?? '—'} · ${a.model || '—'} · ${a.hasKey ? '••••' : '—'}`,
    a.group || '—',
    a.tz ?? '—',
  ].join('\n')
}

export async function askBasics(u: Ui, a: Partial<Answers>) {
  a.lang = check(
    u,
    await p.select<Lang>({
      ...u.io,
      message: 'Idioma · Language',
      initialValue: a.lang,
      options: [
        { value: 'pt-BR', label: 'Português (Brasil)' },
        { value: 'en', label: 'English' },
        { value: 'es', label: 'Español' },
      ],
    }),
  )
  u.text = SETUP_TEXT[a.lang]
  a.currency = check(
    u,
    await p.text({
      ...u.io,
      message: u.text.currency,
      initialValue: a.currency ?? defaultCurrency(a.lang),
      validate: v => (validCurrency(v ?? '') ? undefined : u.text.currencyInvalid),
    }),
  )
    .trim()
    .toUpperCase()
  a.pairing = check(
    u,
    await p.select<Pairing>({
      ...u.io,
      message: u.text.pairing,
      initialValue: a.pairing,
      options: [
        { value: 'qr', label: u.text.pairingQr },
        { value: 'code', label: u.text.pairingCode },
      ],
    }),
  )
  if (a.pairing === 'code') {
    a.phone =
      normalizePhone(
        check(
          u,
          await p.text({
            ...u.io,
            message: u.text.phone,
            initialValue: a.phone,
            validate: v => (normalizePhone(v ?? '') ? undefined : u.text.phoneInvalid),
          }),
        ),
      ) ?? ''
  }
}

export async function askEndpoint(u: Ui, a: Partial<Answers>) {
  a.llmUrl = check(
    u,
    await p.text({
      ...u.io,
      message: u.text.aiUrl,
      initialValue: a.llmUrl,
      validate: v => (!validUrl(v ?? '') ? u.text.aiUrlInvalid : envSafe(v ?? '') ? undefined : u.text.noQuotes),
    }),
  ).trim()
  a.visionModel = check(
    u,
    await p.text({
      ...u.io,
      message: u.text.aiModel,
      initialValue: a.visionModel,
      validate: v => (!v?.trim() ? u.text.required : envSafe(v) ? undefined : u.text.noQuotes),
    }),
  ).trim()
}

export async function askKey(u: Ui, ai: Exclude<Answers['ai'], 'none'>, kept: string | undefined): Promise<string> {
  const preset = ai === 'custom' ? '' : AI_PRESETS[ai].keyUrl
  const typed = check(
    u,
    await p.password({
      ...u.io,
      message: kept ? `${u.text.aiKey(preset)} (${u.text.keyKept})` : u.text.aiKey(preset),
      validate: v => (preset && !kept && !v?.trim() ? u.text.required : envSafe(v ?? '') ? undefined : u.text.noQuotes),
    }),
  ).trim()
  return typed || kept || ''
}

export async function askAi(u: Ui, a: Partial<Answers>, source?: Partial<Answers>) {
  a.ai = check(
    u,
    await p.select<Answers['ai']>({
      ...u.io,
      message: u.text.ai,
      initialValue: a.ai,
      options: [
        { value: 'gemini', label: u.text.aiGemini, hint: u.text.aiGeminiHint },
        { value: 'openai', label: u.text.aiOpenai },
        { value: 'custom', label: u.text.aiCustom, hint: u.text.aiCustomHint },
        { value: 'none', label: u.text.aiNone, hint: u.text.aiNoneHint },
      ],
    }),
  )
  const explicit = a.llmKey || undefined
  a.llmKey = undefined
  while (a.ai !== 'none') {
    if (a.ai === 'custom') await askEndpoint(u, a)
    a.llmKey = await askKey(u, a.ai, explicit ?? keyFor({ ai: a.ai, llmUrl: a.llmUrl }, source))
    const s = p.spinner(u.io)
    s.start(u.text.aiChecking)
    const ok = await u.probe(
      resolveAi({ ai: a.ai, llmUrl: a.llmUrl ?? '', llmKey: a.llmKey, visionModel: a.visionModel ?? '' }),
    )
    s.stop(ok ? u.text.aiOk : u.text.aiFailed)
    if (
      ok ||
      !check(
        u,
        await p.confirm({
          ...u.io,
          message: u.text.aiRetry,
        }),
      )
    )
      break
  }
}

export async function ask(u: Ui, pre: Partial<Answers>, source?: Partial<Answers>): Promise<Answers> {
  const a: Partial<Answers> = { ...pre }
  await askBasics(u, a)
  await askAi(u, a, source)
  a.group = check(
    u,
    await p.text({
      ...u.io,
      message: u.text.group,
      initialValue: a.group,
      validate: v => (!validGroup(v ?? '') ? u.text.groupInvalid : envSafe(v ?? '') ? undefined : u.text.noQuotes),
    }),
  ).trim()
  const full = withDefaults(a) as Answers
  const shown = resolveAi(full)
  p.note(describe(u.text, { ...full, model: shown.model, hasKey: Boolean(shown.key) }), u.text.summary, u.io)
  if (
    !check(
      u,
      await p.confirm({
        ...u.io,
        message: u.text.confirm,
      }),
    )
  ) {
    p.cancel(u.text.cancelled, u.io)
    u.exit(130)
  }
  return full
}
