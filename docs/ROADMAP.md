# Roadmap

This is the plan for the next twelve months (to October 2027). It is a statement of intent, not a promise; the maintainer reorders it as real use shows what matters. Ideas and votes go to https://github.com/jeancarlos/contas-bot/issues.

## Now (to end of 2026)

- Keep 90 percent line coverage and raise the weakest files: `src/setup.ts` and the event handlers at the bottom of `src/adapters/wa.ts` (good first issues).
- Reach the OpenSSF Best Practices silver level and keep the Scorecard score from dropping.
- Keep dependencies current with Dependabot; non-major updates merge on their own once checks pass.

## Next (first half of 2027)

- Move the runtime from Node 22 to the next LTS before Node 22 reaches end of life (April 2027), including the base image and the CI matrix.
- Follow Baileys releases and the WhatsApp Web version changes; fix pairing and reconnect regressions quickly.
- A worked example for every command in the README.

## Later (second half of 2027)

- More languages beyond Portuguese, English and Spanish, driven by contributors (the message tables are in `src/core/i18n.ts` and `src/setup/i18n.ts`).
- Better handling of receipts that the model cannot read: clearer questions, fewer retries.
- Optional per-bill reminders, off by default.

## Not planned

- A hosted version, accounts or any web login: the bot stays self-hosted and answers only in the groups its owner lists.
- Storing receipt images: they are used for one model call and dropped, and that stays.
