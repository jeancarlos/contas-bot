export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function clean(text: string): string {
  return text
    .replace(/[*_~`]/g, ' ')
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u{FE0F}|\u{200D}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/\s+/, '/')
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, sub)
    }
    prev = cur
  }
  return prev[b.length] ?? 0
}

export function closest<T>(items: readonly T[], keyOf: (t: T) => string, q: string): T | null {
  const near = items
    .map(t => ({ t, key: keyOf(t), d: levenshtein(q, keyOf(t)) }))
    .filter(x => x.d <= Math.max(1, Math.floor(x.key.length / 3)))
  const best = Math.min(...near.map(x => x.d))
  const top = near.filter(x => x.d === best)
  return top.length === 1 ? (top[0]?.t ?? null) : null
}
