# Contributing

Bug reports and feature requests go to https://github.com/jeancarlos/contas-bot/issues. Security problems go through the private route in SECURITY.md, never a public issue.

## Changes

1. Branch from `develop` as `feature/<name>`, `fix/<name>` or `chore/<name>`.
2. Run `npm ci`, then `npm run check` (lint, typecheck, tests). Every behavior change needs a test; `npm run coverage` must keep its thresholds.
3. Commit messages follow the repo hook: `feat` and `fix` are user-facing and need the trailers it asks for; internal work uses `chore`, `ci`, `refactor`, `test` or `docs`.
4. Open a pull request into `develop`. CI must pass. Only `develop` merges into `main`.

## Style

Biome decides formatting and lint (`npm run lint`). Code is TypeScript run by Node 22.18 or newer with no build step. The project is GPL-3.0-or-later; by contributing you agree your changes are released under it.

## What makes a contribution acceptable

A change is acceptable when it keeps the project's scope (see GOVERNANCE.md), passes `npm run check` and `npm run coverage`, comes with a test, follows the style Biome enforces, keeps every source file's SPDX header, and does not move a trust boundary without updating docs/ASSURANCE.md. A bug fix adds a regression test that fails without the fix. Source files must be written in English, and issues and pull requests are accepted in English or Portuguese.

## Tests are required

Every new behavior and every bug fix needs an automated test in `test/`, run with `npm test` (Node's built-in runner). The commit hook and CI both refuse a `feat` or `fix` commit that changes nothing under `test/`; the rare exception carries a `No-Test: <reason>` line in the commit message. `npm run coverage` fails the build below 90 percent lines, and CI requires it to pass.

## Code review

Every change, from anyone, goes through a pull request into `develop`, and no change reaches `main` any other way. Today the project has one maintainer, so the maintainer reviews their own pull requests against the checklist below and CI enforces what a machine can: lint, types, tests, coverage, a test with every `feat` and `fix`, secret and vulnerability scans. When a second maintainer exists, nobody merges their own change alone. The checklist: the change does what its description says and nothing else; tests prove it and would fail without it; error paths and untrusted input are handled; no secret, personal data or new network call slipped in; dependencies and workflow permissions are no wider than needed; the docs and docs/ASSURANCE.md still describe the code. A change from an outside contributor is accepted when CI is green and the maintainer approves, otherwise it gets a written reason. Dependabot updates that are patch or minor merge by themselves once CI passes; majors are reviewed by hand.

## Where to start

Issues labelled `good first issue` are small and self-contained: https://github.com/jeancarlos/contas-bot/labels/good%20first%20issue.

## Releases

Before tagging a release, run `npm run changelog` and commit the regenerated `CHANGELOG.md`: it lists the user-facing changes of every release, built from the same commit trailers as the release notes.

## Bug reports and requests

Bug reports and enhancement requests get a first response within 14 days. A report with the bot's version (`contas-bot status`) and the relevant log lines is fastest to fix. Fixed bugs close with a link to the change that fixed them.

## Developer setup

`git clone`, then `npm ci` and `npm test`. Docker is only needed for the container checks. `npm run check` runs lint, typecheck and tests in one go.
