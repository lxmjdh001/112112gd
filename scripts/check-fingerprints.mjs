// Isolated UI + Chromium verification. No personal accounts or external messages.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { waitClientState } from "./desktop-wait.mjs";
const profile = await mkdtemp(path.join(tmpdir(), "d1-fingerprints-"));
const tenant = "00000000-0000-4000-8000-000000000301";
let app,
  rows = [],
  unexpected = [];
const platforms = [{ id: "whatsapp", name: "WhatsApp" }];
function sample() {
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 40;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#568abc";
  ctx.fillRect(0, 0, 80, 40);
  ctx.fillText("D1 profile", 4, 24);
  const first = canvas.toDataURL();
  const second = canvas.toDataURL();
  const audio = new AudioBuffer({ length: 128, sampleRate: 44100 });
  const a = Array.from(audio.getChannelData(0));
  const b = Array.from(audio.getChannelData(0));
  const gl = document.createElement("canvas").getContext("webgl");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  const pixels = new Uint8Array(64);
  gl.clearColor(0.3, 0.4, 0.5, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let rtcDisabled = false;
  try {
    new RTCPeerConnection().close();
  } catch {
    rtcDisabled = true;
  }
  return {
    ua: navigator.userAgent,
    platform: navigator.platform,
    uaData: navigator.userAgentData?.toJSON(),
    language: navigator.language,
    languages: navigator.languages,
    cpu: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    width: screen.width,
    height: screen.height,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
    pixels: Array.from(pixels),
    canvas: first,
    canvasStable: first === second,
    audio: a,
    audioStable: a.every((v, i) => v === b[i]),
    rtcDisabled,
    node: typeof window.require,
  };
}
async function bindAccount(id) {
  await app.evaluate(
    ({ session }, { tenant, id, source }) => {
      session
        .fromPartition(`persist:gd7-${tenant}-${id}`)
        .protocol.handle(
          "https",
          (request) =>
            new Response(
              `<!doctype html><html><body><h1>Fingerprint fixture</h1><canvas aria-label="QR" width="20" height="20"></canvas><script>window.requestHeaders=${JSON.stringify(Object.fromEntries(request.headers))};window.early=(${source})();window.sample=${source};</script></body></html>`,
              { headers: { "Content-Type": "text/html" } },
            ),
        );
    },
    { tenant, id, source: sample.toString() },
  );
}
const server = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const route = new URL(req.url, "http://localhost").pathname.replace("/api/v1", "");
    let data = {};
    if (route === "/client/auth")
      data = {
        accessToken: "fixture",
        tenantId: tenant,
        codeId: tenant,
        deviceId: "fixture",
        label: "指纹验收",
        leaseSeconds: 3600,
      };
    else if (route === "/client/accounts" && req.method === "GET") data = rows;
    else if (route === "/client/accounts" && req.method === "POST") {
      const id = `00000000-0000-4000-8000-${String(400 + rows.length).padStart(12, "0")}`;
      const row = {
        ...body,
        id,
        available: true,
        networkMode: "system",
        connectionType: "web",
        paused: false,
      };
      rows.push(row);
      await bindAccount(id);
      data = { id };
    } else if (route === "/client/platforms") data = platforms;
    else if (route === "/client/account-options")
      data = { platforms, proxies: [], usedAccounts: rows.length };
    else if (route === "/client/billing")
      data = { points: "100", status: "normal", graceDaysRemaining: 3 };
    else if (route.startsWith("/client/tools/")) data = [];
    else {
      const match = route.match(/^\/client\/accounts\/([^/]+)\/(open|status|close|remove)$/);
      if (match) {
        const row = rows.find((r) => r.id === match[1]);
        assert.ok(row);
        if (match[2] === "open") {
          row.paused = false;
          data = {
            id: row.id,
            tenantId: tenant,
            networkMode: "system",
            proxy: null,
            fingerprint: row.fingerprint,
          };
        } else if (match[2] === "close") row.paused = true;
        else if (match[2] === "remove") rows = rows.filter((r) => r !== row);
      } else if (!["/client/heartbeat", "/client/logout"].includes(route)) unexpected.push(route);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 0, data }));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
async function start() {
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
  for (const row of rows) await bindAccount(row.id);
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  return page;
}
async function snapshot(id) {
  for (let n = 0; n < 80; n++) {
    const result = await app.evaluate(async ({ BrowserWindow }, id) => {
      for (const v of BrowserWindow.getAllWindows()[0].contentView.children) {
        const wc = v.webContents;
        if (wc?.getURL() === "https://web.whatsapp.com/" && wc.session.storagePath?.includes(id))
          return wc.executeJavaScript(
            "({early:window.early,now:window.sample?.(),headers:window.requestHeaders})",
          );
      }
      return null;
    }, id);
    if (result?.early) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Error(
    "Fingerprint page not ready: " +
      JSON.stringify(await (await app.firstWindow()).evaluate(() => window.gongdan.state())),
  );
}
try {
  let page = await start();
  await page.locator("#login-code").fill("GD7-FP-FIXTURE");
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  await page.locator("#add-account").click();
  await page.locator("#use-system-network").click();
  assert.match(await page.locator(".fp-status").innerText(), /当前电脑/);
  await page.locator("[data-fp-random]").click();
  assert.match(await page.locator(".fp-status").innerText(), /自定义/);
  const set = async (key, value) => page.locator(`[data-fp="${key}"]`).fill(String(value));
  await page.locator('[data-fp="os"]').selectOption("windows");
  await set("screenWidth", 2560);

  const originalUA = await page.locator('[data-fp="userAgent"]').inputValue();
  await set("userAgent", originalUA.replace(/Chrome\/[\d.]+/, "Chrome/99.0.0.0"));
  await page.locator('#account-form button[type="submit"]').click();
  assert.equal(rows.length, 0);
  assert.match(await page.locator("#account-error").innerText(), /浏览器版本/);
  await page.locator("[data-fp-random]").click();
  assert.match(await page.locator('[data-fp="userAgent"]').inputValue(), /Chrome\/152\./);
  await page.locator('[data-fp="os"]').selectOption("windows");
  await set("screenWidth", 2560);
  await set("screenHeight", 1440);
  await set("hardwareConcurrency", 12);
  await page.locator('[data-fp="deviceMemory"]').selectOption("4");
  await set("language", "ja-JP");
  await set("timezone", "invalid/timezone");
  await page.locator('[data-fp="webrtc"]').selectOption("disabled");
  await page.locator(".fp-privacy summary").click();
  await page.locator('[data-fp="blockLocalFonts"]').check();
  await page.locator('#account-form button[type="submit"]').click();
  assert.equal(rows.length, 0, "invalid settings blocked before creating account");
  assert.match(await page.locator("#account-error").innerText(), /时区/);
  await set("timezone", "Asia/Tokyo");
  await mkdir(".runtime", { recursive: true });
  await page.locator("#account-form").evaluate((el) => (el.closest("dialog").scrollTop = 0));
  await page.screenshot({ path: ".runtime/fingerprint-form.png" });
  await page.locator('#account-form button[type="submit"]').click();
  await waitClientState(page, (s) => s.accounts.length === 1 && s.activeId === rows[0].id);
  const id = rows[0].id,
    saved = structuredClone(rows[0].fingerprint);
  const first = await snapshot(id);
  for (const value of [first.early, first.now]) {
    assert.equal(value.ua, saved.userAgent);
    assert.equal(value.platform, "Win32");
    assert.equal(value.uaData.platform, "Windows");
    assert.equal(value.language, "ja-JP");
    assert.equal(value.languages[0], "ja-JP");
    assert.equal(value.cpu, 12);
    assert.equal(value.memory, 4);
    assert.equal(value.width, 2560);
    assert.equal(value.height, 1440);
    assert.equal(value.timezone, "Asia/Tokyo");
    assert.equal(value.gpu, saved.gpuRenderer);
    assert.equal(value.rtcDisabled, true);
    assert.equal(value.canvasStable, true);
    assert.equal(value.audioStable, true);
    assert.equal(value.node, "undefined");
  }
  assert.equal(first.headers["user-agent"], saved.userAgent);
  assert.match(first.headers["accept-language"], /^ja-JP/);
  const font = (id) =>
    app.evaluate(async ({ BrowserWindow }, id) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
        v.webContents?.session.storagePath?.includes(id),
      );
      return view.webContents.executeJavaScript(
        `new FontFace('D1Test','local("Arial")').load().then(()=>true,()=>false)`,
      );
    }, id);
  assert.equal(await font(id), false, "local font loading is blocked");
  await page.evaluate(() => window.gongdan.reload());
  assert.equal((await snapshot(id)).now.canvas, first.now.canvas);
  await page.evaluate((id) => window.gongdan.closeAccount(id), id);
  await page.evaluate((id) => window.gongdan.open(id), id);
  const reopened = await snapshot(id);
  assert.deepEqual(reopened.now, first.now, "reopening retains identical profile and noise");
  await page.locator("#add-account").click();
  await page.locator("#use-system-network").click();
  await page.locator("[data-fp-random]").click();
  await page.locator("[data-fp-current]").click();
  await page.locator('#account-form button[type="submit"]').click();
  await waitClientState(page, (s) => s.accounts.length === 2 && s.activeId === rows[1].id);
  assert.equal(rows[1].fingerprint, null);
  const native = await snapshot(rows[1].id);
  assert.equal(await font(rows[1].id), true, "native profile retains local font loading");
  assert.notDeepEqual(native.now.pixels, first.now.pixels, "WebGL readback noise takes effect");
  assert.notDeepEqual(native.now.audio, first.now.audio, "audio noise takes effect");
  assert.notEqual(
    native.now.platform,
    "Win32",
    "custom profile does not leak into native account on this Mac",
  );
  await page.evaluate((id) => window.gongdan.open(id), id);
  await app.close();
  app = undefined;
  page = await start();
  await waitClientState(page, (s) => s.loggedIn && s.activeId === id);
  assert.deepEqual((await snapshot(id)).now, first.now, "application restart preserves settings");
  assert.deepEqual(rows[0].fingerprint, saved);
  await page.evaluate((id) => window.gongdan.closeAccount(id), id);
  rows[0].fingerprint.userAgent = saved.userAgent.replace(/Chrome\/[\d.]+/, "Chrome/99.0.0.0");
  await page.evaluate((id) => window.gongdan.open(id), id);
  const repaired = await snapshot(id);
  assert.match(repaired.now.ua, /Chrome\/152\./);
  assert.equal(repaired.now.canvas, first.now.canvas, "legacy repair preserves account seed");
  assert.deepEqual(unexpected, []);
  console.log(
    "PASS: manual/random/current UI, invalid setting rejection, first-script UA/CH/platform/screen/timezone/language/CPU/memory/GPU/WebRTC, stable Canvas/audio, HTTP headers, native isolation and restart persistence.",
  );
} finally {
  await app?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
