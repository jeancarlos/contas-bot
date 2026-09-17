import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Payment } from './bills.ts'

export type PinKey = { id: string; fromMe: boolean; remoteJid: string }
export type Meta = { last_reset?: string; pinned?: PinKey; listed?: boolean; bills?: string[]; section?: boolean; desc_warned?: boolean; long_warned?: boolean; handled?: string[] }
export type State = { _meta: Meta; months: Record<string, Record<string, Payment>> }
export type StateStore = { get(): State; save(): Promise<void> }
export type Store = { forGroup(jid: string): StateStore; jids(): string[] }

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
type Log = { warn(o: any, msg?: string): void }
// A hand-edited or half-written file must not crash startup or turn `months` into an array that drops data on save.
const toState = (v: unknown, log?: Log): State => {
  const meta = isObj(v) && isObj(v._meta) ? v._meta : {}
  if (meta.pinned && meta.listed === undefined) meta.listed = true
  const rawMonths = isObj(v) && isObj(v.months) ? v.months : {}
  const months: Record<string, Record<string, Payment>> = {}
  for (const [key, val] of Object.entries(rawMonths)) {
    if (isObj(val)) months[key] = val
    else log?.warn({ key }, 'dropping corrupt month (not an object)')
  }
  return { _meta: meta, months }
}

export async function openState(path: string, log?: Log): Promise<Store> {
  let groups: Record<string, State> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isObj(parsed)) throw new Error(`${path} is not a JSON object`)
    if (isObj(parsed.groups)) for (const [jid, g] of Object.entries(parsed.groups)) groups[jid] = toState(g, log)
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

  return {
    forGroup(jid) {
      groups[jid] ??= { _meta: {}, months: {} }
      return { get: () => groups[jid], save }
    },
    jids: () => Object.keys(groups),
  }
}
