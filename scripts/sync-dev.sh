#!/bin/sh
set -eu
SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="${GONGDAN_DEV_DIR:-$HOME/Projects/gongdan007-dev}"
[ "$SOURCE" != "$DEST" ] || exit 0
mkdir -p "$DEST"
rsync -a --delete --exclude=.git --exclude='._*' --exclude=.DS_Store --exclude=node_modules --exclude=dist --exclude=.env.local --exclude=.runtime --exclude=docs/references "$SOURCE/" "$DEST/"
printf '%s\n' "Development mirror: $DEST"
