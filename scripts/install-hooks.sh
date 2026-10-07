#!/bin/sh
set -eu
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
if [ -n "$(git config --global --get core.hooksPath || true)" ]; then
  git config --local hooks.chain .githooks
else
  git config --local core.hooksPath .githooks
fi
