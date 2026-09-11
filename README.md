# contas-bot 🤖💸

**Your household bills, handled in the WhatsApp group you already use.**

Everyone has that group: someone pays the electricity, drops the receipt in the chat, and then someone else scrolls up and retypes the whole checklist ("Luz ✅, Água ⬜, Aluguel ⬜…") so nobody loses track. Every month. By hand.

contas-bot takes that job. Add it to the group and it keeps the list for you: it reads every receipt, ticks the bill off, pulls the amount off the image, adds up the month, and keeps the latest list pinned at the top of the chat. Nobody installs an app, nobody learns a new tool. You keep chatting the way you already do.

> 🇧🇷 Feito para grupos brasileiros: o bot fala português, entende `R$ 6.237,60` e lê comprovantes de Pix, boleto e cartão.

## What it feels like

```
Gabi:  [photo of the Pix receipt] luz
Bot:   ✅
Bot:   📋 *Contas — Setembro/2026*

       ✅ Luz — R$ 231,45
       ✅ Cartão Nu — R$ 6.237,60
       ⬜ Água
       ⬜ Aluguel
       ⏸️ Academia

       *Pago:* 2/4 · *Total:* R$ 6.469,05
       📌 (pinned)
```

No caption? No problem. The bot looks at the receipt and works out which bill it was. If it isn't sure, it asks instead of guessing.

## Features

- 📎 **Receipts in, checkmarks out.** Photos and PDFs. A caption with the bill name marks it paid on the spot, and the amount is read from the receipt.
- 🧠 **AI only where it earns its keep.** Commands, captions and names are matched mechanically: instant, free, predictable. The vision model is only called to read amounts and to identify receipts nobody labeled, and it can only answer with a bill that exists.
- 📌 **Always pinned.** Every change posts a fresh list with the month total and pins it. The old one is unpinned, so the top of the chat is always the truth.
- 🗓️ **Monthly reset.** On the 1st, a clean list goes up by itself.
- 👋 **Onboards itself.** Add the bot to a group and it introduces itself, sets up a demo list, and writes its own section into the group description.
- 📝 **The group description is the settings screen.** Bills live in the bot's section of the description. Edit them in WhatsApp and the list follows. Add `(pausado)` to skip a bill this month without deleting it.
- 🔒 **Private by default.** It only works in groups that include one of its owners. Anywhere else it says so and leaves.
- 🌎 **Speaks your language and your money.** Portuguese, English or Spanish, with any currency (`R$ 6.237,60`, `$6,237.60`, `6237,60 €`). It understands commands in all three languages no matter which one it writes in.

## Commands

| Command | What it does |
|---|---|
| `/pago <bill> [amount]` | mark paid: `/pago luz`, `/pago cartão nu 6.237,60` |
| `/despago <bill>` | unmark (also `/reverter`, `/revert`) |
| `/lista` | repost and repin the list |
| `/help` | every command, with examples |

Bill names ignore accents and case, and a unique prefix is enough (`/pago cond`). A message that is just a bill name, or `pago luz`, counts too. Say `oi bot`, @mention it, or reply to one of its messages and it introduces itself. Everything else in the chat is left alone.

## How it's built

One small Node 22 process speaking WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys). No web server, no database, no build step: TypeScript runs directly on Node, state is a single JSON file written atomically, and the whole thing ships as one Docker container with no open ports.

```
src/
  wa.ts      WhatsApp socket: pairing, reconnect, events, pin/unpin, description
  bot.ts     the handler: commands, receipts, onboarding, greetings, monthly reset
  bills.ts   pure logic: parsing, name matching, amounts, list and section rendering
  llm.ts     OpenAI-compatible client with strict JSON validation
  state.ts   atomic per-group state file
  pdf.ts     first page of a PDF receipt to PNG (poppler)
```

Design choices worth a look:

- **Mechanical first, LLM second.** The model is a fallback, and its output is validated against the bill list before anything is stored. If the endpoint is down, a known bill is still marked paid, just without an amount.
- **Serialized handlers.** Messages, description edits and the monthly tick run one at a time, so pins and saves never interleave.
- **Idempotent description sync.** The bot rewrites its section only when the text actually differs, so its own edit never triggers another one.
- **Receipts are never stored.** The image is used for one model call and dropped. Only the amount is kept.

The logic is covered by the built-in `node:test` runner against fake WhatsApp and LLM doubles: parsing, matching, rendering, the state file, and the full handler flow.

## Run your own

You need a spare WhatsApp number for the bot (a cheap prepaid SIM works) and any OpenAI-compatible endpoint with a vision model.

```bash
git clone https://github.com/jeancarlos/contas-bot
cd contas-bot
cp .env.example .env    # fill in the values below
docker compose up -d --build
docker compose logs -f
```

| Variable | Meaning |
|---|---|
| `BOT_PHONE` | the bot's number, digits with country code; used once to pair |
| `OWNER_PHONES` | comma-separated numbers allowed to use the bot; it only stays in groups where one of them is a member |
| `BOT_LANG` | language the bot writes in: `pt-BR` (default), `en` or `es` |
| `BOT_CURRENCY` | currency for amounts and totals, an ISO 4217 code: `BRL` (default), `USD`, `EUR`, `MXN`… |
| `LLM_BASE_URL` | OpenAI-compatible endpoint |
| `LLM_API_KEY` | key for that endpoint |
| `LLM_TEXT_MODEL` | model for free-text captions |
| `LLM_VISION_MODEL` | model for receipts (must accept images) |

On first start the log prints `PAIRING CODE` with 8 characters. On the bot's phone, go to WhatsApp → Linked devices → Link a device → Link with phone number instead, and type it. Then add the bot to your group and it takes it from there.

For development:

```bash
npm install
npm test        # node --test
npm run check   # tsc --noEmit
```

## Fine print

Baileys speaks the WhatsApp Web protocol, and WhatsApp's terms don't allow automated accounts. A dedicated number in a small family group has been fine, but use it at your own risk and never on your personal number.

## Credits

contas-bot stands on the shoulders of these projects:

- **[Baileys](https://github.com/WhiskeySockets/Baileys)**: the WhatsApp Web protocol in TypeScript. Pairing, messages, pins and group descriptions all come from it, and without it this bot wouldn't exist.
- **[Evolution API](https://github.com/evolution-foundation/evolution-api)**: the first candidate for the WhatsApp side. Studying it showed what a self-hosted WhatsApp integration looks like, and its missing pin endpoint is what led to talking to Baileys directly.
- **[ha-whatsapp](https://github.com/FaserF/ha-whatsapp)**: the Home Assistant route that was evaluated along the way, and a good reference for running WhatsApp automations at home.
- **[9Router](https://www.npmjs.com/package/9router)**: the OpenAI-compatible gateway that serves the vision and text models on my home server.
- **[Poppler](https://poppler.freedesktop.org/)**: `pdftoppm` turns PDF receipts into images the model can read.
- **[pino](https://github.com/pinojs/pino)**: fast, structured logs.

And the original contas-bot: a hand-written checklist, reposted in the group every time a bill was paid. This project only automates what it already did well.

## Made by Jean Souza

Hi, I'm **Jean**, a senior full-stack developer and ops/sysadmin from Brazil. I built contas-bot because my partner and I were tired of retyping the same checklist every month. It turned into a nice exercise in doing a lot with very little: one process, one file, no database, and an LLM used only where rules can't do the job.

I like building things that quietly remove chores from people's lives, from bots like this one to self-hosted infrastructure that just keeps running.

- 🌐 [jeansouza.dev](https://jeansouza.dev)
- 💼 [linkedin.com/in/jeancosouza](https://www.linkedin.com/in/jeancosouza)
- 🐙 [github.com/jeancarlos](https://github.com/jeancarlos)

If contas-bot saved your group some scrolling, **give it a ⭐**. It helps other people find it. Want something like this built for your team or product? Get in touch.
