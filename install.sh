#!/bin/sh
set -eu
main() {
  VERSION="__VERSION__"
  IMAGE="${CONTAS_BOT_IMAGE:-ghcr.io/jeancarlos/contas-bot:$VERSION}"
  DIR="${CONTAS_BOT_DIR:-$HOME/contas-bot}"
  case "${LANG:-}" in pt*) L=pt ;; es*) L=es ;; *) L=en ;; esac
  say() { case "$L" in pt) printf '%s\n' "$1" ;; es) printf '%s\n' "$3" ;; *) printf '%s\n' "$2" ;; esac; }
  fail() { say "$@" >&2; exit 1; }

  command -v docker >/dev/null 2>&1 || fail \
    "🐳 Instale o Docker primeiro: https://docs.docker.com/get-docker/" \
    "🐳 Install Docker first: https://docs.docker.com/get-docker/" \
    "🐳 Instala Docker primero: https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || fail \
    "🐳 Falta o docker compose v2: https://docs.docker.com/compose/install/" \
    "🐳 docker compose v2 is missing: https://docs.docker.com/compose/install/" \
    "🐳 Falta docker compose v2: https://docs.docker.com/compose/install/"
  docker info >/dev/null 2>&1 || fail \
    "🐳 O Docker não está rodando, ou seu usuário não pode usá-lo. Abra o Docker e rode de novo." \
    "🐳 Docker isn't running, or your user can't use it. Start Docker and run this again." \
    "🐳 Docker no está corriendo, o tu usuario no puede usarlo. Abre Docker y vuelve a ejecutar."

  mkdir -p "$DIR"
  [ "${CONTAS_BOT_NO_START:-}" = 1 ] || [ ! -f "$DIR/docker-compose.yml" ] || (cd "$DIR" && docker compose stop)
  [ -n "${CONTAS_BOT_IMAGE:-}" ] || docker pull -q "$IMAGE" >/dev/null

  tz=${CONTAS_BOT_TZ:-}
  [ -n "$tz" ] || tz=$(cat /etc/timezone 2>/dev/null || true)
  [ -n "$tz" ] || tz=$(readlink /etc/localtime 2>/dev/null | sed -n 's#.*/zoneinfo/##p' || true)
  CONTAS_BOT_TZ=${tz:-America/Sao_Paulo}
  export CONTAS_BOT_TZ

  set -- docker run --rm --user "$(id -u):$(id -g)" -v "$DIR:/setup"
  for v in $(env | sed -n 's/^\(CONTAS_BOT_[A-Z0-9_]*\)=.*/\1/p'); do set -- "$@" -e "$v"; done
  if [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
    "$@" -it "$IMAGE" node src/setup.ts </dev/tty
  else
    "$@" -i "$IMAGE" node src/setup.ts </dev/null
  fi

  [ "${CONTAS_BOT_NO_START:-}" = 1 ] || (cd "$DIR" && docker compose up -d)

  mkdir -p "$HOME/.local/bin"
  ln -sf "$DIR/contas-bot" "$HOME/.local/bin/contas-bot"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) say "➕ Para usar o comando contas-bot, adicione ao seu shell: export PATH=\"\$HOME/.local/bin:\$PATH\"" \
           "➕ To use the contas-bot command, add to your shell: export PATH=\"\$HOME/.local/bin:\$PATH\"" \
           "➕ Para usar el comando contas-bot, agrega a tu shell: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
  say "📜 contas-bot logs · 🆕 contas-bot update · 🗑️ cd '$DIR' && docker compose down && rm -rf '$DIR'" \
      "📜 contas-bot logs · 🆕 contas-bot update · 🗑️ cd '$DIR' && docker compose down && rm -rf '$DIR'" \
      "📜 contas-bot logs · 🆕 contas-bot update · 🗑️ cd '$DIR' && docker compose down && rm -rf '$DIR'"
}
main "$@"
