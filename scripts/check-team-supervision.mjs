import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, request } from "playwright";

// Only an explicitly started disposable Go fixture is used; never a live API.
const fixturePath = process.env.GONGDAN_TEAM_PREVIEW_PATH || ".runtime/team-preview-fixture.json";
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const base = new URL(process.env.GONGDAN_TEAM_PREVIEW_URL || "http://127.0.0.1:5786/");
const api = new URL(fixture.apiURL);
for (const url of [base, api]) {
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "This test requires local fixture URLs",
  );
  assert.equal(url.protocol, "http:", "This test requires a local HTTP fixture");
}
const output = path.dirname(fixturePath);
await mkdir(output, { recursive: true });
const apiContext = await request.newContext();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROME_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH }
    : {}),
});
const errors = [];
const routeURL = (route) => new URL(`/#/${route}`, base).href;
async function apiCall(token, endpoint, data, method = "GET") {
  const response = await apiContext.fetch(new URL(`/api/v1${endpoint}`, api).href, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json();
  return { status: response.status(), data: body.data };
}
async function loginToken(username, password) {
  const result = await apiCall("", "/auth/login", { username, password }, "POST");
  assert.equal(result.status, 200);
  return result.data.accessToken;
}
async function contextFor(username, password) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "Asia/Shanghai",
  });
  // Forward real API traffic to the test-only server even if another local API
  // is configured in Vite. No production requests or response mocks are used.
  await context.route("**/api/v1/**", async (route) => {
    const incoming = new URL(route.request().url());
    const response = await route.fetch({
      url: new URL(incoming.pathname + incoming.search, api).href,
    });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(routeURL("auth/login"));
  await page.locator("#username").fill(username);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  return { context, page };
}
async function summary(page, expected) {
  await page.waitForFunction((values) => {
    const nodes = [...document.querySelectorAll(".business .team-summary strong")];
    return (
      nodes.length === values.length &&
      nodes.every((node, index) => node.textContent.trim() === String(values[index]))
    );
  }, expected);
  assert.deepEqual(
    await page.locator(".business .team-summary strong").allTextContents(),
    expected.map(String),
  );
}
async function navigate(page, route, title) {
  await page.goto(routeURL(route));
  await page.getByRole("heading", { name: title, exact: true }).waitFor();
}
async function noImplementationText(page) {
  const text = await page.locator(".business").innerText();
  assert.ok(!/网页|页面/.test(text), "Team UI should use customer-facing account/status wording");
  assert.ok(!text.includes("外部团队"), "Other tenant data must not be visible");
}
async function noDocumentOverflow(page, width) {
  await page.setViewportSize({ width, height: 1000 });
  // Element Plus transitions width as well as transform. Wait for the real
  // transition instead of sampling an intermediate width after a fixed delay.
  await page.locator(".el-drawer:visible").evaluateAll(async (drawers) => {
    await Promise.all(
      drawers.flatMap((drawer) =>
        drawer.getAnimations().map((animation) => animation.finished.catch(() => {})),
      ),
    );
  });
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert.ok(
    geometry.width <= geometry.viewport + 1,
    `Unexpected document overflow at ${width}px: ${geometry.width}`,
  );
}

try {
  const token = await loginToken(fixture.username, fixture.password);
  const operatorToken = await loginToken(fixture.otherUsername, fixture.otherPassword);
  const options = await apiCall(token, "/team/options");
  assert.equal(options.status, 200);
  assert.deepEqual(
    options.data.codes.map((code) => code.label),
    [fixture.codeLabel],
  );
  for (const [actor, foreignAccount, customer] of [
    [token, fixture.otherAccountId, fixture.otherCustomer],
    [operatorToken, fixture.accountId, fixture.customer],
  ]) {
    const result = await apiCall(
      actor,
      `/team/messages?${new URLSearchParams({ accountId: foreignAccount, customer })}`,
    );
    assert.equal(
      result.status,
      404,
      "Company admins, including operators, must stay within their own team",
    );
  }

  const { context, page } = await contextFor(fixture.username, fixture.password);
  await navigate(page, "leads", "新增接待");
  await summary(page, fixture.expectedLeads);
  assert.equal(
    await page.getByRole("switch", { name: "团队聊天同步" }).getAttribute("aria-checked"),
    "false",
  );
  assert.equal(await page.locator(".el-table__body-wrapper tr").count(), 4);
  assert.equal(
    await page
      .locator(".el-table__body-wrapper tr")
      .filter({ hasText: fixture.outboundOnlyCustomer })
      .count(),
    0,
  );
  assert.equal(
    await page.locator(".el-table__body-wrapper tr").filter({ hasText: "lid:123456789" }).count(),
    0,
  );
  await noImplementationText(page);
  for (const width of [390, 1024, 1440]) {
    await noDocumentOverflow(page, width);
    await page.screenshot({ path: path.join(output, `team-leads-${width}.png`), fullPage: true });
  }

  // Date-filtered overview must use first inbound, matching the visible rows.
  const dates = page.locator(".team-leads .el-date-editor input");
  await dates.nth(0).fill(fixture.date);
  await dates.nth(1).fill(fixture.date);
  await dates.nth(1).press("Tab");
  await page.getByRole("button", { name: "查询接待", exact: true }).click();
  await summary(page, fixture.expectedDateLeads);

  // An outbound-only customer and a profile without messages remain available.
  await navigate(page, "customers", "客户运营");
  await summary(page, fixture.expectedCustomers);
  const profile = page
    .locator(".el-table__body-wrapper tr")
    .filter({ hasText: fixture.profileCustomer });
  assert.equal(await profile.getByRole("button", { name: "查看聊天", exact: true }).count(), 0);
  await profile.getByText("暂无对话", { exact: true }).waitFor();
  const outbound = page
    .locator(".el-table__body-wrapper tr")
    .filter({ hasText: fixture.outboundOnlyCustomer });
  await outbound.waitFor();
  await noImplementationText(page);

  // A lead's route opens the matching account/customer pair, not another
  // device using the same code. Paging starts with the newest 50 messages.
  await navigate(
    page,
    `customers?${new URLSearchParams({ accountId: fixture.accountId, customer: fixture.customer })}`,
    "客户运营",
  );
  const drawer = page.locator(".team-chat-drawer");
  await drawer.waitFor({ state: "visible" });
  await drawer.locator(".chat-message").nth(49).waitFor();
  assert.equal(await drawer.locator(".chat-message").count(), 50);
  const current = await drawer.locator(".chat-message").allTextContents();
  assert.ok(current[0].includes("fixture-message-05"));
  assert.ok(current.at(-1).includes("fixture-message-54"));
  assert.ok((await drawer.locator(".chat-message.outbound").count()) > 0);
  assert.ok((await drawer.locator(".chat-message:not(.outbound)").count()) > 0);
  await drawer.getByText(fixture.escapedBody, { exact: false }).waitFor();
  assert.equal(await drawer.locator(".message-bubble img,.message-bubble script").count(), 0);
  assert.equal(await page.evaluate(() => window.__teamUnsafe), undefined);
  await drawer.getByText("内容较长，仅同步部分文字", { exact: true }).waitFor();
  await drawer.getByText("[图片]", { exact: true }).waitFor();
  await drawer
    .getByText("本次同步范围有限，更早或更多记录需由客户端继续同步。", { exact: true })
    .waitFor();
  assert.ok((await drawer.innerText()).includes("不代表完整历史"));
  assert.equal(
    await drawer.locator("textarea,input:not([type=hidden])").count(),
    0,
    "Chat history must stay read-only",
  );
  for (const width of [390, 1024, 1440]) {
    await noDocumentOverflow(page, width);
    const bounds = await drawer.boundingBox();
    await page.screenshot({ path: path.join(output, `team-chat-${width}.png`), fullPage: true });
    assert.ok(
      bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1,
      `Chat drawer bounds at ${width}px: ${JSON.stringify(bounds)}`,
    );
  }
  await drawer.locator(".chat-pagination .btn-next").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".team-chat-drawer .chat-message").length === 5,
  );
  assert.ok(
    (await drawer.locator(".chat-message").first().innerText()).includes("fixture-message-00"),
  );
  assert.ok(
    (await drawer.locator(".chat-message").last().innerText()).includes("fixture-message-04"),
  );
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });

  await page.locator(".team-sync .el-switch").click();
  await page.getByRole("button", { name: "确认开启", exact: true }).click();
  await page.getByText("团队聊天同步已开启", { exact: true }).waitFor();
  await page.locator(".team-sync .el-switch").click();
  await page.getByRole("button", { name: "确认关闭", exact: true }).click();
  await page.getByText("团队聊天同步已关闭", { exact: true }).waitFor();
  await page
    .locator(".el-table__body-wrapper tr")
    .filter({ hasText: "Alice · 主账号" })
    .getByRole("button", { name: "查看聊天", exact: true })
    .click();
  await drawer.locator(".chat-message").nth(49).waitFor();
  assert.equal(
    await drawer.locator(".chat-message").count(),
    50,
    "Disabling collection must preserve archived messages",
  );
  assert.ok(!/网页|页面/.test(await drawer.innerText()));
  await context.close();

  const operator = await contextFor(fixture.otherUsername, fixture.otherPassword);
  await navigate(operator.page, "leads", "新增接待");
  await summary(operator.page, [1, 1, 1, 0]);
  assert.equal(await operator.page.locator(".el-table__body-wrapper tr").count(), 1);
  assert.ok(!(await operator.page.locator(".business").innerText()).includes(fixture.codeLabel));
  await operator.context.close();
  assert.deepEqual(errors, [], "No uncaught browser errors");
  console.log(
    "Team UI passed: tenant boundaries, first-inbound stats/date filtering, profile and outbound-only records, read-only escaped chat, newest paging, opt-in setting persistence and 390/1024/1440 layouts.",
  );
} finally {
  await browser.close();
  await apiContext.dispose();
}
