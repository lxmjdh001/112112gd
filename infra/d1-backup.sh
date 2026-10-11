#!/usr/bin/env bash
# PostgreSQL snapshot plus the matching encryption key/config; never public.
set -euo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run as root.' >&2; exit 1; }
destination="/var/backups/d1scrm"
install -d -m 0700 "$destination"
exec 9>"$destination/.lock"
flock -n 9 || exit 0
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d "$destination/.backup-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
# Peer authentication avoids exposing database credentials in command arguments.
runuser -u postgres -- pg_dump --format=custom --dbname=d1scrm > "$work/database.dump"
pg_restore --list "$work/database.dump" > /dev/null
install -m 0600 /etc/d1scrm/api.env "$work/api.env"
readlink -f /opt/d1scrm/current > "$work/release.txt"
if [[ -f /opt/d1scrm/current/manifest.json ]]; then
    cp /opt/d1scrm/current/manifest.json "$work/manifest.json"
fi
tar -C "$work" -czf "$destination/$stamp.tar.gz.part" .
mv "$destination/$stamp.tar.gz.part" "$destination/$stamp.tar.gz"
sha256sum "$destination/$stamp.tar.gz" > "$destination/$stamp.tar.gz.sha256"
# Initial production backups are retained until an explicit retention policy is set.
echo "D1 backup: $destination/$stamp.tar.gz"
