export type Llm = {
  enabled: boolean
  readAmount(image: Buffer, mime: string, signal?: AbortSignal): Promise<number | null>
  pickBill(
    image: Buffer,
    mime: string,
    names: string[],
    signal?: AbortSignal,
  ): Promise<{ index: number | null; amount: number | null }>
}
type Pick = { index: number | null; amount: number | null }
const NO_PICK: Pick = { index: null, amount: null }
type Cfg = { baseUrl: string; apiKey: string; visionModel: string; currency?: string; fetchFn?: typeof fetch }

const validAmount = (v: unknown): number | null =>
  typeof v === 'number' && v > 0 && v < 1e12 ? Math.round(v * 100) / 100 || null : null

function replyJson(raw: string): { index?: unknown; amount?: unknown } | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

function parseAmountReply(raw: string): number | null {
  return validAmount(replyJson(raw)?.amount)
}

const validIndex = (v: unknown, count: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : null

function parsePickReply(raw: string, count: number): Pick {
  const r = replyJson(raw)
  return r ? { index: validIndex(r.index, count), amount: validAmount(r.amount) } : NO_PICK
}

export function makeLlm(cfg: Cfg): Llm {
  if (!cfg.baseUrl) return { enabled: false, readAmount: async () => null, pickBill: async () => NO_PICK }
  const fetchFn = cfg.fetchFn ?? fetch
  const system = `You read payment receipts. Answer ONLY a JSON object: {"amount": <total paid in ${cfg.currency ?? 'BRL'} as a number, or null>}
"amount" is the total paid ("Total", "Valor", "Valor pago", "Amount", "Importe"). Answer null when unsure.`
  const pickSystem = `You match a payment receipt to one of the numbered bills. Answer ONLY a JSON object: {"index": <number of the bill the receipt pays, or null>, "amount": <total paid in ${cfg.currency ?? 'BRL'} as a number, or null>}
Answer null for "index" when no bill clearly matches, and null for "amount" when unsure.`
  async function ask(
    system: string,
    prompt: string,
    image: Buffer,
    mime: string,
    signal: AbortSignal | undefined,
  ): Promise<string | null> {
    try {
      const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.visionModel,
          stream: false,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            {
              role: 'user',
              content: [
                ...(prompt ? [{ type: 'text', text: prompt }] : []),
                { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
              ],
            },
          ],
        }),
        signal: AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] } | null
      return data?.choices?.[0]?.message?.content || null
    } catch {
      return null
    }
  }
  return {
    enabled: true,
    async readAmount(image, mime, signal) {
      const raw = await ask(system, '', image, mime, signal)
      return raw ? parseAmountReply(raw) : null
    },
    async pickBill(image, mime, names, signal) {
      const list = names.map((n, i) => `${i}: ${n}`).join('\n')
      const raw = await ask(pickSystem, `Bills:\n${list}`, image, mime, signal)
      return raw ? parsePickReply(raw, names.length) : NO_PICK
    },
  }
}
