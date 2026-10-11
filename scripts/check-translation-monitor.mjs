// Isolated DB schema and mocked translation transports; no customer text or
// live provider requests. Requires a built admin application.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, open } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

await mkdir(".runtime", { recursive: true });
const fixturePath = path.resolve(".runtime/translation-monitor-fixture.json");
await rm(fixturePath, { force: true });
const log = await open(".runtime/translation-monitor-fixture.log", "w", 0o600);
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
const base = "http://127.0.0.1:5783";
let fixture, browser, page;
try {
  assert(
    !(await fetch(base).then(
      () => true,
      () => false,
    )),
    "Preview port 5783 occupied",
  );
  launch(
    "go",
    [
      "test",
      "./internal/app",
      "-run",
      "^TestTranslationMonitorBrowserFixture$",
      "-count=1",
      "-timeout",
      "5m",
    ],
    {
      TEST_DATABASE_URL:
        process.env.TEST_DATABASE_URL || "postgres://127.0.0.1:55437/gongdan007?sslmode=disable",
      GONGDAN_TRANSLATION_E2E_PATH: fixturePath,
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
      "5783",
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
  await page.goto(base + "/#/auth/login");
  await page.locator("#username").fill(fixture.username);
  await page.locator("#password").fill(fixture.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.goto(base + "/#/translation-services");
  await page.getByRole("heading", { name: "翻译接口", exact: true }).waitFor();
  const root = page.locator(".translation-services"),
    panels = root.locator("section.panel");
  await waitFor(
    async () => (await root.locator(".stat strong").first().innerText()) === "26",
    "usage totals",
  );
  assert.deepEqual(await root.locator(".stat strong").allTextContents(), ["26", "280", "216", "2"]);
  assert.equal(await panels.first().getByText("未检测", { exact: true }).count(), 3);
  await page.getByRole("button", { name: "检测全部", exact: true }).click();
  await panels.first().getByText("可用", { exact: true }).waitFor();
  await panels.first().getByText("限流中", { exact: true }).waitFor();
  await panels.first().getByText("额度用完", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "检测 Google", exact: true }).isDisabled(),
    true,
  );
  assert.equal(await root.locator(".stat strong").first().innerText(), "26");
  await page.reload();
  await page.getByRole("heading", { name: "翻译接口", exact: true }).waitFor();
  await panels.first().getByText("限流中", { exact: true }).waitFor();
  async function select(label, option) {
    await page
      .getByRole("combobox", { name: label, exact: true })
      .locator("xpath=ancestor::div[contains(@class,'el-select__wrapper')]")
      .click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
  await select("统计时间", "全部时间");
  await waitFor(
    async () => (await root.locator(".stat strong").first().innerText()) === "27",
    "all-time totals",
  );
  await select("筛选翻译接口", "LibreTranslate");
  const bodyRows = panels.last().locator(".el-table__body-wrapper tr");
  await waitFor(async () => (await bodyRows.count()) === 2, "provider filter");
  assert.match(await bodyRows.first().innerText(), /WhatsApp API/);
  await select("筛选使用位置", "客户端");
  await panels.last().getByText("所选条件下暂无翻译记录", { exact: true }).waitFor();
  await select("筛选翻译接口", "Google");
  await waitFor(async () => (await bodyRows.count()) === 20, "first page");
  await panels.last().getByRole("button", { name: "下一页", exact: true }).click();
  await waitFor(async () => (await bodyRows.count()) === 4, "second page");
  await panels.last().getByPlaceholder("搜索账号名称", { exact: true }).fill("不存在的账号");
  await panels.last().getByRole("button", { name: "搜索", exact: true }).click();
  await panels.last().getByText("所选条件下暂无翻译记录", { exact: true }).waitFor();
  await panels.last().getByPlaceholder("搜索账号名称", { exact: true }).fill("");
  await panels.last().getByRole("button", { name: "搜索", exact: true }).click();
  await select("筛选翻译接口", "全部接口");
  await select("筛选使用位置", "全部使用位置");
  await page.keyboard.press("Escape");
  await root.evaluate((element) => {
    document.activeElement?.blur();
    for (let current = element; current; current = current.parentElement)
      current.scrollTo({ top: 0, left: 0, behavior: "instant" });
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  });
  await waitFor(async () => (await root.boundingBox()).y >= 0, "page scrolled to top");
  await page.screenshot({
    path: ".runtime/translation-monitor.png",
    fullPage: false,
    animations: "disabled",
  });
  await page.route("**/translation/providers?*", (route) =>
    route.fulfill({ status: 503, json: { code: 503, message: "模拟加载失败" } }),
  );
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await page.getByText("接口数据加载失败，请刷新重试。", { exact: true }).waitFor();
  await page.unroute("**/translation/providers?*");
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await page
    .getByText("接口数据加载失败，请刷新重试。", { exact: true })
    .waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: admin translation status, independent checks, persisted results, cooldown, usage totals, period/provider/channel/search filters, pagination and load-error recovery",
  );
} catch (e) {
  await page
    ?.screenshot({ path: ".runtime/translation-monitor-failure.png", fullPage: true })
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
