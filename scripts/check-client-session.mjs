import { _electron as electron } from "playwright";
import { readFile, mkdtemp, access } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { waitClientState } from "./desktop-wait.mjs";

const settings = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
const backend = "http://127.0.0.1:18081";
let token;
async function api(route, body, method = body ? "POST" : "GET") {
  const res = await fetch(backend + "/api/v1" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(res.status, 200, `API ${route}`);
  return (await res.json()).data;
}
token = (
  await api("/auth/login", {
    username: settings.BOOTSTRAP_USERNAME,
    password: settings.BOOTSTRAP_PASSWORD,
  })
).accessToken;
const policy = {
  label: "登录保留验收",
  maxDevices: 1,
  maxAccounts: 1,
  allowedPlatforms: ["whatsapp"],
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
};
const code = await api("/login-codes", policy);
await api("/proxies/import", { lines: "session-probe.invalid:1080", protocol: "socks5" });
const proxy = (await api("/proxies")).find((p) => p.host === "session-probe.invalid");

let mode = "online",
  authCount = 0,
  heartbeatCount = 0;
const sockets = new Set();
const relay = http.createServer(async (req, res) => {
  try {
    if (req.url.endsWith("/client/auth")) authCount++;
    if (req.url.endsWith("/client/heartbeat")) heartbeatCount++;
    if (mode === "timeout") return; // Real AbortSignal timeout, not an HTTP error.
    if (mode === "offline") {
      req.socket.destroy();
      return;
    }
    if (
      mode === "unavailable" ||
      (mode === "metadata-failure" && req.url.endsWith("/client/accounts"))
    ) {
      res.writeHead(503, { "Content-Type": "text/plain" }).end("Service restarting");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const result = await fetch(backend + req.url, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    res.writeHead(result.status, { "Content-Type": "application/json" }).end(await result.text());
  } catch {
    if (!res.destroyed) res.writeHead(502).end();
  }
});
relay.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
});
relay.listen(0, "127.0.0.1");
await once(relay, "listening");
const address = `http://127.0.0.1:${relay.address().port}`;
const userData = await mkdtemp(path.join(tmpdir(), "gongdan007-session-"));
const credentials = path.join(userData, "authorization.bin");
let app, page;
const errors = [];
async function launch() {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: { ...process.env, GONGDAN_USER_DATA: userData },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
}
async function waitState(connection) {
  await waitClientState(page, (s) => s.loggedIn && s.connection === connection);
  assert.equal(await page.locator("#login-code").count(), 0, "Must retain the workspace");
}
async function login() {
  await page.locator("#login-code").fill(code.code);
  await page.locator("summary").click();
  await page.locator("#api-url").fill(address);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
}
try {
  await launch();
  // Successful authentication followed by failed account sync must retain credentials too.
  mode = "metadata-failure";
  await login();
  await waitState("reconnecting");
  mode = "online";
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("resume");
  });
  await waitState("online");
  const account = await page.evaluate(
    (proxyId) =>
      window.gongdan.createAccount({
        label: "缓存账号",
        platform: "whatsapp",
        proxyId,
        requestId: crypto.randomUUID(),
      }),
    proxy.id,
  );
  // Wait for the encrypted account snapshot, not just the renderer event.
  await waitClientState(page, (s) => s.accounts.some((a) => a.id === account));
  for (let i = 0; i < 40; i++) {
    const saved = await app.evaluate(async ({ safeStorage, app }) => {
      try {
        const fs = process.getBuiltinModule("fs");
        const p = process.getBuiltinModule("path");
        const value = JSON.parse(
          safeStorage.decryptString(
            fs.readFileSync(p.join(app.getPath("userData"), "authorization.bin")),
          ),
        );
        return value.accounts?.length;
      } catch {
        return 0;
      }
    });
    if (saved === 1) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(
    !(await readFile(credentials)).includes(Buffer.from(code.code)),
    "Must not persist a plaintext login code",
  );
  for (const failure of ["unavailable", "timeout", "offline"]) {
    mode = failure;
    await page.evaluate(() => window.gongdan.refresh());
    await waitState("reconnecting");
    await access(credentials);
    assert.equal((await page.evaluate(() => window.gongdan.state())).accounts.length, 1);
  }
  // Restart while the management service is still offline.
  await app.close();
  app = undefined;
  await launch();
  await waitState("reconnecting");
  assert.equal((await page.evaluate(() => window.gongdan.state())).accounts[0].id, account);
  await page.screenshot({ path: ".runtime/client-session-reconnecting.png" });
  const beforeRetry = heartbeatCount;
  mode = "online";
  // No refresh click: the scheduled retry must recover on its own.
  await waitState("online");
  assert(heartbeatCount > beforeRetry);
  assert.equal(authCount, 1, "Recovery must reuse the saved device session without the login code");
  await page.screenshot({ path: ".runtime/client-session-recovered.png" });
  // An explicit offline logout clears disk immediately and stays logged out after restart.
  mode = "offline";
  await page.getByRole("button", { name: "退出客户端", exact: true }).click();
  await page.locator("#login-code").waitFor();
  await assert.rejects(access(credentials));
  await app.close();
  app = undefined;
  mode = "online";
  await launch();
  await page.locator("#login-code").waitFor();
  assert.equal((await page.evaluate(() => window.gongdan.state())).loggedIn, false);
  await login();
  await waitState("online");
  // Confirmed admin revocation still ends the persistent session.
  await api("/login-codes/" + code.id, { ...policy, enabled: false }, "PATCH");
  await page.evaluate(() => window.gongdan.refresh());
  await page.locator("#login-code").waitFor();
  await assert.rejects(access(credentials));
  assert.deepEqual(errors, []);
  console.log(
    "Client session checks passed: partial startup failure, 503, timeout, offline restart, cached accounts, automatic reconnect, resume, explicit logout and admin revocation.",
  );
} finally {
  if (app) await app.close();
  for (const socket of sockets) socket.destroy();
  relay.close();
}
