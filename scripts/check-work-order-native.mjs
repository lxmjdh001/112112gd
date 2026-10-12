import { _electron as electron } from "playwright";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { waitClientState } from "./desktop-wait.mjs";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
let admin;
async function api(route, body) {
  const r = await fetch("http://127.0.0.1:18081/api/v1" + route, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Authorization: "Bearer " + admin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await r.json();
  assert.equal(r.status, 200, route + JSON.stringify(b));
  return b.data;
}
admin = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
const code = await api("/login-codes", {
  label: "原生进线验收",
  allowedPlatforms: ["whatsapp"],
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const profile = await mkdtemp(path.join(tmpdir(), "d1-inbound-e2e-"));
let app;
try {
  app = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop"), "--use-mock-keychain"],
    env: {
      ...process.env,
      GONGDAN_E2E: "1",
      GONGDAN_USER_DATA: profile,
      GONGDAN_API_URL: "http://127.0.0.1:18081",
    },
    timeout: 90000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.locator("#login-code").fill(code.code);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  await app.evaluate(({ app }) =>
    app.on("session-created", (s) =>
      s.protocol.handle(
        "https",
        () =>
          new Response(
            `<!doctype html><html><body><div id="pane-side"></div><div id="main"></div><script>
 localStorage.setItem('last-wid-md','"8613800000000@c.us"');
 window.testMessages=[{id:{id:'native-1',fromMe:false,remote:{user:'447700900001',server:'c.us'}},t:Math.floor(Date.now()/1000),type:'chat'}];
 window.testListeners={};window.require=name=>({Msg:{getModelsArray:()=>window.testMessages,on:(k,f)=>window.testListeners[k]=f,off:k=>delete window.testListeners[k]}});
 </script></body></html>`,
            { headers: { "Content-Type": "text/html" } },
          ),
      ),
    ),
  );
  await page.locator("#add-account").click();
  await page
    .getByRole("button", { name: /使用当前电脑网络|用默认 IP|用默认IP|当前电脑网络/, exact: false })
    .first()
    .click();
  await page.locator("#account-label").fill("原生统计测试");
  await page.getByRole("button", { name: "添加并登录", exact: true }).click();
  const state = await waitClientState(page, (s) => !!s.activeId);
  const account = state.activeId;
  const order = await api("/work-orders", {
    name: "原生统计",
    accountIds: [account],
    startAt: new Date(Date.now() - 3600000).toISOString(),
    enabled: true,
  });
  async function waitTotal(total) {
    for (let n = 0; n < 90; n++) {
      const stats = await api(`/work-orders/${order.id}/stats`);
      if (stats.total === total) return stats;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw Error("native events not synchronized");
  }
  let stats = await waitTotal(1);
  assert(stats.accounts[0].collectorReady);
  await app.evaluate(({ webContents }) => {
    const w = webContents
      .getAllWebContents()
      .find((x) => x.getURL().startsWith("https://web.whatsapp.com"));
    return w.executeJavaScript(
      `(()=>{const m={id:{id:'native-2',fromMe:false,remote:{user:'447700900002',server:'c.us'}},t:Math.floor(Date.now()/1000),type:'chat'};testMessages.push(m);testListeners.add(m);testListeners.add(m);testListeners.add({...m,id:{...m.id,id:'out',fromMe:true}})})()`,
    );
  });
  stats = await waitTotal(2);
  assert.equal(stats.today, 2);
  assert.equal(stats.duplicate, 0);
  // Close/reopen while the old upload response is still in flight. One outbox
  // must serve both runtimes, and cached events must remain idempotent.
  await app.evaluate(() => {
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).includes("/inbound-events"))
        await new Promise((resolve) => setTimeout(resolve, 3000));
      return response;
    };
  });
  await app.evaluate(({ webContents }) => {
    const w = webContents
      .getAllWebContents()
      .find((x) => x.getURL().startsWith("https://web.whatsapp.com"));
    return w.executeJavaScript(
      `(()=>{const m={id:{id:'native-3',fromMe:false,remote:{user:'447700900003',server:'c.us'}},t:Math.floor(Date.now()/1000),type:'chat'};testMessages.push(m);testListeners.add(m)})()`,
    );
  });
  await waitTotal(3);
  await page.evaluate((id) => window.gongdan.closeAccount(id), account);
  await page.evaluate((id) => window.gongdan.open(id), account);
  await waitClientState(page, (s) => s.activeId === account);
  await page.waitForTimeout(7000);
  assert.equal((await api(`/work-orders/${order.id}/stats`)).total, 3);
  await page.screenshot({ path: ".runtime/work-order-native-client.png" });
  console.log(
    "Electron sandbox/main-world collector -> encrypted queue -> authenticated API -> website statistics passed; duplicate/outgoing ignored. No real platform messages used.",
  );
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
