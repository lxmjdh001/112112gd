import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
async function api(route, body, token, method = body ? "POST" : "GET") {
  const r = await fetch("http://127.0.0.1:18081/api/v1" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const b = await r.json();
  assert.equal(r.status, 200, `${route}: ${JSON.stringify(b)}`);
  return b.data;
}
const admin = (
  await api("/auth/login", { username: env.BOOTSTRAP_USERNAME, password: env.BOOTSTRAP_PASSWORD })
).accessToken;
const group = await api("/login-code-groups", { name: "工单验收组" }, admin);
const code = await api(
  "/login-codes",
  {
    label: "统计客服",
    groupId: group.id,
    allowedPlatforms: ["whatsapp"],
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  },
  admin,
);
const client = (
  await api(
    "/client/auth",
    {
      code: code.code,
      deviceId: createHash("sha256").update(randomUUID()).digest("hex"),
      deviceName: "统计验收",
    },
    null,
  )
).accessToken;
const account = await api(
  "/client/accounts",
  { label: "WhatsApp 测试账号", platform: "whatsapp", requestId: randomUUID(), proxyId: "" },
  client,
);
await api(`/client/accounts/${account.id}/open`, {}, client);
await api(
  `/client/accounts/${account.id}/status`,
  { status: "ready", identifier: "8613800000000" },
  client,
);
await api(
  `/client/accounts/${account.id}/inbound-events`,
  {
    owner: "8613800000000",
    ready: true,
    events: [{ id: "e2e-one", customer: "447700900001", at: new Date().toISOString() }],
  },
  client,
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://127.0.0.1:5779/#/auth/login");
  await page.locator("#username").fill(env.BOOTSTRAP_USERNAME);
  await page.locator("#password").fill(env.BOOTSTRAP_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.goto("http://127.0.0.1:5779/#/work-orders");
  await page.getByRole("heading", { name: "工单管理", exact: true }).waitFor();
  await page.getByRole("button", { name: "＋ 创建工单", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建工单统计链接", exact: true });
  await dialog.getByPlaceholder("例如：十月 WhatsApp 推广").fill("十月渠道工单");
  await dialog.locator(".filters .el-select").first().click();
  await page.getByRole("option", { name: "工单验收组", exact: true }).click();
  assert.equal(await dialog.locator(".account-choice").count(), 1);
  await dialog.locator(".selection-bar .el-checkbox").click();
  await dialog.getByPlaceholder("留空无需密码").fill("stats-pass");
  await page.waitForTimeout(800);
  await page.screenshot({ path: ".runtime/work-order-create.png", fullPage: true });
  await dialog.getByRole("button", { name: "保存工单", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("十月渠道工单", { exact: true }).waitFor();
  const orders = await api("/work-orders", null, admin);
  const order = orders.find((o) => o.name === "十月渠道工单");
  assert.deepEqual(order.accountIds, [account.id]);
  assert(order.hasPassword);
  await page.getByRole("button", { name: "查看统计", exact: true }).click();
  const stats = page.getByRole("dialog", { name: "十月渠道工单", exact: true });
  await stats.locator(".metrics").waitFor();
  assert.equal(await stats.locator(".metrics strong").first().innerText(), "1");
  await page.screenshot({ path: ".runtime/work-order-member.png", fullPage: true });
  const publicPage = await browser.newPage({ viewport: { width: 1440, height: 980 } });
  publicPage.on("pageerror", (e) => errors.push(e.message));
  await publicPage.goto(`http://127.0.0.1:5779/#/s/${order.token}`);
  await publicPage.getByPlaceholder("请输入访问密码").fill("stats-pass");
  await publicPage.getByRole("button", { name: "查看统计", exact: true }).click();
  await publicPage.locator(".metrics").waitFor();
  assert.equal(await publicPage.locator(".metrics strong").first().innerText(), "1");
  assert(!(await publicPage.locator("body").innerText()).includes("447700900001"));
  await publicPage.waitForTimeout(1200);
  await publicPage.screenshot({ path: ".runtime/work-order-public.png", fullPage: true });
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await publicPage.screenshot({ path: ".runtime/work-order-mobile.png", fullPage: true });
  assert(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await api(`/work-orders/${order.id}`, { ...order, enabled: false }, admin, "PUT");
  await publicPage.getByRole("button", { name: "刷新", exact: true }).click();
  await publicPage.getByRole("alert").filter({ hasText: "已停用" }).waitFor();
  assert.equal(await publicPage.locator(".metrics").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Work orders: group selection, real inbound aggregation, member/public views, password and revocation passed.",
  );
} finally {
  await browser.close();
}
