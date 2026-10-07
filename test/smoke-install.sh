#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
img=contas-bot:smoke
docker build -q -t "$img" . >/dev/null
work=$(mktemp -d)
export HOME="$work/home"
mkdir -p "$HOME"
run() {
  CONTAS_BOT_IMAGE=$img CONTAS_BOT_DIR="$work/bot" CONTAS_BOT_NO_START=1 CONTAS_BOT_NO_PAIR=1 \
  CONTAS_BOT_LANG=pt-BR CONTAS_BOT_PAIRING=code CONTAS_BOT_PHONE='+55 (11) 90000-0000' \
  CONTAS_BOT_AI=none CONTAS_BOT_TZ=America/Sao_Paulo sh install.sh </dev/null
}
run >/dev/null
env_file="$work/bot/.env"
grep -qx 'BOT_PHONE=5511900000000' "$env_file"
grep -qx 'BOT_LANG=pt-BR' "$env_file"
grep -qx 'LLM_BASE_URL=' "$env_file"
[ "$(stat -c %a "$env_file")" = 600 ]
[ -d "$work/bot/auth" ] && [ -d "$work/bot/data" ]
[ -x "$work/bot/contas-bot" ] && [ -L "$HOME/.local/bin/contas-bot" ]
(cd "$work/bot" && docker compose config -q)
before=$(cat "$env_file")
out=$(run)
[ "$(cat "$env_file")" = "$before" ]
printf '%s\n' "$out" | grep -qF "rm -rf '$work/bot'"
"$HOME/.local/bin/contas-bot" status | grep -q 'contas-bot'
count() { docker ps -a --filter name=contas-bot -q | wc -l; }
before_ps=$(count)
fresh="$work/fresh"
mkdir -p "$fresh"
if HOME="$fresh" CONTAS_BOT_IMAGE=$img CONTAS_BOT_DIR="$fresh/bot" CONTAS_BOT_LANG=pt-BR CONTAS_BOT_AI=none sh install.sh </dev/null >/dev/null 2>&1; then
  echo "install.sh should fail without answers" >&2
  exit 1
fi
[ ! -e "$fresh/.local/bin/contas-bot" ]
[ "$(count)" = "$before_ps" ]
echo "smoke ok"
