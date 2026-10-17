# Security requirements and assurance case

This document states what contas-bot must protect, who and what it trusts, how the design and the code counter the threats that follow, and how that has been reviewed. It is kept in step with the code: a change that moves a trust boundary updates this page in the same pull request.

## What is protected

- The household's bill list and payment history, kept in SQLite under `data/`.
- The WhatsApp session in `auth/` (anyone holding it can act as the bot's number).
- The optional LLM API key in `.env`.

## Security requirements

1. The bot answers only in the groups its owner lists in `GROUP_INVITE_LINKS`, and only to slash commands and to a direct answer to a question it just asked. Everywhere else it is inert.
2. Only the person the bot asked can answer a question, within 10 minutes.
3. Nothing the model returns is trusted: its output is validated against the bill list before it is stored, and the bill is still marked paid if the endpoint is down.
4. Receipts are never stored: the image is used for one model call and dropped; only the amount is kept.
5. The optional HTTP add-ons are read-only, off unless `HTTP_PORT` is set, restricted to allowed host names, and protected by a bearer token when `HTTP_TOKEN` is set.
6. Secrets and state are readable by the bot's user only (`umask 077`), and the container runs with the least privilege Docker allows.
7. Every release is traceable to a commit and verifiable by a user before it runs.

## Threat model and trust boundaries

| Boundary | Untrusted side | What crosses it | Countered by |
|---|---|---|---|
| WhatsApp to bot | any group member, any sender | message text, images, PDFs | group allowlist (requirement 1); text cut to a fixed length; receipts capped at 16 MB; mentions and whitespace stripped before parsing |
| Bot to LLM endpoint | the model and the network | one receipt image out, JSON back | strict JSON extraction and validation against the bill list (requirement 3); no tool use, no code execution, the model cannot change state |
| PDF to image | a crafted PDF | first page rendered by poppler | `execFile` with an argument array (no shell), run as the unprivileged `node` user in a read-only container with a memory and process cap |
| HTTP add-ons to reader | anyone who can reach the port | read-only exports and metrics | host allowlist (421 on a bad host), constant-time bearer token comparison, binding configurable with `HTTP_BIND`, no write routes (requirement 5) |
| Installer and updater to user | the network, a compromised mirror | `install.sh`, the image | HTTPS only; build provenance attestation on `install.sh` and the image; `contas-bot update` runs `gh attestation verify` when `gh` is available; the image is pinned by digest after install |
| Repository to release | a malicious dependency or workflow change | the published artifacts | pinned action SHAs, Dependabot, OSV and Trivy scans, CodeQL, gitleaks, branch protection on `main` and `develop`, SLSA-style provenance |

## Secure design principles applied

- **Least privilege**: non-root user, all Linux capabilities dropped, `no-new-privileges`, read-only root filesystem with a tmpfs for `/tmp`, workflow tokens limited per job.
- **Economy of mechanism**: a small pure core (`decide(state, input)` has no I/O), one process, one SQLite file.
- **Fail safe**: save before you speak; if the save fails the bot says so and nothing else; an empty state refuses to start unless `ALLOW_EMPTY_STATE=1`.
- **Complete mediation and input validation**: every inbound message passes the same allowlist and parser; every model answer passes the same validator; amounts are parsed by one tested module.
- **Separation of duties for secrets**: credentials live in `.env` and `auth/`, outside the image; they change without rebuilding.
- **No custom cryptography**: transport encryption is WhatsApp's (libsignal through Baileys) and TLS to the LLM endpoint with certificate verification on by default.

## Common weaknesses and how they are countered

- Injection: no shell is spawned with user data; SQLite statements are parameterized; the model's text never reaches a query or a command.
- Denial of service: size caps on text and receipts, one queue per group, a lane limit with a timeout on receipt reads, memory and process limits on the container.
- Path traversal and file overwrite: user input never forms a file path; the only files written are the database, the session and logs.
- Credential leakage: gitleaks scans the full history on every change, and keys live only in `.env`.
- Vulnerable dependencies: OSV and Trivy scans, Dependabot, and the lockfile is the only dependency source.
- Memory safety: the code is TypeScript on Node; poppler is the one native component and runs confined as above.

## Assurance activities

- Static analysis on every pull request: CodeQL (security-extended), Biome with warnings as errors, `tsc`, Trivy config scan.
- Dynamic analysis: property and fuzz tests (fast-check) run in CI and again on every release tag and weekly in `dynamic.yml`.
- Tests: more than 390 tests, 90 percent line coverage and 90 percent branch coverage gated in CI.
- Security review: a full code-quality and security audit of the whole repository was run in October 2026 with code-jig (complexity, duplication, injection, secrets, container and workflow hardening). Every finding was fixed and released in v2.0.1 and later; the scan now reports zero findings. The next review is due when a trust boundary changes, or by October 2027.
