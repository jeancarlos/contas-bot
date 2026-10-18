# OpenSSF Best Practices answers

Answers for <https://www.bestpractices.dev> (passing level). Project URL: <https://github.com/jeancarlos/contas-bot>.

| Criterion | Answer | Evidence |
|---|---|---|
| description_good, interact, contribution, contribution_requirements | Met | README.md, CONTRIBUTING.md (including "What makes a contribution acceptable"), GOVERNANCE.md |
| floss_license, floss_license_osi, license_location | Met | GPL-3.0-or-later, LICENSE at the repository root |
| documentation_basics | Met | README.md: features, install, run your own, day to day, uninstall |
| documentation_interface | Met | README.md "Commands" (every chat command), "Day to day" (the `contas-bot` CLI), the environment variable table; addons/README.md for the HTTP endpoints, their query parameters and bearer token |
| sites_https, delivery_mitm | Met | github.com, ghcr.io and contas-bot.jeansouza.dev only, all over HTTPS; releases carry a Sigstore build provenance attestation that `contas-bot update` verifies |
| sites_password_security | N/A | the project's sites store no user passwords |
| discussion, english | Met | GitHub issues and pull requests, English or Portuguese; documentation and source in English |
| maintained | Met | commits every week, see the commit history |
| repo_public, repo_track, repo_interim, repo_distributed | Met | public git repository on GitHub |
| version_unique, version_semver, version_tags | Met | tags vX.Y.Z (semantic versioning), one per release |
| release_notes | Met | https://github.com/jeancarlos/contas-bot/releases: each release lists the user-facing changes in English and Portuguese, or says there are none, and ends with the upgrade impact (`contas-bot update`, settings and history kept); built from CHANGELOG.json by scripts/changelog.ts, never from the git log |
| release_notes_vulns | N/A | no publicly known vulnerability fixed in a release so far; SECURITY.md promises the CVE in the notes when one exists |
| report_process, report_tracker, report_responses, enhancement_responses, report_archive | Met | GitHub issues, CONTRIBUTING.md "Bug reports and requests" (first response within 14 days) |
| vulnerability_report_process, vulnerability_report_private, vulnerability_report_response | Met | SECURITY.md, GitHub private vulnerability reporting, 7 day acknowledgement |
| build, build_common_tools, build_floss_tools | N/A | TypeScript run directly by Node 22.18, no compile step; the container image is built from the Dockerfile with `docker compose build` and by release.yml |
| test, test_invocation, test_most, test_continuous_integration | Met | `npm test` (Node's built-in runner), coverage gate 90 lines / 93 branches / 93 functions, .github/workflows/ci.yml and quality.yml |
| test_policy, tests_are_added, tests_documented_added | Met | CONTRIBUTING.md "Tests are required"; the commit hook and the `fixes-have-tests` CI job refuse a `feat` or `fix` without a test |
| warnings, warnings_fixed, warnings_strict | Met | Biome with `--error-on-warnings` and `tsc --noEmit` in `npm run check` and in CI |
| know_secure_design, know_common_errors | Met | docs/ASSURANCE.md (requirements, threat model, trust boundaries); test/claims.test.ts fails on shell spawns, weak crypto, interpolated SQL and non-GET HTTP in src/ |
| crypto_published, crypto_call, crypto_floss, crypto_keylength, crypto_working, crypto_weaknesses, crypto_pfs, crypto_password_storage, crypto_random | N/A | no cryptography implemented; only node:crypto `createHash('sha256')` and `timingSafeEqual` for the optional HTTP token, and the WhatsApp protocol is Baileys |
| delivery_unsigned | Met | install.sh and the container image carry build provenance attestations (Sigstore, no stored key); `gh attestation verify` in SECURITY.md |
| vulnerabilities_fixed_60_days, vulnerabilities_critical_fixed | Met | none known open; OSV scanner and Trivy in security.yml, Dependabot |
| no_leaked_credentials | Met | gitleaks in security.yml, secrets only in `.env` and `auth/`, both ignored by git |
| static_analysis, static_analysis_fixed, static_analysis_often | Met | CodeQL on push to main and develop and weekly (codeql.yml), Biome, tsc |
| static_analysis_common_vulnerabilities | Met | CodeQL runs the `security-extended` query suite for JavaScript/TypeScript and for GitHub Actions workflows (codeql.yml), which covers injection, path traversal, unsafe deserialization and similar |
| dynamic_analysis, dynamic_analysis_enable_assertions | Met | .github/workflows/dynamic.yml runs the fuzz and property tests (fast-check) on every `v*` tag and weekly; assertions are on in `node --test` |
| dynamic_analysis_unsafe, dynamic_analysis_fixed | N/A | memory-safe language |
