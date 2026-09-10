export type Verdict = { bill: string | null; amount: number | null; confidence: number }
export type Llm = {
  interpretCaption(text: string, bills: string[]): Promise<Verdict | null>
  readReceipt(image: Buffer, mime: string, caption: string, bills: string[]): Promise<Verdict | null>
}
type Cfg = { baseUrl: string; apiKey: string; textModel: string; visionModel: string; fetchFn?: typeof fetch }

const SYSTEM = `You classify Brazilian household bill payments. Answer ONLY a JSON object:
{"bill": <one exact name from the list or null>, "amount": <number in BRL or null>, "confidence": <0..1>}
"amount" is the total paid on the receipt ("Valor", "Total", "Valor pago"). Never invent a bill outside the list.`

function parseVerdict(raw: string, bills: string[]): Verdict | null {
  const m = /\{[\s\S]*\}/.exec(raw)
  if (!m) return null
  let o: any
  try { o = JSON.parse(m[0]) } catch { return null }
  const bill = typeof o.bill === 'string' && bills.includes(o.bill) ? o.bill : null
  const amount = typeof o.amount === 'number' && Number.isFinite(o.amount) ? o.amount : null
  const confidence = typeof o.confidence === 'number' ? Math.max(0, Math.min(1, o.confidence)) : 0
  return { bill, amount, confidence }
}

export function makeLlm(cfg: Cfg): Llm {
  const fetchFn = cfg.fetchFn ?? fetch
  async function chat(model: string, content: unknown): Promise<string | null> {
    try {
      const res = await fetchFn(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model, stream: false, temperature: 0,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) return null
      const data: any = await res.json()
      return data?.choices?.[0]?.message?.content ?? null
    } catch {
      return null
    }
  }
  const listText = (bills: string[]) => `Bills: ${JSON.stringify(bills)}`
  return {
    async interpretCaption(text, bills) {
      const raw = await chat(cfg.textModel, `${listText(bills)}\nMessage: ${JSON.stringify(text)}`)
      return raw == null ? null : parseVerdict(raw, bills)
    },
    async readReceipt(image, mime, caption, bills) {
      const raw = await chat(cfg.visionModel, [
        { type: 'text', text: `${listText(bills)}\nCaption: ${JSON.stringify(caption)}` },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
      ])
      return raw == null ? null : parseVerdict(raw, bills)
    },
  }
}
