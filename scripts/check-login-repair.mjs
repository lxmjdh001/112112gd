// Isolated synthetic HTTPS pages only: no real platform logins or messages.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "d1-login-repair-"));
const tenant = "00000000-0000-4000-8000-000000000001";
const ids = [2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const [tgLive, tgDelayed, waRepair, waOther] = ids;
const accounts = ids.map((id, i) => ({
  id,
  label: ["TG 当前用户", "TG 延迟识别", "WA 修复目标", "WA 保留账号"][i],
  platform: i < 2 ? "telegram" : "whatsapp",
  connectionType: "web",
  available: true,
  networkMode: "system",
}));
const requests = [];
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url, "http://localhost").pathname.replace("/api/v1", "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ route, body });
    let data = {};
    if (route === "/client/auth")
      data = {
        accessToken: "synthetic-token",
        deviceId: "fixture-device",
        tenantId: tenant,
        codeId: tenant,
        label: "本机登录修复验收",
        leaseSeconds: 3600,
      };
    else if (route === "/client/accounts") data = accounts;
    else if (route === "/client/platforms")
      data = [
        { id: "telegram", name: "Telegram" },
        { id: "whatsapp", name: "WhatsApp" },
      ];
    else if (route === "/client/billing")
      data = { points: "100", status: "normal", graceDaysRemaining: 3 };
    else if (route.endsWith("/open"))
      data = { id: route.split("/")[3], tenantId: tenant, networkMode: "system", proxy: null };
    else if (route.startsWith("/client/tools")) data = [];
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
  console.error("FAIL: login repair regression exceeded three minutes");
  void app?.close();
}, 180000).unref();

async function nativeEval(id, func, argument = null) {
  return app.evaluate(
    async ({ webContents, session }, { tenant, id, source, argument }) => {
      const partition = session.fromPartition(`persist:gd7-${tenant}-${id}`);
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.session === partition && /^https:/.test(w.getURL()));
      if (!wc) throw Error("Synthetic account view not found: " + id);
      return wc.executeJavaScript(`(${source})(${JSON.stringify(argument)})`);
    },
    { tenant, id, source: func.toString(), argument },
  );
}
async function viewState(id) {
  return app.evaluate(
    ({ BrowserWindow, session }, { tenant, id }) => {
      const partition = session.fromPartition(`persist:gd7-${tenant}-${id}`);
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
        (v) => v.webContents?.session === partition,
      );
      return view
        ? {
            id: view.webContents.id,
            visible: view.getVisible(),
            loading: view.webContents.isLoading(),
          }
        : null;
    },
    { tenant, id },
  );
}
async function waitLoaded(id) {
  for (let i = 0; i < 150; i++) {
    const view = await viewState(id);
    if (view && !view.loading) return view;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Synthetic account did not finish loading: " + id);
}
async function openAccount(id, status) {
  await page.locator(`.account[data-id="${id}"]`).click();
  await waitClientState(page, (s) => s.activeId === id && s.statuses[id] === status);
  return waitLoaded(id);
}
async function seedStorage(id, marker) {
  await nativeEval(
    id,
    async (marker) => {
      localStorage.setItem("repair-fixture", marker);
      document.cookie = `repair_fixture=${marker}; Path=/; Secure; SameSite=Lax`;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(marker),
      );
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("d1-repair-fixture", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("records");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const transaction = db.transaction("records", "readwrite");
          transaction.objectStore("records").put({ key, iv, ciphertext, marker }, "record");
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () =>
            reject(transaction.error || Error("Fixture transaction aborted"));
        });
      } finally {
        db.close();
      }
      const cache = await caches.open("d1-repair-fixture");
      await cache.put(new Request(location.origin + "/fixture-cache"), new Response(marker));
    },
    marker,
  );
}
async function snapshot(id) {
  return nativeEval(id, async () => {
    const result = {
      local: localStorage.getItem("repair-fixture"),
      cookie: document.cookie,
      databases: (await indexedDB.databases()).map((db) => db.name).sort(),
      caches: (await caches.keys()).sort(),
      decrypted: null,
      extractable: null,
    };
    if (!result.databases.includes("d1-repair-fixture")) return result;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("d1-repair-fixture", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let record;
    try {
      record = await new Promise((resolve, reject) => {
        const request = db.transaction("records").objectStore("records").get("record");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
    result.decrypted = new TextDecoder().decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv },
        record.key,
        record.ciphertext,
      ),
    );
    result.extractable = record.key.extractable;
    return result;
  });
}
async function repairDialog() {
  await page.getByRole("button", { name: "修复登录", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "修复账号登录", exact: true });
  await dialog.waitFor();
  return dialog;
}
function readyReports(id) {
  return requests.filter(
    (r) => r.route === `/client/accounts/${id}/status` && r.body?.status === "ready",
  );
}
async function waitReadyReport(id, count = 1) {
  for (let i = 0; i < 100; i++) {
    if (readyReports(id).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Expected ready observation did not reach the fixture API: " + id);
}

try {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop"), "--use-mock-keychain"],
    env: {
      ...process.env,
      GONGDAN_API_URL: `http://127.0.0.1:${server.address().port}`,
      GONGDAN_USER_DATA: profile,
      GONGDAN_E2E: "1",
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(
    ({ session }, { tenant, ids }) => {
      globalThis.__loginRepairFixtures = { telegramStorage: "stale" };
      for (const [index, id] of ids.entries()) {
        session.fromPartition(`persist:gd7-${tenant}-${id}`).protocol.handle("https", () => {
          let html;
          if (index === 0) {
            const value =
              globalThis.__loginRepairFixtures.telegramStorage === "stale"
                ? JSON.stringify({ userId: 111 })
                : "opaque-encrypted-storage";
            html = `<script>localStorage.setItem('account1', ${JSON.stringify(value)});localStorage.setItem('user_auth','{"id":333}');window.rootScope={myId:12345,peerId:99999};</script><div id="page-chats">Synthetic Telegram chats</div>`;
          } else if (index === 1) {
            html =
              '<script>localStorage.clear();window.rootScope={peerId:99999};</script><div class="passcode-lock-screen">Synthetic passcode lock</div><div id="page-chats">Synthetic delayed Telegram chats</div>';
          } else {
            html = '<p role="alert">你的浏览器上发生了数据库错误。请重新连接你的设备。</p>';
          }
          return new Response("<!doctype html><html><body>" + html + "</body></html>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        });
      }
    },
    { tenant, ids },
  );
  await page.locator("#login-code").fill("GD7-SYNTHETIC-REPAIR");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");

  await openAccount(tgLive, "ready");
  await waitReadyReport(tgLive);
  assert.equal((await viewState(tgLive)).visible, true);
  assert.ok(readyReports(tgLive).some((r) => r.body.identifier === "12345"));
  assert.ok(
    readyReports(tgLive).every((r) => r.body.identifier === "12345"),
    "stale account or conversation peer cannot win",
  );
  await app.evaluate(() => {
    globalThis.__loginRepairFixtures.telegramStorage = "encrypted";
  });
  const reportCount = readyReports(tgLive).length;
  await page.locator("#reload").click();
  await waitLoaded(tgLive);
  await waitClientState(page, (s) => s.statuses[tgLive] === "ready");
  await waitReadyReport(tgLive, reportCount + 1);
  assert.equal(
    await nativeEval(tgLive, () => localStorage.getItem("account1")),
    "opaque-encrypted-storage",
  );
  assert.ok(readyReports(tgLive).length > reportCount);
  assert.ok(readyReports(tgLive).every((r) => r.body.identifier === "12345"));

  await openAccount(tgDelayed, "loading");
  assert.equal((await viewState(tgDelayed)).visible, true, "passcode lock must remain visible");
  assert.equal(readyReports(tgDelayed).length, 0, "locked account must not cause billing");
  await nativeEval(tgDelayed, () => {
    document.querySelector(".passcode-lock-screen").remove();
    localStorage.setItem("account1", '{"userId":444}');
    window.dispatchEvent(new Event("online"));
  });
  await waitClientState(page, (s) => s.statuses[tgDelayed] === "identity_pending");
  assert.equal((await viewState(tgDelayed)).visible, false);
  assert.equal(readyReports(tgDelayed).length, 0, "unidentified owner must not cause billing");
  await nativeEval(tgDelayed, () => {
    localStorage.clear();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        window.rootScope.myId = 67890;
      }),
    );
  });
  // Deliberately no synthetic online event: the normal five-second observer must recover.
  await waitClientState(page, (s) => s.statuses[tgDelayed] === "ready", 12000);
  await waitReadyReport(tgDelayed);
  assert.equal((await viewState(tgDelayed)).visible, true);
  assert.ok(readyReports(tgDelayed).some((r) => r.body.identifier === "67890"));
  assert.equal(await nativeEval(tgDelayed, () => localStorage.getItem("account1")), null);
  console.log(
    "PASS: Telegram live owner beats stale storage; encrypted/absent storage works; passcode stays visible; hidden RAF initialization recovers without reload; no unidentified billing",
  );

  await openAccount(waOther, "storage_error");
  await seedStorage(waOther, "other-slot");
  const otherBefore = await snapshot(waOther);
  await openAccount(waRepair, "storage_error");
  await seedStorage(waRepair, "repair-slot");
  const before = await snapshot(waRepair);
  assert.equal(before.decrypted, "repair-slot");
  assert.equal(before.extractable, false);
  assert.deepEqual(before.caches, ["d1-repair-fixture"]);
  assert.equal(readyReports(waRepair).length, 0);
  assert.equal(readyReports(waOther).length, 0);
  assert.ok(
    requests
      .filter((r) => r.route.endsWith("/status"))
      .every((r) => r.body.status !== "storage_error"),
    "storage error must map to the existing backend unknown status",
  );

  let dialog = await repairDialog();
  if (process.env.D1_REPAIR_SCREENSHOTS) {
    await mkdir(".runtime", { recursive: true });
    await dialog.screenshot({ path: ".runtime/login-repair-dialog.png" });
  }
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await snapshot(waRepair), before, "dismiss must preserve all storage");
  const beforeRefreshView = (await viewState(waRepair)).id;
  dialog = await repairDialog();
  await app.evaluate(
    ({ session }, { tenant, id }) => {
      const partition = session.fromPartition(`persist:gd7-${tenant}-${id}`);
      const original = partition.clearCache;
      partition.clearCache = async function () {
        partition.clearCache = original;
        throw Error("Synthetic one-time cache failure");
      };
    },
    { tenant, id: waRepair },
  );
  await dialog.getByRole("button", { name: "刷新网页缓存", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "未能完成网页存储修复" }).waitFor();
  await waitClientState(page, (s) => s.statuses[waRepair] === "storage_error");
  await waitLoaded(waRepair);
  const failedRefreshView = (await viewState(waRepair)).id;
  assert.notEqual(failedRefreshView, beforeRefreshView, "repair failure must reopen the account");
  assert.deepEqual(
    await snapshot(waRepair),
    before,
    "failed cache operation must preserve storage",
  );
  assert.deepEqual(await snapshot(waOther), otherBefore);
  // Retry from the same still-open dialog, without closing the account or restarting.
  await dialog.getByRole("button", { name: "刷新网页缓存", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await waitClientState(page, (s) => s.statuses[waRepair] === "storage_error");
  await waitLoaded(waRepair);
  assert.notEqual(
    (await viewState(waRepair)).id,
    failedRefreshView,
    "repair must reopen a new view",
  );
  const afterCache = await snapshot(waRepair);
  assert.deepEqual(
    afterCache,
    { ...before, caches: [] },
    "cache refresh must preserve cookies, localStorage and nonextractable IndexedDB CryptoKey",
  );
  assert.deepEqual(await snapshot(waOther), otherBefore);
  console.log(
    "PASS: database error detected; dismiss is inert; cache failure reopens and retries; cache refresh preserves cookies/localStorage/IndexedDB CryptoKey and other account",
  );

  dialog = await repairDialog();
  await dialog.getByRole("button", { name: "重置本机登录…", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "重置此账号的本机登录？", exact: true });
  await confirmation.waitFor();
  if (process.env.D1_REPAIR_SCREENSHOTS)
    await confirmation.screenshot({ path: ".runtime/login-repair-reset-confirmation.png" });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  assert.deepEqual(
    await snapshot(waRepair),
    afterCache,
    "cancel second confirmation must preserve storage",
  );

  dialog = await repairDialog();
  await dialog.getByRole("button", { name: "重置本机登录…", exact: true }).click();
  await confirmation.getByRole("button", { name: "确认重置并重新登录", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  await waitClientState(page, (s) => s.statuses[waRepair] === "storage_error");
  await waitLoaded(waRepair);
  const afterReset = await snapshot(waRepair);
  assert.equal(afterReset.local, null);
  assert.equal(afterReset.cookie, "");
  assert.equal(afterReset.databases.includes("d1-repair-fixture"), false);
  assert.deepEqual(afterReset.caches, []);
  assert.deepEqual(
    await snapshot(waOther),
    otherBefore,
    "other slot must retain its login, database and cache",
  );
  const state = await page.evaluate(() => window.gongdan.state());
  assert.deepEqual(
    state.accounts.map((a) => a.id).sort(),
    [...ids].sort(),
    "repair must retain account records",
  );
  assert.equal(state.activeId, waRepair);
  assert.equal(
    requests.filter((r) => /\/(?:remove|close)$/.test(r.route)).length,
    0,
    "repair must not remove or close a backend account",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: two-step reset cancel is inert; confirmed reset clears only chosen partition; account records remain; no backend remove/close",
  );
} finally {
  clearTimeout(deadline);
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
