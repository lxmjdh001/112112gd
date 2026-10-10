import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve("electron"));
if (!existsSync(path.join(electronDir, "path.txt"))) {
  const install = spawnSync(process.execPath, [path.join(electronDir, "install.js")], {
    stdio: "inherit",
  });
  if (install.status !== 0) throw new Error("Electron runtime installation failed");
}
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.cjs",
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
for (const name of ["shell", "whatsapp"])
  await build({
    entryPoints: [`src/preload/${name}.ts`],
    outfile: `dist/${name}-preload.cjs`,
    platform: "node",
    format: "cjs",
    bundle: true,
    external: ["electron"],
    target: "node24",
  });
await build({
  entryPoints: ["src/renderer/index.ts"],
  outfile: "dist/renderer.js",
  platform: "browser",
  format: "iife",
  bundle: true,
  target: "chrome140",
});
await copyFile("src/renderer/index.html", "dist/index.html");
await copyFile("src/renderer/style.css", "dist/style.css");
