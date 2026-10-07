import { DEFAULT_CONNECTION_CONFIG, fetchLatestWaWebVersion, type WAVersion } from '@whiskeysockets/baileys'

type Fetch = () => Promise<{ version: WAVersion; isLatest?: boolean }>
export type ResolvedVersion = { version: WAVersion; live: boolean }

let cached: Promise<ResolvedVersion> | null = null

export async function resolveWaVersion(fetchFn: Fetch = fetchLatestWaWebVersion, timeoutMs = 10_000): Promise<ResolvedVersion> {
  const fallback: ResolvedVersion = { version: DEFAULT_CONNECTION_CONFIG.version, live: false }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs) })
  try {
    const r = await Promise.race([fetchFn(), timeout])
    if (r.isLatest === false) return fallback
    return { version: r.version, live: true }
  } catch {
    return fallback
  } finally {
    clearTimeout(timer)
  }
}

export const waVersionOnce = (): Promise<ResolvedVersion> => (cached ??= resolveWaVersion().then(r => {
  if (!r.live) cached = null
  return r
}))
