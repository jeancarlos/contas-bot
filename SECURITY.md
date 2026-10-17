# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Report it privately through GitHub: https://github.com/jeancarlos/contas-bot/security/advisories/new

Do not open a public issue for a vulnerability. Expect a first reply within 7 days.

## Process

1. The maintainer acknowledges the report within 7 days and confirms or rejects it within 14.
2. A confirmed vulnerability is fixed on a private branch where needed, released as a patch version, and published as a GitHub security advisory. Medium or higher severity issues are fixed within 60 days of becoming public, and critical ones as fast as the fix can be tested.
3. The release notes name the fixed issue, with its CVE when one exists.
4. The reporter is credited in the advisory and the release notes unless they ask to stay anonymous.

## Verifying a release

Every release is built by GitHub Actions and carries a build provenance attestation signed through Sigstore, with no long-lived key to steal. To check a download before running it:

```sh
gh attestation verify install.sh --repo jeancarlos/contas-bot
```

`contas-bot update` does this automatically when `gh` 2.49 or newer is installed and logged in. The container image is attested the same way and pinned by digest after install.
