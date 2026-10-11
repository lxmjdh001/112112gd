import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  LINE_COMPONENT_VERSION,
  LINE_COMPONENT_SHA256,
  LINE_COMPONENT_PUBLIC_KEY,
  LINE_COMPONENT_URL,
} from "../../../../packages/platform/line/component.ts";

export class LineComponentError extends Error {}
let installing: Promise<string> | undefined;
export function unpackLineComponent(crx: Uint8Array): Record<string, Uint8Array> {
  // Pin the official package before decompressing or ever executing it.
  if (createHash("sha256").update(crx).digest("hex") !== LINE_COMPONENT_SHA256)
    throw new LineComponentError("LINE 登录组件校验未通过，请更新 D1 Scrm 后重试");
  const data = Buffer.from(crx);
  if (data.toString("ascii", 0, 4) !== "Cr24" || data.readUInt32LE(4) !== 3)
    throw new LineComponentError("LINE 登录组件格式无效");
  const files = unzipSync(data.subarray(12 + data.readUInt32LE(8)));
  const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
  if (manifest.version !== LINE_COMPONENT_VERSION || manifest.name !== "LINE")
    throw new LineComponentError("LINE 登录组件版本不匹配");
  // D1 manages the host window and its lifecycle. Keep the official app scripts,
  // WASM, extension origin and sandbox untouched; disable only Chrome's launcher.
  delete manifest.background;
  manifest.key = LINE_COMPONENT_PUBLIC_KEY;
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return files;
}

export function ensureLineComponent(
  root: string,
  download: (url: string) => Promise<Response>,
): Promise<string> {
  if (installing) return installing;
  installing = install(root, download).finally(() => {
    installing = undefined;
  });
  return installing;
}
async function install(root: string, download: (url: string) => Promise<Response>) {
  const directory = path.join(root, "components", "line", LINE_COMPONENT_VERSION);
  const archive = path.join(root, "components", "line", `${LINE_COMPONENT_VERSION}.crx`);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(archive);
  } catch {
    try {
      const response = await download(LINE_COMPONENT_URL);
      if (!response.ok) throw Error("download failed");
      const reader = response.body?.getReader();
      if (!reader) throw Error("download body missing");
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > 16 * 1024 * 1024) {
          await reader.cancel();
          throw Error("download too large");
        }
        chunks.push(result.value);
      }
      bytes = Buffer.concat(chunks);
    } catch {
      throw new LineComponentError("LINE 登录组件下载失败，请检查网络后重新打开账号");
    }
  }
  const files = unpackLineComponent(bytes);
  try {
    if ((await readFile(path.join(directory, ".d1-verified"), "utf8")) === LINE_COMPONENT_SHA256)
      return directory;
  } catch {
    /* First install or interrupted component setup. */
  }
  // Recreate only the shared, verified program files. Account sessions live in
  // Electron's separate per-account partitions and are never touched here.
  const temporary = directory + ".installing";
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const [name, contents] of Object.entries(files)) {
      const target = path.resolve(temporary, name);
      if (!target.startsWith(path.resolve(temporary) + path.sep) || name.includes("\\"))
        throw new LineComponentError("LINE 登录组件包含无效路径");
      if (name.endsWith("/")) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    await writeFile(path.join(temporary, ".d1-verified"), LINE_COMPONENT_SHA256);
    await rm(directory, { recursive: true, force: true });
    await rename(temporary, directory);
    await writeFile(archive, bytes, { mode: 0o600 });
    return directory;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
