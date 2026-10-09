#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DATA="${GONGDAN_LOCAL_DATA:-$HOME/.local/share/gongdan007}"
PGBIN="${GONGDAN_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
mkdir -p "$DATA"
chmod 700 "$DATA"
if [ ! -f "$DATA/development.env" ]; then
  python3 - "$DATA" <<'PYCONFIG'
import pathlib,secrets,sys
p=pathlib.Path(sys.argv[1])/'development.env'
s="DATABASE_URL=postgres://127.0.0.1:55437/gongdan007?sslmode=disable\nLISTEN_ADDR=127.0.0.1:18080\nBOOTSTRAP_USERNAME=admin\nBOOTSTRAP_PASSWORD="+secrets.token_urlsafe(18)+"\nGONGDAN_MASTER_KEY="+secrets.token_hex(32)+"\n"
p.write_text(s);p.chmod(0o600)
PYCONFIG
fi
if [ ! -f "$DATA/postgres/PG_VERSION" ]; then
  "$PGBIN/initdb" -D "$DATA/postgres" -A trust --no-locale --encoding=UTF8 > "$DATA/initdb.log"
fi
if ! "$PGBIN/pg_ctl" -D "$DATA/postgres" status >/dev/null 2>&1; then
  "$PGBIN/pg_ctl" -D "$DATA/postgres" -l "$DATA/postgres.log" -o '-h 127.0.0.1 -p 55437' start
fi
if ! "$PGBIN/psql" -h 127.0.0.1 -p 55437 -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname='gongdan007'" | grep -q 1; then
  "$PGBIN/createdb" -h 127.0.0.1 -p 55437 gongdan007
fi
set -a
. "$DATA/development.env"
set +a
python3 - "$DATA" <<'PYACCESS'
import os,pathlib,sys
p=pathlib.Path(sys.argv[1])/'admin-access.txt'
p.write_text('工单007 本机开发环境\n后台：http://127.0.0.1:5777\n账号：'+os.environ['BOOTSTRAP_USERNAME']+'\n密码：'+os.environ['BOOTSTRAP_PASSWORD']+'\n');p.chmod(0o600)
PYACCESS
printf '%s\n' "Local credentials: $DATA/development.env" 'API: http://127.0.0.1:18080'
cd "$ROOT/server"
exec go run ./cmd/api
