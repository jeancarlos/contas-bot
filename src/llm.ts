export type Llm = {
  enabled: boolean
  readAmount(image: Buffer, mime: string): Promise<number | null>
}
type Cfg = { baseUrl: string; apiKey: string; visionModel: string; currency?: string; fetchFn?: typeof fetch }

function parseAmountReply(raw: string): number | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  try {
    const { amount } = JSON.parse(m[0])
    return typeof amount === 'number' && amount > 0 && amount < 1e12 ? Math.round(amount * 100) / 100 || null : null
  } catch {
    return null
  }
}

export function makeLlm(cfg: Cfg): Llm {
  if (!cfg.baseUrl) return { enabled: false, readAmount: async () => null }
  const fetchFn = cfg.fetchFn ?? fetch
  const system = `You read payment receipts. Answer ONLY a JSON object: {"amount": <total paid in ${cfg.currency ?? 'BRL'} as a number, or null>}
"amount" is the total paid ("Total", "Valor", "Valor pago", "Amount", "Importe"). Answer null when unsure.`
  return {
    enabled: true,
    async readAmount(image, mime) {
      try {
        const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({
            model: cfg.visionModel, stream: false, temperature: 0,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } }] },
            ],
          }),
          signal: AbortSignal.timeout(45_000),
        })
        if (!res.ok) return null
        const data = await res.json() as { choices?: { message?: { content?: string } }[] } | null
        const raw = data?.choices?.[0]?.message?.content
        return raw ? parseAmountReply(raw) : null
      } catch {
        return null
      }
    },
  }
}
