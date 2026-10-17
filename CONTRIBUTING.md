# Contributing

Bug reports and feature requests go to https://github.com/jeancarlos/contas-bot/issues. Security problems go through the private route in SECURITY.md, never a public issue.

## Changes

1. Branch from `develop` as `feature/<name>`, `fix/<name>` or `chore/<name>`.
2. Run `npm ci`, then `npm run check` (lint, typecheck, tests). Every behavior change needs a test; `npm run coverage` must keep its thresholds.
3. Commit messages follow the repo hook: `feat` and `fix` are user-facing and need the trailers it asks for; internal work uses `chore`, `ci`, `refactor`, `test` or `docs`.
4. Open a pull request into `develop`. CI must pass. Only `develop` merges into `main`.

## Style

Biome decides formatting and lint (`npm run lint`). Code is TypeScript run by Node 22.18 or newer with no build step. The project is GPL-3.0-or-later; by contributing you agree your changes are released under it.
