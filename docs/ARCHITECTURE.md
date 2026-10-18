# Architecture

contas-bot is one Node 22 process that keeps a household's bill list in a WhatsApp group. TypeScript runs directly on Node with no build step, state lives in one SQLite file, and the whole thing ships as one container. This page is the high-level design; docs/ASSURANCE.md covers the security side of the same boundaries.

## Components

- `src/core/` is the pure core. `decide(state, input, ctx)` in `src/core/decide.ts` takes the current group state and one input (a message, an edit, a tick) and returns the new state plus a list of effects (messages to send, a pin to move). It does no I/O, so every behavior is tested as a table of inputs and expected results. Matching, amounts, months, i18n and the list rendering live beside it.
- `src/shell/` is the imperative shell. `src/shell/run.ts` keeps one queue per group (`src/shell/mailbox.ts`): load the state, call `decide`, save, then run the effects. `src/shell/index.ts` reads the environment and wires everything together.
- `src/adapters/` holds everything that touches the outside world: the WhatsApp socket through Baileys (`src/adapters/wa.ts`), the SQLite store with its import of the old 1.x state file (`src/adapters/store.ts`, `src/adapters/v1.ts`), and the optional read-only HTTP server (`src/adapters/http.ts`).
- `src/llm.ts` is an OpenAI-compatible client that reads one receipt image and returns JSON, validated strictly. `src/pdf.ts` renders the first page of a PDF receipt with poppler.
- `src/setup.ts` and `src/setup/` are the interactive installer and pairing flow behind `contas-bot` in `bin/contas-bot`.

## Data flow

1. WhatsApp delivers a message to the adapter, which drops anything outside the allowed groups and turns the rest into a plain input.
2. The shell queues the input on its group's lane, loads the group's state from SQLite and calls `decide`.
3. If a receipt needs reading, the shell asks the LLM client for the amount and feeds the validated answer back through `decide`.
4. The new state is committed to SQLite in one transaction before anything is sent. Only then does the shell send the confirmation and the fresh list, and move the pin.

## Key properties

- Pure core, thin shell: all decisions are testable without WhatsApp, a database or a model.
- Save before you speak: if the save fails the bot says so and sends nothing else.
- Mechanical first, model second: commands and names are matched by code, the model only reads amounts, and its output never reaches a query or a command unchecked.
- Single writer: one process, one queue per group, one SQLite file, so there is no concurrent state to reconcile.
- Nothing stored that is not needed: receipt images are used for one model call and dropped.

## Deployment

`install.sh` pulls the image from GHCR and writes a `docker-compose.yml` with a read-only root filesystem, no capabilities, a non-root user and memory and process limits. Credentials live in `.env` and `auth/`, outside the image. The HTTP add-ons (`addons/`) are off unless `HTTP_PORT` is set. Releases are built by `.github/workflows/release.yml`, which attests the installer and the image.
