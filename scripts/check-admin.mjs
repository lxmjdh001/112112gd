import { chromium } from "playwright";
import { readFile, mkdir } from "node:fs/promises";
const env = JSON.parse(await readFile(".runtime/e2e.json", "utf8"));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("http://127.0.0.1:5779/", { waitUntil: "networkidle" });
await page.locator("#username").fill(env.BOOTSTRAP_USERNAME);
await page.locator("#password").fill(env.BOOTSTRAP_PASSWORD);
await page.getByRole("button", { name: "登录", exact: true }).click();
await page.getByRole("heading", { name: "团队控制台" }).waitFor();
await page.waitForTimeout(1000);
await page.screenshot({ path: ".runtime/admin-dashboard.png", fullPage: true });
await page.goto("http://127.0.0.1:5779/#/login-codes");
await page.waitForTimeout(1000);
await page.getByRole("button", { name: "＋ 创建登录码" }).click();
await page.getByPlaceholder("例如：客服小林").fill("验收 · 员工01");
await page.getByRole("button", { name: "生成登录码" }).click();
await page.getByText("登录码已生成", { exact: true }).waitFor();
const code = await page.locator(".secret").innerText();
if (!code.startsWith("GD7-")) throw Error("No login code");
await page.getByRole("button", { name: "已保存，关闭" }).click();
await page.getByText("验收 · 员工01", { exact: true }).first().waitFor();
await page.screenshot({ path: ".runtime/admin-codes.png", fullPage: true });
await page.goto("http://127.0.0.1:5779/#/proxies");
await page.getByRole("button", { name: "＋ 添加 / 批量导入" }).click();
await page.getByPlaceholder(/127.0.0.1:1080/).fill("host:0\n127.0.0.1:1080");
await page.getByRole("button", { name: "识别并保存代理" }).click();
await page.getByText(/第 1 行/).waitFor();
await page.locator(".el-dialog__headerbtn").click();
for (const route of [
  "#/platform-accounts",
  "#/promotion",
  "#/account-center",
  "#/baseline",
  "#/leads",
  "#/customers",
  "#/login-logs",
]) {
  await page.goto("http://127.0.0.1:5779/" + route);
  await page.locator(".business h1").waitFor();
}
console.log(
  JSON.stringify({
    passed: [
      "admin login",
      "dashboard",
      "create reusable code",
      "proxy validation",
      "all 10 routes",
    ],
    browserErrors: errors,
  }),
);
await browser.close();
