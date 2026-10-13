// Isolated synthetic HTTPS pages and mock API; never signs into a real platform.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "d1-loading-close-"));
const tenant = "00000000-0000-4000-8000-000000000001";
const ids = [2, 3].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const [slowId, otherId] = ids;
const accounts = ids.map((id, i) => ({ id, label: i ? "正常账号" : "加载中账号",
  platform: "whatsapp", connectionType: "web", available: true, networkMode: "system", paused: false }));
const requests = [];
let failNextClose = false;
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url, "http://localhost").pathname.replace("/api/v1", "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ route, body });
    let data = {};
    if (route === "/client/auth")
      data = { accessToken: "synthetic-token", deviceId: "fixture-device", tenantId: tenant,
        codeId: tenant, label: "加载中关闭验收", leaseSeconds: 3600 };
    else if (route === "/client/accounts") data = accounts;
    else if (route === "/client/platforms") data = [{ id: "whatsapp", name: "WhatsApp" }];
    else if (route === "/client/billing") data = { points: "100", status: "normal", graceDaysRemaining: 3 };
    else if (route.endsWith("/open")) {
      const id = route.split("/")[3];
      accounts.find((a) => a.id === id).paused = false;
      data = { id, tenantId: tenant, networkMode: "system", proxy: null };
    } else if (route.endsWith("/close")) {
      if (failNextClose) {
        failNextClose = false;
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 503, message: "合成测试：关闭上报暂不可用" }));
        return;
      }
      accounts.find((a) => a.id === route.split("/")[3]).paused = true;
    } else if (route.startsWith("/client/tools")) data = [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 500, message: error.message }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app;
let page;
const errors = [];
const deadline = setTimeout(() => {
  console.error("FAIL: loading-close regression exceeded two minutes");
  void app?.close();
}, 120000).unref();

async function nativeEval(id, func, argument = null) {
  return app.evaluate(async ({ webContents, session }, { tenant, id, source, argument }) => {
    const partition = session.fromPartition(`persist:gd7-${tenant}-${id}`);
    const wc = webContents.getAllWebContents().find((w) => w.session === partition && /^https:/.test(w.getURL()));
    if (!wc) throw Error("Fixture view is not open: " + id);
    // executeJavaScript can wait for the very load event this fixture holds open.
    // CDP evaluates directly in the already-initialized document instead.
    const attached = wc.debugger.isAttached();
    if (!attached) wc.debugger.attach("1.3");
    try {
      const result = await wc.debugger.sendCommand("Runtime.evaluate", {
        expression: `(${source})(${JSON.stringify(argument)})`, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.text || "Fixture evaluation failed");
      return result.result.value;
    } finally { if (!attached && !wc.isDestroyed()) wc.debugger.detach(); }
  }, { tenant, id, source: func.toString(), argument });
}
async function viewState(id) {
  return app.evaluate(({ BrowserWindow, session }, { tenant, id }) => {
    const partition = session.fromPartition(`persist:gd7-${tenant}-${id}`);
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
      v.webContents && !v.webContents.isDestroyed() && v.webContents.session === partition);
    return view ? { id: view.webContents.id, visible: view.getVisible(), loading: view.webContents.isLoading() } : null;
  }, { tenant, id });
}
async function openSlow() {
  await page.locator(`.account[data-id="${slowId}"]`).click();
  await waitClientState(page, (s) => s.activeId === slowId && s.statuses[slowId] === "loading", 8000);
  for (let i = 0; i < 80; i++) {
    const ready = await nativeEval(slowId, () => !!window.fixtureDOMReady).catch(() => false);
    if (ready) {
      const view = await viewState(slowId);
      assert.equal(view.loading, true, "fixture must have a pending window load");
      assert.equal(await nativeEval(slowId, () => document.readyState), "interactive");
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Slow fixture never reached DOMContentLoaded");
}
async function closeDialog(id) {
  await page.locator(`[data-close-id="${id}"]`).click();
  const dialog = page.getByRole("dialog", { name: "退出登录账号", exact: true });
  await dialog.waitFor();
  return dialog;
}
async function closeAccount(id, activeAfter) {
  const dialog = await closeDialog(id);
  const started = Date.now();
  await dialog.getByRole("button", { name: "确定退登", exact: true }).click();
  await waitClientState(page, (s) => s.accounts.find((a) => a.id === id)?.paused && s.statuses[id] === "closed", 4000);
  await dialog.waitFor({ state: "hidden", timeout: 4000 });
  assert.ok(Date.now() - started < 4000, "close must not wait for the hanging page");
  assert.equal(await viewState(id), null, "closed native view must be destroyed");
  const state = await page.evaluate(() => window.gongdan.state());
  assert.equal(state.activeId, activeAfter);
  return state;
}
async function storage() {
  return nativeEval(slowId, () => ({ marker: localStorage.getItem("loading-close-marker"), cookie: document.cookie }));
}
async function captureOldCallbacks() {
  await app.evaluate(({ webContents, session }, { tenant, id }) => {
    const partition = session.fromPartition(`persist:gd7-${tenant}-${id}`);
    const wc = webContents.getAllWebContents().find((w) => w.session === partition && /^https:/.test(w.getURL()));
    globalThis.__loadingCloseFixture.staleCallbacks.push({
      fail: wc.listeners("did-fail-load"), gone: wc.listeners("render-process-gone"),
    });
  }, { tenant, id: slowId });
}
async function lateCallbacks() {
  await app.evaluate(() => {
    for (const old of globalThis.__loadingCloseFixture.staleCallbacks) {
      for (const listener of old.fail)
        listener({}, -105, "Synthetic late DNS failure", "https://web.whatsapp.com/", true);
      for (const listener of old.gone)
        listener({}, { reason: "crashed", exitCode: 1 });
    }
  });
  // Allow promise continuations and API observations triggered by late events to settle.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

try {
  app = await electron.launch({
    executablePath: path.resolve("apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    args: [path.resolve("apps/desktop"), "--use-mock-keychain"],
    env: { ...process.env, GONGDAN_API_URL: `http://127.0.0.1:${server.address().port}`,
      GONGDAN_USER_DATA: profile, GONGDAN_E2E: "1" },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(({ session }, { tenant, ids }) => {
    globalThis.__loadingCloseFixture = { slow: true, held: [], staleCallbacks: [] };
    for (const [index, id] of ids.entries()) {
      session.fromPartition(`persist:gd7-${tenant}-${id}`).protocol.handle("https", (request) => {
        if (new URL(request.url).pathname === "/held-image")
          return new Promise((resolve) => globalThis.__loadingCloseFixture.held.push(resolve));
        const slow = index === 0 && globalThis.__loadingCloseFixture.slow;
        const content = slow
          ? '<p>本机合成加载页面</p><img src="https://web.whatsapp.com/held-image">'
          : `<script>localStorage.setItem('last-wid-md','${index ? "15550000002" : "15550000001"}:2@c.us')</script><div id="pane-side">本机合成就绪页面</div>`;
        return new Response('<!doctype html><html><body>' + content
          + '<script>window.addEventListener("DOMContentLoaded",()=>{window.fixtureDOMReady=true})</script></body></html>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } });
      });
    }
  }, { tenant, ids });
  await page.locator("#login-code").fill("GD7-SYNTHETIC-LOADING-CLOSE");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");

  const initialView = await openSlow();
  await nativeEval(slowId, () => {
    localStorage.setItem("loading-close-marker", "must-survive-close");
    document.cookie = "loading_close=must-survive-close; Secure; SameSite=Lax; Path=/";
  });
  const before = await storage();
  await captureOldCallbacks();
  const cancel = await closeDialog(slowId);
  await cancel.getByRole("button", { name: "取消", exact: true }).click();
  await cancel.waitFor({ state: "hidden" });
  assert.equal((await viewState(slowId)).id, initialView.id);
  assert.equal((await viewState(slowId)).loading, true);
  await closeAccount(slowId, "");
  console.log("PASS: active account can cancel or confirm close while window load never completes");

  const reopenedSlow = await openSlow();
  assert.notEqual(reopenedSlow.id, initialView.id);
  assert.deepEqual(await storage(), before, "reopen must retain cookies and localStorage");
  await captureOldCallbacks();
  await page.locator(`.account[data-id="${otherId}"]`).click();
  await waitClientState(page, (s) => s.activeId === otherId && s.statuses[otherId] === "ready", 6000);
  assert.equal((await viewState(slowId)).loading, true);
  assert.equal((await viewState(otherId)).visible, true);
  await closeAccount(slowId, otherId);
  await lateCallbacks();
  let state = await page.evaluate(() => window.gongdan.state());
  assert.equal(state.activeId, otherId);
  assert.equal(state.statuses[otherId], "ready");
  assert.equal(state.statuses[slowId], "closed");
  console.log("PASS: another account opens while first is loading; closing background load keeps active account ready");

  await app.evaluate(() => { globalThis.__loadingCloseFixture.slow = false; });
  await page.locator(`.account[data-id="${slowId}"]`).click();
  await waitClientState(page, (s) => s.activeId === slowId && s.statuses[slowId] === "ready", 6000);
  const replacement = await viewState(slowId);
  assert.deepEqual(await storage(), before);
  await lateCallbacks();
  await app.evaluate(() => {
    for (const resolve of globalThis.__loadingCloseFixture.held.splice(0))
      resolve(new Response("Synthetic delayed image failure", { status: 503 }));
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  state = await page.evaluate(() => window.gongdan.state());
  assert.equal(state.activeId, slowId);
  assert.equal(state.statuses[slowId], "ready");
  assert.equal((await viewState(slowId)).id, replacement.id);
  assert.equal((await viewState(slowId)).visible, true);
  console.log("PASS: late old load failure/crash events cannot corrupt replacement runtime or clear active account");

  failNextClose = true;
  const failedClose = await closeDialog(slowId);
  await failedClose.getByRole("button", { name: "确定退登", exact: true }).click();
  await waitClientState(page, (s) => s.statuses[slowId] === "closed" && s.activeId === "", 4000);
  assert.equal(await viewState(slowId), null, "API close failure must not prevent local stop");
  await failedClose.getByRole("alert").filter({ hasText: "本机聊天页面已关闭，退出状态暂未同步" }).waitFor();
  state = await page.evaluate(() => window.gongdan.state());
  assert.equal(state.accounts.find((a) => a.id === slowId).paused, false,
    "failed API call must not falsely claim server-confirmed pause");
  // The same dialog can retry the server operation after its local view is gone.
  await failedClose.getByRole("button", { name: "确定退登", exact: true }).click();
  await waitClientState(page, (s) => s.accounts.find((a) => a.id === slowId)?.paused && s.statuses[slowId] === "closed", 4000);
  await failedClose.waitFor({ state: "hidden", timeout: 4000 });
  await page.locator(`.account[data-id="${slowId}"]`).click();
  await waitClientState(page, (s) => s.activeId === slowId && s.statuses[slowId] === "ready", 6000);
  assert.deepEqual(await storage(), before);
  assert.equal(requests.filter((r) => r.route.endsWith("/remove")).length, 0);
  assert.equal((await page.evaluate(() => window.gongdan.state())).accounts.length, 2);
  assert.deepEqual(errors, []);
  console.log("PASS: failed API close still stops locally; reopening preserves login data; no remove call or lost account records");
} finally {
  clearTimeout(deadline);
  try { await app?.close(); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true });
  }
}
