// Produce self-contained clients. Only bundled application files enter the package.
import { build, Platform, Arch } from "electron-builder";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

const targets = process.argv.slice(2);
if (!targets.length || targets.some((t) => !["mac-arm64", "mac-x64", "win-x64"].includes(t))) {
  throw new Error("Usage: pnpm package mac-arm64 mac-x64 win-x64");
}
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const root = path.resolve("../../.runtime/desktop-release", pkg.version);
const app = path.join(root, "app");
const apiURL = process.env.D1_RELEASE_API_URL || "https://api.d1scrm.com";
if (new URL(apiURL).protocol !== "https:") throw new Error("Release API must use HTTPS");
await rm(app, { recursive: true, force: true });
await mkdir(app, { recursive: true });
const built = spawnSync(process.execPath, ["scripts/build.mjs"], {
  stdio: "inherit",
  env: {
    ...process.env,
    GONGDAN_API_URL: apiURL,
    GONGDAN_DESKTOP_OUTPUT_DIR: path.join(app, "dist"),
  },
});
if (built.status !== 0) throw new Error("Desktop build failed");
await rm(path.join(app, "dist/main.cjs.map"), { force: true });
await writeFile(
  path.join(app, "package.json"),
  JSON.stringify(
    {
      name: "d1-scrm",
      productName: pkg.productName,
      version: pkg.version,
      description: pkg.description,
      author: "D1 Scrm",
      main: pkg.main,
      homepage: "https://d1scrm.com",
    },
    null,
    2,
  ),
);

const results = [];
for (const target of targets) {
  const [os, cpu] = target.split("-");
  const arch = cpu === "arm64" ? Arch.arm64 : Arch.x64;
  const platform = os === "mac" ? Platform.MAC : Platform.WINDOWS;
  results.push(
    ...(await build({
      projectDir: app,
      targets: platform.createTarget(os === "mac" ? ["dmg"] : ["nsis"], arch),
      publish: "never",
      config: {
        appId: "com.d1scrm.desktop",
        productName: "D1 Scrm",
        electronVersion: pkg.devDependencies.electron,
        directories: {
          output: path.join(root, "artifacts"),
          buildResources: path.resolve("resources"),
        },
        files: ["dist/**/*", "package.json", "!**/*.map"],
        asar: true,
        npmRebuild: false,
        mac: {
          category: "public.app-category.business",
          icon: "icon.icns",
          identity: "-",
          notarize: false,
          hardenedRuntime: true,
          minimumSystemVersion: "13.0.0",
          artifactName: "D1-Scrm-${version}-mac-${arch}.${ext}",
        },
        dmg: { sign: false },
        win: {
          icon: "icon.png",
          executableName: "D1Scrm",
          artifactName: "D1-Scrm-${version}-windows-${arch}-setup.${ext}",
        },
        nsis: {
          oneClick: false,
          perMachine: false,
          allowToChangeInstallationDirectory: true,
          createDesktopShortcut: true,
          shortcutName: "D1 Scrm",
          deleteAppDataOnUninstall: false,
        },
      },
    })),
  );
}
const published = results.filter((f) => /\.(dmg|exe)$/.test(f));
const metadata = [];
for (const file of published) {
  const data = await readFile(file);
  metadata.push({
    file: path.basename(file),
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  path.join(root, "artifacts", "release.json"),
  JSON.stringify(
    {
      version: pkg.version,
      apiURL,
      createdAt: new Date().toISOString(),
      signing: { mac: "ad-hoc, not notarized", windows: "unsigned" },
      files: metadata,
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  path.join(root, "artifacts", "SHA256SUMS"),
  metadata.map((f) => `${f.sha256}  ${f.file}`).join("\n") + "\n",
);
console.log("Client packages:", path.join(root, "artifacts"));
