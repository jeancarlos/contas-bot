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
