#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Jean Souza
set -eu
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
cd "$(git rev-parse --show-toplevel)"
branch=$(git symbolic-ref --short -q HEAD || true)
case "$branch" in
  develop|main|feature/*|fix/*|chore/*|dependabot/*) ;;
  *) echo "ci-local: branch '$branch' would fail branch-name in CI: use feature/, fix/ or chore/" >&2; exit 1 ;;
esac
echo "ci-local: check"
npm run --silent check
echo "ci-local: coverage gate"
npm run --silent coverage >/dev/null
echo "ci-local: policy"
node scripts/test-policy.ts "origin/develop..HEAD"
echo "ci-local: shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck .githooks/pre-commit .githooks/commit-msg scripts/install-hooks.sh scripts/ci-local.sh install.sh bin/contas-bot test/smoke-install.sh
else
  echo "ci-local: shellcheck not installed, CI will run it" >&2
fi
echo "ci-local: smoke install"
sh test/smoke-install.sh >/dev/null
