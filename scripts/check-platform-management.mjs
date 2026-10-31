import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const base = "http://127.0.0.1:5779/#/";
  await page.goto(base + "auth/login");
  await page.locator("#username").fill(env.BOOTSTRAP_USERNAME);
  await page.locator("#password").fill(env.BOOTSTRAP_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.getByText("平台管理", { exact: true }).first().click();
  await page.getByRole("menuitem", { name: "用户管理", exact: true }).click();
  await page.getByRole("heading", { name: "用户管理", exact: true }).waitFor();
  await page.getByLabel("搜索用户", { exact: true }).fill("commerce-member");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const row = page.locator(".el-table__body-wrapper tr").filter({ hasText: "commerce-member" });
  await row.waitFor();
  assert.equal(await row.count(), 1);
  await row.getByRole("button", { name: "详情", exact: true }).click();
  await page.getByRole("dialog", { name: "用户详情", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "用户详情", exact: true }).waitFor({ state: "hidden" });
  await row.getByRole("button", { name: "重置密码", exact: true }).click();
  await page.getByLabel("重置新密码", { exact: true }).fill("platform-new-123");
  await page.getByLabel("重置确认密码", { exact: true }).fill("platform-new-123");
  await page.getByRole("button", { name: "确认重置密码", exact: true }).click();
  await page.getByText("密码已重置，该用户需重新登录", { exact: true }).waitFor();
  await row.getByRole("button", { name: "停用", exact: true }).click();
  await page.getByRole("button", { name: "确认停用", exact: true }).click();
  await row.getByText("已停用", { exact: true }).waitFor();
  await row.getByRole("button", { name: "启用", exact: true }).click();
  await page.getByRole("button", { name: "确认启用", exact: true }).click();
  await row.getByText("已启用", { exact: true }).waitFor();
  await page.screenshot({ path: ".runtime/platform-users-e2e.png" });
  for (const [route, title] of [
    ["records", "充值记录"],
    ["recharges", "充值审核"],
    ["withdrawals", "提现审核"],
    ["settings", "平台设置"],
  ]) {
    await page.goto(base + "platform/" + route);
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
  }
  const customer = await browser.newContext();
  const cp = await customer.newPage();
  await cp.goto(base + "auth/login");
  await cp.locator("#username").fill("commerce-member");
  await cp.locator("#password").fill("platform-new-123");
  await cp.getByRole("button", { name: "登录", exact: true }).click();
  await cp.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  assert.equal(await cp.getByText("平台管理", { exact: true }).count(), 0);
  await cp.goto(base + "platform/users");
  assert.equal(await cp.getByRole("heading", { name: "用户管理", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Platform management UI passed: operator menu, user search/details/reset/disable/enable, centralized pages and customer route/menu isolation.",
  );
  await customer.close();
  await context.close();
} finally {
  await browser.close();
}
