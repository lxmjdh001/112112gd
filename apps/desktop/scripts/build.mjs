import { build } from "esbuild";
import { mkdir, copyFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
const require = createRequire(import.meta.url);
const outputDir = process.env.GONGDAN_DESKTOP_OUTPUT_DIR || "dist";
const electronDir = path.dirname(require.resolve("electron"));
if (!existsSync(path.join(electronDir, "path.txt"))) {
  const install = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("Electron runtime installation failed");
}
await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: path.join(outputDir, "main.cjs"),
  platform: "node",
  format: "cjs",
  target: "node24",
  bundle: true,
  external: ["electron"],
  sourcemap: true,
  define: {
    __GONGDAN_API_URL__: JSON.stringify(process.env.GONGDAN_API_URL || "http://127.0.0.1:18080"),
  },
});
for (const name of ["shell", "whatsapp", "telegram", "line"])
  await build({
    entryPoints: [`src/preload/${name}.ts`],
    outfile: path.join(outputDir, `${name}-preload.cjs`),
    platform: "node",
    format: "cjs",
    bundle: true,
    external: ["electron"],
    target: "node24",
  });
await build({
  entryPoints: ["src/renderer/index.ts"],
  outfile: path.join(outputDir, "renderer.js"),
  platform: "browser",
  format: "iife",
  bundle: true,
  target: "chrome140",
});
await copyFile("src/renderer/index.html", path.join(outputDir, "index.html"));
await copyFile("src/renderer/style.css", path.join(outputDir, "style.css"));
await copyFile("src/renderer/account-sidebar.css", path.join(outputDir, "account-sidebar.css"));
await copyFile("../../packages/cloud-chat/style.css", path.join(outputDir, "cloud-chat.css"));
await mkdir(path.join(outputDir, "assets"), { recursive: true });
for (const file of await readdir("src/renderer/assets")) {
  if (!file.startsWith("._") && /\.(svg|ico|png|webp)$/.test(file))
    await copyFile(`src/renderer/assets/${file}`, path.join(outputDir, "assets", file));
}
