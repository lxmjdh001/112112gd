#!/bin/sh
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="${GONGDAN_DEV_DIR:-$HOME/Projects/gongdan007-dev}"
sh "$SOURCE/scripts/sync-dev.sh"
cd "$DEST"
# Prefer the compatible Node 24 already installed on this development machine.
# Other machines may supply Node 22.18+ or 24 through their normal PATH.
NODE_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
if [ -x "$NODE_RUNTIME/node" ]; then PATH="$NODE_RUNTIME:$PATH"; export PATH; fi
case "${1:-admin}" in
  api) exec sh scripts/dev-api.sh ;;
  admin|desktop|check)
    if [ ! -d node_modules ]; then pnpm install --frozen-lockfile; fi
    case "${1:-admin}" in
      admin) exec pnpm dev:admin --host 127.0.0.1 ;;
      desktop) exec pnpm dev:desktop ;;
      check) exec pnpm test:e2e ;;
    esac
    ;;
  *) printf '%s\n' 'Usage: sh scripts/dev.sh api|admin|desktop|check'; exit 1 ;;
esac
