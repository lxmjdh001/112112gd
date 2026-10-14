// Real DOM and browser events with synthetic messages; never connects to WhatsApp/Google.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { build } from "../apps/desktop/node_modules/esbuild/lib/main.js";
import { mkdir, readFile } from "node:fs/promises";
await mkdir(".runtime", { recursive: true });
for (const [name, entry] of [
  ["native-auto", "apps/desktop/src/preload/automatic-translation.ts"],
  ["cloud-auto", "packages/cloud-chat/index.ts"],
]) {
  await build({
    entryPoints: [entry],
    outfile: `.runtime/${name}.js`,
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: name === "native-auto" ? "NativeAuto" : "CloudAuto",
  });
}
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 850 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    `<style>body{font:15px system-ui;background:#efe8df;padding:30px}#main{max-width:800px;margin:auto}.bubble{background:white;padding:15px;border-radius:10px;margin:10px;max-width:600px}.out{margin-left:120px;background:#ddffd4}footer{background:#fafafa;margin-top:30px;padding:12px}[role=textbox]{min-height:50px;padding:8px;border:1px solid #ccc}footer button{margin-top:8px}</style><main id="main"><header>合成客户 A</header><section id="messages"></section><footer><div contenteditable="true" role="textbox"></div><button aria-label="Send"><span data-icon="send">发送</span></button></footer></main>`,
  );
  await page.addScriptTag({ path: ".runtime/native-auto.js" });
  await page.evaluate(() => {
    const f = (window.nativeFixture = {
      peer: "15550000001",
      writes: [],
      stored: {},
      calls: [],
      gates: {},
      hold: "",
      fail: "",
      counter: 0,
    });
    f.message = (text, out = false) => {
      const row = document.createElement("div");
      row.className = "bubble" + (out ? " out" : "");
      row.dataset.id = (out ? "true_" : "false_") + f.peer + "@s.whatsapp.net_" + ++f.counter;
      const content = document.createElement("div"),
        span = document.createElement("span");
      span.className = "selectable-text copyable-text";
      span.textContent = text;
      content.append(span);
      row.append(content);
      document.querySelector("#messages").append(row);
      return row.dataset.id;
    };
    f.switch = (id) => {
      f.peer = id;
      document.querySelector("#messages").replaceChildren();
      document.querySelector("[role=textbox]").textContent = "";
      f.message("Hello " + id);
    };
    const t = {
      translate: async (text, target, source) => {
        f.calls.push({ text, target, source });
        if (f.hold === text) await new Promise((r) => (f.gates[text] = r));
        if (f.fail === text) throw Error("模拟断网");
        return {
          text: (target === "zh-CN" ? "中文：" : target + ": ") + text,
          provider: "mymemory",
        };
      },
      loadOriginals: async (id) =>
        Object.fromEntries(Object.entries(f.stored).filter(([, v]) => v.identifier === id)),
      saveOriginal: async (id, value) => {
        f.stored[id] = value;
      },
    };
    f.mount = () => {
      f.controller = NativeAuto.installAutomaticTranslation(document, t);
      f.controller.setLanguage(f.peer, "pt");
    };
    f.message("Quero 500 unidades.");
    f.mount();
    document.querySelector("[aria-label=Send]").addEventListener("click", () => {
      const box = document.querySelector("[role=textbox]");
      f.writes.push({ peer: f.peer, text: box.innerText });
      f.message(box.innerText, true);
      box.textContent = "";
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
  });
  const editor = page.locator("[role=textbox]");
  await page.getByText("译：中文：Quero 500 unidades.", { exact: false }).waitFor();
  await editor.fill("今天发报价单");
  await page.waitForFunction(() => window.nativeFixture.calls.some((c) => c.text === "今天发报价单"));
  assert.equal(await page.locator('[data-gd7-auto-translation="composer"]').count(), 0);
  assert.equal(
    await page.evaluate(
      () => window.nativeFixture.calls.find((c) => c.text === "今天发报价单").source,
    ),
    "zh-CN",
  );
  await editor.press("Enter");
  await page.getByText("原文：今天发报价单", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.nativeFixture.writes), [
    { peer: "15550000001", text: "pt: 今天发报价单" },
  ]);
  await page.waitForFunction(() => Object.keys(window.nativeFixture.stored).length === 1);
  // Re-mount models page reload: original is recovered and added only to its own outgoing message.
  await page.evaluate(() => {
    document.querySelectorAll("[data-gd7-auto-translation]").forEach((n) => n.remove());
    window.nativeFixture.controller.dispose();
    window.nativeFixture.mount();
  });
  await page.getByText("原文：今天发报价单", { exact: true }).waitFor();
  await page.screenshot({ path: ".runtime/native-auto-translation.png" });
  await page.evaluate(() => {
    window.nativeFixture.fail = "不能发";
  });
  await editor.fill("不能发");
  await editor.press("Enter");
  await page
    .getByText(/模拟断网/)
    .first()
    .waitFor();
  assert.equal(await editor.innerText(), "不能发");
  assert.equal(await page.evaluate(() => window.nativeFixture.writes.length), 1);
  // Rapid double send while translating coalesces to one outgoing action.
  await page.evaluate(() => {
    window.nativeFixture.fail = "";
    window.nativeFixture.hold = "只发送一次";
  });
  await editor.fill("只发送一次");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.waitForFunction(() => !!window.nativeFixture.gates["只发送一次"]);
  await page.evaluate(() => window.nativeFixture.gates["只发送一次"]());
  await page.getByText("原文：只发送一次", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.nativeFixture.writes.length), 2);
  await page.waitForTimeout(550);
  // Change peer during a delayed response; neither old nor new chat is sent to.
  await page.evaluate(() => {
    window.nativeFixture.hold = "旧客户草稿";
  });
  await editor.fill("旧客户草稿");
  await editor.press("Enter");
  await page.waitForFunction(() => !!window.nativeFixture.gates["旧客户草稿"]);
  await page.evaluate(() => {
    window.nativeFixture.switch("15550000002");
    window.nativeFixture.controller.setLanguage("15550000002", "fr");
  });
  await page.getByText("译：中文：Hello 15550000002", { exact: false }).waitFor();
  await page.evaluate(() => window.nativeFixture.gates["旧客户草稿"]());
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.nativeFixture.writes.length), 2);
  // Draft changes and IME/newline must not trigger stale or unintended sends.
  await page.evaluate(() => {
    window.nativeFixture.hold = "修改前";
  });
  await editor.fill("修改前");
  await editor.press("Enter");
  await page.waitForFunction(() => !!window.nativeFixture.gates["修改前"]);
  await editor.fill("修改后");
  await page.evaluate(() => window.nativeFixture.gates["修改前"]());
  await page.getByText(/草稿已变化/).waitFor();
  assert.equal(await page.evaluate(() => window.nativeFixture.writes.length), 2);
  await editor.press("Shift+Enter");
  await editor.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    bubbles: true,
  });
  assert.equal(await page.evaluate(() => window.nativeFixture.writes.length), 2);
  await page.evaluate(() => {
    window.nativeFixture.hold = "";
  });
  await editor.fill("新客户回复");
  await page.waitForFunction(() => window.nativeFixture.calls.some((c) => c.text === "新客户回复"));
  await page.locator("[aria-label=Send]").click();
  await page.getByText("原文：新客户回复", { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.nativeFixture.writes.at(-1)), {
    peer: "15550000002",
    text: "fr: 新客户回复",
  });
  await page.close();

  const cloud = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  cloud.on("pageerror", (e) => errors.push(e.message));
  await cloud.route("https://auto-translation.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<style>body{margin:0}#cloud{height:100vh}</style><div id="cloud"></div>',
    }),
  );
  await cloud.goto("https://auto-translation.test/");
  await cloud.addStyleTag({ content: await readFile("packages/cloud-chat/style.css", "utf8") });
  await cloud.addScriptTag({ path: ".runtime/cloud-auto.js" });
  await cloud.evaluate(() => {
    const f = (window.cloudFixture = { writes: [], gates: {}, hold: "", fail: "", seq: 1 });
    f.chats = ["a", "b"].map((id, i) => ({
      id,
      name: "客户 " + id,
      customerId: "1555000000" + (i + 1),
      language: i ? "fr" : "pt",
      lastInboundAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    }));
    f.messages = {
      a: [
        {
          id: "incoming",
          seq: 1,
          direction: "in",
          kind: "text",
          body: "Quero 500 unidades.",
          status: "received",
          occurredAt: new Date().toISOString(),
        },
      ],
      b: [],
    };
    const transport = {
      request: async (path, body) => {
        if (path.startsWith("/chats?")) return structuredClone(f.chats);
        if (path === "/translate") {
          if (f.hold === body.text) await new Promise((r) => (f.gates[body.text] = r));
          if (f.fail === body.text) throw Error("模拟翻译失败");
          if (body.text === "今天发报价单" && body.source !== "zh-CN")
            throw Error("wrong source language");
          return {
            text: (body.target === "zh-CN" ? "中文：" : body.target + ": ") + body.text,
            provider: "mymemory",
          };
        }
        const m = /^\/chats\/([ab])\/(messages|read)$/.exec(path);
        if (m) {
          if (m[2] === "read") return true;
          if (!body) return structuredClone(f.messages[m[1]]);
          f.writes.push({ chat: m[1], ...body });
          const msg = {
            ...body,
            body: body.text,
            id: "out" + ++f.seq,
            seq: f.seq,
            direction: "out",
            status: "sent",
            occurredAt: new Date().toISOString(),
          };
          f.messages[m[1]].push(msg);
          return { id: msg.id };
        }
        throw Error("Unexpected fixture path " + path);
      },
    };
    f.mount = () => {
      f.widget = CloudAuto.mountCloudChat(document.querySelector("#cloud"), transport);
    };
    f.mount();
  });
  await cloud.locator(".wc-conversation").filter({ hasText: "客户 a" }).click();
  await cloud.getByText("译：中文：Quero 500 unidades.", { exact: false }).waitFor();
  assert.equal(await cloud.locator(".wc-language").inputValue(), "pt");
  const draft = cloud.locator(".wc-draft");
  await draft.fill("今天发报价单");
  await cloud.getByText("将发送：pt: 今天发报价单", { exact: false }).waitFor();
  await cloud.locator(".wc-send").click();
  await cloud.locator(".wc-out").getByText("今天发报价单", { exact: true }).waitFor();
  await cloud.locator(".wc-out").getByText("译：pt: 今天发报价单", { exact: true }).waitFor();
  assert.equal(
    (await cloud.evaluate(() => window.cloudFixture.writes[0])).text,
    "pt: 今天发报价单",
  );
  await cloud.screenshot({ path: ".runtime/cloud-auto-translation.png" });
  await cloud.evaluate(() => {
    window.cloudFixture.widget.dispose();
    window.cloudFixture.mount();
  });
  await cloud.locator(".wc-conversation").filter({ hasText: "客户 a" }).click();
  await cloud.locator(".wc-out").getByText("今天发报价单", { exact: true }).waitFor();
  await cloud.evaluate(() => {
    window.cloudFixture.fail = "不能发送";
  });
  await draft.fill("不能发送");
  await cloud.locator(".wc-send").click();
  await cloud.locator(".wc-notice").getByText("模拟翻译失败", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "不能发送");
  assert.equal(await cloud.evaluate(() => window.cloudFixture.writes.length), 1);
  await cloud.evaluate(() => {
    window.cloudFixture.fail = "";
    window.cloudFixture.hold = "旧草稿";
  });
  await draft.fill("旧草稿");
  await cloud.locator(".wc-send").click();
  await cloud.waitForFunction(() => !!window.cloudFixture.gates["旧草稿"]);
  await cloud.locator(".wc-conversation").filter({ hasText: "客户 b" }).click();
  await cloud.evaluate(() => window.cloudFixture.gates["旧草稿"]());
  await cloud
    .locator(".wc-notice")
    .getByText(/本次未发送/)
    .waitFor();
  assert.equal(await cloud.evaluate(() => window.cloudFixture.writes.length), 1);
  assert.equal(await cloud.locator(".wc-language").inputValue(), "fr");
  await cloud.evaluate(() => {
    window.cloudFixture.hold = "修改前";
  });
  await draft.fill("修改前");
  await cloud.locator(".wc-send").click();
  await cloud.waitForFunction(() => !!window.cloudFixture.gates["修改前"]);
  await draft.fill("修改后");
  await cloud.evaluate(() => window.cloudFixture.gates["修改前"]());
  await cloud.waitForFunction(() => !document.querySelector(".wc-send").disabled);
  assert.equal(await cloud.evaluate(() => window.cloudFixture.writes.length), 1);
  await cloud.evaluate(() => {
    window.cloudFixture.hold = "";
  });
  await draft.fill("新客户回复");
  await cloud.getByText("将发送：fr: 新客户回复", { exact: true }).waitFor();
  await cloud.locator(".wc-send").click();
  await cloud.locator(".wc-out").getByText("译：fr: 新客户回复", { exact: true }).waitFor();
  assert.equal(await cloud.evaluate(() => window.cloudFixture.writes.at(-1).chat), "b");
  assert.deepEqual(errors, []);
  console.log(
    "Automatic translation passed: native/API incoming, background preparation, translated send, original display/restoration, duplicate send guard, failures, IME, peer/draft/language isolation. Only synthetic transports were used.",
  );
} finally {
  await browser.close();
}
