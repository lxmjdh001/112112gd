// Exercises Electron's real HTTP transport against a local proxy, with synthetic
// messages only. No external provider or WhatsApp connection is made.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import { build } from "../apps/desktop/node_modules/esbuild/lib/main.js";

await mkdir(".runtime", { recursive: true });
const modulePath = path.resolve(".runtime/translation-network.cjs");
await build({
  stdin: {
    contents:
      "export { FreeTranslator } from './apps/desktop/src/main/translation.ts'; export { throughSession } from './apps/desktop/src/main/network.ts';",
    resolveDir: process.cwd(),
  },
  outfile: modulePath,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const requests = [];
const sockets = new Set();
const proxy = http.createServer(async (req, res) => {
  if (
    req.headers["proxy-authorization"] !==
    "Basic " + Buffer.from("fixture:password").toString("base64")
  ) {
    res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="fixture"' }).end();
    return;
  }
  const buffers = [];
  for await (const chunk of req) buffers.push(chunk);
  const body = Buffer.concat(buffers).toString();
  requests.push({ url: req.url, method: req.method, headers: req.headers, body });
  const url = new URL(req.url);
  if (url.pathname === "/stall") return;
  if (url.pathname === "/translate_a/single") res.writeHead(429).end();
  else if (url.pathname === "/get")
    res.writeHead(200).end(JSON.stringify({ responseStatus: 429, quotaFinished: true }));
  else
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ translatedText: "Olá" }));
});
proxy.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const profile = await mkdtemp(path.join(tmpdir(), "gd-translation-network-"));
let app;
try {
  app = await electron.launch({ args: [modulePath, `--user-data-dir=${profile}`] });
  const result = await app.evaluate(
    async ({ app, session }, { modulePath, port }) => {
      await app.whenReady();
      const { FreeTranslator, throughSession } = process
        .getBuiltinModule("module")
        .createRequire(modulePath)(modulePath);
      const ses = session.fromPartition("translation-network-fixture");
      await ses.setProxy({
        proxyRules: `http://127.0.0.1:${port}`,
        proxyBypassRules: "<-loopback>",
      });
      await ses.cookies.set({
        url: "http://translation.test",
        name: "session",
        value: "must-not-leak",
      });
      const fetch = throughSession(ses, {
        host: "127.0.0.1",
        port,
        username: "fixture",
        password: "password",
      });
      const translator = new FreeTranslator((url, init) =>
        fetch("http://translation.test" + new URL(url).pathname, init),
      );
      const translated = await translator.translate("你好 & 世界", "pt");
      await fetch("http://translation.test/header-check", {
        method: "POST",
        body: "{}",
        headers: {
          "Content-Type": "application/json",
          Authorization: "must-not-leak",
          Cookie: "must-not-leak",
        },
      });
      let aborted = false;
      try {
        await fetch("http://translation.test/stall", { signal: AbortSignal.timeout(150) });
      } catch {
        aborted = true;
      }
      return { translated, aborted };
    },
    { modulePath, port: proxy.address().port },
  );
  assert.equal(result.translated.provider, "libretranslate");
  assert.equal(result.translated.text, "Olá");
  assert.equal(result.aborted, true);
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname),
    ["/translate_a/single", "/get", "/translate", "/header-check", "/stall"],
  );
  const post = requests[2];
  assert.equal(post.method, "POST");
  assert.equal(post.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(post.body), {
    q: "你好 & 世界",
    source: "zh-Hans",
    target: "pt",
    format: "text",
  });
  for (const r of requests) {
    assert.equal(r.headers.cookie, undefined);
    assert.equal(r.headers.authorization, undefined);
  }
  console.log(
    "PASS: Electron fallback POST through authenticated proxy; no session/app credentials; abort works",
  );
} finally {
  await app?.close();
  for (const socket of sockets) socket.destroy();
  proxy.close();
  await rm(profile, { recursive: true, force: true });
}
