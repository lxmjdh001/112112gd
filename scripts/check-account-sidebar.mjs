// Isolated Electron UI check. All accounts, API responses and WhatsApp pages are synthetic.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "gd7-sidebar-"));
const tenant = "00000000-0000-4000-8000-000000000001";
const nativeID = "00000000-0000-4000-8000-000000000002";
const cloudID = "00000000-0000-4000-8000-000000000003";
let accounts = [
  {
    id: nativeID,
    label: "销售一号",
    platform: "whatsapp",
    connectionType: "web",
    available: true,
    networkMode: "system",
  },
  {
    id: cloudID,
    label: "官方客服",
    platform: "whatsapp_cloud",
    connectionType: "cloud",
    available: true,
  },
];
let platforms = [
  { id: "whatsapp", name: "WhatsApp" },
  { id: "whatsapp_cloud", name: "WhatsApp API" },
];
const unexpected = [],
  errors = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname.replace("/api/v1", "");
  const match = route.match(/^\/client\/accounts\/([^/]+)\/(open|close|remove|restore|status)$/);
  let data = {};
  if (route === "/client/team-settings") data = { enabled: false };
  else if (route === "/client/auth") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.code === "GD7-INVALID") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: 401, message: "登录码无效，请检查后重试" }));
      return;
    }
    data = {
      accessToken: "synthetic-token",
      deviceId: "fixture-device",
      tenantId: tenant,
      codeId: tenant,
      label: "演示工作台",
      leaseSeconds: 3600,
    };
  } else if (route === "/client/billing")
    data = { points: "99.00", status: "normal", graceDaysRemaining: 3 };
  else if (route === "/client/accounts") data = accounts;
  else if (route === "/client/platforms") data = platforms;
  else if (route === "/client/account-options")
    data = {
      usedAccounts: accounts.length,
      platforms: platforms.filter((p) => p.id !== "whatsapp_cloud"),
      proxies: [],
    };
  else if (match) {
    const account = accounts.find((a) => a.id === match[1]);
    assert.ok(account);
    if (match[2] === "open") {
      account.paused = false;
      data = { id: account.id, tenantId: tenant, networkMode: "system", proxy: null };
    }
    if (match[2] === "close") account.paused = true;
    if (match[2] === "remove") {
      if (account.connectionType === "cloud") account.hidden = true;
      else accounts = accounts.filter((a) => a !== account);
    }
    if (match[2] === "restore") {
      account.paused = false;
      account.hidden = false;
    }
  } else if (
    route.startsWith("/client/whatsapp-cloud/numbers/") ||
    route.startsWith("/client/tools/")
  )
    data = [];
  else if (!["/client/heartbeat", "/client/logout"].includes(route)) unexpected.push(route);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 0, data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app;
try {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: {
      ...process.env,
      GONGDAN_API_URL: `http://127.0.0.1:${server.address().port}`,
      GONGDAN_USER_DATA: profile,
      GONGDAN_E2E: "1",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(
    ({ session }, { tenant, nativeID }) => {
      session
        .fromPartition(`persist:gd7-${tenant}-${nativeID}`)
        .protocol.handle(
          "https",
          () =>
            new Response(
              '<!doctype html><html lang="zh"><body style="font:16px system-ui;background:#f6faf8;color:#527060;display:grid;place-content:center;height:95vh"><h2>WhatsApp · 扫码登录</h2><p>本地验收页面</p><canvas aria-label="QR" width="120" height="120"></canvas></body></html>',
              { headers: { "Content-Type": "text/html" } },
            ),
        );
    },
    { tenant, nativeID },
  );
  await page.locator("#login-code").fill("GD7-SYNTHETIC-TEST");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  assert.equal(await page.locator(".account-group").count(), 2);
  assert.equal(await page.locator(".unused-platform:disabled").count(), 8);
  assert.equal(
    await page.locator(".account-sidebar").evaluate((el) => el.getBoundingClientRect().width),
    280,
  );
  await page.locator(`.account[data-id="${nativeID}"]`).click();
  await waitClientState(page, (s) => s.statuses[nativeID] === "qr_required");
  assert.equal(
    await page.locator(`.account[data-id="${nativeID}"] .account-presence`).innerText(),
    "离线",
  );
  assert.match(
    await page.locator(`.account[data-id="${nativeID}"]`).getAttribute("title"),
    /等待扫码/,
  );
  // The selected customer's photo must never become the account's own avatar.
  await app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]
      .contentView.children.map((v) => v.webContents)
      .find((w) => w.getURL().startsWith("https://web.whatsapp.com"));
    await wc.executeJavaScript(`localStorage.setItem("last-wid", "8613800000000@c.us");
      document.querySelectorAll("[data-testid=qrcode],canvas").forEach(e=>e.remove());
      const own=document.createElement('canvas');own.width=own.height=64;own.getContext('2d').fillStyle='#159957';own.getContext('2d').fillRect(0,0,64,64);
      const customer=document.createElement('canvas');customer.width=customer.height=64;customer.getContext('2d').fillStyle='#ff0000';customer.getContext('2d').fillRect(0,0,64,64);
      Promise.all([new Promise(r=>own.toBlob(r)),new Promise(r=>customer.toBlob(r))]).then(([a,b])=>{
        document.body.innerHTML='<div id="side"><header><img id="self" /></header><div id="pane-side"></div></div><div id="main"><header><img id="customer" /></header></div>';
        document.querySelector('#self').src=URL.createObjectURL(a);document.querySelector('#customer').src=URL.createObjectURL(b);window.dispatchEvent(new Event('online'));
      });`);
  });
  const ownState = await waitClientState(
    page,
    (s) => s.statuses[nativeID] === "ready" && !!s.accountProfiles?.[nativeID],
  );
  assert.equal(ownState.accountProfiles[nativeID].owner, "8613800000000");
  const originalAvatar = ownState.accountProfiles[nativeID].avatar;
  const pixel = await app.evaluate(
    ({ nativeImage }, avatar) => [
      ...nativeImage.createFromDataURL(avatar).toBitmap().subarray(0, 4),
    ],
    originalAvatar,
  );
  assert(pixel[1] > pixel[2], "Own green avatar, not customer's red photo");
  assert.equal(
    await page.locator(`.account[data-id="${nativeID}"] .account-self-avatar`).count(),
    1,
  );
  assert.equal(
    await page.locator(`.account[data-id="${nativeID}"] .account-presence`).innerText(),
    "在线",
  );
  await app.evaluate(
    ({ ipcMain, BrowserWindow }, { avatar }) => {
      const win = BrowserWindow.getAllWindows()[0],
        wc = win.contentView.children
          .map((v) => v.webContents)
          .find((w) => w.getURL().startsWith("https://web.whatsapp.com"));
      ipcMain.emit(
        "platform:self-avatar",
        { sender: wc, senderFrame: wc.mainFrame },
        "8613900000000",
        avatar,
      );
      ipcMain.emit(
        "platform:self-avatar",
        { sender: win.webContents, senderFrame: win.webContents.mainFrame },
        "8613800000000",
        avatar,
      );
      ipcMain.emit(
        "platform:self-avatar",
        { sender: wc, senderFrame: wc.mainFrame },
        "8613800000000",
        "data:image/svg+xml,<svg/>",
      );
      ipcMain.emit("wa:status", { sender: wc, senderFrame: wc.mainFrame }, "network_error", null);
    },
    { avatar: originalAvatar },
  );
  await waitClientState(page, (s) => s.statuses[nativeID] === "network_error");
  assert.equal(
    await page.locator(`.account[data-id="${nativeID}"] .account-presence`).innerText(),
    "异常",
  );
  assert.equal(
    (await page.evaluate(() => window.gongdan.state())).accountProfiles[nativeID].avatar,
    originalAvatar,
  );
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]
      .contentView.children.map((v) => v.webContents)
      .find((w) => w.getURL().startsWith("https://web.whatsapp.com"));
    return wc.executeJavaScript("window.dispatchEvent(new Event('online'))");
  });
  await waitClientState(page, (s) => s.statuses[nativeID] === "ready");
  async function verifyBounds() {
    // Native resize events can arrive before the renderer's viewport update.
    const contentSize = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getContentSize(),
    );
    await page.waitForFunction(
      ([width, height]) => innerWidth === width && innerHeight === height,
      contentSize,
    );
    const sidebar = await page.locator(".account-sidebar").boundingBox();
    const tools = await page.locator(".customer-sidebar").boundingBox();
    const actual = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.contentView.children.map((view) => view.getBounds()).find((b) => b.y === 58);
    });
    assert.ok(actual);
    assert.equal(actual.x, sidebar.width);
    assert.equal(actual.width, tools.x - sidebar.width);
    assert.equal(actual.y, sidebar.y);
    assert.equal(actual.height, sidebar.height);
  }
  await verifyBounds();
  const fold = page.locator('[data-platform="whatsapp"] .platform-fold');
  await fold.click();
  assert.equal(await page.locator(`.account[data-id="${nativeID}"]`).isVisible(), false);
  assert.equal((await page.evaluate(() => window.gongdan.state())).activeId, nativeID);
  await page.locator("#refresh").click();
  await waitClientState(page, (s) => s.connection === "online");
  assert.equal(await fold.getAttribute("aria-expanded"), "false");
  await fold.click();
  await page.locator('[data-platform="whatsapp"] [data-add-platform]').click();
  await page.getByRole("dialog", { name: "是否设置独立 IP？", exact: true }).waitFor();
  await page.locator("#use-system-network").click();
  assert.equal(await page.locator("#account-platform").inputValue(), "whatsapp");
  assert.match(await page.locator("#network-summary").textContent(), /当前电脑/);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator("#sidebar-toggle").click();
  await waitClientState(page, (s) => s.sidebarCollapsed);
  assert.equal(
    await page.locator(".account-sidebar").evaluate((el) => el.getBoundingClientRect().width),
    76,
  );
  await verifyBounds();
  await page.getByRole("button", { name: "折叠客户工具", exact: true }).click();
  await waitClientState(page, (s) => s.toolsCollapsed);
  await verifyBounds();
  // Every local official asset decodes in the actual client.
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".account-sidebar img")].every(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  await mkdir(".runtime", { recursive: true });
  await page.screenshot({ path: ".runtime/account-sidebar-compact.png" });
  await page.locator("#sidebar-toggle").click();
  await waitClientState(page, (s) => !s.sidebarCollapsed);
  await verifyBounds();
  await page.locator(".ct-expand").click();
  await waitClientState(page, (s) => !s.toolsCollapsed);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
  await verifyBounds();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
  await verifyBounds();
  await page.locator(".account-sidebar").screenshot({ path: ".runtime/account-sidebar.png" });
  await page.screenshot({ path: ".runtime/account-sidebar-workspace.png" });
  await page.locator(`[data-close-id="${nativeID}"]`).click();
  await page
    .getByRole("dialog", { name: "退出登录账号", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.locator(`[data-close-id="${nativeID}"]`).click();
  await page.getByRole("button", { name: "确定退登", exact: true }).click();
  await waitClientState(page, (s) => s.accounts.find((a) => a.id === nativeID)?.paused);
  await page.locator(`[data-close-id="${nativeID}"]`).click();
  await page
    .getByRole("dialog", { name: "移除号位", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  // Cloud group keeps its separate chat and two-stage remove/restore lifecycle.
  await page.locator(`.account[data-id="${cloudID}"]`).click();
  await waitClientState(page, (s) => s.activeId === cloudID);
  await page.locator(".cloud-client-content").waitFor();
  await page.locator(`[data-close-id="${cloudID}"]`).click();
  await page.getByRole("button", { name: "确认关闭", exact: true }).click();
  await waitClientState(page, (s) => s.accounts.find((a) => a.id === cloudID)?.paused);
  await page.locator(`[data-close-id="${cloudID}"]`).click();
  await page.getByRole("button", { name: "确认移除", exact: true }).click();
  await waitClientState(page, (s) => s.accounts.find((a) => a.id === cloudID)?.hidden);
  await page.locator(".removed-api summary").click();
  await page.locator(`[data-restore-id="${cloudID}"]`).click();
  await waitClientState(
    page,
    (s) => s.activeId === cloudID && !s.accounts.find((a) => a.id === cloudID)?.hidden,
  );
  await page.locator('[data-add-platform="whatsapp_cloud"]').click();
  await page.getByRole("dialog", { name: "添加 WhatsApp API 号码", exact: true }).waitFor();
  await page.getByRole("button", { name: "刷新已分配号码", exact: true }).click();
  // Empty/unauthorized platforms must not become working integrations by showing a plus.
  accounts = [];
  platforms = [];
  await page.locator("#refresh").click();
  await waitClientState(page, (s) => !s.accounts.length && !s.platforms.length);
  assert.equal(await page.locator(".account-group").count(), 0);
  assert.equal(await page.locator(".unused-platform:disabled").count(), 10);
  assert.equal(await page.locator("#add-account").isDisabled(), true);
  await page.locator(".account-list").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page
    .locator(".account-sidebar")
    .screenshot({ path: ".runtime/account-sidebar-platforms.png" });

  // The new empty-state entry must use the existing network/account form.
  platforms = [
    { id: "whatsapp", name: "WhatsApp" },
    { id: "line", name: "LINE" },
    { id: "telegram", name: "Telegram" },
  ];
  await page.locator("#refresh").click();
  await waitClientState(page, (s) => s.platforms.length === 3);
  const emptyAdd = page.locator("[data-empty-add]");
  await emptyAdd.waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await emptyAdd.focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert.equal(await emptyAdd.evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
  assert.equal(await emptyAdd.evaluate((el) => getComputedStyle(el).outlineWidth), "2px");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  for (const heading of await page.locator(".ct-card-head h3").all()) {
    assert.equal(
      await heading.evaluate(
        (el) =>
          el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 1.25,
      ),
      true,
      "Tool headings must remain readable without forced character wrapping",
    );
  }
  await page.screenshot({ path: ".runtime/desktop-ui-workspace.png" });
  await emptyAdd.click();
  const networkDialog = page.getByRole("dialog", { name: "是否设置独立 IP？", exact: true });
  await networkDialog.waitFor();
  await page.screenshot({ path: ".runtime/desktop-ui-network.png" });
  await page.locator("#use-system-network").click();
  await page.locator("#account-platform").waitFor();
  await page.screenshot({ path: ".runtime/desktop-ui-account-form.png" });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator('.ct-tabs [data-tab="profile"]').click();
  await page.locator(".ct-profile-page").waitFor();
  await page.screenshot({ path: ".runtime/desktop-ui-profile.png" });
  await page.locator('.ct-tabs [data-tab="tools"]').click();
  await page.getByRole("button", { name: "新增话术", exact: true }).click();
  await page.getByRole("dialog", { name: "新增话术", exact: true }).waitFor();
  await page.screenshot({ path: ".runtime/desktop-ui-quick-reply.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.locator("#logout").click();
  await page.locator("#login-code").waitFor();
  await page.locator("#login-code").focus();
  await page.screenshot({ path: ".runtime/desktop-ui-login.png" });
  assert.equal(
    await page.locator(".login").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }),
    true,
    "Login form must fit the compact native window",
  );
  await page.locator("#login-code").fill("GD7-INVALID");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "登录码无效" }).waitFor();
  assert.equal(await page.locator("#login-code").inputValue(), "GD7-INVALID");
  await page.screenshot({ path: ".runtime/desktop-ui-login-error.png" });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    "Desktop UI passed: grouping, native/API isolation, official icons, add flows, folding, native bounds, lifecycle, empty state, dialogs, keyboard focus, reduced motion, compact login and recoverable login errors.",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
