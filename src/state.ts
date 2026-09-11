import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Payment } from './bills.ts'

export type PinKey = { id: string; fromMe: boolean; remoteJid: string }
export type Meta = { last_reset?: string; pinned?: PinKey; bills?: string[]; section?: boolean; desc_warned?: boolean }
export type State = { _meta: Meta; months: Record<string, Record<string, Payment>> }
export type StateStore = { get(): State; save(): Promise<void> }
export type Store = { forGroup(jid: string): StateStore; jids(): string[] }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
// A hand-edited or half-written file must not crash startup or turn `months` into an array that drops data on save.
const toState = (v: unknown): State => ({
  _meta: isObj(v) && isObj(v._meta) ? v._meta : {},
  months: isObj(v) && isObj(v.months) ? v.months : {},
})

export async function openState(path: string, legacyJid?: string): Promise<Store> {
  let groups: Record<string, State> = {}
  let migrated = false
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isObj(parsed)) throw new Error(`${path} is not a JSON object`)
    if (isObj(parsed.groups)) for (const [jid, g] of Object.entries(parsed.groups)) groups[jid] = toState(g)
    else if (parsed._meta) {
      // First version kept one group at the top level; without its JID the data would be orphaned.
      if (!legacyJid) throw new Error('state file is from the single-group version: set GROUP_JID once so it can be migrated')
      groups[legacyJid] = toState(parsed)
      migrated = true
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e
  }
  await mkdir(dirname(path), { recursive: true })

  // Every group writes the same file: chain the writes so two saves never share the temp file.
  let chain: Promise<void> = Promise.resolve()
  const save = () => {
    const run = chain.then(async () => {
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify({ groups }, null, 2))
      await rename(tmp, path)
    })
    chain = run.catch(() => {})
    return run
  }
  if (migrated) await save()

  return {
    forGroup(jid) {
      groups[jid] ??= { _meta: {}, months: {} }
      return { get: () => groups[jid], save }
    },
    jids: () => Object.keys(groups),
  }
}
