# contas-bot 🤖💸

[![CI](https://github.com/jeancarlos/contas-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/jeancarlos/contas-bot/actions/workflows/ci.yml)
[![security](https://github.com/jeancarlos/contas-bot/actions/workflows/security.yml/badge.svg)](https://github.com/jeancarlos/contas-bot/actions/workflows/security.yml)
[![CodeQL](https://github.com/jeancarlos/contas-bot/actions/workflows/codeql.yml/badge.svg)](https://github.com/jeancarlos/contas-bot/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jeancarlos/contas-bot/badge)](https://scorecard.dev/viewer/?uri=github.com/jeancarlos/contas-bot)
[![coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/jeancarlos/contas-bot/badges/coverage.json)](https://github.com/jeancarlos/contas-bot/actions/workflows/quality.yml)
[![release](https://img.shields.io/github/v/release/jeancarlos/contas-bot)](https://github.com/jeancarlos/contas-bot/releases/latest)
[![license](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-22%2B-blue)

**Your household bills, handled in the WhatsApp group you already use.**

Everyone has that group: someone pays the electricity, drops the receipt in the chat, and then someone else scrolls up and retypes the whole checklist ("Luz ✅, Água ⬜, Aluguel ⬜…") so nobody loses track. Every month. By hand.

contas-bot takes that job. Add it to the group and it keeps the list for you: send a receipt with `/pago luz`, and it ticks the bill off, reads the amount from the image, adds up the month, and keeps the latest list pinned at the top of the chat. Nobody installs an app, nobody learns a new tool.

> 🇧🇷 Feito para grupos brasileiros: o bot fala português, entende `R$ 6.237,60` e lê comprovantes de Pix, boleto e cartão.

## What it feels like

```
Ana:   [photo of the Pix receipt] /pago luz
Bot:   ✅
Bot:   📋 *Contas - Setembro/2026*

       ✅ Luz - R$ 231,45
       ✅ Cartão Nu - R$ 6.237,60
       ⬜ Água
       ⬜ Aluguel
       ⏸️ Academia

       *Pago:* 2/4 · *Total:* R$ 6.469,05
       📌 (pinned)
```

When something is missing, it asks instead of guessing:

```
Ana:   /pago cartão 120
Bot:   qual conta? Responda o nome: Cartão Nu, Cartão Itaú
Ana:   nu
Bot:   ✅
```

## Features

- 📎 **Receipts in, checkmarks out.** Photos and PDFs captioned `/pago <bill>`. The amount is read from the receipt, or typed: `/pago luz 80,00`.
- 💬 **It asks back.** A typo gets "você quis dizer `/pago luz 80,00`? Responda *sim*". An ambiguous name gets "qual conta?". A receipt it can't read gets "qual foi o valor?". Only the person who was asked can answer, with their next message, within 10 minutes. A 👍 counts as yes.
- 🧾 **One-off expenses.** `/pago avulsa farmácia 45,90` puts an extra expense on this month's list without adding a bill. An unknown name with an amount gets the offer too.
- 🧠 **AI only where it earns its keep.** Commands and names are matched mechanically: instant, free, predictable. The vision model only reads amounts, and, when a name matches several bills, picks among those bills only.
- 📌 **Always pinned.** Every change posts a fresh list with the month total and pins it. The old one is unpinned, so the top of the chat is always the truth.
- 🗓️ **Monthly reset.** On the 1st, a clean list goes up by itself.
- ✏️ **Edits work.** Fix a typo by editing the message. An edit never changes a payment that already happened: use `/despago` for that.
- 🔒 **Private by default.** It only serves the groups you list, and only answers slash commands. Anywhere else it's completely inert.
- 🌎 **Speaks your language and your money.** Portuguese, English or Spanish, with any currency (`R$ 6.237,60`, `$6,237.60`, `6237,60 €`). It understands commands in all three languages no matter which one it writes in.

## Commands

| Command | What it does |
|---|---|
| `/pago <bill> [amount] [month/year]` | mark paid: `/pago luz`, `/pago cartão nu 6.237,60`, `/pago luz 80 09/2026` (also `/paguei`, `/pagar`) |
| `/pago avulsa <name> <amount>` | a one-off expense on this month's list |
| `/despago <bill> [month/year]` | unmark |
| `/lista` | repost and repin the list |
| `/conta` | list the bills; `/conta adiciona <name>`, `remove`, `pausa`, `continua`, `renomeia <name> = <new>` |
| `/ajuda` | every command, with examples |

### One example per command

| You send | The bot replies |
|---|---|
| `/pago luz` | updates the list with ✅ luz and the new total, asking for the amount if the receipt gave none |
| `/pago cartão nu 6.237,60 09/2026` | marks the bill paid with that amount in September 2026 |
| `/pago avulsa presente 120` | adds a one-off `presente` of R$ 120,00 to this month's list |
| `/despago luz` | puts luz back to ⬜ and drops its amount from the total |
| `/lista` | posts the month's list again and pins it |
| `/conta` | shows the bills (⏸️ marks paused ones) and the `/conta` subcommands |
| `/conta adiciona internet` | adds `internet` to the bills |
| `/conta renomeia luz = energia` | renames luz to energia, keeping its history |
| `/ajuda` | lists every command with an example, in your language |

Bill names ignore accents and case, and a unique prefix is enough (`/pago cond`). Everything that isn't a slash command is left alone, except a direct answer to a question the bot just asked you.

## How it's built

One small Node 22 process speaking WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys). TypeScript runs directly on Node, state lives in SQLite (`node:sqlite`, one transaction per change), and the whole thing ships as one Docker container.

```
src/
  core/       pure logic: commands, matching, amounts, months, questions, the list, i18n
  shell/      one queue per group: load, decide, save, then talk to WhatsApp
  adapters/   WhatsApp socket, SQLite store and 1.x import, optional read-only HTTP
  llm.ts      OpenAI-compatible client with strict JSON validation
  pdf.ts      first page of a PDF receipt to PNG (poppler)
```

Design choices worth a look:

- **A pure core.** Every message goes through one function, `decide(state, input) → { state, effects }`, that does no I/O. Tests are tables of inputs and expected results.
- **Save before you speak.** A change is committed to SQLite before any ✅ or list is sent. If the save fails, the bot says so and nothing else.
- **Mechanical first, LLM second.** The model is a fallback, and its output is validated against the bill list before anything is stored. If the endpoint is down, the bill is still marked paid and the bot asks for the amount.
- **Receipts are never stored.** The image is used for one model call and dropped. Only the amount is kept.

## Add-ons

The bot can serve read-only data over HTTP (off unless you set `HTTP_PORT`): Prometheus metrics, CSV/JSON exports, a summary for Home Assistant and a small dashboard. See [addons/](addons/README.md). Nothing there can change a bill: every change happens in the group.

## Install

You need Docker:

- **Linux:** Docker Engine with the compose plugin (https://docs.docker.com/engine/install/).
- **macOS:** Docker Desktop (https://docs.docker.com/desktop/).
- **Windows:** Docker Desktop with WSL 2; run the command below inside your WSL terminal.

Then paste this into a terminal:

```sh
curl -fsSL https://github.com/jeancarlos/contas-bot/releases/latest/download/install.sh | sh
```

The installer asks a few questions and then connects the bot's WhatsApp right there on the screen:

1. Language (Português, English, Español) and currency.
2. How to connect WhatsApp: a QR code on the screen (recommended) or an 8-letter code.
3. Which AI reads the receipts: Google Gemini (free key from https://aistudio.google.com/apikey), OpenAI, your own OpenAI-compatible endpoint, or no AI at all.
4. The group's invite link (optional - you can add the bot to a group later).

On the bot's phone, open WhatsApp → Linked devices → Link a device and point the camera at the QR. If you chose the code, don't scan anything: tap "Link with phone number instead" and type the code shown.

Everything lives in `~/contas-bot` (set `CONTAS_BOT_DIR` before the command to use another folder). Nothing needs root.

### Coming from 1.x

Update as usual. On first start, 2.0 imports `data/state.json` into `data/contas.db` (the old file is kept as `state.v1.json`), takes the bill list from the bot's section of the group description once, and from then on bills are managed with `/conta`.

### Without AI

Pick "No AI" in the installer. Receipts are then paid when their caption names the bill (`/pago luz`), and the bot asks for the amount. Text commands work the same.

### Day to day

The installer adds a `contas-bot` command (in `~/.local/bin`):

| Command | What it does |
|---|---|
| `contas-bot status` | version, whether it's running and paired, how many groups |
| `contas-bot logs` | follow the bot's log |
| `contas-bot update` | checks for a newer release and updates after you confirm |
| `contas-bot pair` | reconnects WhatsApp when the session was lost |
| `contas-bot restart` | restarts the bot |

Updating is the same one-line command, or `contas-bot update`; your settings, history and WhatsApp session are kept.

To move the bot to a different WhatsApp number, stop it, delete `~/contas-bot/auth`, and run `contas-bot pair`.

### Uninstall

```sh
cd ~/contas-bot && docker compose down && rm -rf ~/contas-bot ~/.local/bin/contas-bot
```

### Unattended install

Every question can come from an environment variable, which skips the prompts: `CONTAS_BOT_LANG`, `CONTAS_BOT_CURRENCY`, `CONTAS_BOT_PAIRING` (`qr`/`code`), `CONTAS_BOT_PHONE`, `CONTAS_BOT_AI` (`gemini`/`openai`/`custom`/`none`), `CONTAS_BOT_LLM_KEY`, `CONTAS_BOT_LLM_URL`, `CONTAS_BOT_VISION_MODEL`, `CONTAS_BOT_GROUP`, `CONTAS_BOT_TZ`.

## Run your own

You need a spare WhatsApp number for the bot (a cheap prepaid SIM works). An OpenAI-compatible endpoint with a vision model is optional.

```bash
git clone https://github.com/jeancarlos/contas-bot
cd contas-bot
cp .env.example .env    # fill in the values below
docker compose up -d --build
docker compose logs -f
```

| Variable | Meaning |
|---|---|
| `BOT_PHONE` | the bot's number, digits with country code; only needed to pair with an 8-character code |
| `GROUP_INVITE_LINKS` | comma-separated groups the bot serves - a `chat.whatsapp.com` invite link or a jid; a link is resolved at boot and the jid is remembered; removing it from this variable turns the group off; empty serves no group |
| `BOT_LANG` | language the bot writes in: `pt-BR` (default), `en` or `es` |
| `BOT_CURRENCY` | currency for amounts and totals, an ISO 4217 code: `BRL` (default), `USD`, `EUR`, `MXN`… |
| `LLM_BASE_URL` | OpenAI-compatible endpoint; empty runs without AI |
| `LLM_API_KEY` | key for that endpoint |
| `LLM_VISION_MODEL` | model for receipts (must accept images) |
| `TZ` | time zone for the monthly reset (default `America/Sao_Paulo`) |
| `ALLOW_EMPTY_STATE` | `1` lets a brand-new install start with no history; without it the bot refuses to start empty, so a move that forgot to copy `data/` fails loudly |
| `HTTP_PORT` | optional: serve the read-only add-on endpoints on this port |
| `HTTP_HOSTS` | optional: extra host names allowed to reach `HTTP_PORT` (for a reverse proxy) |
| `HTTP_TOKEN` | optional: every HTTP request must send `Authorization: Bearer <token>` |

To set up a group before the bot joins it, put its invite link in `GROUP_INVITE_LINKS`, start the bot, then add the bot to the group: it's already allowed in, so it introduces itself right away. Being removed from a group turns the bot off for that group immediately; the group's history is kept.

For development:

```bash
npm install
npm run check   # lint, typecheck and tests
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

Hi, I'm **Jean**, a senior full-stack developer and ops/sysadmin from Brazil. I built contas-bot because my partner and I were tired of retyping the same checklist every month. It turned into a nice exercise in doing a lot with very little, and an LLM used only where rules can't do the job.

I like building things that quietly remove chores from people's lives, from bots like this one to self-hosted infrastructure that just keeps running.

- 🌐 [jeansouza.dev](https://jeansouza.dev)
- 💼 [linkedin.com/in/jeancosouza](https://www.linkedin.com/in/jeancosouza)
- 🐙 [github.com/jeancarlos](https://github.com/jeancarlos)

If contas-bot saved your group some scrolling, **give it a ⭐**. It helps other people find it. Want something like this built for your team or product? Get in touch.
