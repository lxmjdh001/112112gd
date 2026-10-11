// Synthetic accounts and pages; no real WhatsApp login or outbound requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";
const profile = await mkdtemp(path.join(tmpdir(), "gd7-billing-"));
const tenant = "00000000-0000-4000-8000-000000000001";
const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"];
const observations = [];
let expired = false;
let points = "99.00";
const server = createServer(async (req, res) => {
  const route = new URL(req.url, "http://localhost").pathname.replace("/api/v1", "");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  if (expired) {
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        code: 402,
        message: "点数不足且公司累计 3 天缓冲已用完，全部账号已退登。请联系平台充值后重新登录。",
      }),
    );
    return;
  }
  let data = {};
  if (route === "/client/auth")
    data = {
      accessToken: "synthetic-token",
      deviceId: "fixture-device",
      tenantId: tenant,
      codeId: tenant,
      label: "点数测试",
      leaseSeconds: 3600,
    };
  else if (route === "/client/accounts")
    data = ids.map((id, i) => ({
      id,
      label: "销售 " + i,
      platform: "whatsapp",
      connectionType: "web",
      available: true,
      networkMode: "system",
    }));
  else if (route === "/client/platforms") data = [{ id: "whatsapp", name: "WhatsApp" }];
  else if (route === "/client/billing")
    data = { points, status: points === "0.00" ? "low" : "normal", graceDaysRemaining: 3 };
  else if (route.endsWith("/open"))
    data = { id: route.split("/")[3], tenantId: tenant, networkMode: "system", proxy: null };
  else if (route.endsWith("/status")) observations.push(body);
  else if (route.startsWith("/client/tools")) data = [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: 0, data }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
  page.setDefaultTimeout(15000);
  await app.evaluate(
    ({ session }, { tenant, ids }) => {
      for (const id of ids)
        session
          .fromPartition(`persist:gd7-${tenant}-${id}`)
          .protocol.handle(
            "https",
            () =>
              new Response(
                '<!doctype html><html><body><div id="pane-side">Synthetic account is ready</div></body></html>',
                { headers: { "Content-Type": "text/html" } },
              ),
          );
    },
    { tenant, ids },
  );
  await page.locator("#login-code").fill("GD7-SYNTHETIC-TEST");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  assert.match(await page.locator(".billing-status").innerText(), /99 点/);
  await page.locator(`.account[data-id="${ids[0]}"]`).click();
  await waitClientState(page, (s) => s.statuses[ids[0]] === "identity_pending");
  assert.equal(observations.filter((x) => x.status === "ready").length, 0);
  await page.getByRole("heading", { name: "正在识别登录账号", exact: true }).waitFor();
  async function identify(phone, id) {
    await app.evaluate(
      async ({ webContents, session }, { phone, tenant, id }) => {
        const view = webContents
          .getAllWebContents()
          .find(
            (c) =>
              c.getURL().startsWith("https://web.whatsapp.com") &&
              c.session === session.fromPartition(`persist:gd7-${tenant}-${id}`),
          );
        await view.executeJavaScript(
          `localStorage.setItem('last-wid-md',JSON.stringify('${phone}:2@c.us'));window.dispatchEvent(new Event('online'))`,
        );
      },
      { phone, tenant, id },
    );
  }
  await identify("15550000001", ids[0]);
  await waitClientState(page, (s) => s.statuses[ids[0]] === "ready");
  assert.ok(observations.some((x) => x.status === "ready" && x.identifier === "15550000001"));
  await page.locator(`.account[data-id="${ids[1]}"]`).click();
  await waitClientState(page, (s) => s.statuses[ids[1]] === "identity_pending");
  await identify("15550000002", ids[1]);
  await waitClientState(page, (s) => s.statuses[ids[1]] === "ready");
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((c) => c.getURL().startsWith("https://web.whatsapp.com")).length,
    ),
    2,
  );
  points = "0.00";
  await page.locator("#refresh").click();
  await waitClientState(page, (s) => s.billing?.points === "0.00");
  assert.match(await page.locator(".billing-status").innerText(), /剩余 0 点/);
  assert.doesNotMatch(await page.locator(".billing-status").innerText(), /0\.00/);
  expired = true;
  await page.locator("#refresh").click();
  await waitClientState(page, (s) => !s.loggedIn);
  await page.getByRole("alert").filter({ hasText: "全部账号已退登" }).waitFor();
  assert.equal(
    await app.evaluate(
      ({ webContents }) =>
        webContents
          .getAllWebContents()
          .filter((c) => c.getURL().startsWith("https://web.whatsapp.com")).length,
    ),
    0,
  );
  await assert.rejects(access(path.join(profile, "authorization.bin")));
  console.log(
    "PASS: owner identity required, points display, two native accounts authorized, expiry closes every account and erases client credentials",
  );
} finally {
  await app?.close();
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
