import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Payment } from './bills.ts'

export type PinKey = { id: string; fromMe: boolean; remoteJid: string }
export type Meta = { last_reset?: string; pinned?: PinKey; bills?: string[] }
export type State = { _meta: Meta; months: Record<string, Record<string, Payment>> }
export type StateStore = { get(): State; save(): Promise<void> }

export async function openState(path: string): Promise<StateStore> {
  let state: State = { _meta: {}, months: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    state = { _meta: parsed._meta ?? {}, months: parsed.months ?? {} }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e
  }
  await mkdir(dirname(path), { recursive: true })
  return {
    get: () => state,
    save: async () => {
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(state, null, 2))
      await rename(tmp, path)
    },
  }
}
