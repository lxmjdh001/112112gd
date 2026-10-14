import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { readFile, writeFile, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeFixture } from "./fixtures/native-chat.mjs";
import { waitClientState } from "./desktop-wait.mjs";
import {
  LINE_COMPONENT_PUBLIC_KEY,
  LINE_COMPONENT_SHA256,
} from "../packages/platform/line/component.ts";
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
  assert.equal(r.status, 200, JSON.stringify(b));
  return b.data;
}
admin = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
const code = await api("/login-codes", {
  label: "多平台客户工具验收",
  allowedPlatforms: ["line", "telegram"],
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const profile = await mkdtemp(path.join(tmpdir(), "d1-native-tools-"));
const component = path.join(profile, "components/line/3.7.2");
await mkdir(component, { recursive: true });
await copyFile(
  process.env.LINE_COMPONENT_ARCHIVE ||
    "/Users/chaoteng/Library/Application Support/@gongdan/desktop/components/line/3.7.2.crx",
  path.join(profile, "components/line/3.7.2.crx"),
);
await writeFile(path.join(component, ".d1-verified"), LINE_COMPONENT_SHA256);
await writeFile(
  path.join(component, "manifest.json"),
  JSON.stringify({
    manifest_version: 3,
    name: "LINE fixture",
    version: "3.7.2",
    key: LINE_COMPONENT_PUBLIC_KEY,
    permissions: ["storage", "cookies", "notifications", "tabs"],
    action: {},
    host_permissions: ["https://*/*"],
  }),
);
await writeFile(
  path.join(component, "index.html"),
  '<html><head><meta charset="utf-8"></head><body><script src="fixture.js"></script></body></html>',
);
await writeFile(path.join(component, "fixture.js"), `(${nativeFixture.toString()})('line')`);
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
  await app.evaluate(
    ({ app }, fixture) =>
      app.on("session-created", (s) =>
        s.protocol.handle("https", (request) => {
          const url = new URL(request.url);
          if (url.hostname === "translate.googleapis.com")
            return new Response(
              JSON.stringify([
                [[`Translated ${url.searchParams.get("tl")}: ${url.searchParams.get("q")}`]],
                null,
                "en",
              ]),
              { headers: { "content-type": "application/json" } },
            );
          if (url.hostname === "web.telegram.org")
            return new Response(
              '<html><head><meta charset="utf-8"></head><body><script>(' +
                fixture +
                ")('telegram')</script></body></html>",
              { headers: { "content-type": "text/html" } },
            );
          return new Response("unexpected external request", { status: 502 });
        }),
      ),
    nativeFixture.toString(),
  );
  await app.evaluate(({ app }) =>
    app.on("web-contents-created", (_event, w) => {
      w.on("preload-error", (_event, _path, error) =>
        console.error("Fixture preload error:", error.message),
      );
    }),
  );
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.locator("#login-code").fill(code.code);
  await page.getByRole("button", { name: "进入工作台", exact: true }).click();
  await waitClientState(page, (s) => s.loggedIn && s.connection === "online");
  const ids = {};
  for (const platform of ["line", "telegram"]) {
    ids[platform] = await page.evaluate(
      (platform) =>
        window.gongdan.createAccount({
          platform,
          label: platform + " 工具",
          proxyId: "",
          requestId: crypto.randomUUID(),
          fingerprint: null,
        }),
      platform,
    );
    await page.evaluate((id) => window.gongdan.open(id), ids[platform]);
    const peer = platform === "line" ? "u" + "1".repeat(32) : "100001";
    console.log("Checking", platform);
    try {
      await waitClientState(page, (s) => s.customer?.identifier === peer, 15000);
    } catch (error) {
      console.log("Shell fixture state", await page.evaluate(() => window.gongdan.state()));
      console.log(
        "Views",
        await app.evaluate(async ({ webContents }) =>
          Promise.all(
            webContents
              .getAllWebContents()
              .filter((w) => w.getURL().startsWith("chrome-extension:"))
              .map(async (w) => ({
                url: w.getURL(),
                body: await w.executeJavaScript("document.body.innerText.slice(0,500)"),
              })),
          ),
        ),
      );
      throw error;
    }
    await page.waitForFunction(() => !document.querySelector(".ct-language").disabled);
    assert(await page.locator(".ct-scroll").isVisible());
    console.log(platform, "customer identified");
    const native = async (script) =>
      app.evaluate(
        ({ webContents }, { platform, script }) => {
          const w = webContents
            .getAllWebContents()
            .find((w) =>
              platform === "line"
                ? w.getURL().startsWith("chrome-extension://ophjlpahpchlmihnnnihgmmeilfjmjjc")
                : w.getURL().startsWith("https://web.telegram.org/k/"),
            );
          return w.executeJavaScript(script);
        },
        { platform, script },
      );
    await page.locator(".ct-language").selectOption("ja");
    await page.getByText("已保存当前客户的翻译语言", { exact: true }).waitFor();
    await page.getByRole("button", { name: "新建标签", exact: true }).click();
    let d = page.getByRole("dialog", { name: "新建客户标签" });
    await d.locator("input").fill(platform + " 重点");
    await d.getByRole("button", { name: "创建标签" }).click();
    await d.waitFor({ state: "hidden" });
    if (await page.locator(".ct-tag-menu").isHidden())
      await page.getByRole("button", { name: "选择客户标签", exact: true }).click();
    await page
      .locator(".ct-tag-options")
      .getByRole("button", { name: platform + " 重点", exact: true })
      .click();
    await page.getByRole("button", { name: platform + " 重点 ×", exact: true }).waitFor();
    await page.getByRole("button", { name: "客户资料 / 备注", exact: true }).click();
    await page.locator(".ct-notes").fill(platform + " 客户资料");
    await page.getByRole("button", { name: "保存资料", exact: true }).click();
    await page.getByText("客户资料与备注已保存", { exact: true }).waitFor();
    await page.getByRole("button", { name: "聊天工具", exact: true }).click();
    console.log(platform, "profile and tags saved");
    const context = (await page.evaluate(() => window.gongdan.state())).customer;
    await page.evaluate((c) => window.gongdan.prepareQuick(c, { text: "测试回复" }), context);
    assert.equal(await native("fixture.text()"), "测试回复");
    assert.equal(await native("fixture.sent.length"), 0);
    await assert.rejects(
      page.evaluate((c) => window.gongdan.prepareQuick(c, { text: "不能覆盖" }), context),
      /草稿/,
    );
    assert.equal(
      await native(`document.querySelectorAll('[data-gd7-auto-translation="composer"]').length`),
      0,
    );
    // User-confirmed send only: Enter reaches the shadow input for LINE.
    await native(
      "fixture.editor().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true,composed:true,cancelable:true}))",
    );
    for (let n = 0; n < 50; n++) {
      if (await native("fixture.sent.length")) break;
      await page.waitForTimeout(150);
    }
    const sent = await native("fixture.sent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, "Translated ja: 测试回复");
    const annotations = () =>
      native(
        `Array.from(document.querySelectorAll('[data-gd7-auto-translation="message"]')).map(el=>el.shadowRoot.textContent).join('\\n')`,
      );
    for (let n = 0; n < 40; n++) {
      if (
        (await annotations()).includes("原文：测试回复") &&
        (await annotations()).includes("Translated zh-CN")
      )
        break;
      await page.waitForTimeout(150);
    }
    assert.match(await annotations(), /原文：测试回复/);
    assert.match(await annotations(), /Translated zh-CN/);
    const second = platform === "line" ? "u" + "2".repeat(32) : "100002";
    await native("fixture.select(" + JSON.stringify(second) + ")");
    await waitClientState(page, (s) => s.customer?.identifier === second);
    await page.waitForFunction(() => !document.querySelector(".ct-language").disabled);
    assert.equal(await page.locator(".ct-language").inputValue(), "en");
    await assert.rejects(
      page.evaluate((c) => window.gongdan.prepareQuick(c, { text: "错误客户" }), context),
      /客户已切换/,
    );
    await native("fixture.select(" + JSON.stringify(peer) + ")");
    await waitClientState(page, (s) => s.customer?.identifier === peer);
    await page.waitForFunction(() => document.querySelector(".ct-language").value === "ja");
    await page.getByRole("button", { name: "客户资料 / 备注", exact: true }).click();
    assert.equal(await page.locator(".ct-notes").inputValue(), platform + " 客户资料");
    await page.getByRole("button", { name: "聊天工具", exact: true }).click();
    const image = await page.evaluate(() =>
      window.gongdan.toolsRequest("POST", "/assets", {
        kind: "image",
        title: "预览测试",
        scope: "personal",
        category: "默认",
        mime: "image/png",
        filename: "test.png",
        data: (() => {
          const canvas = document.createElement("canvas");
          canvas.width = 4;
          canvas.height = 4;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#285def";
          ctx.fillRect(0, 0, 4, 4);
          return canvas.toDataURL("image/png").split(",")[1];
        })(),
      }),
    );
    await page.evaluate(({ c, id }) => window.gongdan.prepareQuick(c, { assetId: id }), {
      c: context,
      id: image.id,
    });
    assert((await native("fixture.paste.flat()")).includes("image/png"));
    assert.equal(await native("fixture.sent.length"), 1, "image requires user confirmation");
    await page.getByRole("button", { name: "折叠客户工具", exact: true }).click();
    assert(await page.getByRole("button", { name: "展开客户工具", exact: true }).isVisible());
    await page.getByRole("button", { name: "展开客户工具", exact: true }).click();
    await page.screenshot({ path: ".runtime/native-tools-" + platform + ".png" });
    await native(
      "fixture.select(" +
        JSON.stringify(platform === "line" ? "c" + "3".repeat(32) : "-1000001") +
        ")",
    );
    await waitClientState(page, (s) => !s.customer);
    assert(await page.locator(".ct-language").isDisabled());
    await page.evaluate((id) => window.gongdan.closeAccount(id), ids[platform]);
  }
  console.log(
    "PASS native LINE and Telegram: customer tools, tags, notes, per-customer language, translation send, image preview, stale-context guards, groups and collapse. No external messages.",
  );
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
