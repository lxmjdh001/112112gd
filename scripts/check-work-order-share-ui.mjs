// Public statistics UI regression check; intercepts every statistics response with synthetic data.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.WORK_ORDER_PREVIEW_URL || "http://127.0.0.1:5786";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let requirePassword = false,
  revoked = false,
  requests = 0;
const now = new Date().toISOString();
const fixture = {
  name: "十月渠道工单",
  platforms: ["whatsapp", "telegram"],
  startAt: "2026-10-01T00:00:00Z",
  endAt: null,
  resetMinutes: 0,
  target: 100,
  updatedAt: now,
  today: 7,
  yesterday: 9,
  total: 33,
  fresh: 22,
  duplicate: 11,
  todayFresh: 4,
  todayDuplicate: 3,
  accounts: [
    { id: "one", label: "客服一号", nickname: "Alice", account: "8613800000000", platform: "whatsapp", connectionType: "web", status: "online", total: 17, today: 7, yesterday: 2, fresh: 12, duplicate: 5, todayFresh: 4, todayDuplicate: 3, collectorReady: false, lastSync: null },
    { id: "two", label: "客服二号", nickname: "Bob", account: "8613900000000", platform: "whatsapp", connectionType: "web", status: "offline", total: 11, today: 0, yesterday: 7, fresh: 8, duplicate: 3, todayFresh: 0, todayDuplicate: 0, collectorReady: true, lastSync: now },
    { id: "three", label: "客服三号", nickname: "", account: "123456789", platform: "telegram", connectionType: "web", status: "error", total: 5, today: 0, yesterday: 0, fresh: 2, duplicate: 3, todayFresh: 0, todayDuplicate: 0, collectorReady: true, lastSync: now },
  ],
};
await page.route("**/api/v1/public/work-orders/**", async (route) => {
  requests++;
  const body = route.request().postDataJSON();
  const passwordDenied = requirePassword && body.password !== "stats-pass";
  await route.fulfill({
    status: revoked ? 404 : passwordDenied ? 403 : 200,
    contentType: "application/json",
    body: JSON.stringify(
      revoked
        ? { code: 404, message: "此统计链接已停用" }
        : passwordDenied
          ? { code: 403, message: "请输入访问密码" }
          : { code: 0, data: fixture },
    ),
  });
});
try {
  await page.goto(base + "/#/s/synthetic-work-order-share");
  await page.locator(".account-stats-table .el-table__body-wrapper tr").first().waitFor();
  await page.locator("#__app-loading__").waitFor({ state: "detached" });
  const headers = await page.locator(".account-stats-table .el-table__header th .cell").allTextContents();
  assert.deepEqual(headers.map((text) => text.trim()), ["昵称", "账号", "今日新增", "累积新增", "今日重复", "累积重复", "状态"]);
  const rows = page.locator(".account-stats-table .el-table__body-wrapper tr");
  assert.deepEqual((await rows.nth(0).locator("td .cell").allTextContents()).map((text) => text.trim()), ["Alice", "8613800000000", "4", "12", "3", "5", "在线"]);
  assert.equal((await rows.nth(1).locator("td .cell").last().innerText()).trim(), "离线");
  assert.equal((await rows.nth(2).locator("td .cell").last().innerText()).trim(), "异常");
  assert.equal((await rows.nth(2).locator("td .cell").first().innerText()).trim(), "客服三号");
  const body = await page.locator("body").innerText();
  for (const removed of ["ACCOUNT PERFORMANCE", "工单期间，同一客户", "原生账号由新版客户端"])
    assert(!body.includes(removed), "Removed copy remains: " + removed);
  assert.equal(await page.locator(".header-context .order-name").innerText(), fixture.name);
  assert.deepEqual(await page.locator(".header-context .platforms span").allTextContents(), ["WhatsApp", "Telegram"]);
  const aligned = await page.locator(".title-context").evaluate((element) => {
    const section = element.querySelector(".section-name").getBoundingClientRect();
    const name = element.querySelector(".order-name").getBoundingClientRect();
    const platforms = element.querySelector(".platforms").getBoundingClientRect();
    return Math.abs((section.top + section.bottom) / 2 - (name.top + name.bottom) / 2) < 2 &&
      Math.abs((platforms.top + platforms.bottom) / 2 - (name.top + name.bottom) / 2) < 2;
  });
  assert(aligned, "Work order name and platforms must align alongside 工单统计");
  assert.equal(await page.locator(".order-name").evaluate((element) => getComputedStyle(element).fontSize), "14px");
  const before = requests;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".board-toolbar button")?.classList.contains("is-loading"));
  assert(requests > before);
  await mkdir(".runtime", { recursive: true });
  await page.screenshot({ path: ".runtime/work-order-share-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator(".public-order").count(), 1);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: ".runtime/work-order-share-mobile.png", fullPage: true });

  requirePassword = true;
  await page.reload();
  await page.getByPlaceholder("请输入访问密码").fill("stats-pass");
  await page.getByRole("button", { name: "查看统计", exact: true }).click();
  await page.locator(".account-stats-table").waitFor();
  revoked = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "已停用" }).waitFor();
  assert.equal(await page.locator(".account-stats-table").count(), 0);
  assert.deepEqual(errors, []);
  console.log("Public work-order share passed: compact aligned title/platforms, exact seven columns, distinct today/cumulative counts, real presence states, removed instructions, responsive table, refresh, password and revocation.");
} finally {
  await browser.close();
}
