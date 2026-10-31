// Real Electron/preload/main/outbox integration; all accounts and API responses are synthetic.
// Build the client first, or set GONGDAN_ARCHIVE_E2E_MAIN to a separately built main.cjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";

const profile = await mkdtemp(path.join(tmpdir(), "d1-team-archive-"));
const tenant = "00000000-0000-4000-8000-000000000021";
const account = "00000000-0000-4000-8000-000000000022";
const device = "archive-fixture-device";
const owner = "8613800000000";
const customer = "447700900001";
const queueFile = path.join(profile, "chat-archive", tenant, device, account + ".bin");
let enabled = false,
  offline = true,
  incompleteAck = false,
  incompleteResponses = 0;
const attempts = [],
  accepted = [],
  inbound = [],
  unexpected = [],
  errors = [];
async function waitFor(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Timed out: " + label);
}
const server = createServer(async (req, res) => {
  const route = new URL(req.url, "http://localhost").pathname.replace("/api/v1", "");
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  let data = {};
  if (route === "/client/auth")
    data = {
      accessToken: "synthetic-archive-token",
      tenantId: tenant,
      codeId: tenant,
      deviceId: device,
      label: "团队归档验收",
      leaseSeconds: 3600,
    };
  else if (route === "/client/team-settings") data = { enabled };
  else if (route === "/client/billing") data = { points: "99.00", status: "normal" };
  else if (route === "/client/accounts")
    data = [
      {
        id: account,
        label: "销售一号",
        platform: "whatsapp",
        connectionType: "web",
        networkMode: "system",
        available: true,
      },
    ];
  else if (route === "/client/platforms") data = [{ id: "whatsapp", name: "WhatsApp" }];
  else if (route === `/client/accounts/${account}/open`)
    data = { id: account, tenantId: tenant, networkMode: "system", proxy: null };
  else if (route === `/client/accounts/${account}/chat-archive`) {
    assert.equal(req.headers.authorization, "Bearer synthetic-archive-token");
    assert.equal(body.owner, owner);
    attempts.push(body);
    if (!enabled || (offline && body.messages.length)) {
      res.writeHead(!enabled ? 200 : 503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          !enabled
            ? { code: 0, data: { accepted: 0, enabled: false } }
            : { code: 503, message: "Synthetic service unavailable" },
        ),
      );
      return;
    }
    if (incompleteAck && body.messages.length) {
      incompleteResponses++;
      data = { enabled: true };
    } else {
      accepted.push(...body.messages);
      data = { accepted: body.messages.length, enabled: true };
    }
  } else if (route === `/client/accounts/${account}/inbound-events`) {
    inbound.push(...body.events);
    data = { accepted: body.events.length };
  } else if (route.startsWith("/client/tools/")) data = [];
  else if (
    ![
      "/client/heartbeat",
      "/client/logout",
      `/client/accounts/${account}/status`,
      `/client/accounts/${account}/close`,
    ].includes(route)
  )
    unexpected.push(route);
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
    args: [path.resolve(process.env.GONGDAN_ARCHIVE_E2E_MAIN || "apps/desktop")],
    env: {
      ...process.env,
      GONGDAN_API_URL: `http://127.0.0.1:${server.address().port}`,
      GONGDAN_USER_DATA: profile,
      GONGDAN_E2E: "1",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate(
    ({ session }, { tenant, account, owner, customer }) => {
      const script = `
        localStorage.setItem("last-wid-md", ${JSON.stringify(owner + "@c.us")});
        window.__fixtureListeners=new Set();
        window.__fixtureMessage=(id,out,body,peer=${JSON.stringify(customer)})=>({
          id:{id,fromMe:out,remote:{user:peer,server:"c.us"}},
          from:{user:out?${JSON.stringify(owner)}:peer,server:"c.us"},
          to:{user:out?peer:${JSON.stringify(owner)},server:"c.us"},
          type:"chat",body,t:Math.floor(Date.now()/1000)-3600
        });
        window.__fixtureMessages=[
          __fixtureMessage("history-in",false,"HISTORICAL PRIVATE IN"),
          __fixtureMessage("history-out",true,"HISTORICAL PRIVATE OUT"),
          {...__fixtureMessage("group-secret",false,"GROUP SECRET"),id:{id:"group-secret",fromMe:false,remote:{user:"123456789",server:"g.us"}}}
        ];
        const Msg={getModelsArray:()=>window.__fixtureMessages,
          on:(event,fn)=>{if(event==="add")window.__fixtureListeners.add(fn)},
          off:(event,fn)=>window.__fixtureListeners.delete(fn)};
        window.require=name=>name==="WAWebCollections"?{Msg,Contact:{get:()=>({name:"客户甲"})}}:undefined;
        window.__fixtureAdd=(id,out,body)=>{const m=__fixtureMessage(id,out,body);__fixtureMessages.push(m);for(const f of [...__fixtureListeners])f(m)};
      `;
      return session
        .fromPartition(`persist:gd7-${tenant}-${account}`)
        .protocol.handle(
          "https",
          () =>
            new Response(
              `<!doctype html><html><head><script>${script}</script></head><body><div id="side"><header></header><div id="pane-side"></div></div><div id="main"></div></body></html>`,
              { headers: { "Content-Type": "text/html" } },
            ),
        );
    },
    { tenant, account, owner, customer },
  );
  await page.locator("#login-code").fill("GD7-SYNTHETIC-ARCHIVE");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (state) => state.loggedIn && state.connection === "online");
  await page.locator(`.account[data-id="${account}"]`).click();
  await waitClientState(page, (state) => state.statuses[account] === "ready");
  const platform = (source) =>
    app.evaluate(async ({ BrowserWindow }, source) => {
      const wc = BrowserWindow.getAllWindows()[0]
        .contentView.children.map((view) => view.webContents)
        .find((wc) => wc.getURL().startsWith("https://web.whatsapp.com"));
      assertPlatform(wc);
      function assertPlatform(wc) {
        if (!wc) throw Error("Synthetic WhatsApp runtime missing");
      }
      return wc.executeJavaScript(source);
    }, source);
  const readQueue = () =>
    app.evaluate(({ safeStorage }, file) => {
      const fs = process.getBuiltinModule("fs");
      if (!fs.existsSync(file)) return null;
      return JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    }, queueFile);
  await waitFor(() => platform("!!window.__d1InboundStatisticsV1?.attached"), "normal collector");
  await waitFor(
    () => inbound.some((event) => event.id.endsWith(":history-in")),
    "baseline reception event",
  );
  assert.equal(await platform("!!window.__d1ChatArchiveV1"), false);
  assert.equal(attempts.length, 0, "Default-off policy must not send chat content");
  const initialInbound = inbound.filter((event) => event.id.endsWith(":history-in")).length;

  enabled = true;
  await page.locator("#refresh").click();
  await waitClientState(page, (state) => state.teamArchiveEnabled === true);
  await waitFor(
    async () => (await readQueue())?.entries.length === 2,
    "encrypted historical outbox",
  );
  await waitFor(
    () => attempts.some((batch) => batch.messages.length === 2),
    "failed historical send",
  );
  const cipher = await readFile(queueFile);
  assert(!cipher.includes(Buffer.from("HISTORICAL PRIVATE IN")));
  assert.equal((await stat(queueFile)).mode & 0o777, 0o600);
  let stored = await readQueue();
  assert.deepEqual(stored.scope, { tenantId: tenant, deviceId: device, accountId: account });
  assert.deepEqual(
    stored.entries.map((entry) => entry.message.direction),
    ["in", "out"],
  );
  assert(attempts.every((batch) => batch.historyScope === "loaded_only"));
  await waitFor(
    () => platform("window.__d1ChatArchiveV1.pending.size===0"),
    "durable collector ACK",
  );
  assert.equal(
    (await readQueue()).entries.length,
    2,
    "Failed server sends must retain durable text",
  );
  assert.equal(
    inbound.filter((event) => event.id.endsWith(":history-in")).length,
    initialInbound,
    "Enabling archives must not duplicate the existing new-reception events",
  );
  await platform(
    `__fixtureAdd("live-in",false,"LIVE IN");__fixtureAdd("live-out",true,"LIVE OUT");__fixtureAdd("unicode",true,"🙂".repeat(5000));`,
  );
  await waitFor(
    async () => (await readQueue())?.entries.length === 5,
    "live + Unicode encrypted batch",
  );
  await waitFor(() => platform("window.__d1ChatArchiveV1.pending.size===0"), "live durable ACK");
  stored = await readQueue();
  assert.equal(
    [...stored.entries.find((entry) => entry.message.id.endsWith(":unicode")).message.body].length,
    5000,
  );

  // IPC callers cannot bypass authenticated runtime/owner validation.
  const forged = await app.evaluate(
    async ({ ipcMain, BrowserWindow }, { account, owner, customer }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const wc = win.contentView.children
        .map((view) => view.webContents)
        .find((wc) => wc.getURL().startsWith("https://web.whatsapp.com"));
      const handler = ipcMain._invokeHandlers.get("platform:chat-archive");
      const input = { owner, ready: true, historyScope: "loaded_only", messages: [] };
      const result = [];
      for (const [sender, senderFrame, batch] of [
        [win.webContents, win.webContents.mainFrame, input],
        [wc, null, input],
        [wc, wc.mainFrame, { ...input, owner: customer }],
      ]) {
        try {
          await handler({ sender, senderFrame }, batch);
          result.push(false);
        } catch {
          result.push(true);
        }
      }
      return result;
    },
    { account, owner, customer },
  );
  assert.deepEqual(forged, [true, true, true]);
  offline = false;
  incompleteAck = true;
  // A second attempt proves the first incomplete acknowledgement did not clear the outbox.
  await waitFor(() => incompleteResponses >= 2, "retry after incomplete server ACK");
  assert.equal((await readQueue()).entries.length, 5);
  assert.equal(accepted.length, 0);
  incompleteAck = false;
  await waitFor(
    () => new Set(accepted.map((message) => message.id)).size === 5,
    "server complete ACK",
  );
  await waitFor(
    async () => (await readQueue())?.entries.length === 0,
    "durable server ACK cleanup",
  );
  assert(accepted.every((message) => message.customer === customer));
  assert(!accepted.some((message) => message.body.includes("GROUP SECRET")));

  // Losing the current identity may report unavailable metadata using the last
  // confirmed owner, but cannot upload any message body under that identity.
  const metadata = await app.evaluate(async ({ ipcMain, BrowserWindow }, owner) => {
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.contentView.children
      .map((view) => view.webContents)
      .find((wc) => wc.getURL().startsWith("https://web.whatsapp.com"));
    const event = { sender: wc, senderFrame: wc.mainFrame };
    ipcMain.emit("platform:status", event, "qr_required");
    const handler = ipcMain._invokeHandlers.get("platform:chat-archive");
    const result = await handler(event, {
      owner: "",
      ready: false,
      historyScope: "unavailable",
      messages: [],
    });
    let bodyRejected = false;
    try {
      await handler(event, {
        owner,
        ready: true,
        historyScope: "loaded_only",
        messages: [
          {
            id: "stale",
            customer: "15550009999",
            direction: "in",
            kind: "text",
            body: "MUST REJECT",
            at: new Date().toISOString(),
          },
        ],
      });
    } catch {
      bodyRejected = true;
    }
    return { result, bodyRejected };
  }, owner);
  assert.equal(metadata.result.stored, true);
  assert.equal(metadata.bodyRejected, true);
  await waitFor(
    () =>
      attempts.some(
        (batch) =>
          batch.ready === false &&
          batch.historyScope === "unavailable" &&
          batch.owner === owner &&
          batch.messages.length === 0,
      ),
    "unavailable owner-scoped metadata",
  );
  await app.evaluate(({ ipcMain, BrowserWindow }, owner) => {
    const wc = BrowserWindow.getAllWindows()[0]
      .contentView.children.map((view) => view.webContents)
      .find((wc) => wc.getURL().startsWith("https://web.whatsapp.com"));
    ipcMain.emit("platform:status", { sender: wc, senderFrame: wc.mainFrame }, "ready", owner);
  }, owner);

  // Opt-out clears unacknowledged local content and unsubscribes only the archive observer.
  offline = true;
  await platform('__fixtureAdd("before-disable",false,"DISCARD ON OPT OUT")');
  await waitFor(async () => (await readQueue())?.entries.length === 1, "pending opt-out record");
  enabled = false;
  await page.locator("#refresh").click();
  await waitClientState(page, (state) => state.teamArchiveEnabled === false);
  await waitFor(() => platform("!window.__d1ChatArchiveV1"), "archive subscription disposal");
  await waitFor(async () => {
    const queue = await readQueue();
    return !queue || queue.entries.length === 0;
  }, "opt-out encrypted cleanup");
  assert.equal(
    await platform("__fixtureListeners.size"),
    1,
    "Existing new-reception collector stays active",
  );
  const attemptsAfterOptOut = attempts.length;
  await platform('__fixtureAdd("disabled",false,"DO NOT COLLECT THIS TEXT")');
  await waitFor(
    () => inbound.some((event) => event.id.endsWith(":disabled")),
    "normal collector still works",
  );
  assert.equal(attempts.length, attemptsAfterOptOut);
  assert.equal(await platform("!!window.__d1ChatArchiveV1"), false);
  assert.equal((await readQueue())?.entries.length || 0, 0);
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(
    "Team archive Electron passed: default-off policy; cached/live in/out history; encrypted durable queue; offline retry; Unicode; exact server ACK; runtime/owner IPC rejection; opt-out disposal; existing reception collector preserved.",
  );
} finally {
  await app?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
