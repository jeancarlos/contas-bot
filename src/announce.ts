import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type { Lang } from './i18n.ts'
export type Entry = { en: string; 'pt-BR'?: string; es?: string }
export type Release = { version: string; entries: Entry[] }
const SEMVER = /^\d+\.\d+\.\d+$/
export const isSemver = (v: string) => SEMVER.test(v)
const parts = (v: string) => v.split('.').map(n => Number.parseInt(n, 10) || 0)
export function compareVersions(a: string, b: string): number {
  const pa = parts(a)
  const pb = parts(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
export function pendingReleases(all: Release[], current: string, announced: string | undefined): Release[] {
  if (!isSemver(current) || announced === current) return []
  if (announced === undefined) return all.filter(r => r.version === current)
  return all
    .filter(r => isSemver(r.version) && compareVersions(r.version, announced) > 0 && compareVersions(r.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}
const MAX_LINES = 10
export function announcementText(releases: Release[], lang: Lang, current: string, more: (n: number) => string): string | null {
  const lines = releases.flatMap(r => r.entries.map(e => e[lang] ?? e.en))
  if (lines.length === 0) return null
  const shown = lines.slice(0, MAX_LINES).map(l => `• ${l}`)
  if (lines.length > MAX_LINES) shown.push(more(lines.length - MAX_LINES))
  return [`🎉🤖 contas-bot v${current}`, '', ...shown].join('\n')
}

export const MAX_GIF = 5 * 1024 * 1024

export async function loadReleases(file: URL): Promise<Release[] | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as Release[]) : null
  } catch { return null }
}

async function fetchGif(url: string, fetchFn: typeof fetch): Promise<Buffer> {
  const ctl = new AbortController()
  const res = await fetchFn(url, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(15_000)]) })
  if (!res.ok) throw new Error(`gif fetch ${res.status}`)
  if (Number(res.headers.get('content-length')) > MAX_GIF) throw new Error('gif too large')
  if (!res.body) throw new Error('gif has no body')
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > MAX_GIF) { ctl.abort(); throw new Error('gif too large') }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function loadGif(src: string, dataDir: string, fetchFn: typeof fetch = fetch): Promise<Buffer | null> {
  if (!src) return null
  if (src.startsWith('https://')) return fetchGif(src, fetchFn)
  const root = await realpath(dataDir)
  const target = await realpath(join(root, basename(src)))
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('gif outside the data dir')
  if ((await stat(target)).size > MAX_GIF) throw new Error('gif too large')
  return readFile(target)
}
