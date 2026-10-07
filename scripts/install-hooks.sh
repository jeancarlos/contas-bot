#!/bin/sh
set -eu
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
if git config --show-scope --get-all core.hooksPath | grep -qv '^local[[:space:]]'; then
  git config --local hooks.chain .githooks
  if [ "$(git config --local --get core.hooksPath || true)" = .githooks ]; then
    git config --local --unset core.hooksPath
  fi
else
  git config --local core.hooksPath .githooks
fi
