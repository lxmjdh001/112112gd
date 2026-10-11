import { _electron as electron } from "playwright";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { waitClientState } from "./desktop-wait.mjs";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
let admin, app, page;
async function api(route, body) {
  const r = await fetch("http://127.0.0.1:18081/api/v1" + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Authorization: "Bearer " + admin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(r.status, 200, route);
  return (await r.json()).data;
}
admin = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
// Preserve any fixtures already created by other suites in this isolated team.
const before = await api("/proxies");
const code = await api("/login-codes", {
  label: "自建代理验收",
  allowedPlatforms: ["whatsapp"],
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const profile = await mkdtemp(path.join(tmpdir(), "gd7-client-proxy-"));
const errors = [];
async function openAccountForm() {
  await page.locator("#add-account").click();
  await page.getByRole("button", { name: "设置独立 IP", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号", exact: true }).waitFor();
}
async function fillProxy() {
  await page.locator("#add-proxy").click();
  await page.locator("#proxy-label").fill("客户端自建 IP");
  await page.locator("#proxy-protocol").selectOption("http");
  await page.locator("#proxy-host").fill("198.51.100.42");
  await page.locator("#proxy-port").fill("8080");
  await page.locator("#proxy-username").fill("test-user");
}
try {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: {
      ...process.env,
      GONGDAN_E2E: "1",
      GONGDAN_USER_DATA: profile,
      GONGDAN_API_URL: "http://127.0.0.1:18081",
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#login-code").fill(code.code);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  await openAccountForm();
  await page.locator("#account-label").fill("保留的账号名称");
  await fillProxy();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  assert.equal(await page.locator("#account-label").inputValue(), "保留的账号名称");
  assert.equal((await api("/proxies")).length, before.length, "cancel saved a proxy");
  await fillProxy();
  await page.getByRole("button", { name: "保存并选择", exact: true }).click();
  assert.match(await page.locator("#new-proxy-error").innerText(), /同时填写/);
  await page.locator("#proxy-password").fill("test-password");
  await page.screenshot({ path: ".runtime/client-add-proxy.png" });
  await page.getByRole("button", { name: "保存并选择", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号", exact: true }).waitFor();
  const proxy = (await api("/proxies")).find((p) => p.label === "客户端自建 IP");
  assert(proxy && proxy.maxAccountsPerPlatform === 1 && proxy.enabled);
  assert.equal(await page.locator("#account-proxy").inputValue(), proxy.id);
  assert.equal(await page.locator("#account-label").inputValue(), "保留的账号名称");
  assert.equal(await page.locator("#proxy-password").inputValue(), "");
  assert.equal(await page.locator("#proxy-empty").innerText(), "");
  await fillProxy();
  await page.locator("#proxy-password").fill("test-password");
  await page.getByRole("button", { name: "保存并选择", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号", exact: true }).waitFor();
  assert.equal((await api("/proxies")).length, before.length + 1, "retry duplicated proxy");
  assert.equal(await page.locator("#account-proxy").inputValue(), proxy.id);
  await page.screenshot({ path: ".runtime/client-proxy-selected.png" });
  // Local synthetic HTTPS page: no actual connection to the placeholder proxy,
  // no WhatsApp pairing, and no real messages. Inspect session routing below.
  await app.evaluate(({ app }) =>
    app.on("session-created", (s) =>
      s.protocol.handle(
        "https",
        () =>
          new Response(
            '<!doctype html><div id="pane-side"></div><div id="main">代理账号测试</div>',
            { headers: { "Content-Type": "text/html" } },
          ),
      ),
    ),
  );
  await page.getByRole("button", { name: "添加并登录", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const state = await waitClientState(page, (s) => !!s.activeId);
  const account = (await api("/platform-accounts")).find((a) => a.id === state.activeId);
  assert.equal(account.proxyHost, "198.51.100.42");
  assert.equal(account.proxyPort, 8080);
  let routed = false;
  for (let i = 0; i < 100; i++) {
    routed = await app.evaluate(async ({ webContents }) => {
      const w = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith("https://web.whatsapp.com"));
      if (!w || w.isLoading()) return false;
      return (
        (await w.session.resolveProxy("https://web.whatsapp.com")) === "PROXY 198.51.100.42:8080"
      );
    });
    if (routed) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(routed, "account did not use selected proxy routing");
  await api("/proxies/import", { lines: "http://198.51.100.43:8081", group: "管理员配置" });
  await openAccountForm();
  assert(
    await page.locator(`#account-proxy option[value="${proxy.id}"]`).isDisabled(),
    "full proxy selectable",
  );
  const adminProxy = (await api("/proxies")).find((p) => p.host === "198.51.100.43");
  await page.locator("#account-proxy").selectOption(adminProxy.id);
  assert.equal(await page.locator("#account-proxy").inputValue(), adminProxy.id);
  await page.locator("#add-proxy").click();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "Client proxy checks passed: cancel, validation, encrypted server storage, auto-selection, retry deduplication, saved account name, proxy session routing, shared limits, admin selection. Native page was a local fixture.",
  );
} catch (error) {
  if (page) await page.screenshot({ path: ".runtime/client-proxy-failure.png" }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
