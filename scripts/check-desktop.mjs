import { _electron as electron } from "playwright";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { build } from "../apps/desktop/node_modules/esbuild/lib/main.js";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
const requests = [];
const sockets = new Set();
const track = (s) => {
  sockets.add(s);
  s.on("error", () => {});
  s.once("close", () => sockets.delete(s));
  return s;
};
const proxy = http.createServer((_req, res) => res.writeHead(400).end());
proxy.on("connection", track);
proxy.on("connect", (req, client, head) => {
  if (
    req.headers["proxy-authorization"] !==
    "Basic " + Buffer.from("e2e:test-password").toString("base64")
  ) {
    client.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="e2e"\r\nContent-Length: 0\r\n\r\n',
    );
    return;
  }
  const url = new URL("http://" + req.url);
  requests.push(url.hostname);
  const upstream = track(
    net.connect(Number(url.port), url.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    }),
  );
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  upstream.on("error", () => client.destroy());
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const port = proxy.address().port;
let token;
async function api(route, data, method) {
  const r = await fetch("http://127.0.0.1:18081/api/v1" + route, {
    method: method || (data ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw Error(j.message);
  return j.data;
}
token = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
const code = await api("/login-codes", {
  label: "桌面验收",
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  maxDevices: 1,
  maxAccounts: 2,
});
await api("/proxies/import", {
  lines: `http://e2e:test-password@127.0.0.1:${port}`,
  group: "E2E 本机测试出口",
  maxAccountsPerPlatform: 2,
});
const proxies = await api("/proxies");
const p = proxies.find((x) => x.port === port);
let account, second;
await build({
  stdin: {
    contents:
      "export {GoogleFreeTranslator} from '../apps/desktop/src/main/translation.ts';export {throughSession} from '../apps/desktop/src/main/network.ts';",
    resolveDir: path.resolve(".runtime"),
  },
  outfile: ".runtime/translation-probe.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const userData = await mkdtemp(path.join(tmpdir(), "gongdan007-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: { ...process.env, GONGDAN_USER_DATA: userData },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#login-code").fill(code.code);
  await page.locator("summary").click();
  await page.locator("#api-url").fill("http://127.0.0.1:18081");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "＋ 添加账号", exact: true }).waitFor();
  await page.screenshot({ path: ".runtime/desktop-shell.png" });
  await page.getByRole("button", { name: "＋ 添加账号", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号" }).waitFor();
  await page.locator("#account-label").fill("验收 WhatsApp");
  await page.locator("#account-proxy").selectOption(p.id);
  await page.getByRole("button", { name: "添加并登录", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号" }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /验收 WhatsApp/ }).waitFor();
  account = (await api("/platform-accounts")).find((a) => a.label === "验收 WhatsApp");
  assert(account?.deviceName, "Client-created account must appear in admin with its device");
  let wa;
  for (let i = 0; i < 50; i++) {
    const status = await app.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getURL().startsWith("https://web.whatsapp.com"))
        .map((w) => ({ id: w.id, loading: w.isLoading() })),
    );
    if (status.length && !status[0].loading) {
      wa = status[0].id;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!wa) throw Error("Official WhatsApp view did not load");
  // The document load event precedes the official app's asynchronous QR setup.
  for (let i = 0; i < 60; i++) {
    const ready = await app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            'Array.from(document.querySelectorAll("canvas")).some(c => c.getBoundingClientRect().width > 100)',
          ),
      wa,
    );
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const snapshot = await app.evaluate(
    async ({ webContents }, { id, dest }) => {
      const w = webContents.fromId(id);
      await (await w.capturePage()).toPNG();
      process.getBuiltinModule("fs").writeFileSync(dest, (await w.capturePage()).toPNG());
      return {
        url: w.getURL(),
        qr: await w.executeJavaScript('!!document.querySelector("[data-ref] canvas,canvas")'),
        overlay: await w.executeJavaScript('!!document.getElementById("gongdan-translation")'),
        security: w.getLastWebPreferences(),
      };
    },
    { id: wa, dest: path.resolve(".runtime/whatsapp-native.png") },
  );
  assert.equal(snapshot.url, "https://web.whatsapp.com/");
  assert.equal(snapshot.overlay, true);
  assert.equal(snapshot.qr, true, "Official QR must be visible");
  assert.equal(snapshot.security.nodeIntegration, false);
  assert.equal(snapshot.security.contextIsolation, true);
  assert.equal(snapshot.security.sandbox, true);
  assert(requests.includes("web.whatsapp.com"));
  // Keep the native page alive, but hide it while the shell's form is open.
  await page.getByRole("button", { name: "＋ 添加账号", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号" }).waitFor();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((view) =>
          view.webContents?.getURL().startsWith("https://web.whatsapp.com"),
        )
        .every((view) => !view.getVisible()),
    ),
    true,
  );
  await page.screenshot({ path: ".runtime/desktop-add-account.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "添加账号" }).waitFor({ state: "hidden" });
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((view) =>
          view.webContents?.getURL().startsWith("https://web.whatsapp.com"),
        )
        .some((view) => view.getVisible()),
    ),
    true,
  );
  second = {
    id: await page.evaluate(
      async (proxyId) =>
        window.gongdan.createAccount({
          label: "独立环境验证",
          platform: "whatsapp",
          proxyId,
          requestId: crypto.randomUUID(),
        }),
      p.id,
    ),
  };
  await page.getByRole("button", { name: "＋ 添加账号", exact: true }).click();
  await page.getByRole("dialog", { name: "添加账号" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "添加并登录", exact: true }).isDisabled(),
    true,
  );
  assert.match(await page.getByRole("dialog", { name: "添加账号" }).innerText(), /账号额度已用完/);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "添加账号" }).waitFor({ state: "hidden" });
  const fullOption = await page.evaluate(async (proxyId) => {
    const options = await window.gongdan.accountForm(true);
    await window.gongdan.accountForm(false);
    return options.proxies.find((proxy) => proxy.id === proxyId);
  }, p.id);
  assert.equal(fullOption.platformUsage.whatsapp, 2);
  assert.equal(fullOption.maxAccountsPerPlatform, 2);
  const translation = await app.evaluate(
    async ({ webContents }, { id, modulePath, port }) => {
      const { GoogleFreeTranslator, throughSession } = process
        .getBuiltinModule("module")
        .createRequire(modulePath)(modulePath);
      const translator = new GoogleFreeTranslator(
        throughSession(webContents.fromId(id).session, {
          host: "127.0.0.1",
          port,
          username: "e2e",
          password: "test-password",
        }),
      );
      return translator.translate("Hello, how are you?", "zh-CN");
    },
    { id: wa, modulePath: path.resolve(".runtime/translation-probe.cjs"), port },
  );
  assert(translation.text);
  assert(requests.includes("translate.googleapis.com"));
  await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id).send("wa:selection", "Hello, how are you?"),
    wa,
  );
  await new Promise((r) => setTimeout(r, 4000));
  await app.evaluate(
    async ({ webContents }, { id, dest }) =>
      process
        .getBuiltinModule("fs")
        .writeFileSync(dest, (await webContents.fromId(id).capturePage()).toPNG()),
    { id: wa, dest: path.resolve(".runtime/whatsapp-translation.png") },
  );
  const isolation = await app.evaluate(
    async ({ webContents, session }, { id, tenant, current, other }) => {
      const a = webContents.fromId(id).session;
      await a.cookies.set({
        url: "https://gd7-storage-probe.invalid",
        name: "gd7_isolation_probe",
        value: "one",
        expirationDate: Date.now() / 1000 + 3600,
      });
      const b = session.fromPartition(`persist:gd7-${tenant}-${other}`);
      return {
        otherCount: (await b.cookies.get({ name: "gd7_isolation_probe" })).length,
        currentValue: (await a.cookies.get({ name: "gd7_isolation_probe" }))[0]?.value,
        matchingPartition: a === session.fromPartition(`persist:gd7-${tenant}-${current}`),
      };
    },
    { id: wa, tenant: (await api("/user/info")).tenantId, current: account.id, other: second.id },
  );
  assert.equal(isolation.otherCount, 0);
  assert.equal(isolation.currentValue, "one", "Storage probe must exist before disable");
  assert.equal(
    isolation.matchingPartition,
    true,
    "Storage probe must use the real account partition",
  );
  // Disabling a proxy must pause its already-open native page on heartbeat.
  await api("/proxies/" + p.id, { enabled: false }, "PATCH");
  await page.getByRole("button", { name: /验收 WhatsApp.*代理已禁用/ }).waitFor({ timeout: 40000 });
  assert.equal(await page.getByRole("button", { name: /验收 WhatsApp/ }).isDisabled(), true);
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((w) => w.getURL().startsWith("https://web.whatsapp.com")).length,
    ),
    0,
  );
  assert.equal(
    (await api("/platform-accounts")).find((row) => row.id === account.id).status,
    "proxy_disabled",
  );
  const whileDisabled = await app.evaluate(
    async ({ session }, { tenant, account }) => {
      return (
        await session
          .fromPartition(`persist:gd7-${tenant}-${account}`)
          .cookies.get({ name: "gd7_isolation_probe" })
      )[0]?.value;
    },
    { tenant: (await api("/user/info")).tenantId, account: account.id },
  );
  assert.equal(whileDisabled, "one", "Closing a disabled view must retain its storage");
  // Re-enabling retains the same profile and never requires creating a new account.
  await api("/proxies/" + p.id, { enabled: true }, "PATCH");
  await page.evaluate(() => window.gongdan.refresh());
  await page.getByRole("button", { name: /验收 WhatsApp/ }).click();
  const retained = await app.evaluate(
    async ({ session }, { tenant, account }) => {
      const s = session.fromPartition(`persist:gd7-${tenant}-${account}`);
      return (await s.cookies.get({ name: "gd7_isolation_probe" }))[0]?.value;
    },
    { tenant: (await api("/user/info")).tenantId, account: account.id },
  );
  assert.equal(retained, "one", "Proxy disable must retain local login storage");
  await api(
    "/login-codes/" + code.id,
    {
      label: "桌面验收",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxDevices: 1,
      maxAccounts: 2,
      enabled: false,
    },
    "PATCH",
  );
  await page.locator("#login-code").waitFor({ timeout: 40000 });
  const remaining = await app.evaluate(
    ({ webContents }) =>
      webContents
        .getAllWebContents()
        .filter((w) => w.getURL().startsWith("https://web.whatsapp.com")).length,
  );
  assert.equal(remaining, 0);
  console.log(
    JSON.stringify({
      passed: [
        "desktop login code",
        "client account creation and admin synchronization",
        "native view preserved behind account form",
        "account quota feedback",
        "authenticated HTTP proxy",
        "official WhatsApp page",
        "translation overlay",
        "Google translation through account proxy",
        "cookie isolation",
        "proxy quota details",
        "proxy disable closes native view on heartbeat and reenable retains cookies",
        "revocation closes native view",
      ],
      qr: snapshot.qr,
      translation: translation.text,
      rendererErrors: errors,
    }),
  );
} catch (e) {
  if (app) {
    console.error(
      "windows",
      await app.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .map((w) => ({ id: w.id, url: w.getURL(), loading: w.isLoading() })),
      ),
    );
    const page = await app.firstWindow();
    await page.screenshot({ path: ".runtime/desktop-failure.png" });
    console.error((await page.locator("body").innerText()).slice(0, 1300));
  }
  throw e;
} finally {
  if (app) await app.close();
  for (const s of sockets) s.destroy();
  proxy.close();
}
