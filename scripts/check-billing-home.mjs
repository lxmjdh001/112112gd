// Isolated database schema for point billing and public-homepage acceptance.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, open } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

await mkdir(".runtime", { recursive: true });
const fixturePath = path.resolve(".runtime/billing-home-fixture.json");
await rm(fixturePath, { force: true });
const log = await open(".runtime/billing-home-fixture.log", "w", 0o600);
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
async function waitFor(check, label) {
  for (let i = 0; i < 120; i++) {
    try {
      const result = await check();
      if (result) return result;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Timed out: " + label);
}
const base = "http://127.0.0.1:5784";
let fixture, browser, page;
try {
  assert(
    !(await fetch(base).then(
      () => true,
      () => false,
    )),
    "Preview port 5784 occupied",
  );
  launch(
    "go",
    ["test", "./internal/app", "-run", "^TestBillingBrowserFixture$", "-count=1", "-timeout", "5m"],
    {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL || "postgres://127.0.0.1:55437/gongdan007?sslmode=disable",
      GONGDAN_BILLING_E2E_PATH: fixturePath,
    },
    path.resolve("server"),
  );
  fixture = await waitFor(async () => JSON.parse(await readFile(fixturePath, "utf8")), "fixture");
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
      "5784",
      "--strictPort",
    ],
    { GONGDAN_API_TARGET: fixture.apiURL },
  );
  await waitFor(async () => (await fetch(base)).ok, "preview");
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1500, height: 1080 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator(".home-hero h1").waitFor();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Lucas/ }).click();
  await page.getByText("Vocês podem enviar uma amostra primeiro?", { exact: false }).waitFor();
  await page.screenshot({ path: ".runtime/home-desktop.png" });
  await page.getByLabel("上线账号数量", { exact: true }).fill("8");
  await page.getByLabel("使用天数", { exact: true }).fill("15");
  assert.match(await page.locator(".price-calculator output").innerText(), /120/);
  await page.locator("#pricing").scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".runtime/home-pricing.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".gd-home").evaluate((el) => el.scrollTo(0, 0));
  await page.screenshot({ path: ".runtime/home-mobile.png" });
  assert.equal(
    await page.evaluate(() => document.querySelector(".gd-home").scrollWidth > innerWidth),
    false,
  );
  await page.getByRole("button", { name: "展开导航" }).click();
  await page.getByRole("button", { name: "透明计费", exact: true }).click();
  await page.setViewportSize({ width: 1500, height: 1080 });
  await page.goto(base + "/#/auth/login");
  await page.locator("#username").fill(fixture.username);
  await page.locator("#password").fill(fixture.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.goto(base + "/#/account-center");
  await page.getByRole("heading", { name: "账户中心", exact: true }).waitFor();
  await page.getByText("99", { exact: true }).waitFor();
  await page.getByText("15550000001", { exact: true }).waitFor();
  assert.match(await page.locator(".billing-rules").innerText(), /北京时间/);
  await page.screenshot({ path: ".runtime/billing-account-center.png" });
  await page.getByPlaceholder("搜索账号名称或平台账号").fill("不存在");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.getByText("暂无扣点记录，账号实际上线后将在这里显示", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "点数流水", exact: true }).click();
  await page.getByText("账号按日扣点", { exact: true }).waitFor();
  await page.getByText("-1", { exact: true }).waitFor();
  // Separate browser context verifies public registration grants real DB points.
  const signup = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await signup.goto(base + "/#/auth/register");
  await signup.locator("#register-team").fill("新团队验收");
  await signup.locator("#register-username").fill("billing-browser-signup");
  await signup.locator("#register-password").fill("browser-test-only-123");
  await signup.locator("#register-confirm").fill("browser-test-only-123");
  await signup.getByRole("button", { name: "创建账户并登录", exact: true }).click();
  await signup.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await signup.goto(base + "/#/account-center");
  await signup.getByText("100", { exact: true }).waitFor();
  await signup.getByRole("tab", { name: "点数流水", exact: true }).click();
  await signup.getByText("注册赠送", { exact: true }).waitFor();
  await signup.close();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: public homepage, chat demo, calculator, mobile layout, real registration gift, billing totals/history/search and point ledger",
  );
} catch (e) {
  await page
    ?.screenshot({ path: ".runtime/billing-home-failure.png", fullPage: true })
    .catch(() => {});
  throw e;
} finally {
  await browser?.close();
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
  await rm(fixturePath, { force: true });
}
