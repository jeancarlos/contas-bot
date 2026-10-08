import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Entry, Release } from '../src/announce.ts'
import { parseTrailers } from './changelog-lint.ts'

const LOGGED = /^(feat|fix)(\(.+\))?!?:\s*(.*)$/
const SEMVER = /^v(\d+)\.(\d+)\.(\d+)$/
const MAINTENANCE = 'Maintenance release.'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
const key = (t: string) => (SEMVER.exec(t) as RegExpExecArray).slice(1).map(Number)

export function buildChangelog(repoDir: string): Release[] {
  const tags = git(repoDir, 'tag', '--list', 'v*')
    .split('\n')
    .filter(t => SEMVER.test(t))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)]
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
  const releases = tags.map((tag, i) => {
    const range = i ? `${tags[i - 1]}..${tag}` : tag
    const entries: Entry[] = []
    for (const raw of git(repoDir, 'log', '--no-merges', '--format=%H%x00%B%x1e', range).split('\x1e')) {
      const body = raw.split('\x00')[1]
      if (!body) continue
      const m = LOGGED.exec(body.trim().split('\n')[0])
      if (!m) continue
      const t = parseTrailers(body)
      const entry: Entry = { en: m[3] }
      if (t['Changelog-pt-BR']) entry['pt-BR'] = t['Changelog-pt-BR']
      if (t['Changelog-es']) entry.es = t['Changelog-es']
      entries.push(entry)
    }
    return { version: tag.slice(1), entries }
  })
  return releases.reverse()
}

export function releaseNotes(r: Release): string {
  if (!r.entries.length) return MAINTENANCE
  return r.entries.map(e => `- ${e.en}${e['pt-BR'] ? `\n  ${e['pt-BR']}` : ''}`).join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outJson, notesFile, version] = process.argv.slice(2)
  if (!outJson || !notesFile || !version) {
    process.stderr.write('usage: changelog.ts <outJson> <notesFile> <version>\n')
    process.exit(2)
  }
  const all = buildChangelog('.')
  const rel = all.find(r => r.version === version)
  for (const f of [outJson, notesFile]) mkdirSync(dirname(resolve(f)), { recursive: true })
  writeFileSync(outJson, JSON.stringify(all, null, 2))
  writeFileSync(notesFile, rel ? releaseNotes(rel) : MAINTENANCE)
}
