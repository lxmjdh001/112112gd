import { _electron as electron } from "playwright";
import { readFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { waitClientState } from "./desktop-wait.mjs";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
let token, app, page;
const errors = [];
async function api(route, body) {
  const response = await fetch("http://127.0.0.1:18081/api/v1" + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal(response.status, 200, route);
  return (await response.json()).data;
}
token = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
const code = await api("/login-codes", {
  label: "账号关闭验收",
  allowedPlatforms: ["whatsapp"],
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const profile = await mkdtemp(path.join(tmpdir(), "gd7-lifecycle-"));
async function launch() {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: {
      ...process.env,
      GONGDAN_API_URL: "http://127.0.0.1:18081",
      GONGDAN_USER_DATA: profile,
      GONGDAN_E2E: "1",
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
}
async function mockNative(account) {
  await app.evaluate(({ session }, { tenant, id }) => {
    const s = session.fromPartition(`persist:gd7-${tenant}-${id}`);
    s.protocol.handle(
      "https",
      () =>
        new Response(
          '<!doctype html><body><div id="pane-side"></div><div id="main"><header>本机合成聊天</header><div data-id="false_447410419512@s.whatsapp.net_TEST">测试消息</div><footer><div contenteditable="true" role="textbox"></div></footer></div></body>',
          { headers: { "Content-Type": "text/html" } },
        ),
    );
  }, account);
}
async function cookies(account) {
  return app.evaluate(
    async ({ session }, { tenant, id }) =>
      (
        await session.fromPartition(`persist:gd7-${tenant}-${id}`).cookies.get({ name: "retained" })
      ).map((c) => c.value),
    account,
  );
}
async function closeDialog(account, confirm = true) {
  await page.locator(`[data-close-id="${account.id}"]`).click();
  const d = page.getByRole("dialog", { name: "退出登录账号", exact: true });
  await d.waitFor();
  await d.getByRole("button", { name: confirm ? "确定退登" : "取消", exact: true }).click();
  await d.waitFor({ state: "hidden" });
}
async function waitNativeReady() {
  for (let i = 0; i < 100; i++) {
    const ready = await app.evaluate(({ webContents }) => {
      const w = webContents
        .getAllWebContents()
        .find((w) => w.getURL().startsWith("https://web.whatsapp.com"));
      return !!w && !w.isLoading();
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("Native account did not finish opening");
}
try {
  await launch();
  await page.locator("#login-code").fill(code.code);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  const first = await page.evaluate(() =>
    window.gongdan.createAccount({
      label: "退出验收账号",
      platform: "whatsapp",
      proxyId: "",
      requestId: crypto.randomUUID(),
    }),
  );
  const second = await page.evaluate(() =>
    window.gongdan.createAccount({
      label: "其他账号",
      platform: "whatsapp",
      proxyId: "",
      requestId: crypto.randomUUID(),
    }),
  );
  const tenant = await app.evaluate(
    ({ app, safeStorage }) =>
      JSON.parse(
        safeStorage.decryptString(
          process
            .getBuiltinModule("fs")
            .readFileSync(
              process.getBuiltinModule("path").join(app.getPath("userData"), "authorization.bin"),
            ),
        ),
      ).auth.tenantId,
  );
  const a = { tenant, id: first },
    b = { tenant, id: second };
  await mockNative(a);
  await page.locator(`.account[data-id="${first}"]`).click();
  await waitClientState(page, (s) => s.activeId === first);
  for (let i = 0; i < 50; i++) {
    const done = await app.evaluate(
      async ({ webContents, session }, { a, b }) => {
        const w = webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith("https://web.whatsapp.com"));
        if (!w || w.isLoading()) return false;
        await w.executeJavaScript("localStorage.setItem('retained','local-login')");
        for (const [account, value] of [
          [a, "first"],
          [b, "other"],
        ])
          await session.fromPartition(`persist:gd7-${account.tenant}-${account.id}`).cookies.set({
            url: "https://web.whatsapp.com",
            name: "retained",
            value,
            expirationDate: Date.now() / 1000 + 86400,
          });
        return true;
      },
      { a, b },
    );
    if (done) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await closeDialog(a, false);
  assert.deepEqual(await cookies(a), ["first"]);
  await page.locator(`[data-close-id="${first}"]`).click();
  await page.screenshot({ path: ".runtime/account-exit-confirm.png" });
  await page.getByRole("button", { name: "确定退登", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await waitClientState(
    page,
    (s) => s.activeId === "" && s.accounts.find((a) => a.id === first)?.paused,
  );
  assert.deepEqual(await cookies(a), ["first"]);
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((w) => w.getURL().startsWith("https://web.whatsapp.com")).length,
    ),
    0,
  );
  await page.evaluate(() => window.gongdan.refresh());
  assert.match(await page.locator(`.account[data-id="${first}"]`).getAttribute("class"), /paused/);
  await app.close();
  app = undefined;
  await launch();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  assert.match(await page.locator(`.account[data-id="${first}"]`).getAttribute("class"), /paused/);
  assert.deepEqual(await cookies(a), ["first"]);
  await page.locator(`[data-close-id="${first}"]`).click();
  let d = page.getByRole("dialog", { name: "移除号位", exact: true });
  await d.waitFor();
  await page.screenshot({ path: ".runtime/account-remove-confirm.png" });
  await page.keyboard.press("Escape");
  await d.waitFor({ state: "hidden" });
  assert.deepEqual(await cookies(a), ["first"]);
  await mockNative(a);
  await page.locator(`.account[data-id="${first}"]`).click();
  await waitClientState(
    page,
    (s) => s.activeId === first && !s.accounts.find((a) => a.id === first)?.paused,
  );
  await waitNativeReady();
  assert.deepEqual(await cookies(a), ["first"]);
  await closeDialog(a);
  await page.locator(`[data-close-id="${first}"]`).click();
  d = page.getByRole("dialog", { name: "移除号位", exact: true });
  await d.getByRole("button", { name: "确认移除", exact: true }).click();
  await d.waitFor({ state: "hidden" });
  assert.equal(await page.locator(`.account[data-id="${first}"]`).count(), 0);
  assert.deepEqual(await cookies(a), []);
  assert.deepEqual(await cookies(b), ["other"]);
  const local = await app.evaluate(async ({ BrowserWindow, session }, { tenant, id }) => {
    const s = session.fromPartition(`persist:gd7-${tenant}-${id}`);
    s.webRequest.onBeforeRequest((_d, cb) => cb({ cancel: false }));
    const w = new BrowserWindow({ show: false, webPreferences: { session: s } });
    try {
      await w.loadURL("https://web.whatsapp.com");
      return await w.webContents.executeJavaScript("localStorage.getItem('retained')");
    } finally {
      w.destroy();
    }
  }, a);
  assert.equal(local, null, "local storage not cleared");
  await page.evaluate(() => window.gongdan.refresh());
  assert.equal(await page.locator(`.account[data-id="${first}"]`).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Account lifecycle passed: cancel, pause, gray item, restart, resume with cookies, second confirmation, scoped cookie/storage removal. Native page was a local synthetic fixture.",
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: ".runtime/account-lifecycle-failure.png" }).catch(() => {});
    console.error(await page.locator("dialog .error").allTextContents());
  }
  throw error;
} finally {
  if (app) await app.close();
}
