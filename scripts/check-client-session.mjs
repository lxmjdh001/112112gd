import { _electron as electron } from "playwright";
import { readFile, mkdtemp, access, rm } from "node:fs/promises";
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
let releaseAuth;
const authGate = new Promise((resolve) => {
  releaseAuth = resolve;
});
const relay = http.createServer(async (req, res) => {
  try {
    if (req.url.endsWith("/client/auth")) authCount++;
    if (mode === "slow-auth" && req.url.endsWith("/client/auth")) await authGate;
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
    const requested = new URL(req.url, backend);
    const result = await fetch(backend + requested.pathname + requested.search, {
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
const preferences = path.join(userData, "login-preferences.json");
let app, page;
const errors = [];
async function launch(apiAddress = address) {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: {
      ...process.env,
      GONGDAN_USER_DATA: userData,
      GONGDAN_API_URL: apiAddress,
      GONGDAN_E2E: "1",
    },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
}
async function waitState(connection) {
  await waitClientState(page, (s) => s.loggedIn && s.connection === connection);
  assert.equal(await page.locator("#login-code").count(), 0, "Must retain the workspace");
}
async function checkWindow(loggedIn) {
  const geometry = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { ...win.getBounds(), resizable: win.isResizable(), fullscreen: win.isFullScreen() };
  });
  assert.equal(geometry.resizable, loggedIn);
  assert.equal(geometry.fullscreen, false);
  if (loggedIn) assert(geometry.width > 480, "Workspace must expand after login");
  else {
    assert(geometry.width <= 480, "Login must use a compact window");
    assert(geometry.height <= 560, "Login must fit in a compact window");
    assert(
      await page.locator(".login").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      }),
      "Login form must remain fully visible",
    );
  }
}
async function login() {
  await page.locator("#login-code").fill(code.code);
  assert.equal(await page.locator("#api-url").count(), 0);
  assert.equal(await page.getByText("服务连接设置", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
}
try {
  // The API is reachable only through a proxy. Node fetch fails, while the actual
  // login must use Chromium's configured proxy and reach the backend unchanged.
  const closedPort = http.createServer();
  closedPort.listen(0, "127.0.0.1");
  await once(closedPort, "listening");
  const proxyOnlyAddress = `http://127.0.0.1:${closedPort.address().port}`;
  await new Promise((resolve) => closedPort.close(resolve));
  await launch(proxyOnlyAddress);
  await page.locator("#login-code").waitFor();
  await app.evaluate(async ({ session }, proxy) => {
    await session.defaultSession.setProxy({
      mode: "fixed_servers",
      proxyRules: proxy,
      proxyBypassRules: "<-loopback>",
    });
  }, address);
  const oldTransport = await app.evaluate(async (_, target) => {
    try {
      await fetch(target + "/api/v1/client/auth", { signal: AbortSignal.timeout(2000) });
      return "unexpected success";
    } catch (error) {
      return error.message;
    }
  }, proxyOnlyAddress);
  assert.equal(oldTransport, "fetch failed");
  await page.locator("#login-code").fill("GD7-proxy-compatibility-invalid");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "登录码无效" }).waitFor();
  assert.equal(authCount, 1, "Login must reach the API through the proxy exactly once");
  await app.close();
  authCount = 0;
  await launch();
  await page.locator("#login-code").waitFor();
  await checkWindow(false);
  assert.equal(await page.getByLabel("记住登录码", { exact: true }).isChecked(), true);
  mode = "offline";
  await page.locator("#login-code").fill("GD7-offline-network-invalid");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "无法连接服务器" }).waitFor();
  assert(!/fetch failed|Error invoking|TypeError/.test(await page.getByRole("alert").innerText()));
  assert.equal(await page.locator(".login-submit").isEnabled(), true);
  authCount = 0;
  mode = "slow-auth";
  await page.locator("#login-code").fill("GD7-invalid-window-test");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  assert.equal(await page.locator(".login-submit").getAttribute("aria-busy"), "true");
  assert.equal(await page.locator(".login-submit").isDisabled(), true);
  assert.equal(await page.locator(".login-spinner").isVisible(), true);
  assert.equal(
    await page.locator(".login-spinner").evaluate((el) => getComputedStyle(el).animationName),
    "login-spin",
  );
  await page.locator("form.login").evaluate((form) => form.requestSubmit());
  await page.screenshot({ path: ".runtime/client-remember-loading.png" });
  releaseAuth();
  await page.getByRole("alert").filter({ hasText: "登录码无效" }).waitFor();
  assert.equal(authCount, 1, "Repeated submit must not create another authentication request");
  assert.equal(await page.locator(".login-submit").isEnabled(), true);
  assert.equal(await page.locator(".login-spinner").isVisible(), false);
  await assert.rejects(access(preferences));
  await checkWindow(false);
  // Successful authentication followed by failed account sync must retain credentials too.
  mode = "metadata-failure";
  await login();
  await waitState("reconnecting");
  mode = "online";
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit("resume");
  });
  await waitState("online");
  await checkWindow(true);
  assert(!(await readFile(preferences, "utf8")).includes(code.code));
  const resized = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1000, 680);
    return win.getBounds();
  });
  await page.evaluate(() => window.gongdan.refresh());
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
    resized,
    "Heartbeat must not reset the user's workspace size",
  );
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
  await checkWindow(true);
  assert.equal((await page.evaluate(() => window.gongdan.state())).accounts[0].id, account);
  await page.screenshot({ path: ".runtime/client-session-reconnecting.png" });
  const beforeRetry = heartbeatCount;
  mode = "online";
  // No refresh click: the scheduled retry must recover on its own.
  await waitState("online");
  assert(heartbeatCount > beforeRetry);
  assert.equal(authCount, 2, "Recovery must reuse the saved device session without the login code");
  await page.screenshot({ path: ".runtime/client-session-recovered.png" });
  // An explicit offline logout clears disk immediately and stays logged out after restart.
  mode = "offline";
  await page.getByRole("button", { name: "退出客户端", exact: true }).click();
  await page.locator("#login-code").waitFor();
  await checkWindow(false);
  await page.waitForFunction(
    (value) => document.querySelector("#login-code").value === value,
    code.code,
  );
  await assert.rejects(access(credentials));
  await app.close();
  app = undefined;
  mode = "online";
  await launch();
  await page.locator("#login-code").waitFor();
  await checkWindow(false);
  await page.waitForFunction(
    (value) => document.querySelector("#login-code").value === value,
    code.code,
  );
  await page.screenshot({ path: ".runtime/client-remember-restored.png" });
  assert.equal((await page.evaluate(() => window.gongdan.state())).loggedIn, false);
  await login();
  await waitState("online");
  await checkWindow(true);
  // Confirmed admin revocation still ends the persistent session.
  await api("/login-codes/" + code.id, { ...policy, enabled: false }, "PATCH");
  await page.evaluate(() => window.gongdan.refresh());
  await page.locator("#login-code").waitFor();
  await checkWindow(false);
  await assert.rejects(access(credentials));
  // Forget immediately, without submitting the form, and retain that choice across restarts.
  await page.getByLabel("记住登录码", { exact: true }).uncheck();
  await page.waitForFunction(async () => !(await window.gongdan.loginPreference()).remember);
  await app.close();
  app = undefined;
  await launch();
  await page.locator("#login-code").waitFor();
  await page.waitForFunction(() => !document.querySelector("#remember-login").checked);
  assert.equal(await page.locator("#login-code").inputValue(), "");
  const second = await api("/login-codes", { ...policy, label: "记住登录码切换验收" });
  await page.locator("#login-code").fill(second.code);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitState("online");
  await page.getByRole("button", { name: "退出客户端", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#remember-login")?.checked);
  assert.equal(await page.locator("#login-code").inputValue(), "");
  await page.getByLabel("记住登录码", { exact: true }).check();
  await page.locator("#login-code").fill(second.code);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitState("online");
  await page.getByRole("button", { name: "退出客户端", exact: true }).click();
  await page.waitForFunction(
    (value) => document.querySelector("#login-code")?.value === value,
    second.code,
  );
  assert.equal((await page.evaluate(() => window.gongdan.loginPreference())).code, second.code);
  await checkWindow(false);
  assert.deepEqual(errors, []);
  console.log(
    "Client session checks passed: partial startup failure, 503, timeout, offline restart, cached accounts, reconnect, logout/revocation, encrypted remembered codes, switch/forget/restart and loading animation/duplicate-submit guard.",
  );
} finally {
  releaseAuth();
  if (app) await app.close();
  for (const socket of sockets) socket.destroy();
  relay.close();
  await rm(userData, { recursive: true, force: true });
}
