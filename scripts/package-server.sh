#!/usr/bin/env bash
# Build a clean Git revision on the development mirror, never on the live server.
set -euo pipefail
source_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
dev_root="${GONGDAN_DEV_DIR:-$HOME/Projects/gongdan007-dev}"
release_arch="${D1_GOARCH:-amd64}"
case "$release_arch" in amd64|arm64) ;; *) echo 'D1_GOARCH must be amd64 or arm64' >&2; exit 1;; esac
cd "$source_root"
[[ -z "$(git status --porcelain)" ]] || { echo 'Commit the release source before packaging.' >&2; exit 1; }
revision="$(git rev-parse HEAD)"
sh scripts/sync-dev.sh
export D1_RELEASE_REV="$revision" D1_RELEASE_ARCH="$release_arch"
export D1_RELEASE_DIR="$dev_root/.runtime/releases/${revision:0:12}-linux-$release_arch"
[[ ! -e "$D1_RELEASE_DIR" ]] || { echo "Release already exists: $D1_RELEASE_DIR" >&2; exit 1; }
mkdir -p "$D1_RELEASE_DIR"
cd "$dev_root"
pnpm build:admin
(cd server && CGO_ENABLED=0 GOOS=linux GOARCH="$release_arch" go build -trimpath -ldflags='-s -w' -o "$D1_RELEASE_DIR/api" ./cmd/api)
cp -R apps/admin/dist "$D1_RELEASE_DIR/web"
mkdir "$D1_RELEASE_DIR/infra"
cp infra/d1* infra/api.env.example infra/README.md "$D1_RELEASE_DIR/infra/"
node --input-type=module <<'JS'
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.env.D1_RELEASE_DIR;
await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
  product: 'D1 Scrm', revision: process.env.D1_RELEASE_REV,
  architecture: `linux-${process.env.D1_RELEASE_ARCH}`, migration: 20,
  createdAt: new Date().toISOString(),
}, null, 2) + '\n');
async function files(dir) {
  const result = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...await files(p));
    else if (e.isFile()) result.push(p);
    else throw new Error(`Unexpected release entry: ${p}`);
  }
  return result;
}
const sums = [];
for (const p of (await files(root)).sort()) {
  sums.push(`${createHash('sha256').update(await readFile(p)).digest('hex')}  ${path.relative(root, p)}`);
}
await writeFile(path.join(root, 'SHA256SUMS'), sums.join('\n') + '\n');
JS
COPYFILE_DISABLE=1 tar -czf "$D1_RELEASE_DIR.tar.gz" -C "$D1_RELEASE_DIR" .
shasum -a 256 "$D1_RELEASE_DIR.tar.gz" > "$D1_RELEASE_DIR.tar.gz.sha256"
printf 'Release: %s\n' "$D1_RELEASE_DIR.tar.gz"
