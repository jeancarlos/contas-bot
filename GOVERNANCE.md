# Governance

contas-bot is a small project with one maintainer. This page says who decides what, so that contributors know what to expect and so the project can outlive any one person.

## Roles

- **Maintainer** (currently Jean Souza, GitHub `@jeancarlos`): owns the roadmap, reviews and merges every pull request, cuts releases, answers vulnerability reports, and enforces the code of conduct. The maintainer holds the only account with write access to the repository, the release workflow and the Cloudflare zone for `contas-bot.jeansouza.dev`.
- **Contributor**: anyone who opens an issue, a pull request or a discussion. Contributors follow CONTRIBUTING.md and the code of conduct. A contributor who has had several changes merged can be invited to become a maintainer.
- **Reporter**: anyone who reports a vulnerability through SECURITY.md. Reporters are credited in the release notes of the fix unless they ask not to be.

## How decisions are made

Day-to-day decisions happen in issues and pull requests, in the open. The maintainer decides, after listening: a change merges when CI is green, it has tests, and the maintainer judges it fits the project's scope (a WhatsApp bot for a household's bills, small, self-hosted, mechanical first and AI second). Larger changes get an issue first so the design can be discussed before code is written. Disagreements are settled by the maintainer; the GPL-3.0-or-later license always lets anyone fork.

## Continuity

Everything needed to build, test and release is in the repository: the release workflow signs and attests every release from GitHub Actions with no stored secrets, tests run in CI, and the install script and Docker image are published from tags. Anyone given write access can cut a release by pushing a `v*` tag from `main`. If the maintainer becomes unavailable, a trusted contributor can be granted access by the repository owner's successor; until a second maintainer exists, the project may pause new features, but the license, the published releases and the source remain available to everyone.

TODO for the maintainer: name a second person (backup maintainer) here and give them admin access to the repository. That is what makes the continuity statement above true, and it is also what the bus-factor criteria ask for.
