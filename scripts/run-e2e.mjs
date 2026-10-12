import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const schema = "gd007_e2e_" + randomBytes(5).toString("hex");
const ordersOnly = process.argv.includes("--work-orders-only");
const adminOnly = process.argv.includes("--admin-only") || ordersOnly;
const desktopOnly = process.argv.includes("--desktop-only");
const sessionOnly = process.argv.includes("--session-only");
const lifecycleOnly = process.argv.includes("--lifecycle-only");
const proxyOnly = process.argv.includes("--proxy-only");
if ([adminOnly, desktopOnly, sessionOnly, lifecycleOnly, proxyOnly].filter(Boolean).length > 1)
  throw Error("Choose only one focused suite");
const withAdmin = !desktopOnly && !sessionOnly && !lifecycleOnly && !proxyOnly;
const pg = process.env.GONGDAN_PG_BIN || "/opt/homebrew/opt/postgresql@17/bin";
const database =
  process.env.TEST_DATABASE_URL || "postgres://127.0.0.1:55437/gongdan007?sslmode=disable";
const url = new URL(database);
url.searchParams.set("search_path", schema);
const settings = {
  DATABASE_URL: url.toString(),
  LISTEN_ADDR: "127.0.0.1:18081",
  BOOTSTRAP_USERNAME: "e2e-admin",
  BOOTSTRAP_PASSWORD: randomBytes(20).toString("hex"),
  GONGDAN_MASTER_KEY: randomBytes(32).toString("hex"),
  schema,
};
const children = [];
function sql(statement) {
  const r = spawnSync(path.join(pg, "psql"), [database, "-v", "ON_ERROR_STOP=1", "-c", statement], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw Error(r.stderr || "psql failed");
}
function launch(command, args, env = {}, cwd = process.cwd()) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    cwd,
    detached: true,
  });
  children.push(child);
  return child;
}
async function run(command, args, env = {}) {
  const child = launch(command, args, env);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(command + " exited " + code)),
    );
  });
}
async function ready(url) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Service did not start: " + url);
}
for (const port of withAdmin ? [18081, 5779] : [18081]) {
  try {
    await fetch(`http://127.0.0.1:${port}`);
    throw Error("E2E port is already occupied: " + port);
  } catch (e) {
    if (e.message.startsWith("E2E")) throw e;
  }
}
await mkdir(".runtime", { recursive: true });
await writeFile(".runtime/e2e.json", JSON.stringify(settings), { mode: 0o600 });
sql("CREATE SCHEMA " + schema);
try {
  if (withAdmin) await run("pnpm", ["build:admin"]);
  if (!adminOnly || ordersOnly) await run("pnpm", ["build:desktop"]);
  launch("go", ["run", "./cmd/api"], settings, path.resolve("server"));
  await ready("http://127.0.0.1:18081/healthz");
  if (withAdmin) {
    launch(
      "pnpm",
      [
        "--filter",
        "@gongdan/admin",
        "exec",
        "vite",
        "preview",
        "--host",
        "127.0.0.1",
        "--port",
        "5779",
      ],
      { GONGDAN_API_TARGET: "http://127.0.0.1:18081" },
    );
    await ready("http://127.0.0.1:5779");
    if (!ordersOnly) {
      await run(process.execPath, ["scripts/check-admin.mjs"]);
      await run(process.execPath, ["scripts/check-commerce.mjs"]);
      await run(process.execPath, ["scripts/check-baseline.mjs"]);
    }
    await run(process.execPath, ["scripts/check-work-orders.mjs"]);
    if (ordersOnly) await run(process.execPath, ["scripts/check-work-order-native.mjs"]);
  }
  if (!adminOnly) {
    if (proxyOnly) await run(process.execPath, ["scripts/check-client-proxy.mjs"]);
    else if (lifecycleOnly) await run(process.execPath, ["scripts/check-account-lifecycle.mjs"]);
    else {
      if (!sessionOnly) {
        await run(process.execPath, ["scripts/check-client-proxy.mjs"]);
        await run(process.execPath, ["scripts/check-desktop.mjs"]);
      }
      await run(process.execPath, ["scripts/check-client-session.mjs"]);
    }
  }
  console.log(
    sessionOnly
      ? "Client session end-to-end checks passed."
      : adminOnly
        ? "Admin end-to-end checks passed."
        : "End-to-end checks passed. No WhatsApp account was paired or message sent.",
  );
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  sql("DROP SCHEMA " + schema + " CASCADE");
}
