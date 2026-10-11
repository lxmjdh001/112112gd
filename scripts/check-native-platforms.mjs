// Isolated Telegram storage/lifecycle checks plus LINE's real, unauthenticated login page.
// Never signs into a personal account or sends messages to another person.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "d1-native-platforms-"));
const tenant = "00000000-0000-4000-8000-000000000010";
const tg1 = "00000000-0000-4000-8000-000000000011";
const tg2 = "00000000-0000-4000-8000-000000000012";
const line = "00000000-0000-4000-8000-000000000013";
let accounts = [
  { id: tg1, label: "TG 一", platform: "telegram" },
  { id: tg2, label: "TG 二", platform: "telegram" },
  { id: line, label: "LINE 验收", platform: "line" },
].map((row) => ({
  ...row,
  available: true,
  networkMode: "system",
  connectionType: "web",
  paused: false,
}));
const platforms = [
  { id: "telegram", name: "Telegram" },
  { id: "line", name: "LINE" },
];
const observations = [],
  unexpected = [];
const server = createServer(async (req, res) => {
  const route = new URL(req.url, "http://localhost").pathname.replace("/api/v1", "");
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const input = raw ? JSON.parse(raw) : {};
  let data = {};
  const match = route.match(/^\/client\/accounts\/([^/]+)\/(open|close|remove|status)$/);
  if (route === "/client/auth")
    data = {
      accessToken: "native-fixture",
      tenantId: tenant,
      codeId: tenant,
      deviceId: "fixture-device",
      label: "多平台验收",
      leaseSeconds: 3600,
    };
  else if (route === "/client/accounts") data = accounts;
  else if (route === "/client/platforms") data = platforms;
  else if (route === "/client/billing")
    data = { points: "100", status: "normal", graceDaysRemaining: 3 };
  else if (route === "/client/account-options")
    data = { platforms, usedAccounts: accounts.length, proxies: [] };
  else if (route.startsWith("/client/tools/")) data = [];
  else if (match) {
    const row = accounts.find((a) => a.id === match[1]);
    assert.ok(row);
    if (match[2] === "open") {
      row.paused = false;
      data = { id: row.id, tenantId: tenant, networkMode: "system", proxy: null };
    }
    if (match[2] === "close") row.paused = true;
    if (match[2] === "remove") accounts = accounts.filter((a) => a !== row);
    if (match[2] === "status") observations.push({ id: row.id, ...input });
  } else if (!["/client/heartbeat", "/client/logout"].includes(route)) unexpected.push(route);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 0, data }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await mkdir(".runtime", { recursive: true });
if (process.env.LINE_COMPONENT_ARCHIVE) {
  await mkdir(path.join(profile, "components/line"), { recursive: true });
  await copyFile(
    process.env.LINE_COMPONENT_ARCHIVE,
    path.join(profile, "components/line/3.7.2.crx"),
  );
}
let app;
async function start() {
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
  await app.evaluate(
    ({ session }, { tenant, tg1, tg2 }) => {
      for (const id of [tg1, tg2])
        session
          .fromPartition(`persist:gd7-${tenant}-${id}`)
          .protocol.handle(
            "https",
            () =>
              new Response(
                `<!doctype html><html><body><div id="page-chats"><h1>Telegram isolation fixture</h1></div><script>localStorage.setItem('account1',JSON.stringify({userId:${id === tg1 ? 123456781 : 123456782}}));</script></body></html>`,
                { headers: { "Content-Type": "text/html" } },
              ),
          );
    },
    { tenant, tg1, tg2 },
  );
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  return page;
}
async function nativeStorage(id, write = false) {
  return app.evaluate(
    ({ BrowserWindow }, { id, write }) => {
      // Find the requested slot by its own authenticated fixture ID, not selected chat data.
      const views = BrowserWindow.getAllWindows()[0].contentView.children.filter((v) =>
        v.webContents?.getURL().startsWith("https://web.telegram.org/k/"),
      );
      return (async () => {
        for (const v of views) {
          const owner = await v.webContents.executeJavaScript(
            "JSON.parse(localStorage.account1).userId",
          );
          if (String(owner) === id)
            return v.webContents.executeJavaScript(
              write
                ? "localStorage.setItem('isolation-marker','saved');document.cookie='slot-marker=saved;Secure';'saved'"
                : "localStorage.getItem('isolation-marker')",
            );
        }
        throw Error("fixture view missing");
      })();
    },
    { id, write },
  );
}
try {
  let page = await start();
  await page.locator("#login-code").fill("GD7-NATIVE-FIXTURE");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  assert.equal(
    await page.locator("#add-account").isEnabled(),
    true,
    "LINE/TG-only grants can add accounts",
  );
  await page.evaluate((id) => window.gongdan.open(id), tg1);
  await waitClientState(page, (s) => s.statuses[tg1] === "ready");
  assert.equal(await nativeStorage("123456781", true), "saved");
  await page.evaluate(() => window.gongdan.reload());
  await waitClientState(page, (s) => s.statuses[tg1] === "ready");
  assert.equal(await nativeStorage("123456781"), "saved", "reload stays on Telegram");
  assert.equal(await page.locator(".ct-scroll").isHidden(), true);
  assert.match(await page.locator(".ct-customer").innerText(), /选中文字后右键/);
  await app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
      v.webContents?.getURL().startsWith("https://web.telegram.org/k/"),
    );
    return view.webContents.executeJavaScript(
      "setTimeout(() => { location.href = 'https://web.telegram.org/k/?account=2'; }, 0); true",
    );
  });
  await waitClientState(page, (s) => s.message.includes("每个号位只登录一个 Telegram 账号"));
  assert.equal(await nativeStorage("123456781"), "saved");
  await page.evaluate((id) => window.gongdan.open(id), tg2);
  await waitClientState(page, (s) => s.statuses[tg2] === "ready");
  assert.equal(await nativeStorage("123456782"), null);
  await page.evaluate((id) => window.gongdan.closeAccount(id), tg1);
  await page.evaluate((id) => window.gongdan.open(id), tg1);
  await waitClientState(page, (s) => s.statuses[tg1] === "ready");
  assert.equal(await nativeStorage("123456781"), "saved");
  await page.evaluate((id) => window.gongdan.open(id), line);
  for (let attempt = 0; attempt < 45; attempt++) {
    if ((await page.evaluate(() => window.gongdan.state())).statuses[line] === "qr_required") break;
    await page.waitForTimeout(1000);
  }
  assert.equal(
    (await page.evaluate(() => window.gongdan.state())).statuses[line],
    "qr_required",
    "LINE should reach its actual QR/password login page",
  );
  const lineState = await app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
      v.webContents?.getURL().startsWith("chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/"),
    );
    return view.webContents.executeJavaScript(
      '({hasQR:!!document.querySelector("canvas,svg"),hasPassword:!!document.querySelector("input[type=password]"),node:typeof window.require})',
    );
  });
  assert.equal(lineState.hasPassword, true);
  assert.equal(lineState.hasQR, true);
  assert.equal(lineState.node, "undefined");
  assert.equal(await page.locator(".ct-scroll").isHidden(), true);
  assert.match(await page.locator(".ct-customer strong").innerText(), /LINE/);
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
      v.webContents?.getURL().startsWith("chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc/"),
    );
    return (await view.webContents.capturePage()).toPNG().toString("base64");
  });
  await writeFile(".runtime/native-line-login.png", Buffer.from(screenshot, "base64"));
  assert.equal(
    observations.some((x) => x.id === line && x.status === "ready"),
    false,
  );
  assert.ok(observations.some((x) => x.id === tg1 && x.identifier === "123456781"));
  await page.evaluate((id) => window.gongdan.closeAccount(id), line);
  await page.evaluate((id) => window.gongdan.open(id), tg1);
  await app.close();
  app = undefined;
  page = await start();
  await waitClientState(page, (s) => s.loggedIn && s.statuses[tg1] === "ready");
  assert.equal(
    await nativeStorage("123456781"),
    "saved",
    "login storage survived application restart",
  );
  await page.evaluate((id) => window.gongdan.closeAccount(id), tg1);
  await page.evaluate((id) => window.gongdan.removeAccount(id), tg1);
  const cookies = await app.evaluate(
    ({ session }, { tenant, id }) =>
      session.fromPartition(`persist:gd7-${tenant}-${id}`).cookies.get({}),
    { tenant, id: tg1 },
  );
  assert.equal(cookies.length, 0);
  assert.deepEqual(unexpected, []);
  console.log(
    "PASS: Telegram owner detection, account isolation, pause/reopen, restart persistence, removal cleanup; official LINE QR/password login, sandbox, no QR-page billing.",
  );
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
