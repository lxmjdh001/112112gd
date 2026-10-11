import { spawn } from "node:child_process";
import { mkdir, readFile, rm, open, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { chromium, _electron as electron } from "playwright";

// Requires built admin/desktop. The Go fixture uses an isolated DB schema and
// an in-process fake Graph API, so no live WhatsApp messages can be sent.
await mkdir(".runtime", { recursive: true });
const fixturePath = path.resolve(".runtime/cloud-browser-fixture.json");
await rm(fixturePath, { force: true });
const log = await open(".runtime/cloud-browser-fixture.log", "w", 0o600);
const children = [];
function launch(command, args, env = {}, cwd = process.cwd()) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", log.fd, log.fd],
    detached: true,
  });
  children.push(child);
  return child;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, label) {
  for (let i = 0; i < 160; i++) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await sleep(250);
  }
  throw Error("Timed out: " + label);
}
let fixture, browser, desktop, profile;
const errors = [];
const previewURL = "http://127.0.0.1:5781";
try {
  const occupied = await fetch(previewURL).then(
    () => true,
    () => false,
  );
  assert(!occupied, "Cloud test preview port 5781 is occupied");
  launch(
    "go",
    ["test", "./internal/app", "-run", "^TestCloudBrowserFixture$", "-count=1", "-timeout", "6m"],
    {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL || "postgres://127.0.0.1:55437/gongdan007?sslmode=disable",
      GONGDAN_CLOUD_E2E_PATH: fixturePath,
    },
    path.resolve("server"),
  );
  fixture = await waitFor(
    async () => JSON.parse(await readFile(fixturePath, "utf8")),
    "Go fixture",
  );
  async function api(route, data, method) {
    const response = await fetch(fixture.apiURL + "/api/v1" + route, {
      method: method || (data ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + fixture.adminToken,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    const result = await response.json();
    assert(response.ok, result.message || String(response.status));
    return result.data;
  }
  launch(
    "pnpm",
    [
      "--filter",
      "@gongdan/admin",
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "5781",
      "--strictPort",
    ],
    { GONGDAN_API_TARGET: fixture.apiURL },
  );
  await waitFor(async () => (await fetch(previewURL)).ok, "preview");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1040 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.__copied = value;
        },
      },
    }),
  );
  await page.goto(previewURL);
  await page.locator("#username").fill(fixture.username);
  await page.locator("#password").fill(fixture.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台" }).waitFor();
  await page.goto(previewURL + "/#/whatsapp-api");
  await page.getByRole("heading", { name: "WhatsApp API", exact: true }).waitFor();
  await page.getByRole("button", { name: "＋ 添加 API 号码" }).click();
  let dialog = page.getByRole("dialog", { name: "添加 WhatsApp API 号码" });
  await dialog.getByPlaceholder("如：售前客服").fill("验收 API 二号");
  await dialog.getByPlaceholder("App ID", { exact: true }).fill("100001");
  await dialog.getByPlaceholder("Phone Number ID", { exact: true }).fill("200002");
  await dialog.getByPlaceholder("WhatsApp Business Account ID", { exact: true }).fill("300001");
  await dialog.locator('input[type="password"]').nth(0).fill(fixture.appSecret);
  await dialog.locator('input[type="password"]').nth(1).fill(fixture.token);
  await dialog.getByRole("button", { name: "验证并添加" }).click();
  await dialog.waitFor({ state: "hidden" });
  const row = page.locator(".el-table__body-wrapper tr").filter({ hasText: "验收 API 二号" });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "编辑 API 号码" });
  assert.equal(await dialog.locator('input[type="password"]').nth(0).inputValue(), "");
  assert.equal(await dialog.locator('input[type="password"]').nth(1).inputValue(), "");
  await dialog.getByRole("button", { name: "保存设置" }).click();
  await dialog.waitFor({ state: "hidden" });
  await row.getByRole("button", { name: "分配", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "分配登录码" });
  await dialog.locator(".el-select").click();
  await page.getByRole("option", { name: "API 验收登录码", exact: true }).click();
  await dialog.locator("p").first().click();
  await dialog.getByRole("button", { name: "保存分配" }).click();
  await dialog.waitFor({ state: "hidden" });
  await row.getByRole("button", { name: "回调配置" }).click();
  dialog = page.getByRole("dialog", { name: "配置 Meta Webhook" });
  await dialog.getByRole("button", { name: "复制", exact: true }).first().click();
  assert.match(
    await page.evaluate(() => window.__copied),
    /^https:\/\/gongdan.example\/api\/v1\/whatsapp-cloud\/webhooks\//,
  );
  await dialog.locator(".el-dialog__headerbtn").click();
  await row.getByRole("button", { name: "订阅消息" }).click();
  await waitFor(
    async () =>
      (await api("/whatsapp-cloud/numbers")).find((n) => n.phoneId === "200002")?.subscribedAt,
    "subscription",
  );
  await page.screenshot({ path: ".runtime/cloud-numbers.png", fullPage: true });
  const firstRow = page.locator(".el-table__body-wrapper tr").filter({ hasText: "200001" });
  await firstRow.getByRole("button", { name: "聊天", exact: true }).click();
  await page.locator(".wc-conversation").first().click();
  await page.locator(".wc-in .wc-message-body").waitFor();
  assert.match(await page.locator(".wc-in .wc-message-body").innerText(), /<img src=x/);
  assert.equal(await page.locator(".wc-message-body img,.wc-message-body script").count(), 0);
  await page.route("**/chats/*/messages", async (route) => {
    if (route.request().method() === "POST") await sleep(500);
    await route.continue();
  });
  await page.locator(".wc-draft").fill("后台验收回复");
  await page
    .locator(".wc-draft-translation")
    .getByText(/将发送：/)
    .waitFor();
  await page.locator(".wc-send").click();
  await page.locator(".wc-draft").fill("正在编写下一条");
  await page
    .locator(".wc-out")
    .filter({ hasText: "后台验收回复" })
    .getByText(/Meta 已接收/)
    .waitFor();
  assert.equal(await page.locator(".wc-draft").inputValue(), "正在编写下一条");
  await page.unroute("**/chats/*/messages");
  await page.locator(".wc-draft").fill("筛选时保留草稿");
  await page.locator(".wc-search").fill("no-such-customer");
  await page.getByText("暂无对话，客户发来消息后会显示在这里。", { exact: true }).waitFor();
  assert.equal(await page.locator(".wc-draft").isEnabled(), true);
  assert.equal(await page.locator(".wc-draft").inputValue(), "筛选时保留草稿");
  await page.locator(".wc-search").fill("");
  await page.locator(".wc-conversation").first().waitFor();
  // Google response is stubbed only for this UI check; no customer text is sent.
  await page.route("**/whatsapp-cloud/numbers/*/translate", (route) =>
    route.fulfill({ json: { code: 0, data: { text: "Draft translation" }, message: "ok" } }),
  );
  await page.locator(".wc-draft").fill("附件说明");
  await page.locator(".wc-translate").click();
  await page
    .locator(".wc-draft-translation")
    .getByText("将发送：Draft translation", { exact: true })
    .waitFor();
  assert.equal(await page.locator(".wc-draft").inputValue(), "附件说明");
  await page.locator(".wc-file-input").setInputFiles({
    name: "sample.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("local fixture"),
  });
  await page.getByText("附件已准备好，点击发送后才会发给客户", { exact: true }).waitFor();
  await page.locator(".wc-send").click();
  await page
    .locator(".wc-out")
    .filter({ hasText: "Draft translation" })
    .getByText(/Meta 已接收/)
    .waitFor();
  await page.locator(".wc-new").click();
  dialog = page.getByRole("dialog", { name: "开始新对话" });
  await dialog.getByLabel("客户手机号").fill("+15550009999");
  await dialog.getByRole("button", { name: "创建对话", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".wc-send").isDisabled(), true);
  await page.locator(".wc-templates").click();
  dialog = page.getByRole("dialog", { name: "发送模板消息" });
  await dialog.getByPlaceholder("参数 1").fill("Cloud Customer");
  await dialog.getByRole("button", { name: "发送模板", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page
    .locator(".wc-out")
    .getByText(/Meta 已接收/)
    .waitFor();
  await page.screenshot({ path: ".runtime/cloud-admin-chat.png", fullPage: true });

  profile = await mkdtemp(path.join(tmpdir(), "gongdan-cloud-e2e-"));
  desktop = await electron.launch({
    executablePath: path.resolve(
      "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    args: [path.resolve("apps/desktop")],
    env: {
      ...process.env,
      GONGDAN_USER_DATA: profile,
      GONGDAN_API_URL: fixture.apiURL,
      GONGDAN_E2E: "1",
    },
    timeout: 30000,
  });
  const client = await desktop.firstWindow();
  client.setDefaultTimeout(15000);
  client.on("pageerror", (e) => errors.push(e.message));
  await client.locator("#login-code").fill(fixture.code);
  await client.getByRole("button", { name: "进入工作台" }).click();
  await client.locator(`.account[data-id="${fixture.numberId}"]`).click();
  await client.locator(".wc-conversation").filter({ hasText: "客户 <script>" }).click();
  await client.waitForFunction(() => !document.querySelector(".ct-language")?.disabled);
  await client.locator(".ct-language").selectOption("fr");
  await client.getByText("已保存当前客户的翻译语言", { exact: true }).waitFor();
  assert.equal(await client.locator(".wc-language").inputValue(), "fr");
  await client.getByRole("button", { name: "客户资料 / 备注", exact: true }).click();
  await client.locator(".ct-notes").fill("API 客户独立备注");
  await client.getByRole("button", { name: "保存资料", exact: true }).click();
  await client.getByText("客户资料与备注已保存", { exact: true }).waitFor();
  await client.getByRole("button", { name: "聊天工具", exact: true }).click();
  await client.evaluate(async () => {
    await window.gongdan.toolsRequest("POST", "/assets", {
      kind: "text",
      scope: "team",
      title: "API 快捷话术",
      body: "API 快捷回复验收",
      category: "售前",
    });
  });
  await client.getByRole("button", { name: "刷新工具资料", exact: true }).click();
  await client.getByRole("button", { name: "团队话术", exact: true }).click();
  await client
    .locator(".ct-text-library .ct-asset-use")
    .filter({ hasText: "API 快捷话术" })
    .click();
  let quickDialog = client.getByRole("dialog", { name: "发送预览" });
  await quickDialog.getByRole("button", { name: "放入当前聊天" }).click();
  await quickDialog.waitFor({ state: "hidden" });
  assert.equal(await client.locator(".wc-draft").inputValue(), "API 快捷回复验收");
  await client.locator(".wc-draft").fill("");
  const quickImage = await desktop.evaluate(({ nativeImage }) =>
    nativeImage
      .createFromBitmap(Buffer.from([0, 140, 0, 255]), { width: 1, height: 1 })
      .toPNG()
      .toString("base64"),
  );
  await client.evaluate(async (data) => {
    await window.gongdan.toolsRequest("POST", "/assets", {
      kind: "image",
      scope: "personal",
      title: "API 报价图片",
      mime: "image/png",
      filename: "quote.png",
      data,
    });
  }, quickImage);
  await client.getByRole("button", { name: "刷新工具资料", exact: true }).click();
  await client
    .locator(".ct-image-library .ct-asset-use")
    .filter({ hasText: "API 报价图片" })
    .click();
  quickDialog = client.getByRole("dialog", { name: "发送预览" });
  await quickDialog.getByRole("button", { name: "放入当前聊天" }).click();
  await quickDialog.waitFor({ state: "hidden" });
  assert.match(await client.locator(".wc-file").innerText(), /quote.png/);
  await client.locator(".wc-file").click();
  await client.locator(".wc-draft").fill("客户端验收回复");
  await client.locator(".wc-send").click();
  await client
    .locator(".wc-out")
    .filter({ hasText: "客户端验收回复" })
    .getByText(/Meta 已接收/)
    .waitFor();
  await client.locator(".wc-draft").fill("刷新后保留草稿");
  const scrollBefore = await client.locator(".wc-messages").evaluate((e) => {
    e.scrollTop = e.scrollHeight;
    return e.scrollTop;
  });
  await client.locator("#refresh").click();
  await sleep(700);
  assert.equal(await client.locator(".wc-messages").evaluate((e) => e.scrollTop), scrollBefore);
  await client.locator(".wc-templates").click();
  await client.getByRole("dialog", { name: "发送模板消息" }).waitFor();
  await client.evaluate(() => window.gongdan.refresh());
  assert.equal(await client.locator("dialog:modal").count(), 1);
  await client
    .getByRole("dialog", { name: "发送模板消息" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  assert.equal(await client.locator(".wc-draft").inputValue(), "刷新后保留草稿");
  assert.equal(
    await desktop.evaluate(({ webContents }) =>
      webContents
        .getAllWebContents()
        .some((w) => w.getURL().startsWith("https://web.whatsapp.com")),
    ),
    false,
  );
  const denied = await client.evaluate(async (id) => {
    try {
      await window.gongdan.cloudRequest(id, "/webhook", {});
      return false;
    } catch {
      return true;
    }
  }, fixture.numberId);
  assert(denied, "Desktop IPC exposed credential route");
  await client.screenshot({ path: ".runtime/cloud-desktop-chat.png" });
  await client.locator(`[data-close-id="${fixture.numberId}"]`).click();
  let closeDialog = client.getByRole("dialog", { name: "关闭 API 聊天", exact: true });
  await closeDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await client.locator(".wc-draft").inputValue(), "刷新后保留草稿");
  await client.locator(`[data-close-id="${fixture.numberId}"]`).click();
  await closeDialog.getByRole("button", { name: "确认关闭", exact: true }).click();
  await closeDialog.waitFor({ state: "hidden" });
  assert.equal(await client.locator(".wa-cloud-chat").count(), 0);
  assert.match(
    await client.locator(`.account[data-id="${fixture.numberId}"]`).getAttribute("class"),
    /paused/,
  );
  await client.locator(`[data-close-id="${fixture.numberId}"]`).click();
  closeDialog = client.getByRole("dialog", { name: "从客户端移除", exact: true });
  await closeDialog.getByRole("button", { name: "确认移除", exact: true }).click();
  await closeDialog.waitFor({ state: "hidden" });
  assert.equal(await client.locator(`.account[data-id="${fixture.numberId}"]`).count(), 0);
  await client.evaluate(() => window.gongdan.refresh());
  assert.equal(await client.locator(`.account[data-id="${fixture.numberId}"]`).count(), 0);
  const retainedNumber = (await api("/whatsapp-cloud/numbers")).find(
    (n) => n.id === fixture.numberId,
  );
  assert(
    retainedNumber.enabled && retainedNumber.codeIds.includes(fixture.codeId),
    "client removal changed shared number",
  );
  await client.locator(".removed-api summary").click();
  await client.locator(`[data-restore-id="${fixture.numberId}"]`).click();
  await client.locator(".wa-cloud-chat").waitFor();
  await api(`/whatsapp-cloud/numbers/${fixture.numberId}/assignments`, { codeIds: [] }, "PUT");
  await client.locator("#refresh").click();
  await client.locator(`.account[data-id="${fixture.numberId}"]`).waitFor({ state: "hidden" });
  assert.equal(await client.locator(".wa-cloud-chat").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Cloud browser and Electron checks passed: onboarding, assignment, callbacks, text, template, attachment, translation UI, drafts, client close/remove/restore, revocation. Graph API was mocked.",
  );
} catch (error) {
  if (desktop) {
    const client = await desktop.firstWindow();
    await client.screenshot({ path: ".runtime/cloud-client-failure.png" }).catch(() => {});
    console.error(await client.locator(".ct-dialog-error").allTextContents());
  }
  throw error;
} finally {
  if (desktop) await desktop.close();
  if (browser) await browser.close();
  if (fixture) await fetch(fixture.apiURL + "/__fixture/stop", { method: "POST" }).catch(() => {});
  if (children[0])
    await waitFor(() => children[0].exitCode !== null, "fixture shutdown").catch(() => {});
  for (const child of children)
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    }
  await log.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  await rm(fixturePath, { force: true });
}
