import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
let token = "";
async function api(route, data, auth = token) {
  const r = await fetch("http://127.0.0.1:18081/api/v1" + route, {
    method: data ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth },
    body: data ? JSON.stringify(data) : undefined,
  });
  const j = await r.json();
  assert.equal(r.status, 200, j.message);
  return j.data;
}
token = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
const code = await api("/login-codes", {
  allowedPlatforms: ["whatsapp"],
  label: "底库验收",
  maxDevices: 1,
  maxAccounts: 2,
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const client = (
  await api(
    "/client/auth",
    { code: code.code, deviceId: "b".repeat(64), deviceName: "底库验收设备" },
    "",
  )
).accessToken;
await api("/proxies/import", { lines: "socks5://127.0.0.1:12222", maxAccountsPerPlatform: 2 });
const proxy = (await api("/proxies")).find((p) => p.port === 12222);
const accounts = [];
for (const label of ["底库客服 A", "底库客服 B"])
  accounts.push(
    await api(
      "/client/accounts",
      { label, platform: "whatsapp", proxyId: proxy.id, requestId: randomUUID() },
      client,
    ),
  );
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1050 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
async function choose(scope, label, name) {
  await scope
    .getByRole("combobox", { name: label, exact: true })
    .locator('xpath=ancestor::div[contains(@class,"el-select__wrapper")]')
    .click();
  await page.getByRole("option", { name, exact: true }).click();
}
try {
  await page.goto("http://127.0.0.1:5779/");
  await page.locator("#username").fill(env.BOOTSTRAP_USERNAME);
  await page.locator("#password").fill(env.BOOTSTRAP_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.goto("http://127.0.0.1:5779/#/baseline");
  await page.getByRole("heading", { name: "底库管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "批量导入", exact: true }).click();
  const imp = page.getByRole("dialog", { name: "批量导入底库", exact: true });
  await choose(imp, "来源客服账号", "底库客服 A");
  await imp
    .getByLabel("批量底库内容", { exact: true })
    .fill(
      "客户账号,客户IP,备注\n+44 7410419512,203.0.113.8,历史客户\n447410419512@s.whatsapp.net,203.0.113.8,重复行\nwrong,,错误行\n,2001:db8::1,IP 底库",
    );
  await imp.getByRole("button", { name: "校验预览", exact: true }).click();
  await imp.getByText("共 4 行：预计新增 2，跳过重复 1，无效 1", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".runtime/baseline-import-preview.png", fullPage: true });
  await imp.getByRole("button", { name: "确认导入有效行", exact: true }).click();
  await imp.getByText("导入完成：新增 2，跳过重复 1，无效 1", { exact: true }).waitFor();
  await imp.getByRole("button", { name: "完成", exact: true }).click();
  await imp.waitFor({ state: "hidden" });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".el-table__body-wrapper tr").filter({ hasText: "447410419512" }).waitFor();
  await page.getByRole("button", { name: "客户查重", exact: true }).click();
  const check = page.getByRole("dialog", { name: "客户查重", exact: true });
  await check.getByLabel("查重客户账号", { exact: true }).fill("447410419599");
  await check.getByLabel("查重客户IP", { exact: true }).fill("2001:0db8::1");
  await check.getByRole("button", { name: "查重", exact: true }).click();
  await check.getByText("重复用户", { exact: true }).waitFor();
  await check.getByText("IP 重复 · 命中底库", { exact: true }).waitFor();
  await choose(check, "查重平台", "LINE");
  await check.getByRole("button", { name: "查重", exact: true }).click();
  await check.getByText("新用户", { exact: true }).waitFor();
  await check.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("tab", { name: "对话查重记录", exact: true }).click();
  async function register(number, account) {
    await page.getByRole("button", { name: "登记对话", exact: true }).click();
    const d = page.getByRole("dialog", { name: "登记对话", exact: true });
    await choose(d, "查重平台", "WhatsApp");
    await choose(d, "登记客服账号", account);
    await d.getByLabel("查重客户账号", { exact: true }).fill(number);
    await d.getByRole("button", { name: "登记并查重", exact: true }).click();
    await d.getByText(/^(新用户|重复用户)$/).waitFor();
    const text = await d.innerText();
    await d.getByRole("button", { name: "关闭", exact: true }).click();
    return text;
  }
  assert.match(await register("447410419512", "底库客服 B"), /重复用户/);
  assert.match(await register("447410419600", "底库客服 A"), /新用户/);
  assert.match(await register("447410419600", "底库客服 B"), /重复用户/);
  await api(
    "/client/conversations",
    { accountId: accounts[0].id, identifier: "447410419600" },
    client,
  );
  assert.equal((await api("/baselines/summary")).conversations, 3);
  await page.getByRole("button", { name: "新增客户", exact: true }).click();
  const single = page.getByRole("dialog", { name: "新增底库客户", exact: true });
  await single.getByLabel("客户账号", { exact: true }).fill("447410419600");
  await single.getByRole("button", { name: "校验预览", exact: true }).click();
  await single.getByRole("button", { name: "确认导入", exact: true }).click();
  await single.getByRole("button", { name: "完成", exact: true }).click();
  await choose(page, "筛选平台", "WhatsApp");
  await page.getByRole("button", { name: "重新计算", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "重新计算查重结果", exact: true });
  await confirm.getByRole("button", { name: /确定|确认/ }).click();
  await page.getByText("已重新计算 3 条对话", { exact: true }).waitFor();
  assert.equal((await api("/baselines/summary")).repeatedUsers, 3);
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".runtime/baseline-conversations.png", fullPage: true });
  await page.getByRole("tab", { name: "底库客户", exact: true }).click();
  const row = page.locator(".el-table__body-wrapper tr").filter({ hasText: "447410419600" });
  await row.getByRole("button", { name: "停用", exact: true }).click();
  await page
    .getByRole("dialog", { name: "停用底库记录", exact: true })
    .getByRole("button", { name: /确定|确认/ })
    .click();
  await row.getByText("停用", { exact: true }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".runtime/baseline-customers.png", fullPage: true });
  await page.getByRole("tab", { name: "导入记录", exact: true }).click();
  await page.getByRole("button", { name: "失败行", exact: true }).click();
  await page
    .getByRole("dialog", { name: "导入失败行", exact: true })
    .getByText("WhatsApp 账号须为含国家区号的手机号或完整 LID", { exact: true })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "Baseline UI checks passed: import preview, persistence, IP/platform distinction, cross-account duplicate, retry, recalculate, disable, failure rows.",
  );
} catch (e) {
  await page.screenshot({ path: ".runtime/baseline-failure.png", fullPage: true }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
