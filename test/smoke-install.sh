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
cleanup() { docker rm -f contas-bot-smoke >/dev/null 2>&1 || true; }
trap cleanup EXIT
boot() {
  cleanup
  docker run -d --name contas-bot-smoke --network none --user "$(id -u):$(id -g)" --env-file "$1/.env" \
    -e AUTH_DIR=/app/auth -e STATE_FILE=/app/data/state.json \
    -v "$1/auth:/app/auth" -v "$1/data:/app/data" "$img" >/dev/null
  n=0
  while [ "$n" -lt 20 ]; do
    out=$(docker logs contas-bot-smoke 2>&1)
    case "$out" in *'contas-bot ready'*) break ;; esac
    n=$((n + 1))
    sleep 1
  done
  cleanup
  case "$out" in *'contas-bot ready'*) ;; *) printf '%s\n' "$out" >&2; return 1 ;; esac
  case "$out" in *'missing env'*) printf '%s\n' "$out" >&2; return 1 ;; esac
}
boot "$work/bot"
custom="$work/custom"
CONTAS_BOT_IMAGE=$img CONTAS_BOT_DIR="$custom" CONTAS_BOT_NO_START=1 CONTAS_BOT_NO_PAIR=1 \
  CONTAS_BOT_LANG=en CONTAS_BOT_PAIRING=code CONTAS_BOT_PHONE=5511900000000 \
  CONTAS_BOT_AI=custom CONTAS_BOT_LLM_URL=http://127.0.0.1:9/v1 CONTAS_BOT_LLM_KEY=k CONTAS_BOT_VISION_MODEL=m CONTAS_BOT_TZ=UTC sh install.sh </dev/null >/dev/null
boot "$custom"
fakebin="$work/fakebin"
mkdir -p "$fakebin" "$work/rb"
cat >"$fakebin/docker" <<'EOF'
#!/bin/sh
echo "$*" >>"$FAKE_LOG"
case "$1 $2" in
  "compose up") [ "$FAKE_UPFAIL" = 1 ] && exit 1; exit 0 ;;
  "compose version"|"info -f"|"compose stop") exit 0 ;;
esac
case "$1" in
  info) exit 0 ;;
  pull) [ "$FAKE_FAIL" = pull ] && exit 1; exit 0 ;;
  run) exit 7 ;;
esac
exit 0
EOF
chmod +x "$fakebin/docker"
touch "$work/rb/docker-compose.yml"
fake() {
  : >"$work/fake.log"
  PATH="$fakebin:$PATH" FAKE_LOG="$work/fake.log" FAKE_FAIL=$1 FAKE_UPFAIL=${2:-0} CONTAS_BOT_DIR="$work/rb" CONTAS_BOT_LANG=pt-BR CONTAS_BOT_AI=none sh install.sh </dev/null >/dev/null 2>&1 && return 1
  return 0
}
fake pull
if grep -q 'compose stop' "$work/fake.log"; then exit 1; fi
fake run
stop_at=$(grep -n 'compose stop' "$work/fake.log" | head -n 1 | cut -d: -f1)
up_at=$(grep -n 'compose up' "$work/fake.log" | tail -n 1 | cut -d: -f1)
[ -n "$stop_at" ] && [ -n "$up_at" ] && [ "$up_at" -gt "$stop_at" ]
rc=0
PATH="$fakebin:$PATH" FAKE_LOG="$work/fake.log" FAKE_FAIL=run FAKE_UPFAIL=1 CONTAS_BOT_DIR="$work/rb" CONTAS_BOT_LANG=pt-BR CONTAS_BOT_AI=none sh install.sh </dev/null >/dev/null 2>&1 || rc=$?
[ "$rc" = 7 ]
echo "smoke ok"
